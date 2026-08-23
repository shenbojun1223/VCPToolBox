'use strict';

const crypto = require('crypto');
const { createDefaultState } = require('./MemoV2Store.js');
const { assertSafeText, normalizedId, STATUSES, eventDate, reductionError } = require('./MemoV2Reducer.js');

const ACTIVE_STATUSES = new Set(['open', 'in_progress', 'blocked']);
const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MAX_TIMELINE_FACTS = 120;
const DEFAULT_MAX_THREAD_HISTORY = 240;

function cloneJson(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function clockIso(clock) {
    const value = typeof clock === 'function' ? clock() : clock == null ? new Date().toISOString() : clock;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw reductionError('MEMO_V2_INVALID_CLOCK', 'clock must produce a valid date');
    return date.toISOString();
}

function hash(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 24);
}

function normalizeText(value) {
    return String(value || '').trim().replace(/\s+/gu, ' ');
}

function sortedIds(values) {
    const result = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
        const id = normalizedId(value);
        if (!seen.has(id)) {
            seen.add(id);
            result.push(id);
        }
    }
    return result.sort((left, right) => {
        const a = Number(left);
        const b = Number(right);
        if (Number.isSafeInteger(a) && Number.isSafeInteger(b)) return a - b;
        return left.localeCompare(right);
    });
}

function actorNames(events) {
    const result = [];
    const seen = new Set();
    for (const event of events) {
        const actor = event?.actor;
        const name = actor && typeof actor === 'object' ? actor.name : actor;
        if (!name || seen.has(String(name))) continue;
        seen.add(String(name));
        result.push(String(name));
    }
    return result.sort((left, right) => left.localeCompare(right));
}

function eventMap(delta) {
    return new Map((Array.isArray(delta?.canonicalEvents) ? delta.canonicalEvents : [])
        .map(event => [normalizedId(event.eventId), event]));
}

function sourceEvents(sourceMessageIds, eventsById) {
    return sourceMessageIds.map(id => eventsById.get(normalizedId(id))).filter(Boolean);
}

function maxOccurredAt(events) {
    const values = events.map(event => String(event.occurredAt || '')).filter(Boolean).sort();
    return values[values.length - 1] || null;
}

function deterministicFactId(date, text) {
    return `fact_${hash(`${date}\n${normalizeText(text).toLocaleLowerCase()}`)}`;
}

function deterministicThreadId(task, sourceMessageIds) {
    const earliest = sortedIds(sourceMessageIds)[0] || '';
    return `thread_${hash(`${normalizeText(task).toLocaleLowerCase()}\n${earliest}`)}`;
}

function mergeUnique(left, right, sort = false) {
    const values = [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])];
    const result = [];
    const seen = new Set();
    for (const value of values) {
        const key = String(value);
        if (!seen.has(key)) {
            seen.add(key);
            result.push(value);
        }
    }
    return sort ? result.sort((a, b) => String(a).localeCompare(String(b))) : result;
}

function transitionAllowed(from, to) {
    const table = {
        open: new Set(['open', 'in_progress', 'blocked', 'completed', 'cancelled', 'superseded']),
        in_progress: new Set(['open', 'in_progress', 'blocked', 'completed', 'cancelled', 'superseded']),
        blocked: new Set(['open', 'in_progress', 'blocked', 'completed', 'cancelled', 'superseded']),
        completed: new Set(['completed', 'open', 'in_progress', 'superseded']),
        cancelled: new Set(['cancelled', 'open', 'in_progress', 'superseded']),
        superseded: new Set(['superseded', 'open', 'in_progress'])
    };
    return Boolean(table[from]?.has(to));
}

function normalizeConstraints(values) {
    return mergeUnique(values, [], true).map(value => String(value).trim()).filter(Boolean).slice(0, 12);
}

function buildFact(fact, eventsById, at) {
    const sourceMessageIds = sortedIds(fact.sourceMessageIds);
    const events = sourceEvents(sourceMessageIds, eventsById);
    if (!events.length) throw reductionError('MEMO_V2_UNKNOWN_SOURCE_ID', 'fact has no canonical source event');
    const dates = [...new Set(events.map(eventDate))];
    if (dates.length !== 1) throw reductionError('MEMO_V2_CROSS_DATE_FACT', 'fact sources must have one date');
    const date = dates[0];
    const text = assertSafeText(fact.text, 'MEMO_V2_INVALID_FACT', 600);
    return {
        factId: deterministicFactId(date, text),
        date,
        text,
        sourceMessageIds,
        actors: actorNames(events),
        createdAt: at,
        updatedAt: at
    };
}

function mergeFacts(previousFacts, incomingFacts, at) {
    const result = cloneJson(Array.isArray(previousFacts) ? previousFacts : []);
    for (const incoming of incomingFacts) {
        const incomingText = normalizeText(incoming.text).toLocaleLowerCase();
        const incomingSources = JSON.stringify(sortedIds(incoming.sourceMessageIds));
        const existing = result.find(item => item.factId === incoming.factId
            || (item.date === incoming.date && normalizeText(item.text).toLocaleLowerCase() === incomingText)
            || (item.date === incoming.date && JSON.stringify(sortedIds(item.sourceMessageIds)) === incomingSources));
        if (!existing) {
            result.push(incoming);
            continue;
        }
        existing.sourceMessageIds = sortedIds(mergeUnique(existing.sourceMessageIds, incoming.sourceMessageIds));
        existing.actors = mergeUnique(existing.actors, incoming.actors, true);
        existing.updatedAt = at;
        if (!existing.text) existing.text = incoming.text;
    }
    return result;
}

function retainTimeline(facts, options, referenceDate) {
    const maxFacts = Math.max(1, Number(options.maxTimelineFacts || DEFAULT_MAX_TIMELINE_FACTS));
    const retentionDays = Math.max(0, Number(options.retentionDays ?? DEFAULT_RETENTION_DAYS));
    const reference = new Date(`${referenceDate}T00:00:00Z`);
    const cutoff = Number.isFinite(reference.getTime()) ? new Date(reference.getTime() - retentionDays * 86400000) : null;
    const retained = facts.filter(fact => {
        if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(fact.date || ''))) return false;
        if (!cutoff) return true;
        return new Date(`${fact.date}T00:00:00Z`).getTime() >= cutoff.getTime();
    });
    retained.sort((left, right) => String(left.date).localeCompare(String(right.date)) || String(left.factId).localeCompare(String(right.factId)));
    return retained.length > maxFacts ? retained.slice(retained.length - maxFacts) : retained;
}

function threadHistoryItems(previousState) {
    return [
        ...(Array.isArray(previousState?.threadHistory) ? previousState.threadHistory : []),
        ...(Array.isArray(previousState?.activeThreads) ? previousState.activeThreads.filter(item => !ACTIVE_STATUSES.has(item.status)) : [])
    ];
}

function normalizeExistingThread(thread, at) {
    const status = STATUSES.has(thread?.status) ? thread.status : 'open';
    return {
        threadId: String(thread?.threadId || ''),
        task: String(thread?.task || '').trim(),
        status,
        constraints: normalizeConstraints(thread?.constraints),
        assignedBy: thread?.assignedBy == null ? null : String(thread.assignedBy),
        sourceMessageIds: sortedIds(thread?.sourceMessageIds),
        actors: mergeUnique(thread?.actors, [], true),
        createdAt: thread?.createdAt == null ? at : String(thread.createdAt),
        updatedAt: thread?.updatedAt == null ? at : String(thread.updatedAt),
        lastUpdatedAt: thread?.lastUpdatedAt == null ? null : String(thread.lastUpdatedAt)
    };
}

function mergeThread(previous, update, eventsById, at) {
    const sourceMessageIds = sortedIds(update.sourceMessageIds);
    const events = sourceEvents(sourceMessageIds, eventsById);
    if (!events.length) throw reductionError('MEMO_V2_UNKNOWN_SOURCE_ID', 'thread has no canonical source event');
    const status = update.status;
    const existing = previous ? normalizeExistingThread(previous, at) : null;
    if (existing && !transitionAllowed(existing.status, status)) {
        throw reductionError('MEMO_V2_INVALID_TRANSITION', 'thread status transition is not allowed');
    }
    const next = existing || {
        threadId: deterministicThreadId(update.task, sourceMessageIds),
        task: update.task,
        status: 'open',
        constraints: [],
        assignedBy: null,
        sourceMessageIds: [],
        actors: [],
        createdAt: at,
        updatedAt: at,
        lastUpdatedAt: null
    };
    next.task = update.task || next.task;
    next.status = status;
    next.constraints = normalizeConstraints(mergeUnique(next.constraints, update.constraints));
    next.assignedBy = update.assignedBy || next.assignedBy || null;
    next.sourceMessageIds = sortedIds(mergeUnique(next.sourceMessageIds, sourceMessageIds));
    next.actors = mergeUnique(next.actors, actorNames(events), true);
    next.updatedAt = at;
    next.lastUpdatedAt = maxOccurredAt(events) || next.lastUpdatedAt;
    return next;
}

function reduceCandidateState(options = {}) {
    const delta = options.delta;
    if (!delta || typeof delta !== 'object') throw reductionError('MEMO_V2_INVALID_DELTA', 'delta is required');
    const previous = cloneJson(options.previousState || delta.previousState || createDefaultState(delta.agentName));
    const at = clockIso(options.clock ?? options.now);
    const advanceCursor = options.advanceCursor !== false;
    const finalize = options.finalize !== false;
    const eventsById = eventMap(delta);
    const reduction = options.reduction || { facts: [], threadUpdates: [] };
    const incomingFacts = reduction.facts.map(fact => buildFact(fact, eventsById, at));
    const timelineAll = mergeFacts(previous.timeline, incomingFacts, at);
    const latestDate = [...timelineAll.map(item => item.date), ...[...eventsById.values()].map(eventDate)].sort().pop()
        || new Date(at).toISOString().slice(0, 10);
    const timeline = retainTimeline(timelineAll, options, latestDate);

    const allPreviousThreads = [
        ...(Array.isArray(previous.activeThreads) ? previous.activeThreads : []),
        ...(Array.isArray(previous.threadHistory) ? previous.threadHistory : [])
    ];
    const byId = new Map(allPreviousThreads.filter(item => item?.threadId != null).map(item => [String(item.threadId), item]));
    const updatedIds = new Set();
    const mergedThreads = [];
    for (const update of reduction.threadUpdates) {
        const existing = update.threadId == null ? null : byId.get(String(update.threadId));
        const next = mergeThread(existing, update, eventsById, at);
        updatedIds.add(next.threadId);
        const prior = mergedThreads.findIndex(item => item.threadId === next.threadId);
        if (prior >= 0) mergedThreads[prior] = next;
        else mergedThreads.push(next);
    }
    for (const item of allPreviousThreads) {
        if (!item?.threadId || updatedIds.has(String(item.threadId))) continue;
        const preserved = normalizeExistingThread(item, at);
        mergedThreads.push(preserved);
    }

    const activeThreads = mergedThreads.filter(item => ACTIVE_STATUSES.has(item.status));
    const history = mergedThreads.filter(item => !ACTIVE_STATUSES.has(item.status));
    const oldHistory = threadHistoryItems(previous).filter(item => !history.some(current => current.threadId === item.threadId));
    const threadHistory = [...history, ...oldHistory.map(item => normalizeExistingThread(item, at))]
        .sort((left, right) => String(right.lastUpdatedAt || right.updatedAt).localeCompare(String(left.lastUpdatedAt || left.updatedAt)))
        .slice(0, Math.max(1, Number(options.maxThreadHistory || DEFAULT_MAX_THREAD_HISTORY)));

    const next = {
        ...previous,
        schemaVersion: 2,
        initialized: true,
        agentName: String(delta.agentName || previous.agentName || '').trim(),
        timeline,
        activeThreads,
        threadHistory,
        cursor: cloneJson(advanceCursor ? (delta.nextCursor || previous.cursor) : previous.cursor),
        lastAttemptAt: finalize ? at : previous.lastAttemptAt || null,
        lastSuccessAt: finalize ? previous.lastSuccessAt || null : previous.lastSuccessAt || null,
        lastError: finalize ? null : previous.lastError || null,
        stats: {
            ...(previous.stats && typeof previous.stats === 'object' ? previous.stats : {}),
            sourceMessageCount: delta.stats?.sourceMessageCount ?? 0,
            normalizedEventCount: delta.stats?.normalizedEventCount ?? 0,
            normalizedChars: delta.stats?.normalizedChars ?? 0,
            skipped: delta.skipped?.total ?? 0,
            duplicates: delta.duplicates?.total ?? 0
        },
        renderedMemo: previous.renderedMemo || ''
    };
    return next;
}

function applyReductionToWorkingState(options = {}) {
    return reduceCandidateState({
        ...options,
        advanceCursor: false,
        finalize: false
    });
}

function finalizeWorkingState(options = {}) {
    const delta = options.delta;
    if (!delta || typeof delta !== 'object') throw reductionError('MEMO_V2_INVALID_DELTA', 'delta is required');
    const workingState = options.workingState;
    if (!workingState || typeof workingState !== 'object') {
        throw reductionError('MEMO_V2_INVALID_STATE', 'workingState is required');
    }
    const at = clockIso(options.clock ?? options.now);
    const next = cloneJson(workingState);
    next.schemaVersion = 2;
    next.initialized = true;
    next.agentName = String(delta.agentName || next.agentName || '').trim();
    next.cursor = cloneJson(delta.nextCursor || next.cursor);
    next.lastAttemptAt = at;
    next.lastSuccessAt = at;
    next.lastError = null;
    next.stats = {
        ...(next.stats && typeof next.stats === 'object' ? next.stats : {}),
        sourceMessageCount: delta.stats?.sourceMessageCount ?? 0,
        normalizedEventCount: delta.stats?.normalizedEventCount ?? 0,
        normalizedChars: delta.stats?.normalizedChars ?? 0,
        skipped: delta.skipped?.total ?? 0,
        duplicates: delta.duplicates?.total ?? 0
    };
    return next;
}

module.exports = {
    ACTIVE_STATUSES,
    DEFAULT_RETENTION_DAYS,
    DEFAULT_MAX_TIMELINE_FACTS,
    DEFAULT_MAX_THREAD_HISTORY,
    cloneJson,
    clockIso,
    deterministicFactId,
    deterministicThreadId,
    transitionAllowed,
    reduceCandidateState,
    applyReductionToWorkingState,
    finalizeWorkingState,
    mergeFacts,
    retainTimeline
};
