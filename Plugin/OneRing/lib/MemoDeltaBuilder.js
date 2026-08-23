'use strict';

const { normalizeMessageRow, dedupeCanonicalEvents } = require('./MemoEventNormalizer.js');
const { createDefaultState } = require('./MemoV2Store.js');

function positiveInteger(value, fallback, max = 1000000) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) ? Math.min(max, Math.max(1, number)) : fallback;
}

function normalizeId(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function localTimestamp(value) {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value == null ? Date.now() : value);
    if (!Number.isFinite(date.getTime())) return '';
    const pad = part => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function getSnapshotDbMaxId(database, agentName) {
    const row = database.prepare(
        'SELECT COALESCE(MAX(id), 0) AS maxId FROM messages WHERE agentName=?'
    ).get(agentName);
    return normalizeId(row?.maxId);
}

function selectIncrementalRows(database, agentName, cursor, snapshotDbMaxId) {
    return database.prepare(
        `SELECT id, role, senderName, frontendSource, content, timestamp
         FROM messages
         WHERE agentName=? AND id>? AND id<=?
         ORDER BY id ASC`
    ).all(agentName, cursor, snapshotDbMaxId);
}

function selectBootstrapRows(database, agentName, snapshotDbMaxId, timelineDays, fallbackCount, now) {
    const cutoff = localTimestamp(new Date(new Date(now == null ? Date.now() : now).getTime() - timelineDays * 86400000));
    let rows = database.prepare(
        `SELECT id, role, senderName, frontendSource, content, timestamp
         FROM messages
         WHERE agentName=? AND id<=? AND timestamp>=?
         ORDER BY timestamp ASC, id ASC`
    ).all(agentName, snapshotDbMaxId, cutoff);

    if (rows.length < fallbackCount) {
        rows = database.prepare(
            `SELECT id, role, senderName, frontendSource, content, timestamp
             FROM messages
             WHERE agentName=? AND id<=?
             ORDER BY id DESC
             LIMIT ?`
        ).all(agentName, snapshotDbMaxId, fallbackCount).sort((left, right) => normalizeId(left.id) - normalizeId(right.id));
    }
    return rows;
}

function dateRange(events) {
    const dates = events.map(event => String(event.occurredAt || '').match(/^(\d{4}-\d{2}-\d{2})/)?.[1]).filter(Boolean).sort();
    return {
        from: dates[0] || null,
        to: dates[dates.length - 1] || null
    };
}

function cloneJson(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function buildDeltaFromRows({
    agentName,
    previousState = null,
    snapshotDbMaxId,
    rows = [],
    bootstrap = false,
    timelineDays = 3,
    fallbackCount = 30
}) {
    const snapshotMax = normalizeId(snapshotDbMaxId);
    const previous = previousState ? cloneJson(previousState) : createDefaultState(agentName);
    const selectedRows = (Array.isArray(rows) ? rows : [])
        .filter(row => normalizeId(row?.id) <= snapshotMax)
        .sort((left, right) => normalizeId(left.id) - normalizeId(right.id));
    const sourceMessageIds = selectedRows.map(row => row.id);
    const rawChars = selectedRows.reduce((sum, row) => sum + String(row?.content || '').length, 0);
    const normalizedEvents = selectedRows.map(normalizeMessageRow).filter(Boolean);
    const canonicalEvents = dedupeCanonicalEvents(normalizedEvents);
    const duplicates = normalizedEvents.length - canonicalEvents.length;
    const skipped = selectedRows.length - normalizedEvents.length;
    const kindCounts = {};
    for (const event of canonicalEvents) kindCounts[event.kind] = (kindCounts[event.kind] || 0) + 1;
    const normalizedChars = canonicalEvents.reduce((sum, event) => sum + event.text.length, 0);

    return {
        schemaVersion: 2,
        agentName: String(agentName || '').trim(),
        previousState: previous,
        bootstrap: Boolean(bootstrap),
        bootstrapOptions: bootstrap ? {
            timelineDays: positiveInteger(timelineDays, 3, 3650),
            fallbackCount: positiveInteger(fallbackCount, 30, 1000000)
        } : null,
        snapshotDbMaxId: snapshotMax,
        nextCursor: {
            lastMessageId: snapshotMax,
            snapshotDbMaxId: snapshotMax
        },
        sourceMessageIds,
        canonicalEvents,
        skipped: {
            total: skipped,
            emptyAfterNormalization: skipped
        },
        duplicates: {
            total: duplicates
        },
        stats: {
            sourceMessageCount: selectedRows.length,
            normalizedEventCount: canonicalEvents.length,
            rawChars,
            normalizedChars,
            kindCounts,
            dateRange: dateRange(canonicalEvents)
        }
    };
}

function buildDeltaFromDb({
    agentName,
    database,
    previousState = null,
    timelineDays = 3,
    fallbackCount = 30,
    now = new Date()
}) {
    if (!database || typeof database.prepare !== 'function') throw new Error('MEMO_V2_INVALID_DB: database adapter is required');
    const expectedAgent = String(agentName || '').trim();
    if (!expectedAgent) throw new Error('MEMO_V2_INVALID_AGENT: agentName is required');
    const snapshotDbMaxId = getSnapshotDbMaxId(database, expectedAgent);
    const hasPreviousCursor = previousState && previousState.initialized !== false;
    const cursor = normalizeId(previousState?.cursor?.lastMessageId);
    const isBootstrap = !hasPreviousCursor;
    const rows = snapshotDbMaxId === 0
        ? []
        : isBootstrap
            ? selectBootstrapRows(
                database,
                expectedAgent,
                snapshotDbMaxId,
                positiveInteger(timelineDays, 3, 3650),
                positiveInteger(fallbackCount, 30, 1000000),
                now
            )
            : selectIncrementalRows(database, expectedAgent, cursor, snapshotDbMaxId);
    return buildDeltaFromRows({
        agentName: expectedAgent,
        previousState,
        snapshotDbMaxId,
        rows,
        bootstrap: isBootstrap,
        timelineDays,
        fallbackCount
    });
}

function deriveCandidateState(delta, at = null) {
    if (!delta || typeof delta !== 'object') throw new Error('MEMO_V2_INVALID_DELTA: delta is required');
    const previous = delta.previousState || createDefaultState(delta.agentName);
    return {
        ...cloneJson(previous),
        schemaVersion: 2,
        initialized: true,
        agentName: delta.agentName,
        cursor: cloneJson(delta.nextCursor),
        lastAttemptAt: at == null ? previous.lastAttemptAt || null : String(at),
        lastError: null,
        stats: {
            ...cloneJson(previous.stats || {}),
            sourceMessageCount: delta.stats.sourceMessageCount,
            normalizedEventCount: delta.stats.normalizedEventCount,
            normalizedChars: delta.stats.normalizedChars,
            skipped: delta.skipped.total,
            duplicates: delta.duplicates.total
        }
    };
}

module.exports = {
    localTimestamp,
    getSnapshotDbMaxId,
    buildDeltaFromRows,
    buildDeltaFromDb,
    deriveCandidateState
};
