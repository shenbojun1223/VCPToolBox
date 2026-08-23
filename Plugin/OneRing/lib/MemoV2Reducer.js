'use strict';

const { redactSensitiveValues } = require('./MemoEventNormalizer.js');
const {
    NEW_THREAD_WIRE_TOKEN,
    NO_ASSIGNEE_WIRE_TOKEN,
    isReservedWireToken
} = require('./MemoV2WireTokens.js');
const {
    stripCanonicalRedactionPlaceholdersForSafety
} = require('./MemoV2PromptSanitizer.js');

const MAX_FACTS = 40;
const MAX_THREAD_UPDATES = 40;
const MAX_SOURCE_IDS_PER_ITEM = 32;
const MAX_FACT_TEXT_CHARS = 600;
const MAX_TASK_CHARS = 500;
const MAX_CONSTRAINTS = 12;
const MAX_CONSTRAINT_CHARS = 160;
const MAX_TOTAL_REDUCTION_CHARS = 24000;
const STATUSES = new Set(['open', 'in_progress', 'blocked', 'completed', 'cancelled', 'superseded']);

function reductionError(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, details);
    return error;
}

function parseStrictJson(raw) {
    if (typeof raw !== 'string' || !raw.trim()) {
        throw reductionError('MEMO_V2_INVALID_JSON', 'reduction response must be a JSON string');
    }
    const input = raw.trim();
    let jsonText = input;
    const fence = input.match(/^```json[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i);
    if (fence) {
        jsonText = fence[1].trim();
    } else if (/```/u.test(input)) {
        throw reductionError('MEMO_V2_INVALID_JSON', 'only one complete json code fence is allowed');
    }
    try {
        const value = JSON.parse(jsonText);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw reductionError('MEMO_V2_INVALID_SCHEMA', 'reduction root must be an object');
        }
        return value;
    } catch (error) {
        if (error && error.code) throw error;
        throw reductionError('MEMO_V2_INVALID_JSON', 'reduction response is not strict JSON');
    }
}

function normalizedId(value) {
    if (typeof value !== 'string' && typeof value !== 'number') {
        throw reductionError('MEMO_V2_INVALID_SOURCE_ID', 'sourceMessageIds must contain strings or numbers');
    }
    const result = String(value).trim();
    if (!result || result.length > 80 || /[\u0000\r\n]/u.test(result)) {
        throw reductionError('MEMO_V2_INVALID_SOURCE_ID', 'sourceMessageId is invalid');
    }
    if (isReservedWireToken(result)) {
        throw reductionError('MEMO_V2_RESERVED_TOKEN_MISUSE', 'reserved wire tokens are not valid source ids');
    }
    return result;
}

function hasUnsafeText(value) {
    const text = String(value || '');
    return /[\u0000]/u.test(text)
        || /<[^>]{1,500}>/u.test(text)
        || /<<<\[TOOL_REQUEST\]>>>|<<<\[END_TOOL_REQUEST\]>>>|\[\[VCP(?:调用|_RAG|_TOOL)|VCP_RAG_BLOCK|「始(?:ESCAPE)?」|「末(?:ESCAPE)?」/iu.test(text)
        || /\[REDACTED\]/iu.test(text)
        || /\b(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|authorization)\s*[:=：]/iu.test(text)
        || /(?:验证码|管理员密码|授权码|访问密码|工具密码|密码)\s*(?:为|是|[:=：])/u.test(text)
        || /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/iu.test(text)
        || /\bsk-[A-Za-z0-9_-]{12,}\b/u.test(text);
}

function hasUnsafeArchivedText(value) {
    // Canonical archived events may contain the exact placeholder [REDACTED]
    // after deterministic secret removal. Permit only that inert placeholder;
    // raw credentials, HTML and VCP protocol syntax remain forbidden.
    const text = stripCanonicalRedactionPlaceholdersForSafety(String(value || ''));

    return hasUnsafeText(text);
}

function assertSafeText(value, code, maxChars) {
    if (typeof value !== 'string') throw reductionError(code, 'text fields must be strings');
    const text = value.trim();
    if (!text) throw reductionError(code, 'text fields must not be empty');
    if (text.length > maxChars) throw reductionError('MEMO_V2_LIMIT_EXCEEDED', 'text field exceeds its limit');
    if (text.includes(NEW_THREAD_WIRE_TOKEN) || text.includes(NO_ASSIGNEE_WIRE_TOKEN)) {
        throw reductionError('MEMO_V2_RESERVED_TOKEN_MISUSE', 'reserved wire tokens are not valid reduction text');
    }
    if (hasUnsafeText(text)) throw reductionError('MEMO_V2_UNSAFE_TEXT', 'reduction text contains unsafe content');
    return redactSensitiveValues(text);
}

function sourceArray(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SOURCE_IDS_PER_ITEM) {
        throw reductionError('MEMO_V2_INVALID_SOURCES', 'each item needs a bounded non-empty sourceMessageIds array');
    }
    const result = [];
    const seen = new Set();
    for (const item of value) {
        const id = normalizedId(item);
        if (!seen.has(id)) {
            seen.add(id);
            result.push(id);
        }
    }
    return result;
}

function eventActorNames(event) {
    const actor = event && event.actor;
    const name = actor && typeof actor === 'object' ? actor.name : actor;
    return name == null || !String(name).trim() ? [] : [String(name).trim()];
}

function eventDate(event) {
    const value = String(event?.occurredAt || '');
    const match = value.match(/^(\d{4}-\d{2}-\d{2})(?:[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?)?$/u);
    if (!match) throw reductionError('MEMO_V2_UNKNOWN_EVENT_DATE', 'source event has no trusted outer date');
    const [year, month, day] = match[1].split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        throw reductionError('MEMO_V2_UNKNOWN_EVENT_DATE', 'source event date is not a real calendar date');
    }
    return match[1];
}

function previousSourceIds(previousState) {
    const result = new Set();
    const collect = items => {
        for (const item of Array.isArray(items) ? items : []) {
            for (const source of Array.isArray(item?.sourceMessageIds) ? item.sourceMessageIds : []) {
                try { result.add(normalizedId(source)); } catch (_) { /* malformed old data is simply not trusted */ }
            }
        }
    };
    collect(previousState?.timeline);
    collect(previousState?.activeThreads);
    collect(previousState?.threadHistory);
    return result;
}

function previousThreadIds(previousState, allowedThreadIds) {
    const result = new Set();
    if (Array.isArray(allowedThreadIds)) {
        for (const item of allowedThreadIds) {
            if (item != null && String(item).trim()) result.add(String(item).trim());
        }
        return result;
    }
    for (const item of Array.isArray(previousState?.activeThreads) ? previousState.activeThreads : []) {
        if (item && item.threadId != null) result.add(String(item.threadId).trim());
    }
    return result;
}

function previousSourceDates(previousState) {
    const result = new Map();
    for (const fact of Array.isArray(previousState?.timeline) ? previousState.timeline : []) {
        const date = String(fact?.date || '');
        if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) continue;
        for (const source of Array.isArray(fact?.sourceMessageIds) ? fact.sourceMessageIds : []) {
            const id = normalizedId(source);
            const dates = result.get(id) || new Set();
            dates.add(date);
            result.set(id, dates);
        }
    }
    return result;
}

function validateReduction(reduction, options = {}) {
    const value = typeof reduction === 'string' ? parseStrictJson(reduction) : reduction;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw reductionError('MEMO_V2_INVALID_SCHEMA', 'reduction must be an object');
    }
    const rootKeys = Object.keys(value).sort();
    if (rootKeys.some(key => key !== 'facts' && key !== 'threadUpdates')) {
        if (rootKeys.includes('date') || rootKeys.includes('factId')) {
            throw reductionError('MEMO_V2_MODEL_DATE_FORBIDDEN', 'model may not provide dates or fact ids');
        }
        throw reductionError('MEMO_V2_INVALID_SCHEMA', 'reduction contains an unknown field');
    }
    if (!Array.isArray(value.facts) || !Array.isArray(value.threadUpdates)) {
        throw reductionError('MEMO_V2_INVALID_SCHEMA', 'facts and threadUpdates must be arrays');
    }
    if (value.facts.length > MAX_FACTS) throw reductionError('MEMO_V2_LIMIT_EXCEEDED', 'too many facts');
    if (value.threadUpdates.length > MAX_THREAD_UPDATES) throw reductionError('MEMO_V2_LIMIT_EXCEEDED', 'too many thread updates');

    const delta = options.delta || {};
    const currentEvents = Array.isArray(delta.canonicalEvents) ? delta.canonicalEvents : [];
    const currentIds = new Set(currentEvents.map(event => normalizedId(event.eventId)));
    const knownIds = new Set([...currentIds, ...previousSourceIds(options.previousState || delta.previousState)]);
    const existingThreads = previousThreadIds(
        options.previousState || delta.previousState,
        options.allowedThreadIds
    );
    const allowedActors = new Set(
        (Array.isArray(options.allowedActorNames)
            ? options.allowedActorNames
            : currentEvents.flatMap(eventActorNames))
            .map(name => String(name).trim())
            .filter(Boolean)
    );
    const archivedDatesById = previousSourceDates(options.previousState || delta.previousState);
    const eventMap = new Map(currentEvents.map(event => [normalizedId(event.eventId), event]));
    const totalChars = JSON.stringify(value).length;
    if (totalChars > MAX_TOTAL_REDUCTION_CHARS) throw reductionError('MEMO_V2_LIMIT_EXCEEDED', 'reduction response is too large');

    const facts = value.facts.map((fact, index) => {
        if (!fact || typeof fact !== 'object' || Array.isArray(fact)) {
            throw reductionError('MEMO_V2_INVALID_SCHEMA', `facts[${index}] must be an object`);
        }
        if (Object.keys(fact).some(key => key !== 'text' && key !== 'sourceMessageIds')) {
            if (Object.prototype.hasOwnProperty.call(fact, 'date') || Object.prototype.hasOwnProperty.call(fact, 'factId')) {
                throw reductionError('MEMO_V2_MODEL_DATE_FORBIDDEN', 'model may not provide dates or fact ids');
            }
            throw reductionError('MEMO_V2_INVALID_SCHEMA', `facts[${index}] contains an unknown field`);
        }
        const text = assertSafeText(fact.text, 'MEMO_V2_INVALID_FACT', MAX_FACT_TEXT_CHARS);
        const sourceMessageIds = sourceArray(fact.sourceMessageIds);
        if (!sourceMessageIds.some(id => knownIds.has(id))) throw reductionError('MEMO_V2_UNKNOWN_SOURCE_ID', 'fact references an unknown source id');
        if (!sourceMessageIds.some(id => currentIds.has(id))) {
            throw reductionError('MEMO_V2_FACT_REQUIRES_CURRENT_SOURCE', 'new facts must cite a current delta event');
        }
        if (sourceMessageIds.some(id => !currentIds.has(id))) {
            throw reductionError('MEMO_V2_UNKNOWN_SOURCE_ID', 'fact source ids must come from the current batch');
        }
        const dates = new Set();
        for (const id of sourceMessageIds) {
            if (eventMap.has(id)) dates.add(eventDate(eventMap.get(id)));
            else if (archivedDatesById.has(id)) {
                for (const date of archivedDatesById.get(id)) dates.add(date);
            } else {
                throw reductionError('MEMO_V2_UNKNOWN_EVENT_DATE', 'source event date is not available');
            }
        }
        if (dates.size > 1) throw reductionError('MEMO_V2_CROSS_DATE_FACT', 'a fact may not cite events from multiple dates');
        return { text, sourceMessageIds };
    });

    const threadUpdates = value.threadUpdates.map((update, index) => {
        if (!update || typeof update !== 'object' || Array.isArray(update)) {
            throw reductionError('MEMO_V2_INVALID_SCHEMA', `threadUpdates[${index}] must be an object`);
        }
        const allowed = new Set(['threadId', 'task', 'status', 'constraints', 'assignedBy', 'sourceMessageIds']);
        if (Object.keys(update).some(key => !allowed.has(key))) {
            throw reductionError('MEMO_V2_INVALID_SCHEMA', `threadUpdates[${index}] contains an unknown field`);
        }
        const task = assertSafeText(update.task, 'MEMO_V2_INVALID_THREAD', MAX_TASK_CHARS);
        const status = typeof update.status === 'string' ? update.status.trim() : '';
        if (!STATUSES.has(status)) throw reductionError('MEMO_V2_INVALID_STATUS', 'thread status is not allowed');
        const sourceMessageIds = sourceArray(update.sourceMessageIds);
        if (!sourceMessageIds.some(id => knownIds.has(id))) throw reductionError('MEMO_V2_UNKNOWN_SOURCE_ID', 'thread references an unknown source id');
        if (!sourceMessageIds.some(id => currentIds.has(id))) {
            throw reductionError('MEMO_V2_STATUS_REQUIRES_CURRENT_SOURCE', 'status changes must cite a current delta event');
        }
        if (sourceMessageIds.some(id => !currentIds.has(id))) {
            throw reductionError('MEMO_V2_UNKNOWN_SOURCE_ID', 'thread source ids must come from the current batch');
        }
        const threadId = update.threadId == null ? null : String(update.threadId).trim();
        if (threadId === '') throw reductionError('MEMO_V2_INVALID_THREAD_ID', 'threadId must be null or a non-empty string');
        if (threadId !== null && !existingThreads.has(threadId)) {
            throw reductionError('MEMO_V2_UNKNOWN_THREAD_ID', 'threadId does not exist in previous state');
        }
        let constraints = [];
        if (update.constraints != null) {
            if (!Array.isArray(update.constraints) || update.constraints.length > MAX_CONSTRAINTS) {
                throw reductionError('MEMO_V2_LIMIT_EXCEEDED', 'constraints exceed their limit');
            }
            const seen = new Set();
            constraints = update.constraints.map(item => assertSafeText(item, 'MEMO_V2_INVALID_CONSTRAINT', MAX_CONSTRAINT_CHARS))
                .filter(item => !seen.has(item) && seen.add(item));
        }
        let assignedBy = null;
        if (update.assignedBy != null && String(update.assignedBy).trim()) {
            assignedBy = String(update.assignedBy).trim();
            if (!allowedActors.has(assignedBy)) {
                throw reductionError('MEMO_V2_UNSUPPORTED_ASSIGNEE', 'assignedBy is not supported by current actor allowlist');
            }
            if (assignedBy.length > MAX_TASK_CHARS || hasUnsafeText(assignedBy)) {
                throw reductionError('MEMO_V2_UNSAFE_TEXT', 'assignedBy contains unsafe content');
            }
        }
        return { threadId, task, status, constraints, assignedBy, sourceMessageIds };
    });

    return { facts, threadUpdates };
}

function validateReductionResponse(options = {}) {
    const response = options.response;
    const content = typeof response === 'string' ? response : response?.content;
    if (typeof content !== 'string') throw reductionError('MEMO_V2_INVALID_MODEL_RESPONSE', 'model response content is required');
    const parsed = parseStrictJson(content);
    return validateReduction(parsed, options);
}

module.exports = {
    MAX_FACTS,
    MAX_THREAD_UPDATES,
    MAX_SOURCE_IDS_PER_ITEM,
    MAX_FACT_TEXT_CHARS,
    MAX_TASK_CHARS,
    MAX_CONSTRAINTS,
    MAX_CONSTRAINT_CHARS,
    MAX_TOTAL_REDUCTION_CHARS,
    STATUSES,
    parseStrictJson,
    hasUnsafeText,
    hasUnsafeArchivedText,
    assertSafeText,
    validateReduction,
    validateReductionResponse,
    reductionError,
    normalizedId,
    eventDate
};
