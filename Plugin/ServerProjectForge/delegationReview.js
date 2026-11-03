'use strict';
const C = require('./delegationReviewRecord');
const PREFIX = 'aa_delegation_review:';
const MAX_REVISIONS = 64;
const check = (ok, code = 'REVIEW_ARGUMENT') => {
    if (!ok) throw Object.assign(new Error(code), { code });
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = x => JSON.parse(JSON.stringify(x));
const token = (v, max) => typeof v === 'string' && v.trim().length > 0
    && v.length <= max && !/[\r\n\0]/.test(v);
function target(args) {
    check(args && /^p[A-Za-z0-9_-]{1,127}$/.test(args.projectId)
        && Number.isSafeInteger(args.todoSeq) && args.todoSeq > 0
        && /^aa-delegation-\d{10,16}-[a-f0-9]{8}$/.test(args.delegationId));
}
function state(store, id) {
    const row = store.db.prepare('SELECT value FROM meta WHERE key=?').get('aa_delegation:' + id);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { check(false, 'REVIEW_STALE'); }
}
function saved(store, args) {
    const row = store.db.prepare('SELECT value FROM meta WHERE key=?').get(PREFIX + args.delegationId);
    if (!row) return [];
    try {
        const list = JSON.parse(row.value), runtime = { data: state(store, args.delegationId) };
        check(Array.isArray(list) && list.length > 0 && list.length <= MAX_REVISIONS, 'REVIEW_CORRUPT');
        const requests = new Set();
        for (const [i, r] of list.entries()) {
            check(C.validReview(r, runtime) && r.revision === i + 1
                && r.projectId === args.projectId && r.todoSeq === args.todoSeq
                && r.delegationId === args.delegationId && !requests.has(r.requestId), 'REVIEW_CORRUPT');
            requests.add(r.requestId);
        }
        return list;
    } catch (error) {
        if (error.code === 'REVIEW_CORRUPT') throw error;
        check(false, 'REVIEW_CORRUPT');
    }
}
function history(store, args) {
    target(args);
    store.assertProjectAvailable(args.projectId);
    check(store.getProject(args.projectId), 'REVIEW_TARGET');
    return clone(saved(store, args));
}
function record(store, args) {
    target(args);
    check(Number.isSafeInteger(args.expectedSequence) && args.expectedSequence >= 0
        && Number.isSafeInteger(args.expectedRevision) && args.expectedRevision >= 0
        && token(args.requestId, 100));
    return store.db.transaction(() => {
        store.assertProjectAvailable(args.projectId);
        check(store.getProject(args.projectId), 'REVIEW_TARGET');
        const rows = store.db.prepare('SELECT * FROM todos WHERE project_id=? AND seq=?')
            .all(args.projectId, args.todoSeq);
        check(rows.length === 1, 'REVIEW_TARGET');
        const row = rows[0], runtime = C.readRuntime(row.note, {
            projectId: args.projectId, todoSeq: args.todoSeq, todoId: row.id,
        });
        check(runtime && runtime.data.delegationId === args.delegationId
            && equal(runtime.data, state(store, args.delegationId))
            && runtime.data.sequence === args.expectedSequence, 'REVIEW_STALE');
        const d = runtime.data;
        check(['completed', 'failed', 'cancelled', 'stopped'].includes(d.runtimeStatus), 'REVIEW_NOT_TERMINAL');
        check(args.verdict !== 'passed' || d.runtimeStatus === 'completed', 'REVIEW_FAILED_EXECUTION');
        const records = saved(store, args);
        const request = {
            requestId: args.requestId, verdict: args.verdict, reviewedBy: args.reviewedBy,
            scope: args.scope, evidence: args.evidence, reason: args.reason,
        };
        const old = records.find(r => r.requestId === args.requestId);
        if (old) {
            check(Object.keys(request).every(k => equal(old[k], request[k]))
                && args.expectedRevision === old.revision - 1, 'REVIEW_CONFLICT');
            return { changed: false, review: clone(old) };
        }
        check(args.expectedRevision === records.length, 'REVIEW_CONFLICT');
        check(records.length < MAX_REVISIONS, 'REVIEW_LIMIT');
        const review = {
            version: 1, projectId: d.projectId, todoId: d.todoId, todoSeq: d.todoSeq,
            delegationId: d.delegationId, runtimeSequence: d.sequence, runtimeUpdatedAt: d.updatedAt,
            revision: records.length + 1, ...request, reviewedAt: new Date().toISOString(),
        };
        check(C.validReview(review, runtime));
        // Preflight the existing catalog preview before storing any revision.
        C.compose(row.note, review);
        store.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
            .run(PREFIX + args.delegationId, JSON.stringify([...records, review]));
        // Republish the new independent result, without touching the Todo row.
        store.touchProject(args.projectId);
        return { changed: true, review: clone(review) };
    }).immediate();
}
function projectTodos(store, todos) {
    return todos.map(row => {
        // Even a stale row may contain a copied complete old projection. Never
        // forward that approval untouched: remote previews intentionally omit row ID.
        if (!C.readRuntime(row.note)) return { ...row };
        const runtime = C.readRuntime(row.note, {
            projectId: row.project_id, todoSeq: row.seq, ...(row.id === undefined ? {} : { todoId: row.id }),
        });
        let review = null;
        try {
            if (runtime && equal(runtime.data, state(store, runtime.data.delegationId))) {
                const records = saved(store, runtime.data);
                review = records.at(-1) || null;
            }
        } catch { /* A corrupt/stale review never certifies acceptance. Source execution is retained. */ }
        try { return { ...row, note: C.compose(row.note, review) }; }
        catch { return { ...row }; }
    });
}
module.exports = { record, history, projectTodos };