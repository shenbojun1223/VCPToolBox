'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ProjectStore } = require('../Plugin/ServerProjectForge/store');
const L = require('../Plugin/ServerProjectForge/delegationLifecycle');
const ID = 'aa-delegation-1793459141509-557448cf';
const NEXT = 'aa-delegation-1793459141510-557448ce';
function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-aa-lifecycle-'));
    const store = new ProjectStore(path.join(dir, 'test.db'));
    const p = store.createProject({ name: 'synthetic only', root: dir, workspaceAlias: 'fixture' });
    store.addTodos(p.id, ['one', 'two'], 'Owner');
    const note = '原备注\n状态=限定范围验收通过：旧交付；路径=a。b.md\n不得覆盖';
    store.updateTodo(p.id, 1, { status: 'done', note, updatedBy: 'Owner' });
    const args = { projectId: p.id, todoSeq: 1, delegationId: ID, role: '鲸鱼娘#test',
        assignedBy: 'Kerr', sessionId: 'test-session' };
    t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    return { store, p, note, args, row: () => store.getTodoBySeq(p.id, 1) };
}
test('bind preserves business status and exact original note; Succeed only means review', t => {
    const f = fixture(t);
    const bound = L.bind(f.store, f.args);
    assert.equal(bound.runtimeStatus, 'queued');
    assert.equal(f.row().status, 'done');
    assert.equal(L.readNote(f.row().note).original, f.note);
    assert.equal(L.readNote(f.row().note).data.stage, 'pending');
    L.advance(f.store, { ...f.args, sequence: 1, status: 'running' });
    assert.equal(L.readNote(f.row().note).data.stage, 'working');
    L.advance(f.store, { ...f.args, sequence: 2, status: 'waiting' });
    L.advance(f.store, { ...f.args, sequence: 3, status: 'completed' });
    const final = L.readNote(f.row().note);
    assert.equal(final.data.stage, 'review');
    assert.equal(final.data.runtimeStatus, 'completed');
    assert.equal(f.row().status, 'done');
    assert.equal(final.original, f.note);
});
test('active binding rejects a second delegation and idempotent replay never duplicates block', t => {
    const f = fixture(t);
    L.bind(f.store, f.args);
    const before = f.row().note;
    assert.equal(L.bind(f.store, f.args).delegationId, ID);
    assert.equal(f.row().note, before);
    assert.throws(() => L.bind(f.store, { ...f.args, delegationId: NEXT }), { code: 'DELEGATION_BUSY' });
    assert.equal(f.row().note, before);
});
test('terminal binding can be explicitly replaced; late old callbacks cannot affect replacement', t => {
    const f = fixture(t);
    L.bind(f.store, f.args);
    L.advance(f.store, { ...f.args, sequence: 1, status: 'completed' });
    L.bind(f.store, { ...f.args, delegationId: NEXT });
    const before = f.row().note;
    assert.throws(() => L.advance(f.store, { ...f.args, sequence: 9, status: 'failed' }), { code: 'DELEGATION_STALE' });
    assert.equal(f.row().note, before);
    assert.equal(L.readNote(before).original, f.note);
});
test('out of order events and terminal regressions do not change the row', t => {
    const f = fixture(t);
    L.bind(f.store, f.args);
    L.advance(f.store, { ...f.args, sequence: 2, status: 'waiting' });
    const before = f.row().note;
    assert.equal(L.advance(f.store, { ...f.args, sequence: 1, status: 'running' }).changed, false);
    assert.equal(f.row().note, before);
    L.advance(f.store, { ...f.args, sequence: 3, status: 'cancelled' });
    const terminal = f.row().note;
    assert.equal(L.advance(f.store, { ...f.args, sequence: 4, status: 'running' }).changed, false);
    assert.equal(f.row().note, terminal);
    assert.equal(L.readNote(terminal).data.stage, 'unknown');
});
test('bad input and missing or duplicate Todo targets have zero partial writes', t => {
    const f = fixture(t);
    const before = f.store.db.serialize();
    for (const patch of [{ todoSeq: 0 }, { todoSeq: 999 }, { delegationId: 'forged' },
        { role: 'bad\nstage=verified' }, { assignedBy: 'x'.repeat(101) }, { projectId: 'remote:foreign' }]) {
        assert.throws(() => L.bind(f.store, { ...f.args, ...patch }));
        assert.deepEqual(f.store.db.serialize(), before);
    }
    f.store.db.prepare('INSERT INTO todos(project_id,seq,title,status,updated_at) VALUES(?,?,?,?,?)')
        .run(f.p.id, 1, 'duplicate', 'pending', new Date().toISOString());
    assert.throws(() => L.bind(f.store, f.args), { code: 'DELEGATION_TARGET' });
});
test('deleting and recreating same seq or removing managed block invalidates the old callback', t => {
    const f = fixture(t);
    L.bind(f.store, f.args);
    f.store.removeTodo(f.p.id, 1);
    f.store.addTodos(f.p.id, ['new']); // seq is not reused here; force the ABA fixture explicitly.
    f.store.db.prepare('UPDATE todos SET seq=1 WHERE project_id=? AND seq=3').run(f.p.id);
    assert.throws(() => L.advance(f.store, { ...f.args, sequence: 1, status: 'completed' }), { code: 'DELEGATION_STALE' });
    assert.equal(f.row().note, null);
});
test('controller removal of managed block is respected; no callback restores it', t => {
    const f = fixture(t);
    L.bind(f.store, f.args);
    f.store.updateTodo(f.p.id, 1, { note: 'controller override' });
    assert.throws(() => L.advance(f.store, { ...f.args, sequence: 1, status: 'completed' }), { code: 'DELEGATION_STALE' });
    assert.equal(f.row().note, 'controller override');
});
test('note parsing is bounded and rejects spoofed or incomplete envelopes', () => {
    assert.equal(L.readNote('ordinary').data, null);
    assert.equal(L.readNote('[[ForgeDelegation::v1]]\n{"stage":"verified"}\n[[/ForgeDelegation]]\n').data, null);
    assert.equal(L.readNote('[[ForgeDelegation::v1]]\n' + 'x'.repeat(10000)).data, null);
});