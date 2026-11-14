'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ProjectStore } = require('../Plugin/ServerProjectForge/store');
const B = require('../Plugin/ServerProjectForge/projectBundle');
const L = require('../Plugin/ServerProjectForge/delegationLifecycle');
const R = require('../Plugin/ServerProjectForge/delegationReview');
const C = require('../Plugin/ServerProjectForge/delegationReviewRecord');
const W = require('../Plugin/ServerProjectForge/projectWriteGate');
const forge = require('../Plugin/ServerProjectForge/ProjectForgeService');
const ID = 'aa-delegation-1793459141509-557448cf';
const NEXT = 'aa-delegation-1793459141510-557448ce';
const FOREIGN = 'aa-delegation-1793459141511-557448cd';
const encode = data => Buffer.from(JSON.stringify(data));
const snapshot = store => Object.fromEntries(['meta', 'projects', 'todos', 'batches', 'nodes',
    'blobs', 'file_state', 'captures', 'capture_files', 'sqlite_sequence']
    .map(table => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
const meta = (store, key) => JSON.parse(store.db.prepare('SELECT value FROM meta WHERE key=?').get(key).value);
const setMeta = (store, key, value) => store.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)')
    .run(key, JSON.stringify(value));
function fixture(t, status = 'completed') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bundle-delegation-'));
    const source = new ProjectStore(path.join(dir, 'source.db'));
    const targetPath = path.join(dir, 'target.db');
    const target = new ProjectStore(targetPath);
    t.after(() => {
        source.close();
        if (target.db?.open) target.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    // Burn source Todo IDs, but leave the receiving store completely fresh.
    const dummy = source.createProject({ name: 'dummy', root: path.join(dir, 'dummy') });
    source.addTodos(dummy.id, ['dummy-1', 'dummy-2', 'dummy-3']);
    const root = path.join(dir, 'source');
    fs.mkdirSync(root);
    const p = source.createProject({ name: 'bundle delegation', root, workspaceAlias: 'source' });
    source.addTodos(p.id, ['implement', 'other'], 'Controller');
    const prose = '原始备注\n历史通过不等于接收端工作树重跑；保留中文。\n';
    source.updateTodo(p.id, 1, { note: prose });
    const args = { projectId: p.id, todoSeq: 1, delegationId: ID,
        role: 'Worker#T1', assignedBy: 'Controller', sessionId: 'source-session' };
    L.bind(source, args);
    L.advance(source, { ...args, sequence: 1, status: 'running' });
    const row = source.getTodoBySeq(p.id, 1);
    function change(filePath, maid, todoId) {
        const bytes = Buffer.from(`module.exports = ${JSON.stringify(filePath)};\n`);
        const batchId = source.createBatch(p.id, 'create', 'synthetic code change', maid);
        const nodeId = source.addNode({ projectId: p.id, batchId, filePath, op: 'create',
            beforeHash: null, afterHash: source.putBlob(bytes), todoId, added: 1 });
        fs.writeFileSync(path.join(root, filePath), bytes);
        return { batchId, nodeId };
    }
    const edit = change('implementation.js', args.role, row.id);
    change('other-role.js', 'Worker#T2', row.id);
    change('other-todo.js', args.role, source.getTodoBySeq(p.id, 2).id);
    if (status !== 'running') L.advance(source, { ...args, sequence: 2, status });
    const reviewArgs = { ...args, expectedSequence: 2, expectedRevision: 0, requestId: 'bundle-review-1',
        verdict: 'passed', reviewedBy: 'Controller', scope: 'synthetic source only',
        reason: 'independent source evidence read', evidence: { ref: 'source-evidence.json', sha256: 'a'.repeat(64) } };
    if (status === 'completed') R.record(source, reviewArgs);
    const targetSpec = name => ({ root: path.join(dir, name), workspaceAlias: 'fixture',
        workspaceId: 'fixture', subpath: name });
    const exported = () => B.exportProjectBundle(source, p.id);
    const data = () => JSON.parse(exported().bytes);
    return { dir, root, source, target, targetPath, p, args, row, prose, edit, reviewArgs, data, exported, targetSpec,
        closeTarget: () => target.close() };
}

test('real GetProject/GetDelegationReviews roundtrip remaps project/Todo/batch/node IDs and preserves passed history', async t => {
    const f = fixture(t);
    const sourceBefore = snapshot(f.source), bundle = f.exported();
    assert.deepEqual(f.exported(), bundle, 'export stays deterministic');
    assert.deepEqual(snapshot(f.source), sourceBefore, 'export is read-only');
    assert.equal(f.data().meta.length, 2);
    const result = B.importProjectBundle(f.target, bundle.bytes, f.targetSpec('copy'));
    assert.notEqual(result.projectId, f.p.id);
    const todo = f.target.getTodoBySeq(result.projectId, 1);
    assert.notEqual(todo.id, f.row.id);
    assert.equal(result.idMap.todos[f.row.id], todo.id);
    assert.equal(result.currentWorktreeVerified, false);
    assert.equal(fs.existsSync(f.targetSpec('copy').root), false, 'metadata import never materializes files');
    const d = L.readNote(todo.note).data;
    assert.deepEqual(d, { ...L.readNote(f.source.getTodoBySeq(f.p.id, 1).note).data,
        projectId: result.projectId, todoId: todo.id });
    assert.equal(L.readNote(todo.note).original, f.prose);
    assert.deepEqual(meta(f.target, 'aa_delegation:' + ID), d);
    const history = R.history(f.target, { ...f.args, projectId: result.projectId });
    assert.deepEqual(history, R.history(f.source, f.args).map(r => ({ ...r, projectId: result.projectId, todoId: todo.id })));
    assert.equal(todo.status, 'pending', 'history does not accept business Todo');
    // Reopen the same target DB through the real tool service, not a mocked projection.
    f.closeTarget();
    const workspace = { id: 'fixture', alias: 'fixture', path: f.dir, enabled: true };
    forge.initialize({ dbPath: f.targetPath, config: { AST_INDEX_ENABLED: false },
        services: { workspaceService: { list: () => [workspace], getActiveWorkspaceId: () => workspace.id } },
        logger: { log() {}, warn() {}, error() {} } });
    try {
        const project = await forge.processToolCall({ command: 'GetProject', projectId: result.projectId });
        const note = project.details.todos[0].note;
        const runtime = C.readRuntime(note, { projectId: result.projectId, todoId: todo.id, todoSeq: 1 });
        assert.ok(runtime);
        assert.equal(runtime.data.runtimeStatus, 'completed');
        assert.equal(C.readReview(note, runtime).verdict, 'passed');
        assert.ok(note.includes('[[ForgeReview::v1]]'));
        const queried = await forge.processToolCall({ command: 'GetDelegationReviews',
            ...f.args, projectId: result.projectId });
        const q = queried.details;
        assert.deepEqual(q.reviews, history);
        assert.deepEqual(q.current, history.at(-1));
        assert.equal(q.historicalImport, true);
        assert.equal(q.currentWorktreeVerified, false);
        assert.equal(q.truncated, false);
        assert.equal(q.batches.length, 1);
        assert.equal(q.nodes.length, 1, 'exclude same Todo/different role and same role/different Todo');
        assert.equal(q.batches[0].batchId, result.idMap.batches[f.edit.batchId]);
        assert.deepEqual(q.batches[0].nodeIds, [result.idMap.nodes[f.edit.nodeId]]);
        assert.equal(q.nodes[0].nodeId, result.idMap.nodes[f.edit.nodeId]);
        assert.equal(q.nodes[0].todoId, todo.id);
        assert.equal(q.nodes[0].maid, f.args.role);
        assert.match(q.association, /not exact execution attribution/);
        // Historical queries remain available after Todo deletion/recreation;
        // no edits belonging to the replacement row may inherit the old result.
        const receiving = forge._test.getRuntime().store;
        receiving.removeTodo(result.projectId, 1);
        receiving.addTodos(result.projectId, ['replacement']);
        receiving.db.prepare('UPDATE todos SET seq=1 WHERE project_id=? AND seq=3').run(result.projectId);
        const archived = await forge.processToolCall({ command: 'GetDelegationReviews',
            ...f.args, projectId: result.projectId });
        assert.deepEqual(archived.details.reviews, history);
        assert.equal(archived.details.staleTarget, true);
        assert.deepEqual(archived.details.nodes, []);
    } finally { await forge.cleanup(); }
});

test('current/history containers remap every revision, including current-in-history and predecessor-only history', t => {
    for (const includeCurrent of [true, false]) {
        const f = fixture(t);
        R.record(f.source, { ...f.reviewArgs, requestId: 'bundle-review-2', expectedRevision: 1,
            verdict: 'rejected', reason: 'follow-up source finding' });
        const list = R.history(f.source, f.args);
        setMeta(f.source, 'aa_delegation_review:' + ID,
            { current: list[1], history: includeCurrent ? list : list.slice(0, 1) });
        const result = B.importProjectBundle(f.target, f.exported().bytes, f.targetSpec('copy'));
        const todo = f.target.getTodoBySeq(result.projectId, 1);
        const saved = meta(f.target, 'aa_delegation_review:' + ID);
        for (const r of [saved.current, ...saved.history]) {
            assert.equal(r.projectId, result.projectId);
            assert.equal(r.todoId, todo.id);
        }
        const queried = R.history(f.target, { ...f.args, projectId: result.projectId });
        assert.equal(queried.length, 2);
        assert.equal(queried[0].verdict, 'passed');
        assert.equal(queried[1].verdict, 'rejected');
        const projected = R.projectTodos(f.target, [todo])[0].note;
        assert.equal(C.readReview(projected, C.readRuntime(projected)).verdict, 'rejected');
    }
});

test('imported active history blocks old bind/callback, but explicit fresh delegation can take over', t => {
    const f = fixture(t, 'running');
    // Even a real source writer binding is not exported or inherited.
    W.bind(f.source, f.p.id, { hubId: 'source-hub', globalProjectId: 'source-global', mappingId: 'source-map' });
    const bundle = f.exported();
    assert.ok(!bundle.bytes.includes(Buffer.from('project_writer:')));
    const result = B.importProjectBundle(f.target, bundle.bytes, f.targetSpec('copy'));
    const args = { ...f.args, projectId: result.projectId };
    assert.equal(W.binding(f.target, result.projectId), null);
    assert.doesNotThrow(() => W.assertWrite(f.target, result.projectId), 'no ghost source lease blocks normal local operations');
    const before = snapshot(f.target);
    assert.throws(() => L.bind(f.target, args), { code: 'DELEGATION_IMPORTED' });
    assert.throws(() => L.advance(f.target, { ...args, status: 'completed', sequence: 999 }), { code: 'DELEGATION_IMPORTED' });
    assert.deepEqual(snapshot(f.target), before);
    assert.equal(L.readNote(f.target.getTodoBySeq(result.projectId, 1).note).data.runtimeStatus, 'running');
    const fresh = { ...args, delegationId: NEXT, sessionId: 'receiving-session' };
    assert.equal(L.bind(f.target, fresh).runtimeStatus, 'queued');
    assert.equal(L.advance(f.target, { ...fresh, sequence: 1, status: 'running' }).changed, true);
    assert.throws(() => L.advance(f.target, { ...args, status: 'failed', sequence: 1000 }), { code: 'DELEGATION_STALE' });
    // A receiving network lease remains closed even though history is present.
    W.bind(f.target, result.projectId, { hubId: 'new-hub', globalProjectId: 'new-global', mappingId: 'new-map' });
    assert.throws(() => W.assertWrite(f.target, result.projectId), { code: 'WRITE_LEASE_REQUIRED' });
});

test('legacy bundles without meta remain readable; note-only active history is quarantined, not reconstructed as authoritative', t => {
    const f = fixture(t, 'running'), data = f.data();
    delete data.meta;
    const result = B.importProjectBundle(f.target, encode(data), f.targetSpec('legacy'));
    const todo = f.target.getTodoBySeq(result.projectId, 1);
    assert.equal(L.readNote(todo.note).data.todoId, todo.id);
    assert.equal(R.history(f.target, { ...f.args, projectId: result.projectId }).length, 0);
    assert.equal(f.target.db.prepare('SELECT 1 FROM meta WHERE key=?').get('aa_delegation:' + ID), undefined);
    assert.throws(() => L.bind(f.target, { ...f.args, projectId: result.projectId }), { code: 'DELEGATION_IMPORTED' });
    assert.equal(L.bind(f.target, { ...f.args, projectId: result.projectId, delegationId: NEXT }).changed, true);
});

test('export is scoped: superseded delegation histories survive, foreign histories and host capability meta do not', t => {
    const f = fixture(t);
    L.bind(f.source, { ...f.args, delegationId: NEXT });
    const dummy = f.source.db.prepare("SELECT id FROM projects WHERE name='dummy'").get();
    L.bind(f.source, { ...f.args, projectId: dummy.id, delegationId: FOREIGN });
    setMeta(f.source, 'unrelated:secret', { projectId: f.p.id, value: 'not-portable' });
    const data = f.data();
    assert.equal(data.meta.length, 3);
    assert.ok(!data.meta.some(r => r.key.includes(FOREIGN) || r.key.includes('unrelated')));
    const result = B.importProjectBundle(f.target, encode(data), f.targetSpec('copy'));
    const args = { ...f.args, projectId: result.projectId };
    assert.equal(R.history(f.target, args).length, 1, 'rebound old review remains queryable');
    assert.equal(R.relatedChanges(f.target, args).nodes.length, 1);
    const projected = R.projectTodos(f.target, [f.target.getTodoBySeq(result.projectId, 1)])[0].note;
    assert.equal(C.readRuntime(projected).data.delegationId, NEXT);
    assert.equal(C.readReview(projected, C.readRuntime(projected)), null, 'old passed never certifies the new binding');
});

test('invalid or foreign metadata, mismatched Todo, duplicate revisions and unexpected capabilities reject without writes', t => {
    const f = fixture(t);
    const mutations = [
        data => { data.meta = null; },
        data => { data.meta.push(data.meta[0]); },
        data => { data.meta[0].key = 'project_writer:host'; },
        data => { data.meta.find(r => r.key.startsWith('aa_delegation:')).value.projectId = 'pforeign'; },
        data => { data.meta.find(r => r.key.startsWith('aa_delegation:')).value.todoId = 999999; },
        data => { data.meta.find(r => r.key.startsWith('aa_delegation:')).value.sequence++; },
        data => { data.meta.find(r => r.key.startsWith('aa_delegation_review:')).value[0].todoId++; },
        data => { data.meta.find(r => r.key.startsWith('aa_delegation_review:')).value[0].evidence.sha256 = 'bad'; },
        data => { const r = data.meta.find(r => r.key.startsWith('aa_delegation_review:')); r.value.push(r.value[0]); },
        data => { data.meta = data.meta.filter(r => !r.key.startsWith('aa_delegation:')); },
        data => { data.todos[0].note = data.todos[0].note.replace(`"todoId":${f.row.id}`, '"todoId":999'); },
    ];
    const before = snapshot(f.target);
    for (const mutate of mutations) {
        const data = f.data();
        mutate(data);
        assert.throws(() => B.importProjectBundle(f.target, encode(data), f.targetSpec('bad')));
        assert.deepEqual(snapshot(f.target), before);
    }
});

test('global delegation ID conflict rejects without overwriting receiving history or partial project rows', t => {
    const f = fixture(t);
    const local = f.target.createProject({ name: 'local', root: path.join(f.dir, 'local') });
    f.target.addTodos(local.id, ['local']);
    L.bind(f.target, { ...f.args, projectId: local.id });
    const before = snapshot(f.target);
    assert.throws(() => B.importProjectBundle(f.target, f.exported().bytes, f.targetSpec('copy')),
        { code: 'DELEGATION_CONFLICT' });
    assert.deepEqual(snapshot(f.target), before);
});

test('SQL failure after runtime metadata insert rolls back every table and autoincrement', t => {
    const f = fixture(t);
    f.target.db.exec(`CREATE TRIGGER fail_review BEFORE INSERT ON meta
        WHEN NEW.key GLOB 'aa_delegation_review:*' BEGIN SELECT RAISE(ABORT,'injected failure'); END;`);
    const before = snapshot(f.target);
    assert.throws(() => B.importProjectBundle(f.target, f.exported().bytes, f.targetSpec('copy')), /injected failure/);
    assert.deepEqual(snapshot(f.target), before);
});

test('idempotent import receipts detect delegation-history drift before returning success', t => {
    const f = fixture(t), bundle = f.exported();
    B.initializeProjectImports(f.target);
    const args = { requestId: 'delegation-import', expectedHash: bundle.sha256,
        publication: { journalId: 'journal', jobId: 'job', journalPath: path.join(f.dir, 'journal.db') } };
    const first = B.importProjectBundleOnce(f.target, bundle.bytes, f.targetSpec('copy'), args);
    assert.deepEqual(B.importProjectBundleOnce(f.target, bundle.bytes, f.targetSpec('copy'), args), first);
    const d = meta(f.target, 'aa_delegation:' + ID);
    setMeta(f.target, 'aa_delegation:' + ID, { ...d, role: 'tampered' });
    assert.throws(() => B.importProjectBundleOnce(f.target, bundle.bytes, f.targetSpec('copy'), args), { code: 'IMPORT_DRIFT' });
});

test('a second cross-end roundtrip retains approval but never transfers import provenance or lease capability', t => {
    const f = fixture(t), bundle = f.exported();
    const first = B.importProjectBundle(f.target, bundle.bytes, f.targetSpec('copy'));
    const root = f.targetSpec('copy').root;
    fs.mkdirSync(root);
    for (const row of f.data().files) if (row.hash) fs.writeFileSync(path.join(root, row.file_path), f.target.getBlob(row.hash));
    const secondBundle = B.exportProjectBundle(f.target, first.projectId);
    const data = JSON.parse(secondBundle.bytes);
    assert.equal(data.meta.length, 2);
    assert.ok(data.meta.every(row => !row.key.startsWith('aa_delegation_import:')));
    const third = new ProjectStore(path.join(f.dir, 'third.db'));
    try {
        const result = B.importProjectBundle(third, secondBundle.bytes, f.targetSpec('third'));
        const row = third.getTodoBySeq(result.projectId, 1);
        const projected = R.projectTodos(third, [row])[0].note;
        assert.equal(C.readReview(projected, C.readRuntime(projected)).verdict, 'passed');
        assert.equal(L.imported(third, L.readNote(row.note).data), true);
        assert.equal(W.binding(third, result.projectId), null);
    } finally { third.close(); }
});

test('receiving occupied numeric IDs remap associated batches and nodes, not only Todo/project IDs', t => {
    const f = fixture(t);
    const noise = f.target.createProject({ name: 'noise', root: path.join(f.dir, 'noise') });
    f.target.addTodos(noise.id, Array(9).fill('occupied'));
    for (let i = 0; i < 4; i++) {
        const batchId = f.target.createBatch(noise.id, 'create', 'occupied', 'Noise');
        f.target.addNode({ projectId: noise.id, batchId, filePath: `occupied-${i}.js`, op: 'create',
            beforeHash: null, afterHash: f.target.putBlob(Buffer.from('occupied')), todoId: null });
    }
    const result = B.importProjectBundle(f.target, f.exported().bytes, f.targetSpec('copy'));
    assert.notEqual(result.idMap.batches[f.edit.batchId], f.edit.batchId);
    assert.notEqual(result.idMap.nodes[f.edit.nodeId], f.edit.nodeId);
    assert.notEqual(result.idMap.todos[f.row.id], f.row.id);
    const changes = R.relatedChanges(f.target, { ...f.args, projectId: result.projectId });
    assert.deepEqual(changes.batches.map(b => b.batchId), [result.idMap.batches[f.edit.batchId]]);
    assert.deepEqual(changes.nodes.map(n => n.nodeId), [result.idMap.nodes[f.edit.nodeId]]);
    assert.equal(changes.nodes[0].todoId, result.idMap.todos[f.row.id]);
});