'use strict';

const { hasUnsafeText } = require('./MemoV2Reducer.js');

const DEFAULT_MAX_EVENTS = 12;
const DEFAULT_MAX_CHARS = 8000;

function staleError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function eventId(event) {
    const value = String(event?.eventId || '').trim();
    if (!value) throw staleError('MEMO_V2_STALE_INVALID_EVENT', 'canonical event id is required');
    return value;
}

function occurredAt(event) {
    const value = String(event?.occurredAt || '');
    if (!/^\d{4}-\d{2}-\d{2}(?:[T ][0-9]{2}:[0-9]{2}:[0-9]{2})?/u.test(value)) {
        throw staleError('MEMO_V2_STALE_INVALID_EVENT', 'canonical event date is required');
    }
    return value;
}

function sortEvents(left, right) {
    return occurredAt(left).localeCompare(occurredAt(right)) || eventId(left).localeCompare(eventId(right));
}

function priority(event, index, total, recencyRank) {
    const text = String(event.text || '');
    let score = 0;
    if (String(event.role || '').toLowerCase() === 'user') score += 30;
    if (/(委托|请|需要|任务|负责|调研|安排|记得|follow[- ]?up|todo)/iu.test(text)) score += 40;
    if (/(blocked|error|失败|错误|阻塞|完成|completed|success|结果|结论)/iu.test(text)) score += 35;
    if (/(更正|纠正|修正|改为|不是|澄清|correction|correct)/iu.test(text)) score += 35;
    score += Math.max(0, recencyRank == null ? total - index : recencyRank);
    return score;
}

function safeEventLine(event) {
    const text = String(event.text || '').trim();
    if (!text || hasUnsafeText(text) || /<<<\[TOOL_REQUEST\]>>>|\[\[VCP|VCP_RAG_BLOCK|<[^>]{1,500}>/iu.test(text)) return null;
    const actor = event.actor && typeof event.actor === 'object' ? event.actor.name : event.actor;
    const actorText = actor ? ` ${String(actor).trim()}:` : '';
    return `- ${occurredAt(event)}${actorText} ${text}`;
}

function buildStaleDeltaView(canonicalEvents, options = {}) {
    const events = Array.isArray(canonicalEvents) ? canonicalEvents : [];
    const maxEvents = Math.max(1, Number(options.maxEvents ?? DEFAULT_MAX_EVENTS));
    const maxChars = Math.max(1, Number(options.maxChars ?? DEFAULT_MAX_CHARS));
    const chronological = [...events].sort(sortEvents);
    const recencyRanks = new Map(chronological.map((event, index) => [eventId(event), index + 1]));
    const candidates = events.map((event, index) => ({ event, index, line: safeEventLine(event) }))
        .filter(item => item.line)
        .sort((left, right) => priority(right.event, right.index, events.length, recencyRanks.get(eventId(right.event)))
            - priority(left.event, left.index, events.length, recencyRanks.get(eventId(left.event)))
            || sortEvents(left.event, right.event));
    const selected = [];
    let chars = 0;
    for (const item of candidates) {
        if (selected.length >= maxEvents) break;
        const extra = (selected.length ? 1 : 0) + item.line.length;
        if (chars + extra > maxChars) continue;
        selected.push(item);
        chars += extra;
    }
    selected.sort((left, right) => sortEvents(left.event, right.event));
    const text = selected.map(item => item.line).join('\n');
    return {
        text,
        includedEventIds: selected.map(item => eventId(item.event)),
        droppedCount: events.length - selected.length,
        chars: text.length
    };
}

module.exports = {
    DEFAULT_MAX_EVENTS,
    DEFAULT_MAX_CHARS,
    buildStaleDeltaView,
    createStaleDeltaView: buildStaleDeltaView
};
