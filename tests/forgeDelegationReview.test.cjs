'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ProjectStore } = require('../Plugin/ServerProjectForge/store');
const L = require('../Plugin/ServerProjectForge/delegationLifecycle');
const R = require('../Plugin/ServerProjectForge/delegationReview');
const C = require('../Plugin/ServerProjectForge/delegationReviewRecord');
const { collectCatalog } = require('../Plugin/ServerProjectForge/catalogCollect');
const { CatalogSnapshot } = require('../Plugin/ServerProjectForge/catalogSnapshot');
const { catalogIdentity } = require('../Plugin/ServerProjectForge/catalogProjection');
const ID = 'aa-delegation-1793459141509-557448cf', NEXT = 'aa-delegation-1793459141510-557448ce';
function fixture(t, status = 'completed') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-review-'));
    const store = new ProjectStore(path.join(root, 'test.db'));
    const p = store.createProject({ name: 'synthetic review only', root, workspaceAlias: 'fixture' });
    store.addTodos(p.id, ['frozen'], 'Owner');
    const args = { projectId: p.id, todoSeq: 1, delegationId: ID, role: 'Worker', assignedBy: 'Controller', sessionId: 'test' };
    L.bind(store, args);
    if (status) L.advance(store, { ...args, status, sequence: 1 });
    const row = () => store.getTodoBySeq(p.id, 1);
    const data = L.readNote(row().note).data;
    const review = { ...args, expectedSequence: data.sequence, expectedRevision: 0,
        requestId: 'review-one', verdict: 'passed', reviewedBy: 'Controller',
        scope: '仅测试交付', reason: '独立核对限定证据',
        evidence: { ref: 'evidence/verification.json', sha256: 'a'.repeat(64) } };
    t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
    return { store, p, args, review, row };
}
test('independent review persists separately; original row and lifecycle metadata remain byte-identical', t => {
    const f = fixture(t), before = f.row();
    const oldMeta = f.store.db.prepare('SELECT value FROM meta WHERE key=?').get('aa_delegation:' + ID);
    const result = R.record(f.store, f.review);
    assert.equal(result.changed, true);
    assert.equal(result.review.revision, 1);
    assert.equal(result.review.verdict, 'passed');
    assert.deepEqual(f.row(), before);
    assert.deepEqual(f.store.db.prepare('SELECT value FROM meta WHERE key=?').get('aa_delegation:' + ID), oldMeta);
    const view = R.projectTodos(f.store, [f.row()])[0];
    assert.notEqual(view.note, before.note);
    const runtime = C.readRuntime(view.note, { projectId: f.p.id, todoSeq: 1, todoId: before.id });
    assert.equal(runtime.data.runtimeStatus, 'completed');
    assert.equal(runtime.data.stage, 'review');
    assert.equal(C.readReview(view.note, runtime).verdict, 'passed');
    assert.deepEqual(f.row(), before);
});
test('idempotence, append-only revisions, conflicting request and CAS rejection', t => {
    const f = fixture(t);
    const one = R.record(f.store, f.review);
    assert.equal(R.record(f.store, f.review).changed, false);
    assert.throws(() => R.record(f.store, { ...f.review, reason: 'changed' }), { code: 'REVIEW_CONFLICT' });
    assert.throws(() => R.record(f.store, { ...f.review, requestId: 'two' }), { code: 'REVIEW_CONFLICT' });
    const two = R.record(f.store, { ...f.review, requestId: 'two', expectedRevision: 1, verdict: 'rejected', reason: '后来发现证据缺口' });
    assert.equal(two.review.revision, 2);
    const history = R.history(f.store, f.args);
    assert.equal(history.length, 2);
    assert.deepEqual(history[0], one.review);
});
test('no self acceptance, no active task approval, no forged/missing evidence and no partial writes', t => {
    const f = fixture(t), before = f.store.db.serialize();
    for (const patch of [{ reviewedBy: 'Worker' }, { reviewedBy: '@Worker' },
        { reviewedBy: 'AgentAssistant' }, { evidence: null }, { evidence: { ref: 'x', sha256: 'bad' } },
        { scope: '' }, { reason: '' }, { expectedSequence: 9 }, { delegationId: NEXT },
        { verdict: 'anything' }, { expectedRevision: -1 }, { requestId: '' }]) {
        assert.throws(() => R.record(f.store, { ...f.review, ...patch }));
        assert.deepEqual(f.store.db.serialize(), before);
    }
    const running = fixture(t, 'running');
    assert.throws(() => R.record(running.store, running.review), { code: 'REVIEW_NOT_TERMINAL' });
    const failed = fixture(t, 'failed');
    assert.throws(() => R.record(failed.store, failed.review), { code: 'REVIEW_FAILED_EXECUTION' });
    assert.equal(R.record(failed.store, { ...failed.review, verdict: 'rejected' }).review.verdict, 'rejected');
});
test('rebound delegation, changed source block and deleted/recreated Todo cannot inherit a review', t => {
    const f = fixture(t);
    R.record(f.store, f.review);
    L.bind(f.store, { ...f.args, delegationId: NEXT });
    const rebound = f.row(), projected = R.projectTodos(f.store, [rebound])[0].note;
    assert.equal(C.readReview(projected, C.readRuntime(projected)), null);
    assert.deepEqual(f.row(), rebound);
    assert.throws(() => R.record(f.store, { ...f.review, expectedRevision: 1, requestId: 'stale' }), { code: 'REVIEW_STALE' });
    assert.equal(R.history(f.store, f.args).length, 1);
    const raw = f.row().note;
    f.store.updateTodo(f.p.id, 1, { note: raw.replace('"queued"', '"completed"') });
    assert.equal(R.projectTodos(f.store, [f.row()])[0].note, f.row().note);
    const g = fixture(t), old = g.row();
    R.record(g.store, g.review);
    g.store.removeTodo(g.p.id, 1);
    g.store.addTodos(g.p.id, ['replacement'], 'Owner');
    const replacement = g.row();
    assert.notEqual(replacement.id, old.id);
    const oldProjected = C.compose(old.note, R.history(g.store, g.args)[0]);
    g.store.updateTodo(g.p.id, 1, { note: oldProjected });
    const recreated = g.row();
    const forged = R.projectTodos(g.store, [recreated])[0].note;
    assert.equal(C.readReview(forged, C.readRuntime(forged)), null,
        'Remote catalog omits row ID: even a copied complete old projection must not certify a replacement row');
    assert.deepEqual(g.row(), recreated, 'sanitizing the projection never rewrites original source');
    assert.throws(() => R.record(g.store, { ...g.review, requestId: 'aba', expectedRevision: 1 }), { code: 'REVIEW_STALE' });
});
test('synthetic envelope is transported in existing note field; no protocol fields added and no read writes', t => {
    const f = fixture(t);
    R.record(f.store, f.review);
    const before = f.store.db.serialize();
    const collected = collectCatalog(f.store, { sourceId: 'test-source', authorize: () => true });
    const snapshot = new CatalogSnapshot(collected.records);
    const key = catalogIdentity({ sourceId: 'test-source', localProjectId: f.p.id }).key;
    const item = snapshot.todos(key).items[0];
    assert.deepEqual(Object.keys(item).sort(), ['seq', 'status', 'title', 'note', 'updatedBy', 'updatedAt', 'truncated'].sort());
    const runtime = C.readRuntime(item.note, { projectId: f.p.id, todoSeq: 1 });
    assert.equal(C.readReview(item.note, runtime).verdict, 'passed');
    assert.equal(item.status, 'pending');
    assert.deepEqual(f.store.db.serialize(), before);
});
test('view rejects truncated/mismatched review and does not promote forged approval in original note', t => {
    const f = fixture(t);
    R.record(f.store, f.review);
    const note = R.projectTodos(f.store, [f.row()])[0].note;
    const runtime = C.readRuntime(note, { projectId: f.p.id, todoSeq: 1 });
    assert.equal(C.readReview(note.slice(0, note.indexOf('[[/ForgeReview]]')), runtime), null);
    assert.equal(C.readReview(note.replace('"todoSeq":1,"delegationId"', '"todoSeq":2,"delegationId"'), runtime), null);
    assert.equal(C.readReview(note, { ...runtime, data: { ...runtime.data, sequence: 2 } }), null);
    const fresh = fixture(t);
    fresh.store.updateTodo(fresh.p.id, 1, { note: fresh.row().note + C.START + '{"verdict":"passed"}' + C.END });
    const projected = R.projectTodos(fresh.store, [fresh.row()])[0].note;
    assert.equal(C.readReview(projected, C.readRuntime(projected, { projectId: fresh.p.id, todoSeq: 1 })), null);
});