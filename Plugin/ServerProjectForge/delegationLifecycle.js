'use strict';
// Host-only capability. No network, background work, standalone DB or schema migration.
const START = '[[ForgeDelegation::v1]]\n', END = '\n[[/ForgeDelegation]]\n';
const PREFIX = 'aa_delegation:';
const STATES = Object.freeze({
    queued: 'pending', running: 'working', waiting: 'working', cancelling: 'working',
    completed: 'review', failed: 'unknown', cancelled: 'unknown', stopped: 'unknown',
});
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'stopped']);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code = 'DELEGATION_ARGUMENT') => { if (!ok) fail(code); };
const plain = v => v && typeof v === 'object' && !Array.isArray(v);
function token(v, maximum, empty = false) {
    check(typeof v === 'string' && (empty || v.length > 0) && v.length <= maximum && !/[\r\n\0]/.test(v));
    return v;
}
function target(args) {
    check(plain(args));
    check(typeof args.projectId === 'string' && /^p[A-Za-z0-9_-]{1,127}$/.test(args.projectId));
    check(Number.isSafeInteger(args.todoSeq) && args.todoSeq > 0);
    check(typeof args.delegationId === 'string' && /^aa-delegation-\d{10,16}-[a-f0-9]{8}$/.test(args.delegationId));
}
function validData(d) {
    try {
        target(d);
        check(d.version === 1 && Number.isSafeInteger(d.todoId) && d.todoId > 0);
        token(d.role, 100); token(d.assignedBy, 100); token(d.sessionId, 256, true);
        check(Object.hasOwn(STATES, d.runtimeStatus) && d.stage === STATES[d.runtimeStatus]);
        check(Number.isSafeInteger(d.sequence) && d.sequence >= 0);
        check(typeof d.updatedAt === 'string' && new Date(d.updatedAt).toISOString() === d.updatedAt);
        const keys = ['version', 'projectId', 'todoId', 'todoSeq', 'delegationId', 'role',
            'assignedBy', 'sessionId', 'runtimeStatus', 'stage', 'sequence', 'updatedAt'];
        check(Object.keys(d).length === keys.length && keys.every(k => Object.hasOwn(d, k)));
        return true;
    } catch { return false; }
}
function readNote(note) {
    const raw = typeof note === 'string' ? note : '';
    if (!raw.startsWith(START)) return { data: null, original: raw };
    const end = raw.indexOf(END, START.length);
    if (end < 0 || end > 2048) return { data: null, original: raw };
    try {
        const data = JSON.parse(raw.slice(START.length, end));
        if (!validData(data)) return { data: null, original: raw };
        return { data, original: raw.slice(end + END.length) };
    } catch { return { data: null, original: raw }; }
}
function noteOf(data, original) {
    const block = START + JSON.stringify(data) + END;
    check(Buffer.byteLength(block, 'utf8') <= 2048 && original.length <= 60000, 'DELEGATION_NOTE_LIMIT');
    return block + original;
}
function metadata(store, id) {
    const row = store.db.prepare('SELECT value FROM meta WHERE key=?').get(PREFIX + id);
    return row ? JSON.parse(row.value) : null;
}
function getTarget(store, args) {
    store.assertProjectAvailable(args.projectId);
    check(store.getProject(args.projectId), 'DELEGATION_TARGET');
    const rows = store.db.prepare('SELECT * FROM todos WHERE project_id=? AND seq=?')
        .all(args.projectId, args.todoSeq);
    check(rows.length === 1, 'DELEGATION_TARGET');
    return rows[0];
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function write(store, row, data, original) {
    check(store.updateTodo(data.projectId, data.todoSeq, {
        note: noteOf(data, original), updatedBy: 'AgentAssistant',
    }), 'DELEGATION_TARGET');
    store.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(PREFIX + data.delegationId, JSON.stringify(data));
    store.touchProject(data.projectId);
    return { ...data, changed: true };
}
function bind(store, args) {
    target(args);
    const role = token(args.role, 100), assignedBy = token(args.assignedBy, 100);
    const sessionId = token(args.sessionId ?? '', 256, true);
    return store.db.transaction(() => {
        const row = getTarget(store, args), parsed = readNote(row.note);
        const existing = metadata(store, args.delegationId);
        if (existing) {
            check(existing.todoId === row.id && existing.projectId === args.projectId &&
                existing.todoSeq === args.todoSeq && existing.role === role &&
                existing.assignedBy === assignedBy && existing.sessionId === sessionId &&
                same(parsed.data, existing), 'DELEGATION_STALE');
            return { ...existing, changed: false };
        }
        if (parsed.data) {
            check(same(metadata(store, parsed.data.delegationId), parsed.data), 'DELEGATION_STALE');
            check(TERMINAL.has(parsed.data.runtimeStatus), 'DELEGATION_BUSY');
        } else check(!String(row.note || '').startsWith('[[ForgeDelegation::'), 'DELEGATION_STALE');
        const data = {
            version: 1, projectId: args.projectId, todoId: row.id, todoSeq: args.todoSeq,
            delegationId: args.delegationId, role, assignedBy, sessionId,
            runtimeStatus: 'queued', stage: 'pending', sequence: 0, updatedAt: new Date().toISOString(),
        };
        return write(store, row, data, parsed.original);
    }).immediate();
}
function advance(store, args) {
    target(args);
    check(Number.isSafeInteger(args.sequence) && args.sequence > 0);
    check(typeof args.status === 'string' && Object.hasOwn(STATES, args.status) && args.status !== 'queued');
    return store.db.transaction(() => {
        const row = getTarget(store, args), saved = metadata(store, args.delegationId), parsed = readNote(row.note);
        check(saved && saved.projectId === args.projectId && saved.todoSeq === args.todoSeq &&
            saved.todoId === row.id && same(parsed.data, saved), 'DELEGATION_STALE');
        if (args.sequence <= saved.sequence || TERMINAL.has(saved.runtimeStatus)) return { ...saved, changed: false };
        const data = { ...saved, runtimeStatus: args.status, stage: STATES[args.status],
            sequence: args.sequence, updatedAt: new Date().toISOString() };
        return write(store, row, data, parsed.original);
    }).immediate();
}
module.exports = { bind, advance, readNote, STATES };