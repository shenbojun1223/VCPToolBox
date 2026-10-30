'use strict';

let lastTimestampMs = 0;
const START_PREFIX = '<<<[VCP_TOOL_BATCH_START:';
const END_PREFIX = '<<<[VCP_TOOL_BATCH_END:';
const timestampPattern = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}(?:Z|[+-]\\d{2}:\\d{2})';
let cachedTimezone;
let cachedFormatter;

/** Use the project's configured timezone, including DST and fractional offsets. */
function formatBatchTimestamp(date) {
    const timezone = process.env.DEFAULT_TIMEZONE || 'Asia/Shanghai';
    if (!cachedFormatter || cachedTimezone !== timezone) {
        const options = {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            fractionalSecondDigits: 3, hourCycle: 'h23', timeZoneName: 'longOffset'
        };
        try {
            cachedFormatter = new Intl.DateTimeFormat('en-GB', { ...options, timeZone: timezone });
        } catch (error) {
            console.warn(`[ToolResultBatch] Invalid DEFAULT_TIMEZONE="${timezone}", using Asia/Shanghai: ${error.message}`);
            cachedFormatter = new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'Asia/Shanghai' });
        }
        cachedTimezone = timezone;
    }
    const parts = Object.fromEntries(cachedFormatter.formatToParts(date).map(part => [part.type, part.value]));
    const offset = parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName.replace(/^GMT/, '');
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}${offset}`;
}

/** Build only after collecting the batch, so delimiter collisions can be checked. */
function formatToolResultBatch(parts, enableRoleDivider = true) {
    const body = parts.join('');
    if (!body) return '';
    let timestamp;
    let start;
    let end;
    do {
        lastTimestampMs = Math.max(Date.now(), lastTimestampMs + 1);
        timestamp = formatBatchTimestamp(new Date(lastTimestampMs));
        start = `${START_PREFIX}${timestamp}]>>>`;
        end = `${END_PREFIX}${timestamp}]>>>`;
    } while (body.includes(start) || body.includes(end));
    const batch = `\n${start}\n${body}\n${end}\n`;
    return enableRoleDivider
        ? `\n<<<[ROLE_DIVIDE_USER]>>>\n${batch}\n<<<[END_ROLE_DIVIDE_USER]>>>\n`
        : batch;
}

/** A fresh scanner per call; quoted batches are opaque, never recursively parsed. */
function createBatchStartScanner() {
    return new RegExp(`${START_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(${timestampPattern})\\]>>>`, 'g');
}

function findBatchEnd(text, match) {
    const marker = `${END_PREFIX}${match[1]}]>>>`;
    const index = text.indexOf(marker, match.index + match[0].length);
    return index === -1 ? text.length : index + marker.length;
}

/**
 * Project outer wrappers only. The earliest enclosing literal region wins;
 * payloads (including already-readable batches) are never recursively scanned.
 * This is structural recognition, not authentication of server origin.
 */
function projectBatchWrapperText(text, role) {
    if (!['assistant', 'user'].includes(role) ||
        typeof text !== 'string' || /^\s*<!-- VCP_TOOL_PAYLOAD -->/.test(text) ||
        !text.includes(START_PREFIX)) return text;
    const parser = require('./vcpLoop/toolCallParser');
    const matcher = require('./vcpLoop/toolMarkerFuzzyMatcher');
    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const receiptStart = '[[VCP调用结果信息汇总:';
    const summaryStart = '[本轮工具调用摘要:]';
    const scanner = new RegExp([
        `${escape(START_PREFIX)}(${timestampPattern})\\]>>>`,
        '【工具返回批次开始｜时间：([^】\\r\\n]+)】',
        '<{2,4}\\[[Tt][Oo][Oo][Ll]_[Rr][Ee][Qq][Uu][Ee][Ss][Tt]\\]>{2,4}',
        escape(receiptStart), escape(summaryStart),
        '^ {0,3}(?:`{3,}|~{3,})[^\\r\\n]*',
        '^(?: {0,3}>| {4}|\\t)[^\\r\\n]*',
        '`+'
    ].join('|'), 'gm');
    const nestedEnd = (start, open, close) => {
        const tokens = new RegExp(`${escape(open)}|${escape(close)}`, 'g');
        tokens.lastIndex = start + open.length;
        let depth = 1;
        let token;
        while ((token = tokens.exec(text))) {
            depth += token[0] === open ? 1 : -1;
            if (!depth) return tokens.lastIndex;
        }
        return text.length;
    };
    const edits = [];
    let cursor = 0;
    let match;
    while ((match = scanner.exec(text))) {
        const token = match[0];
        let end = scanner.lastIndex;
        if (match[1] || match[2]) {
            const stamp = match[1] || match[2];
            const endMarker = match[1] ? `${END_PREFIX}${stamp}]>>>`
                : `【工具返回批次结束｜时间：${stamp}】`;
            const endIndex = text.indexOf(endMarker, end);
            if (endIndex === -1) break;
            end = endIndex + endMarker.length;
            if (match[1]) {
                const before = text.slice(cursor, match.index);
                const after = text.slice(end);
                const wrapped = /<<<\[ROLE_DIVIDE_USER\]>>>\s*$/.test(before) &&
                    /^\s*<<<\[END_ROLE_DIVIDE_USER\]>>>/.test(after);
                const wholeUserBatch = role === 'user' && cursor === 0 &&
                    /^\s*$/.test(before) && /^\s*$/.test(after);
                if (wrapped || wholeUserBatch) {
                    const date = new Date(stamp);
                    const display = Number.isNaN(date.getTime()) ? stamp : formatBatchTimestamp(date);
                    edits.push({ start: match.index, end: match.index + token.length,
                        value: `【工具返回批次开始｜时间：${display}】` });
                    edits.push({ start: endIndex, end,
                        value: `【工具返回批次结束｜时间：${display}】` });
                }
            }
        } else if (token === receiptStart || token === summaryStart) {
            end = nestedEnd(match.index, token, token === receiptStart
                ? 'VCP调用结果结束]]' : '[本轮工具调用摘要结束]');
        } else if (token.startsWith('<')) {
            const start = matcher.findBlockStartMarker(token, 0);
            if (start) {
                const block = parser.extractNextToolBlock(text, match.index + start.index);
                end = block ? block.nextOffset : text.length;
            }
        } else if (!/^(?: {0,3}>| {4}|\t)/.test(token)) {
            const fence = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(token);
            if (fence && !(fence[1][0] === '`' && fence[2].includes('`')) &&
                (match.index === 0 || /[\r\n]/.test(text[match.index - 1]))) {
                const close = new RegExp('^ {0,3}' + fence[1][0] +
                    '{' + fence[1].length + ',}[ \\t]*(?:\\r\\n|\\r|\\n|$)', 'gm');
                close.lastIndex = end;
                end = close.exec(text) ? close.lastIndex : text.length;
            } else if (/^`+$/.test(token)) {
                const ticks = /`+/g;
                ticks.lastIndex = end;
                let close;
                end = text.length;
                while ((close = ticks.exec(text))) {
                    if (close[0].length === token.length) { end = ticks.lastIndex; break; }
                }
            }
        }
        scanner.lastIndex = end;
        cursor = end;
    }
    if (!edits.length) return text;
    const output = [];
    cursor = 0;
    for (const edit of edits) {
        output.push(text.slice(cursor, edit.start), edit.value);
        cursor = edit.end;
    }
    output.push(text.slice(cursor));
    return output.join('');
}

/** Request-only copy on change; preserve media, tool arguments and array metadata. */
function projectToolBatchForUpstream(body) {
    if (!body || !Array.isArray(body.messages)) return body;
    let messages = body.messages;
    body.messages.forEach((message, index) => {
        if (!message) return;
        const content = message.content;
        let projectedContent = content;
        if (typeof content === 'string') {
            projectedContent = projectBatchWrapperText(content, message.role);
        } else if (Array.isArray(content)) {
            // Cross-part wrappers are ambiguous and remain untouched.
            const texts = content.filter(part => part?.type === 'text' && typeof part.text === 'string');
            if (texts.length !== 1) return;
            const projected = projectBatchWrapperText(texts[0].text, message.role);
            if (projected !== texts[0].text) {
                projectedContent = content.map(part =>
                    part === texts[0] ? { ...part, text: projected } : part);
            }
        }
        if (projectedContent === content) return;
        if (messages === body.messages) {
            messages = body.messages.slice();
            // Preserve OneRing's non-enumerable metadata without freezing new indices.
            for (const key of Reflect.ownKeys(body.messages)) {
                if (typeof key === 'string' && /^(?:length|0|[1-9]\d*)$/.test(key)) continue;
                Object.defineProperty(messages, key, Object.getOwnPropertyDescriptor(body.messages, key));
            }
        }
        messages[index] = { ...message, content: projectedContent };
    });
    return messages === body.messages ? body : { ...body, messages };
}

module.exports = { formatToolResultBatch, createBatchStartScanner, findBatchEnd, projectToolBatchForUpstream };