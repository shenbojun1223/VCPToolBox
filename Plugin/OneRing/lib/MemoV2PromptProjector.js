'use strict';

const DEFAULT_PROMPT_EVENT_TEXT_CHARS = 3750;
const MIN_PROMPT_EVENT_TEXT_CHARS = 512;
const MAX_PROMPT_EVENT_TEXT_CHARS = 8000;
const REQUIRED_SEGMENT_LOST = 'MEMO_V2_PROMPT_PROJECTION_REQUIRED_SEGMENT_LOST';
const {
    sanitizeCanonicalEventForPrompt
} = require('./MemoV2PromptSanitizer.js');

const TOOL_SUMMARY_PATTERN = /\[工具(?:请求|结果)：[^\r\n]*?(?:\]|(?=\r?\n|$))/gu;
const TASK_PATTERN = /任务|委托|要求|约束|验收|待办|计划|task|delegate|delegat(?:e|ed|ion)|requirement|constraint|acceptance|todo|plan/iu;
const RESULT_PATTERN = /完成|失败|错误|阻塞|取消|替代|决定|结论|结果|成功|完成|error|failed|failure|blocked|cancel(?:led)?|alternative|decision|conclusion|result|success|done|complete/iu;
const CORRECTION_PATTERN = /更正|纠正|不是|应为|禁止|不得|仅|边界|correct(?:ion)?|not\s+(?:this|that)|must\s+not|forbidden|only|boundary/iu;
const SENTENCE_END_PATTERN = /[。！？!?；;](?:[”’」』）)】》\]）]*)/u;

function projectionError(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, details);
    return error;
}

function normalizePromptEventTextCap(value) {
    const cap = Number(value ?? DEFAULT_PROMPT_EVENT_TEXT_CHARS);
    if (!Number.isSafeInteger(cap)
        || cap < MIN_PROMPT_EVENT_TEXT_CHARS
        || cap > MAX_PROMPT_EVENT_TEXT_CHARS) {
        throw projectionError(
            'MEMO_V2_PROMPT_EVENT_TEXT_CAP_INVALID',
            `eventTextCapChars must be an integer from ${MIN_PROMPT_EVENT_TEXT_CHARS} to ${MAX_PROMPT_EVENT_TEXT_CHARS}`
        );
    }
    return cap;
}

function cloneValue(value) {
    if (Array.isArray(value)) return value.map(cloneValue);
    if (value && typeof value === 'object') {
        const clone = {};
        for (const [key, child] of Object.entries(value)) clone[key] = cloneValue(child);
        return clone;
    }
    return value;
}

function safeSlice(text, start, end) {
    let safeStart = Math.max(0, start);
    let safeEnd = Math.min(text.length, end);
    if (safeEnd > safeStart
        && safeEnd < text.length
        && /[\uD800-\uDBFF]/u.test(text[safeEnd - 1])
        && /[\uDC00-\uDFFF]/u.test(text[safeEnd])) {
        safeEnd -= 1;
    }
    if (safeEnd > safeStart
        && safeStart > 0
        && /[\uDC00-\uDFFF]/u.test(text[safeStart])
        && /[\uD800-\uDBFF]/u.test(text[safeStart - 1])) {
        safeStart += 1;
    }
    return text.slice(safeStart, safeEnd);
}

function trimRange(text, start, end) {
    let safeStart = start;
    let safeEnd = end;
    while (safeStart < safeEnd && /\s/u.test(text[safeStart])) safeStart += 1;
    while (safeEnd > safeStart && /\s/u.test(text[safeEnd - 1])) safeEnd -= 1;
    return safeStart < safeEnd
        ? { start: safeStart, end: safeEnd, text: safeSlice(text, safeStart, safeEnd) }
        : null;
}

function splitLineIntoSegments(text, start, end) {
    const result = [];
    let cursor = start;
    while (cursor < end) {
        let boundary = end;
        const line = text.slice(cursor, end);
        const match = line.match(SENTENCE_END_PATTERN);
        if (match && match.index != null) boundary = cursor + match.index + match[0].length;
        const piece = trimRange(text, cursor, boundary);
        if (piece) result.push(piece);
        if (boundary >= end) break;
        cursor = boundary;
    }
    return result;
}

function splitPlainRange(text, start, end) {
    const result = [];
    const rangeText = text.slice(start, end);
    const linePattern = /[^\r\n]+/gu;
    let match;
    while ((match = linePattern.exec(rangeText)) !== null) {
        result.push(...splitLineIntoSegments(text, start + match.index, start + match.index + match[0].length));
    }
    return result;
}

function splitTextIntoSegments(text) {
    const result = [];
    let cursor = 0;
    TOOL_SUMMARY_PATTERN.lastIndex = 0;
    let match;
    while ((match = TOOL_SUMMARY_PATTERN.exec(text)) !== null) {
        result.push(...splitPlainRange(text, cursor, match.index));
        const summary = trimRange(text, match.index, match.index + match[0].length);
        if (summary) result.push({ ...summary, required: true, category: 'tool' });
        cursor = match.index + match[0].length;
    }
    result.push(...splitPlainRange(text, cursor, text.length));
    return result.map((segment, index) => ({
        ...segment,
        index,
        required: Boolean(segment.required),
        category: segment.category || 'ordinary'
    }));
}

function categoryFor(segment) {
    if (segment.required) return 'tool';
    if (TASK_PATTERN.test(segment.text)) return 'task';
    if (RESULT_PATTERN.test(segment.text)) return 'result';
    if (CORRECTION_PATTERN.test(segment.text)) return 'correction';
    return 'ordinary';
}

function separatorCost(selected) {
    return selected.length ? 1 : 0;
}

function currentLength(selected) {
    return selected.reduce((sum, item) => sum + item.text.length, 0) + Math.max(0, selected.length - 1);
}

function candidateText(segment, available, mode) {
    if (available <= 0) return '';
    if (segment.text.length <= available) return segment.text;
    if (mode === 'suffix') return safeSlice(segment.text, segment.text.length - available, segment.text.length);
    return safeSlice(segment.text, 0, available);
}

function selectProjectedSegments(segments, cap) {
    const selected = new Map();
    let truncated = false;
    const add = (segment, mode = 'full', required = false) => {
        if (!segment || selected.has(segment.index)) return false;
        const available = cap - currentLength([...selected.values()]) - separatorCost([...selected.values()]);
        if (available <= 0) {
            if (required) throw projectionError(REQUIRED_SEGMENT_LOST, 'required tool summary cannot fit the prompt projection');
            return false;
        }
        if (required && segment.text.length > available) {
            throw projectionError(REQUIRED_SEGMENT_LOST, 'required tool summary cannot fit the prompt projection');
        }
        const text = candidateText(segment, available, mode);
        if (!text) {
            if (required) throw projectionError(REQUIRED_SEGMENT_LOST, 'required tool summary cannot fit the prompt projection');
            return false;
        }
        if (text.length < segment.text.length) truncated = true;
        selected.set(segment.index, { ...segment, text });
        return true;
    };

    const required = segments.filter(segment => segment.required);
    for (const segment of required) add(segment, 'full', true);

    for (const category of ['task', 'result', 'correction']) {
        for (const segment of segments) {
            if (categoryFor(segment) === category) add(segment, 'full');
        }
    }
    const first = segments[0];
    const last = segments[segments.length - 1];
    add(first, 'prefix');
    if (last && last !== first) add(last, 'suffix');

    for (const segment of segments) add(segment, 'full');

    const ordered = [...selected.values()].sort((left, right) => left.index - right.index);
    const projectedText = ordered.map(segment => segment.text).join('\n');
    return {
        projectedText: projectedText || safeSlice(segments[0]?.text || '', 0, cap),
        selectedCount: ordered.length,
        omittedSegmentCount: Math.max(0, segments.length - ordered.length),
        truncated,
        segmentCount: segments.length
    };
}

function projectCanonicalEventForPrompt(event, options = {}) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
        throw projectionError('MEMO_V2_PROMPT_PROJECTION_EVENT_INVALID', 'canonical event must be an object');
    }
    const cap = normalizePromptEventTextCap(options.eventTextCapChars ?? options.cap);
    const clone = sanitizeCanonicalEventForPrompt(event);
    delete clone.textProjection;
    const sanitizedText = String(clone.text ?? '');
    clone.text = sanitizedText;
    if (sanitizedText.length <= cap) return clone;

    const segments = splitTextIntoSegments(sanitizedText);
    const required = segments.filter(segment => segment.required);
    for (const segment of required) {
        if (segment.text.length > cap) {
            throw projectionError(REQUIRED_SEGMENT_LOST, 'required tool summary cannot fit the prompt projection');
        }
    }
    const selection = selectProjectedSegments(segments, cap);
    let projectedText = selection.projectedText;
    if (!projectedText) projectedText = safeSlice(sanitizedText, 0, cap);
    if (!projectedText) {
        throw projectionError('MEMO_V2_PROMPT_PROJECTION_EMPTY', 'prompt projection must not produce empty text');
    }
    if (projectedText.length > cap) projectedText = safeSlice(projectedText, 0, cap);
    if (!projectedText) throw projectionError('MEMO_V2_PROMPT_PROJECTION_EMPTY', 'prompt projection must not produce empty text');
    clone.text = projectedText;
    clone.textProjection = {
        applied: true,
        strategy: selection.truncated ? 'semantic-priority-unicode-truncation' : 'semantic-priority-boundaries',
        originalChars: sanitizedText.length,
        projectedChars: projectedText.length,
        omittedChars: sanitizedText.length - projectedText.length,
        omittedSegmentCount: selection.omittedSegmentCount
    };
    return clone;
}

function projectCanonicalEventsForPrompt(events, options = {}) {
    if (!Array.isArray(events)) {
        throw projectionError('MEMO_V2_PROMPT_PROJECTION_EVENTS_INVALID', 'canonical events must be an array');
    }
    const cap = normalizePromptEventTextCap(options.eventTextCapChars ?? options.cap);
    return events.map(event => projectCanonicalEventForPrompt(event, { eventTextCapChars: cap }));
}

function summarizePromptSanitization(events, sanitizedEvents) {
    const stats = {
        promptSanitizedEventCount: 0,
        promptRedactionPlaceholderCount: 0,
        promptSanitizationRemovedChars: 0
    };
    for (let index = 0; index < events.length; index++) {
        const metadata = sanitizedEvents[index]?.promptSanitization;
        if (metadata?.applied !== true) continue;
        stats.promptSanitizedEventCount += 1;
        stats.promptRedactionPlaceholderCount += Number(metadata.placeholderCount) || 0;
        stats.promptSanitizationRemovedChars += Number(metadata.removedChars) || 0;
    }
    return stats;
}

function sanitizedTextLength(event, projectedEvent) {
    const metadataLength = Number(projectedEvent?.promptSanitization?.sanitizedChars);
    if (Number.isSafeInteger(metadataLength) && metadataLength >= 0) return metadataLength;
    return String(event?.text ?? '').length;
}

function summarizeProjection(events, projectedEvents, eventTextCapChars) {
    const cap = normalizePromptEventTextCap(eventTextCapChars);
    const originalChars = events.reduce((sum, event, index) => sum + sanitizedTextLength(event, projectedEvents[index]), 0);
    const projectedChars = projectedEvents.reduce((sum, event) => sum + String(event?.text ?? '').length, 0);
    const projectedEventCount = events.reduce((count, event, index) => {
        const originalTextLength = sanitizedTextLength(event, projectedEvents[index]);
        const projectedEvent = projectedEvents[index];
        return count + (originalTextLength > cap && projectedEvent?.textProjection?.applied === true ? 1 : 0);
    }, 0);
    return {
        eventTextCapChars: cap,
        projectedEventCount,
        projectionOriginalChars: originalChars,
        projectionOutputChars: projectedChars,
        projectionRemovedChars: Math.max(0, originalChars - projectedChars),
        projectionRequiredSegmentFailures: 0,
        ...summarizePromptSanitization(events, projectedEvents)
    };
}

module.exports = {
    DEFAULT_PROMPT_EVENT_TEXT_CHARS,
    MIN_PROMPT_EVENT_TEXT_CHARS,
    MAX_PROMPT_EVENT_TEXT_CHARS,
    REQUIRED_SEGMENT_LOST,
    normalizePromptEventTextCap,
    cloneValue,
    projectCanonicalEventForPrompt,
    projectCanonicalEventsForPrompt,
    summarizePromptSanitization,
    summarizeProjection
};
