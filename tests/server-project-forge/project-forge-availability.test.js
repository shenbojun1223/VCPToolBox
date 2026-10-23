'use strict';
// Synthetic local fixtures only. Never opens a production Forge database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const Database = require('better-sqlite3');
const plugin = path.resolve(__dirname, '../../Plugin/ServerProjectForge');
const forge = require(path.join(plugin, 'ProjectForgeService'));
const { ProjectStore } = require(path.join(plugin, 'store'));
const Bundle = require(path.join(plugin, 'projectBundle'));
const { ProjectTakeover } = require(path.join(plugin, 'projectTakeover'));
const quiet = { log() {}, warn() {}, error() {} };
const code = expected => error => error.code === expected;
const win = (name, fn) => test(name, { skip: process.platform !== 'win32' }, fn);
const tables = ['meta', 'projects', 'todos', 'batches', 'nodes', 'blobs', 'file_state',
    'captures', 'capture_files', 'project_import_receipts', 'sqlite_sequence'];
function snapshot(db) {
    return Object.fromEntries(tables.filter(table => db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)).map(table => [
        table, db.prepare(`SELECT * FROM ${table}`).all().sort((a, b) =>
            JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ]));
}
function schemaSnapshot(db) {
    return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all();
}
async function fixture(t) {
    await forge.cleanup();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-availability-'));
    const ws = path.join(root, 'workspace');
    const sourceRoot = path.join(root, 'source');
    fs.mkdirSync(ws); fs.mkdirSync(sourceRoot);
    const source = new ProjectStore(path.join(root, 'source.db'));
    const sourceProject = source.createProject({ name: 'pending-private-project', root: sourceRoot, workspaceAlias: 'source' });
    source.addTodos(sourceProject.id, ['private-todo']);
    const bytes = Buffer.from('\uFEFFpending private bytes\r\n');
    fs.writeFileSync(path.join(sourceRoot, 'a.txt'), bytes);
    const hash = source.putBlob(bytes);
    const batch = source.createBatch(sourceProject.id, 'create', 'private-history', 'Worker');
    source.addNode({ projectId: sourceProject.id, batchId: batch, filePath: 'a.txt',
        op: 'create', beforeHash: null, afterHash: hash });
    const capture = source.createCapture({ projectId: sourceProject.id, root: sourceRoot,
        requestId: 'captured', reason: 'private-capture', files: [{ path: 'a.txt', buffer: bytes }] });
    source.finishCapture(sourceProject.id, capture.id, batch);
    const bundle = Bundle.exportProjectBundle(source, sourceProject.id);
    const targetPath = path.join(root, 'target.db');
    forge.initialize({ dbPath: targetPath, config: { AST_INDEX_ENABLED: false }, logger: quiet,
        workspaceService: {
            list: () => [{ id: 'local-ws', alias: 'local', path: ws, enabled: true }],
            getActiveWorkspaceId: () => 'local-ws',
        }, trash: async absolute => fs.rmSync(absolute, { force: true }),
    });
    const readyId = (await forge.processToolCall({ command: 'CreateProject',
        name: 'existing', dir: 'existing', todos: ['keep-me'] })).details.project.id;
    const target = forge._test.getRuntime().store;
    fs.writeFileSync(path.join(ws, 'existing', 'sentinel.txt'), 'untouched');
    const journal = path.join(root, 'publication.db');
    const coordinator = new ProjectTakeover(target, journal);
    const destination = path.join(ws, 'incoming');
    const args = { requestId: 'request-1', bundle: bundle.bytes, expectedHash: bundle.sha256,
        target: { root: destination, workspaceId: 'local-ws', workspaceAlias: 'local', subpath: 'incoming' } };
    const started = coordinator.start(args);
    const row = target.db.prepare('SELECT * FROM project_import_receipts WHERE request_id=?').get(args.requestId);
    const node = target.db.prepare('SELECT * FROM nodes WHERE project_id=? LIMIT 1').get(started.projectId);
    const importedCapture = target.db.prepare('SELECT id FROM captures WHERE project_id=?').get(started.projectId).id;
    const opened = [];
    t.after(async () => {
        coordinator.close();
        for (const store of opened) store.close();
        await forge.cleanup(); source.close();
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { root, ws, source, target, targetPath, readyId, coordinator, journal, destination,
        args, bundle, pid: started.projectId, row, node, importedCapture, bytes, opened };
}
function independentMetadataHash(db, projectId) {
    const project = { ...db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) };
    delete project.deleted_at; delete project.deleted_by; delete project.availability;
    const records = { project };
    for (const table of ['todos', 'batches', 'nodes', 'captures']) {
        records[table] = db.prepare(`SELECT * FROM ${table} WHERE project_id=? ORDER BY id`).all(projectId);
    }
    records.capture_files = db.prepare(`SELECT f.* FROM capture_files f JOIN captures c ON c.id=f.capture_id
        WHERE c.project_id=? ORDER BY f.capture_id,f.file_path`).all(projectId);
    records.files = db.prepare('SELECT * FROM file_state WHERE project_id=? ORDER BY file_path').all(projectId);
    return crypto.createHash('sha256').update(JSON.stringify(records), 'utf8').digest('hex');
}
// Build the exact old v1 column layout/soft-delete convention without importing legacy production data.
async function legacy(f, { complete = false } = {}) {
    if (complete) f.coordinator.resume(f.args.requestId, f.bundle.bytes, { expectedHash: f.bundle.sha256 });
    f.coordinator.close();
    await forge.cleanup();
    const db = new Database(f.targetPath);
    db.pragma('foreign_keys=OFF');
    db.transaction(() => {
        db.exec('DROP TRIGGER pf_import_pending_delete; DROP TRIGGER pf_import_purge_receipt;');
        const row = db.prepare('SELECT * FROM project_import_receipts').get();
        if (!complete) db.prepare('UPDATE projects SET deleted_at=?,deleted_by=? WHERE id=?')
            .run(row.pending_at, 'takeover:' + row.request_id, f.pid);
        db.exec('DROP TABLE project_import_receipts');
        db.exec(`CREATE TABLE project_import_receipts(
            request_id TEXT PRIMARY KEY,bundle_hash TEXT NOT NULL,target_json TEXT NOT NULL,
            destination_key TEXT NOT NULL UNIQUE,publication_json TEXT NOT NULL,
            project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE RESTRICT,
            state TEXT NOT NULL CHECK(state IN ('pending','complete')),result_json TEXT NOT NULL,
            metadata_hash TEXT NOT NULL,pending_at TEXT NOT NULL,source_deleted_by TEXT,completed_at TEXT)`);
        const columns = 'request_id bundle_hash target_json destination_key publication_json project_id state result_json metadata_hash pending_at source_deleted_by completed_at'.split(' ');
        db.prepare(`INSERT INTO project_import_receipts(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
            .run(...columns.map(key => row[key]));
        db.exec('ALTER TABLE projects DROP COLUMN availability');
        db.prepare('UPDATE project_import_receipts SET metadata_hash=?').run(independentMetadataHash(db, f.pid));
        db.prepare("UPDATE meta SET value='3' WHERE key='schema_version'").run();
        db.prepare("UPDATE meta SET value='1' WHERE key='project_import_receipts_version'").run();
    }).immediate();
    db.close();
}
function reopen(f) {
    const store = new ProjectStore(f.targetPath);
    f.opened.push(store);
    return store;
}

win('availability and soft deletion are independent; no includePending override', async t => {
    const f = await fixture(t);
    const row = f.target.db.prepare('SELECT * FROM projects WHERE id=?').get(f.pid);
    assert.equal(row.availability, 'pending');
    assert.equal(row.deleted_at, null);
    assert.equal(f.target.getProject(f.pid, { includeDeleted: true, includePending: true }), null);
    assert.ok(!f.target.listProjects({ includeDeleted: true, includePending: true }).some(p => p.id === f.pid));
    assert.deepEqual(f.target.searchNodes({ projectId: f.pid }), []);
    assert.throws(() => Bundle.exportProjectBundle(f.target, f.pid), code('NOT_FOUND'));
});
const storeActions = {
    listTodos: f => f.target.listTodos(f.pid),
    getTodo: f => f.target.getTodoBySeq(f.pid, 1),
    fileState: f => f.target.getFileState(f.pid, 'a.txt'),
    capture: f => f.target.getCapture(f.pid, f.importedCapture),
    captureByRequest: f => f.target.captureByRequest(f.pid, 'captured'),
    batch: f => f.target.getBatch(f.pid, f.node.batch_id),
    node: f => f.target.getNode(f.pid, f.node.id),
    batchNodes: f => f.target.getBatchNodes(f.pid, f.node.batch_id),
    nodesAfter: f => f.target.nodesAfter(f.pid, 0),
    fileHashAt: f => f.target.fileHashAt(f.pid, 'a.txt', f.node.id),
    lastBatch: f => f.target.lastBatch(f.pid),
    timeline: f => f.target.timeline(f.pid),
    stats: f => f.target.projectStats(f.pid),
    contributors: f => f.target.contributors(f.pid),
    changedFiles: f => f.target.changedFiles(f.pid),
    updateProject: f => f.target.updateProject(f.pid, { name: 'no', availability: 'ready' }),
    touch: f => f.target.touchProject(f.pid),
    addTodos: f => f.target.addTodos(f.pid, ['no']),
    updateTodo: f => f.target.updateTodo(f.pid, 1, { title: 'no' }),
    removeTodo: f => f.target.removeTodo(f.pid, 1),
    setFileState: f => f.target.setFileState(f.pid, 'a.txt', null),
    finishCapture: f => f.target.finishCapture(f.pid, f.importedCapture),
    createBatch: f => f.target.createBatch(f.pid, 'edit', 'no'),
    addNode: f => f.target.addNode({ projectId: f.pid, filePath: 'no', op: 'create' }),
    createCapture: f => f.target.createCapture({ projectId: f.pid, requestId: 'no', root: f.destination, files: [] }),
};
for (const [name, action] of Object.entries(storeActions)) win('Store blocks pending: ' + name, async t => {
    const f = await fixture(t);
    const before = snapshot(f.target.db);
    assert.throws(() => action(f), code('PROJECT_UNAVAILABLE'));
    assert.deepEqual(snapshot(f.target.db), before);
});
for (const operation of ['softDeleteProjects', 'restoreProjects', 'purgeProjects']) {
    for (const reversed of [false, true]) win('bulk atomic guard: ' + operation + ' pending-' + (reversed ? 'first' : 'last'), async t => {
        const f = await fixture(t);
        if (operation === 'restoreProjects' || operation === 'purgeProjects') f.target.softDeleteProjects([f.readyId]);
        const before = snapshot(f.target.db);
        const ids = reversed ? [f.pid, f.readyId] : [f.readyId, f.pid];
        assert.throws(() => f.target[operation](ids), code('PROJECT_UNAVAILABLE'));
        assert.deepEqual(snapshot(f.target.db), before);
    });
}
const toolCommands = ['GetProject', 'UpdateTodos', 'SubmitReport', 'ReadCode', 'Outline', 'FindSymbol', 'Trace',
    'EditCode', 'CreateFile', 'RemoveFile', 'MoveFile', 'MoveCode', 'CopyCode', 'Rollback', 'GetNodeDiff',
    'BeginCapture', 'GetCapture', 'FinishCapture', 'DeleteProjects', 'RestoreProjects', 'PurgeProjects'];
for (const command of toolCommands) win('tool blocks pending: ' + command, async t => {
    const f = await fixture(t);
    const before = snapshot(f.target.db);
    const args = { command, projectId: f.pid, projectIds: [f.pid], path: 'a.txt', paths: ['a.txt'],
        reason: 'must not run', content: 'no', target: 'old', replace: 'new', start: 1, end: 1,
        from: 'a.txt', to: 'other.txt', after: 0, batch: f.node.batch_id, node: f.node.id,
        name: 'x', captureId: f.importedCapture, requestId: 'ordinary', conclusion: 'no', done: '1', confirm: true };
    await assert.rejects(forge.processToolCall(args));
    assert.deepEqual(snapshot(f.target.db), before);
    assert.equal(fs.existsSync(f.destination), false);
});
win('ResolveEdit rechecks project availability for an existing ticket', async t => {
    const f = await fixture(t);
    const ticketId = forge._test.getRuntime().tickets.issue({
        projectId: f.pid, relPath: 'a.txt', fileHash: null,
        steps: [{ step: 1, op: 'target', target: 'a', replace: 'b' }],
        ambiguities: [{ step: 1, signature: '1,2' }], reason: 'must not run', mode: 'atomic',
    });
    await assert.rejects(forge.processToolCall({ command: 'ResolveEdit', ticketId, pick: 1 }), code('PROJECT_UNAVAILABLE'));
    assert.equal(fs.existsSync(f.destination), false);
});
win('tool lists/search and GUI lists/history never disclose pending', async t => {
    const f = await fixture(t);
    const list = await forge.processToolCall({ command: 'ListProjects', includeDeleted: true });
    assert.ok(!list.details.projects.some(p => p.id === f.pid));
    const searched = await forge.processToolCall({ command: 'SearchProjects', workspace: 'local', query: f.pid, includeDeleted: true });
    assert.equal(searched.details.projects?.length ?? searched.details.count, 0);
    await assert.rejects(forge.processToolCall({ command: 'SearchHistory', projectId: f.pid }), /不存在|pending|unavailable/i);
    const history = await forge.processToolCall({ command: 'SearchHistory' });
    assert.ok(!history.details.nodes.some(row => row.project_id === f.pid));
    assert.ok(!forge.gui.listProjects({ includeDeleted: true }).some(p => p.id === f.pid));
    assert.deepEqual(forge.gui.searchHistory({ projectId: f.pid, content: 'pending private' }), []);
});
win('every direct GUI project/batch/node/revert/delete route rejects pending', async t => {
    const f = await fixture(t);
    const before = snapshot(f.target.db);
    for (const read of [
        () => forge.gui.getProject(f.pid),
        () => forge.gui.getBatchNodes(f.pid, f.node.batch_id),
        () => forge.gui.getNodeDetail(f.pid, f.node.id),
        () => forge.gui.deleteProject(f.pid, 'Reviewer'),
    ]) assert.throws(read, code('PROJECT_UNAVAILABLE'));
    await assert.rejects(forge.gui.revertFileChange({
        projectId: f.pid, nodeId: f.node.id, signature: 'Reviewer', force: true,
    }), code('PROJECT_UNAVAILABLE'));
    assert.deepEqual(snapshot(f.target.db), before);
});
win('ordinary new projects, root reassignment and bundle imports cannot alias pending roots', async t => {
    const f = await fixture(t);
    const before = snapshot(f.target.db);
    for (const root of [f.destination, path.join(f.destination, 'child'), f.ws]) {
        assert.throws(() => f.target.createProject({ name: 'alias', root }), code('PROJECT_UNAVAILABLE'));
        assert.throws(() => f.target.updateProject(f.readyId, { root }), code('PROJECT_UNAVAILABLE'));
        assert.throws(() => Bundle.importProjectBundle(f.target, f.bundle.bytes,
            { root, workspaceAlias: 'alias' }), code('PROJECT_UNAVAILABLE'));
    }
    for (const dir of ['incoming', 'incoming/child', '']) {
        await assert.rejects(forge.processToolCall({ command: 'CreateProject', name: 'alias', dir }),
            code('PROJECT_UNAVAILABLE'));
    }
    assert.equal(fs.existsSync(f.destination), false, 'CreateProject must reject before mkdir');
    assert.deepEqual(snapshot(f.target.db), before);
});
win('new pending import refuses overlap with an existing ready parent or child project', async t => {
    const f = await fixture(t);
    for (const destination of [path.join(f.ws, 'existing', 'child'), f.ws]) {
        assert.throws(() => f.coordinator.start({ ...f.args, requestId: 'overlap',
            target: { ...f.args.target, root: destination } }));
    }
    assert.equal(f.target.db.prepare('SELECT COUNT(*) AS n FROM project_import_receipts').get().n, 1);
});
win('legacy overlapping parent cannot read or edit pending files through ordinary file tools', async t => {
    const f = await fixture(t);
    // Simulate a pre-existing legacy parent mapping (raw SQL is trusted, not a public bypass).
    f.target.db.prepare('UPDATE projects SET root=?,subpath=? WHERE id=?').run(f.ws, '', f.readyId);
    const before = snapshot(f.target.db);
    for (const command of ['ReadCode', 'CreateFile', 'RemoveFile', 'EditCode']) {
        await assert.rejects(forge.processToolCall({
            command, projectId: f.readyId, path: 'incoming/a.txt', reason: 'no', content: 'no',
            start: 1, end: 1,
        }), code('PROJECT_UNAVAILABLE'));
    }
    assert.deepEqual(snapshot(f.target.db), before);
    assert.equal(fs.existsSync(f.destination), false);
});
win('ready normal and soft-deleted projects retain existing behavior', async t => {
    const f = await fixture(t);
    assert.equal(f.target.getProject(f.readyId).availability, 'ready');
    assert.equal(f.target.listTodos(f.readyId).length, 1);
    f.target.softDeleteProjects([f.readyId], 'Reviewer');
    assert.equal(f.target.getProject(f.readyId), null);
    assert.ok(forge.gui.getProject(f.readyId).project.deleted_at);
    assert.deepEqual(f.target.restoreProjects([f.readyId]), [f.readyId]);
    assert.equal(f.target.getProject(f.readyId).deleted_at, null);
});
win('complete imports can be purged; tombstone stops every old request replay without filesystem mutation', async t => {
    const f = await fixture(t);
    const result = f.coordinator.resume(f.args.requestId, f.bundle.bytes, { expectedHash: f.bundle.sha256 });
    assert.equal(result.ready, true);
    f.target.softDeleteProjects([f.pid], 'Reviewer');
    const purge = f.target.purgeProjects([f.pid]);
    assert.deepEqual(purge.purged, [f.pid]);
    assert.equal(f.target.getProject(f.pid, { includeDeleted: true }), null);
    const receipt = Bundle.getProjectImportReceipt(f.target, f.args.requestId);
    assert.equal(receipt.state, 'purged');
    assert.equal(receipt.projectId, f.pid);
    assert.ok(receipt.purgedAt);
    const raw = f.target.db.prepare('SELECT * FROM project_import_receipts').get();
    assert.equal(raw.project_id, null);
    assert.equal(raw.original_project_id, f.pid);
    for (const action of [
        () => f.coordinator.start(f.args),
        () => f.coordinator.resume(f.args.requestId, f.bundle.bytes, { expectedHash: f.bundle.sha256 }),
        () => f.coordinator.takeover(f.args),
        () => Bundle.importProjectBundleOnce(f.target, f.bundle.bytes, f.args.target, {
            requestId: f.args.requestId, publication: receipt.publication, expectedHash: f.bundle.sha256 }),
        () => Bundle.completeProjectImport(f.target, f.bundle.bytes, {
            requestId: f.args.requestId, publication: receipt.publication, expectedHash: f.bundle.sha256 }),
    ]) assert.throws(action, code('IMPORT_PURGED'));
    assert.deepEqual(fs.readFileSync(path.join(f.destination, 'a.txt')), f.bytes);
    assert.equal(f.coordinator.getTask(f.args.requestId).state, 'purged');
    assert.equal(f.coordinator.getTask(f.args.requestId).ready, false);
    const again = reopen(f);
    assert.equal(Bundle.getProjectImportReceipt(again, f.args.requestId).state, 'purged');
});
win('purge SQL failure rolls back project removal AND receipt tombstone', async t => {
    const f = await fixture(t);
    f.coordinator.takeover(f.args);
    f.target.softDeleteProjects([f.pid]);
    f.target.db.exec(`CREATE TRIGGER reject_tombstone BEFORE UPDATE OF state ON project_import_receipts
        WHEN NEW.state='purged' BEGIN SELECT RAISE(ABORT,'injected-purge'); END`);
    const before = snapshot(f.target.db);
    assert.throws(() => f.target.purgeProjects([f.pid]), /injected-purge/);
    assert.deepEqual(snapshot(f.target.db), before);
    assert.equal(Bundle.getProjectImportReceipt(f.target, f.args.requestId).state, 'complete');
});
win('raw project deletion cannot remove pending and marks complete imports purged', async t => {
    const f = await fixture(t);
    assert.throws(() => f.target.db.prepare('DELETE FROM projects WHERE id=?').run(f.pid), /PROJECT_UNAVAILABLE/);
    f.coordinator.takeover(f.args);
    f.target.db.prepare('DELETE FROM projects WHERE id=?').run(f.pid);
    assert.equal(Bundle.getProjectImportReceipt(f.target, f.args.requestId).state, 'purged');
    assert.deepEqual(f.target.db.pragma('foreign_key_check'), []);
});
win('purged project IDs remain reserved even when random generator selects the old ID', async t => {
    const f = await fixture(t);
    f.coordinator.takeover(f.args);
    f.target.purgeProjects([f.pid]);
    const original = crypto.randomBytes;
    crypto.randomBytes = size => {
        assert.equal(size, 3);
        const buffer = Buffer.alloc(3);
        buffer.writeUIntBE(parseInt(f.pid.slice(1), 36), 0, 3);
        return buffer;
    };
    try { assert.throws(() => f.target.newProjectId(), /唯一/); }
    finally { crypto.randomBytes = original; }
});
win('v1 pending receipt migrates atomically without exposing it or changing metadata identity', async t => {
    const f = await fixture(t);
    const storeId = f.target.db.prepare("SELECT value FROM meta WHERE key='project_import_store_id'").get().value;
    await legacy(f);
    const store = reopen(f);
    assert.equal(store.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '4');
    assert.equal(store.db.prepare("SELECT value FROM meta WHERE key='project_import_receipts_version'").get().value, '2');
    assert.equal(store.db.prepare("SELECT value FROM meta WHERE key='project_import_store_id'").get().value, storeId);
    assert.equal(store.getProject(f.pid, { includeDeleted: true }), null);
    const project = store.db.prepare('SELECT * FROM projects WHERE id=?').get(f.pid);
    assert.equal(project.availability, 'pending');
    assert.equal(project.deleted_at, null);
    assert.equal(independentMetadataHash(store.db, f.pid), Bundle.getProjectImportReceipt(store, f.args.requestId) &&
        store.db.prepare('SELECT metadata_hash FROM project_import_receipts').get().metadata_hash);
    assert.throws(() => store.restoreProjects([f.pid]), code('PROJECT_UNAVAILABLE'));
    const coordinator = new ProjectTakeover(store, f.journal);
    try { assert.equal(coordinator.takeover(f.args).ready, true); }
    finally { coordinator.close(); }
});
win('v1 complete receipt migrates and remains replayable and purgeable', async t => {
    const f = await fixture(t);
    await legacy(f, { complete: true });
    const store = reopen(f);
    assert.equal(store.getProject(f.pid).availability, 'ready');
    const coordinator = new ProjectTakeover(store, f.journal);
    try { assert.equal(coordinator.takeover(f.args).projectId, f.pid); }
    finally { coordinator.close(); }
    store.softDeleteProjects([f.pid]);
    assert.deepEqual(store.purgeProjects([f.pid]).purged, [f.pid]);
    assert.equal(Bundle.getProjectImportReceipt(store, f.args.requestId).state, 'purged');
});
for (const corruption of ['restored', 'metadata', 'store-id', 'unknown-version']) {
    win('legacy migration rejects corruption with full schema rollback: ' + corruption, async t => {
        const f = await fixture(t);
        await legacy(f);
        const db = new Database(f.targetPath);
        if (corruption === 'restored') db.prepare('UPDATE projects SET deleted_at=NULL,deleted_by=NULL WHERE id=?').run(f.pid);
        if (corruption === 'metadata') db.prepare('UPDATE projects SET name=? WHERE id=?').run('tampered', f.pid);
        if (corruption === 'store-id') db.prepare("UPDATE meta SET value='bad' WHERE key='project_import_store_id'").run();
        if (corruption === 'unknown-version') db.prepare("UPDATE meta SET value='999' WHERE key='project_import_receipts_version'").run();
        const before = snapshot(db), schema = schemaSnapshot(db);
        db.close();
        assert.throws(() => new ProjectStore(f.targetPath), code(
            ['store-id', 'unknown-version'].includes(corruption) ? 'SCHEMA_VERSION' : 'IMPORT_DRIFT'));
        const after = new Database(f.targetPath);
        try {
            assert.deepEqual(snapshot(after), before);
            assert.deepEqual(schemaSnapshot(after), schema);
            assert.ok(!after.prepare('PRAGMA table_info(projects)').all().some(column => column.name === 'availability'));
        } finally { after.close(); }
    });
}
win('SQL failure after receipt table replacement rolls back the entire v3-to-v4 migration', async t => {
    const f = await fixture(t);
    await legacy(f);
    const db = new Database(f.targetPath);
    db.exec(`CREATE TRIGGER reject_version BEFORE UPDATE ON meta
        WHEN NEW.key='project_import_receipts_version' AND NEW.value='2'
        BEGIN SELECT RAISE(ABORT,'injected-migration'); END`);
    const before = snapshot(db), schema = schemaSnapshot(db);
    db.close();
    assert.throws(() => new ProjectStore(f.targetPath), /injected-migration/);
    const check = new Database(f.targetPath);
    try { assert.deepEqual(snapshot(check), before); assert.deepEqual(schemaSnapshot(check), schema); }
    finally { check.close(); }
    const fix = new Database(f.targetPath);
    fix.exec('DROP TRIGGER reject_version'); fix.close();
    assert.equal(reopen(f).getProject(f.pid, { includeDeleted: true }), null);
});
for (const point of ['ADD COLUMN availability', 'RENAME TO pf_legacy_import_receipts', 'DROP TABLE pf_legacy_import_receipts']) {
    win('real process exit rolls migration back at ' + point, async t => {
        const f = await fixture(t);
        await legacy(f);
        const db = new Database(f.targetPath);
        const before = snapshot(db), schema = schemaSnapshot(db);
        db.close();
        const script = `
            const Database=require(${JSON.stringify(require.resolve('better-sqlite3'))});
            const original=Database.prototype.exec;
            Database.prototype.exec=function(sql){const result=original.call(this,sql);
                if(sql.includes(${JSON.stringify(point)}))process.exit(73);return result;};
            const {ProjectStore}=require(${JSON.stringify(path.join(plugin, 'store'))});
            new ProjectStore(${JSON.stringify(f.targetPath)});process.exit(74);`;
        const child = spawnSync(process.execPath, ['-e', script], {
            encoding: 'utf8', timeout: 20000, windowsHide: true,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        });
        assert.equal(child.error, undefined, child.error?.message);
        assert.equal(child.status, 73, child.stdout + child.stderr);
        const recovered = new Database(f.targetPath);
        try { assert.deepEqual(snapshot(recovered), before); assert.deepEqual(schemaSnapshot(recovered), schema); }
        finally { recovered.close(); }
        assert.equal(reopen(f).getProject(f.pid, { includeDeleted: true }), null);
    });
}
win('new bundle stays portable schema 3 and never serializes local availability', async t => {
    const f = await fixture(t);
    const data = JSON.parse(f.bundle.bytes.toString('utf8'));
    assert.equal(data.schema, 3);
    assert.equal(Object.hasOwn(data.project, 'availability'), false);
    assert.ok(!f.source.db.prepare("SELECT 1 FROM sqlite_master WHERE name='project_import_receipts'").get());
});
win('four independent connections cannot restore/update/delete/purge a pending project', async t => {
    const f = await fixture(t);
    const before = snapshot(f.target.db);
    const workers = [];
    t.after(async () => { await Promise.all(workers.map(w => w.terminate())); });
    const results = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
        const worker = new Worker(`
            const {parentPort,workerData:d}=require('node:worker_threads');
            const {ProjectStore}=require(d.plugin+'/store');
            let store;
            try{
                store=new ProjectStore(d.db);
                const codes=[];
                for(let i=0;i<3;i++) for(const action of [
                    ()=>store.restoreProjects([d.pid]),()=>store.softDeleteProjects([d.pid]),
                    ()=>store.purgeProjects([d.pid]),()=>store.updateProject(d.pid,{name:'no'})
                ]){try{action();codes.push('BYPASS');}catch(e){codes.push(e.code);}}
                store.close();parentPort.postMessage({codes});parentPort.close();
            }catch(e){if(store)store.close();parentPort.postMessage({error:e.stack});parentPort.close();}
        `, { eval: true, workerData: { plugin, db: f.targetPath, pid: f.pid } });
        workers.push(worker);
        let value;
        const timer = setTimeout(() => reject(Error('Worker timeout')), 20000);
        worker.on('message', data => { value = data; });
        worker.once('error', reject);
        worker.once('exit', exit => {
            clearTimeout(timer);
            if (exit === 0 && value && !value.error) resolve(value.codes);
            else reject(Error(value?.error || 'Worker failed: ' + exit));
        });
    })));
    assert.equal(results.flat().length, 48);
    assert.ok(results.flat().every(value => value === 'PROJECT_UNAVAILABLE'), JSON.stringify(results));
    assert.deepEqual(snapshot(f.target.db), before);
    assert.equal(fs.existsSync(f.destination), false);
});
for (const command of ['FindSymbol', 'Trace']) {
    win('workspace scan refuses existing pending tree before invoking indexer: ' + command, async t => {
        const f = await fixture(t);
        let calls = 0;
        forge._test.getRuntime().indexer = {
            usable: true, stop: async () => {},
            findSymbols: async () => { calls++; return { hits: [], total: 0 }; },
            facts: async () => { calls++; return { scanned: 0, files: [] }; },
        };
        await assert.rejects(forge.processToolCall({
            command, projectId: f.readyId, scope: 'workspace', name: 'x', target: 'global:x',
        }), code('PROJECT_UNAVAILABLE'));
        assert.equal(calls, 0);
    });
}
for (const phase of ['primary', 'alternate']) {
    win('FindSymbol drops result when takeover begins during ' + phase + ' scan await', async t => {
        const f = await fixture(t);
        f.coordinator.takeover(f.args);
        let calls = 0;
        const next = { ...f.args, requestId: 'request-2',
            target: { ...f.args.target, root: path.join(f.ws, 'later'), subpath: 'later' } };
        forge._test.getRuntime().indexer = {
            usable: true, stop: async () => {},
            findSymbols: async () => {
                calls++;
                if (phase === 'primary' || calls === 2) f.coordinator.start(next);
                return { hits: [], total: 0, scanned: 0, parsed: 0, lines: 0 };
            },
        };
        await assert.rejects(forge.processToolCall({
            command: 'FindSymbol', projectId: f.readyId, scope: 'workspace', name: 'Box::method',
        }), code('PROJECT_UNAVAILABLE'));
        assert.equal(calls, phase === 'primary' ? 1 : 2);
        assert.equal(fs.existsSync(next.target.root), false);
    });
}
for (const phase of ['preload', 'primary-facts', 'alternate-facts']) {
    win('Trace drops result when takeover begins during ' + phase + ' await', async t => {
        const f = await fixture(t);
        f.coordinator.takeover(f.args);
        const LG = require(path.join(plugin, 'linkGraph'));
        const previous = LG.loadPreloadDecls;
        let calls = 0;
        const next = { ...f.args, requestId: 'request-2',
            target: { ...f.args.target, root: path.join(f.ws, 'later'), subpath: 'later' } };
        LG.loadPreloadDecls = async () => {
            if (phase === 'preload') f.coordinator.start(next);
            return { status: 'absent', apis: [], roleGlobals: null };
        };
        forge._test.getRuntime().indexer = {
            usable: true, stop: async () => {},
            facts: async () => {
                calls++;
                if (phase === 'primary-facts' || (phase === 'alternate-facts' && calls === 2)) {
                    f.coordinator.start(next);
                }
                return { scanned: 0, files: phase === 'alternate-facts' && calls === 1 ? [{
                    path: 'alias.js', bridgeAliases: [{ name: 'extraAPI', topLevel: true }],
                }] : [] };
            },
        };
        try {
            await assert.rejects(forge.processToolCall({
                command: 'Trace', projectId: f.readyId, scope: 'workspace', target: 'global:x',
            }), code('PROJECT_UNAVAILABLE'));
        } finally { LG.loadPreloadDecls = previous; }
        assert.equal(calls, phase === 'preload' ? 0 : phase === 'primary-facts' ? 1 : 2);
        assert.equal(fs.existsSync(next.target.root), false);
    });
}