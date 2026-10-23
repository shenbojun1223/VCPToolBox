'use strict';
// Two logical devices, separate SQLite stores and new worktrees. No HTTP, GUI or production data.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const plugin = path.resolve(__dirname, '../../Plugin/ServerProjectForge');
const { ProjectStore } = require(path.join(plugin, 'store'));
const { HubContentStore } = require(path.join(plugin, 'hubContentStore'));
const { HubStore } = require(path.join(plugin, 'hubStore'));
const { ProjectSync } = require(path.join(plugin, 'projectSync'));
const code = value => e => e.code === value;
function fixture(t, { publish = true, receiverHook = null, senderHook = null } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-sync-'));
    const sourceRoot = path.join(root, 'A-source'), workspace = path.join(root, 'B-workspace');
    fs.mkdirSync(sourceRoot); fs.mkdirSync(workspace);
    const A = new ProjectStore(path.join(root, 'A.db')), B = new ProjectStore(path.join(root, 'B.db'));
    const local = A.createProject({ name: 'synthetic-sync', root: sourceRoot, workspaceAlias: 'A' });
    A.addTodos(local.id, ['first', 'second']);
    const text = Buffer.from('\uFEFF中文\r\n'), binary = Buffer.from([0, 255, 1, 128]);
    const batch = A.createBatch(local.id, 'create', 'seed', 'Kerr');
    for (const [name, bytes] of [['a.txt', text], ['nested/b.bin', binary]]) {
        fs.mkdirSync(path.dirname(path.join(sourceRoot, name)), { recursive: true });
        fs.writeFileSync(path.join(sourceRoot, name), bytes);
        A.addNode({ projectId: local.id, batchId: batch, filePath: name, op: 'create',
            beforeHash: null, afterHash: A.putBlob(bytes) });
    }
    const content = new HubContentStore(path.join(root, 'content.db'));
    const hub = new HubStore(path.join(root, 'hub.db'), { contentStore: content });
    const opened = [];
    const open = (side, hook = null, opts = {}) => {
        const s = new ProjectSync(side === 'A' ? A : B, path.join(root, side + '-journal.db'),
            opts.mappingPath ?? path.join(root, side + '-mapping.db'),
            { hub, deviceId: side, _testHook: hook, ...opts });
        opened.push(s); return s;
    };
    const syncA = open('A', senderHook), syncB = open('B', receiverHook);
    const mapping = syncA.registerLocal(local.id), global = mapping.globalProjectId;
    const lease = hub.acquireLease({ projectId: global, holder: 'A', requestId: 'lease-A', ttlMs: 300000 });
    const publishArgs = { globalProjectId: global, lease, requestId: 'publish-A-1', expectedRevision: 0 };
    const revision = publish ? syncA.publishLocal(publishArgs) : null;
    const target = { root: path.join(workspace, 'incoming'), workspaceAlias: 'B', workspaceId: 'B-workspace', subpath: 'incoming' };
    const args = { globalProjectId: global, requestId: 'receive-B', revision: 1, target };
    t.after(() => {
        for (const s of opened) s.close(); hub.close(); content.close(); A.close(); B.close();
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { root, sourceRoot, workspace, A, B, local, text, binary, content, hub, opened, open,
        syncA, syncB, mapping, global, lease, publishArgs, revision, target, args };
}
function change(store, projectId, file, bytes) {
    const project = store.getProject(projectId);
    const before = store.db.prepare('SELECT hash FROM file_state WHERE project_id=? AND file_path=?').get(projectId, file).hash;
    fs.writeFileSync(path.join(project.root, file), bytes);
    const batch = store.createBatch(projectId, 'edit', 'change', 'Kerr');
    store.addNode({ projectId, batchId: batch, filePath: file, op: 'edit',
        beforeHash: before, afterHash: store.putBlob(bytes) });
}
function count(store) { return store.db.prepare('SELECT count(*) AS n FROM projects').get().n; }
test('A export/upload/publish -> B pinned download/takeover retains raw bytes and remaps metadata', t => {
    const f = fixture(t), result = f.syncB.receive(f.args);
    assert.equal(result.state, 'ready'); assert.equal(result.ready, true); assert.equal(result.filesystemVerified, true);
    assert.equal(result.globalProjectId, f.global); assert.notEqual(result.localProjectId, f.local.id);
    assert.deepEqual(fs.readFileSync(path.join(f.target.root, 'a.txt')), f.text);
    assert.deepEqual(fs.readFileSync(path.join(f.target.root, 'nested/b.bin')), f.binary);
    assert.equal(f.B.listTodos(result.localProjectId).length, 2);
    assert.equal(count(f.B), 1);
    const read = f.syncB.getMapping(f.global);
    assert.equal(read.recordedComplete, true); assert.equal(read.ready, false); assert.equal(read.filesystemVerified, false);
});
test('same request survives coordinator reopen without a second project or job', t => {
    const f = fixture(t), first = f.syncB.receive(f.args);
    f.syncB.close(); const again = f.open('B').receive(f.args);
    assert.equal(again.localProjectId, first.localProjectId); assert.equal(count(f.B), 1);
    assert.equal(f.open('B').takeover.materializer.db.prepare('SELECT count(*) AS n FROM materialize_jobs').get().n, 1);
});
test('replica registration reuses global identity, and B publishes its own checkpoint under a new lease', t => {
    const f = fixture(t), first = f.syncB.receive(f.args);
    assert.equal(f.syncB.registerLocal(first.localProjectId).globalProjectId, f.global);
    assert.equal(f.hub.db.prepare('SELECT count(*) AS n FROM hub_projects').get().n, 1);
    f.hub.releaseLease(f.lease);
    const lease = f.hub.acquireLease({ projectId: f.global, holder: 'B', requestId: 'lease-B', ttlMs: 300000 });
    const bytes = Buffer.from('B revision\r\n'); change(f.B, first.localProjectId, 'a.txt', bytes);
    const next = f.syncB.publishLocal({ globalProjectId: f.global, lease, requestId: 'publish-B-2', expectedRevision: 1 });
    assert.equal(next.revision, 2); assert.equal(f.hub.getProject(f.global).revision, 2);
    assert.equal(f.syncB.getMapping(f.global).revision, 2);
    assert.throws(() => f.syncB.receive({ ...f.args, requestId: 'upgrade', revision: 2 }), code('MAPPING_CONFLICT'));
});
test('a different request cannot duplicate an already mapped global project', t => {
    const f = fixture(t); f.syncB.receive(f.args);
    assert.throws(() => f.syncB.receive({ ...f.args, requestId: 'new', target: { ...f.target, root: path.join(f.workspace, 'second') } }), code('MAPPING_CONFLICT'));
    assert.equal(count(f.B), 1);
});
for (const field of ['target', 'revision', 'globalProjectId']) test('request payload cannot change: ' + field, t => {
    const f = fixture(t); f.syncB.start(f.args);
    let args = { ...f.args };
    if (field === 'target') args.target = { ...f.target, subpath: 'different' };
    if (field === 'revision') {
        f.syncA.publishLocal({ ...f.publishArgs, requestId: 'pub2', expectedRevision: 1 }); args.revision = 2;
    }
    if (field === 'globalProjectId') {
        const g = f.hub.registerProject({ originId: 'other', localProjectId: 'p-other', name: 'other' });
        const lease = f.hub.acquireLease({ projectId: g.id, holder: 'other', requestId: 'acq', ttlMs: 300000 });
        f.hub.publishRevision({ ...lease, requestId: 'pub', expectedRevision: 0, bundleHash: f.revision.bundleHash });
        args.globalProjectId = g.id;
    }
    assert.throws(() => f.syncB.start(args), code('REQUEST_CONFLICT'));
    assert.equal(count(f.B), 0);
});
test('omitted revision is pinned once, not advanced on retry to newer Hub head', t => {
    const f = fixture(t); const args = { ...f.args }; delete args.revision;
    f.syncB.start(args);
    change(f.A, f.local.id, 'a.txt', Buffer.from('later'));
    f.syncA.publishLocal({ ...f.publishArgs, requestId: 'later', expectedRevision: 1 });
    const received = f.syncB.receive(args); assert.equal(received.revision, 1);
    assert.deepEqual(fs.readFileSync(path.join(f.target.root, 'a.txt')), f.text);
});
test('unpublished head, missing request and invalid identifiers do not create metadata', t => {
    const f = fixture(t, { publish: false });
    assert.throws(() => f.syncB.start({ ...f.args, revision: undefined }), code('INVALID_ARGUMENT'));
    assert.throws(() => f.syncB.resume('unknown'), code('NOT_FOUND'));
    assert.throws(() => f.syncB.start({ ...f.args, requestId: '../bad' }), code('INVALID_ARGUMENT'));
    assert.equal(count(f.B), 0);
});
test('same receiver cannot bypass mapping uniqueness with a second mapping database', t => {
    const f = fixture(t);
    assert.throws(() => f.open('B', null, { mappingPath: path.join(f.root, 'alternate.db') }), code('MAPPING_BINDING'));
    assert.throws(() => f.open('B', null, { deviceId: 'pretend-B' }), code('MAPPING_BINDING'));
    assert.equal(count(f.B), 0);
});
test('different Hub or receiving store cannot reuse a mapping database', t => {
    const f = fixture(t), otherContent = new HubContentStore(path.join(f.root, 'other-content.db'));
    const otherHub = new HubStore(path.join(f.root, 'other-hub.db'), { contentStore: otherContent });
    const C = new ProjectStore(path.join(f.root, 'C.db'));
    try {
        assert.throws(() => new ProjectSync(f.B, path.join(f.root, 'B-journal.db'), path.join(f.root, 'B-mapping.db'),
            { hub: otherHub, deviceId: 'B' }), code('MAPPING_BINDING'));
        assert.throws(() => new ProjectSync(C, path.join(f.root, 'B-journal.db'), path.join(f.root, 'B-mapping.db'),
            { hub: f.hub, deviceId: 'B' }), code('MAPPING_BINDING'));
    } finally { C.close(); otherHub.close(); otherContent.close(); }
});
test('existing destination is not overwritten; pending metadata stays unavailable', t => {
    const f = fixture(t); fs.mkdirSync(f.target.root); fs.writeFileSync(path.join(f.target.root, 'sentinel'), 'keep');
    assert.throws(() => f.syncB.receive(f.args), code('DESTINATION_EXISTS'));
    assert.equal(fs.readFileSync(path.join(f.target.root, 'sentinel'), 'utf8'), 'keep');
    assert.equal(f.B.listProjects().length, 0);
});
test('damaged Hub content prevents receiver metadata and filesystem publication', t => {
    const f = fixture(t);
    f.content.db.prepare("UPDATE content_bundles SET source_project_id='damaged'").run();
    assert.throws(() => f.syncB.receive(f.args), code('CORRUPT_CONTENT'));
    assert.equal(count(f.B), 0); assert.equal(fs.existsSync(f.target.root), false);
    assert.equal(f.syncB.getMapping(f.global).state, 'pending');
});
test('ready record is not a filesystem attestation; drift blocks replay', t => {
    const f = fixture(t); f.syncB.receive(f.args);
    fs.writeFileSync(path.join(f.target.root, 'a.txt'), 'external drift');
    assert.equal(f.syncB.getMapping(f.global).filesystemVerified, false);
    assert.throws(() => f.syncB.resume(f.args.requestId));
    assert.equal(fs.readFileSync(path.join(f.target.root, 'a.txt'), 'utf8'), 'external drift');
    assert.equal(count(f.B), 1);
});
test('purged receiving project leaves mapping tombstone; replay never recreates it', t => {
    const f = fixture(t), received = f.syncB.receive(f.args);
    f.B.softDeleteProjects([received.localProjectId], 'Kerr');
    f.B.purgeProjects([received.localProjectId]);
    assert.throws(() => f.syncB.resume(f.args.requestId), code('IMPORT_PURGED'));
    assert.equal(f.syncB.getMapping(f.global).state, 'purged'); assert.equal(count(f.B), 0);
    assert.throws(() => f.syncB.receive(f.args), code('IMPORT_PURGED'));
    assert.equal(fs.existsSync(f.target.root), true);
});
test('injected interruption after metadata commit is recoverable without duplicate import', t => {
    let armed = true;
    const f = fixture(t, { receiverHook: event => {
        if (armed && event === 'takeover-started') { armed = false; throw Error('injected link failure'); }
    } });
    assert.throws(() => f.syncB.receive(f.args), /injected/);
    assert.equal(count(f.B), 1); assert.equal(f.B.listProjects().length, 0);
    const result = f.syncB.resume(f.args.requestId);
    assert.equal(result.ready, true); assert.equal(count(f.B), 1);
});
test('publication request pins old bytes across retry even after later local edits', t => {
    let armed = true;
    const f = fixture(t, { publish: false, senderHook: event => {
        if (armed && event === 'revision-published') { armed = false; throw Error('lost reply'); }
    } });
    assert.throws(() => f.syncA.publishLocal(f.publishArgs), /lost reply/);
    assert.equal(f.hub.getProject(f.global).revision, 1);
    change(f.A, f.local.id, 'a.txt', Buffer.from('unpublished later edits'));
    const replay = f.syncA.publishLocal(f.publishArgs); assert.equal(replay.revision, 1);
    f.syncB.receive(f.args); assert.deepEqual(fs.readFileSync(path.join(f.target.root, 'a.txt')), f.text);
    assert.equal(f.A.getProject(f.local.id).root, f.sourceRoot);
    assert.equal(fs.readFileSync(path.join(f.sourceRoot, 'a.txt'), 'utf8'), 'unpublished later edits');
});
test('stale publish cannot advance mapping and wrong device lease is rejected', t => {
    const f = fixture(t);
    assert.throws(() => f.syncA.publishLocal({ ...f.publishArgs, lease: { ...f.lease, holder: 'B' } }), code('INVALID_ARGUMENT'));
    f.hub.releaseLease(f.lease);
    f.hub.acquireLease({ projectId: f.global, holder: 'B', requestId: 'lease-B', ttlMs: 300000 });
    assert.throws(() => f.syncA.publishLocal(f.publishArgs), code('STALE_LEASE'));
    assert.equal(f.syncA.getMapping(f.global).revision, 1);
});
for (const event of ['mapping-planned', 'takeover:job-created', 'takeover:metadata-committed',
    'takeover:files-published', 'takeover:complete-committed', 'takeover-complete', 'mapping-ready']) {
    test('real receiver process.exit(73) recovers at ' + event, t => {
        const f = fixture(t);
        const script = `
            const {ProjectStore}=require(${JSON.stringify(path.join(plugin, 'store'))});
            const {HubContentStore}=require(${JSON.stringify(path.join(plugin, 'hubContentStore'))});
            const {HubStore}=require(${JSON.stringify(path.join(plugin, 'hubStore'))});
            const {ProjectSync}=require(${JSON.stringify(path.join(plugin, 'projectSync'))});
            const c=new HubContentStore(${JSON.stringify(path.join(f.root, 'content.db'))});
            const h=new HubStore(${JSON.stringify(path.join(f.root, 'hub.db'))},{contentStore:c});
            const b=new ProjectStore(${JSON.stringify(path.join(f.root, 'B.db'))});
            const s=new ProjectSync(b,${JSON.stringify(path.join(f.root, 'B-journal.db'))},${JSON.stringify(path.join(f.root, 'B-mapping.db'))},
                {hub:h,deviceId:'B',_testHook:e=>{if(e===${JSON.stringify(event)})process.exit(73)}});
            s.receive(${JSON.stringify(f.args)});
            s.close();b.close();h.close();c.close();
        `;
        const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000,
            windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
        assert.equal(child.status, 73, child.stderr);
        const result = f.open('B').receive(f.args);
        assert.equal(result.ready, true); assert.equal(count(f.B), 1);
        assert.deepEqual(fs.readFileSync(path.join(f.target.root, 'a.txt')), f.text);
        assert.equal(f.syncB.db.prepare('SELECT count(*) AS n FROM sync_mappings').get().n, 1);
    });
}
for (const event of ['publication-planned', 'revision-published']) {
    test('real sender process.exit(73) restores frozen publication at ' + event, t => {
        const f = fixture(t, { publish: false });
        const child = spawnSync(process.execPath, ['-e', `
            const {ProjectStore}=require(${JSON.stringify(path.join(plugin, 'store'))});
            const {HubContentStore}=require(${JSON.stringify(path.join(plugin, 'hubContentStore'))});
            const {HubStore}=require(${JSON.stringify(path.join(plugin, 'hubStore'))});
            const {ProjectSync}=require(${JSON.stringify(path.join(plugin, 'projectSync'))});
            const c=new HubContentStore(${JSON.stringify(path.join(f.root, 'content.db'))});
            const h=new HubStore(${JSON.stringify(path.join(f.root, 'hub.db'))},{contentStore:c});
            const a=new ProjectStore(${JSON.stringify(path.join(f.root, 'A.db'))});
            const s=new ProjectSync(a,${JSON.stringify(path.join(f.root, 'A-journal.db'))},${JSON.stringify(path.join(f.root, 'A-mapping.db'))},
                {hub:h,deviceId:'A',_testHook:e=>{if(e===${JSON.stringify(event)})process.exit(73)}});
            s.publishLocal(${JSON.stringify(f.publishArgs)});
        `], { encoding: 'utf8', timeout: 20000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
        assert.equal(child.status, 73, child.stderr);
        change(f.A, f.local.id, 'a.txt', Buffer.from('after-crash local work'));
        const result = f.open('A').publishLocal(f.publishArgs); assert.equal(result.revision, 1);
        f.syncB.receive(f.args); assert.deepEqual(fs.readFileSync(path.join(f.target.root, 'a.txt')), f.text);
    });
}
test('four independent receivers recover one mapping, one project, one journal task', async t => {
    const f = fixture(t);
    const workers = Array.from({ length: 4 }, () => new Worker(`
        const {parentPort,workerData:d}=require('node:worker_threads');
        const {ProjectStore}=require(d.plugin+'/store'),{HubContentStore}=require(d.plugin+'/hubContentStore');
        const {HubStore}=require(d.plugin+'/hubStore'),{ProjectSync}=require(d.plugin+'/projectSync');
        let c,h,b,s;try{
            c=new HubContentStore(d.root+'/content.db');h=new HubStore(d.root+'/hub.db',{contentStore:c});
            b=new ProjectStore(d.root+'/B.db');
            s=new ProjectSync(b,d.root+'/B-journal.db',d.root+'/B-mapping.db',{hub:h,deviceId:'B'});
            parentPort.postMessage({ok:true,result:s.receive(d.args)});
        }catch(e){parentPort.postMessage({ok:false,code:e.code,message:e.message})}
        finally{s?.close();b?.close();h?.close();c?.close()}
    `, { eval: true, workerData: { root: f.root, plugin, args: f.args } }));
    const values = await Promise.all(workers.map(w => new Promise((resolve, reject) => {
        let received = false, value;
        const timer = setTimeout(() => { reject(Error('Worker did not exit within 30s')); void w.terminate(); }, 30000);
        w.once('message', message => { received = true; value = message; });
        w.once('error', error => { clearTimeout(timer); reject(error); });
        w.once('exit', status => {
            clearTimeout(timer);
            if (status === 0 && received) resolve(value);
            else reject(Error('Worker exited without successful result: ' + status));
        });
    })));
    assert.ok(values.every(v => v.ok), JSON.stringify(values));
    assert.equal(new Set(values.map(v => v.result.localProjectId)).size, 1);
    assert.equal(count(f.B), 1);
    assert.equal(f.syncB.takeover.materializer.db.prepare('SELECT count(*) AS n FROM materialize_jobs').get().n, 1);
});
test('mapping insert SQL failure leaves no mapping, import, journal job or destination', t => {
    const f = fixture(t);
    f.syncB.db.exec("CREATE TRIGGER reject_plan BEFORE INSERT ON sync_mappings BEGIN SELECT RAISE(ABORT,'plan SQL failure'); END");
    assert.throws(() => f.syncB.start(f.args), /plan SQL failure/);
    assert.equal(f.syncB.getMapping(f.global), null);
    assert.equal(count(f.B), 0); assert.equal(fs.existsSync(f.target.root), false);
    f.syncB.db.exec('DROP TRIGGER reject_plan');
    assert.equal(f.syncB.receive(f.args).ready, true);
});
test('mapping link SQL failure after metadata commit recovers same receipt and local project', t => {
    const f = fixture(t);
    f.syncB.db.exec("CREATE TRIGGER reject_link BEFORE UPDATE ON sync_mappings WHEN NEW.local_project_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'link SQL failure'); END");
    assert.throws(() => f.syncB.receive(f.args), /link SQL failure/);
    assert.equal(count(f.B), 1); assert.equal(f.B.listProjects().length, 0);
    assert.equal(f.syncB.getMapping(f.global).localProjectId, null);
    f.syncB.db.exec('DROP TRIGGER reject_link');
    const r = f.syncB.resume(f.args.requestId);
    assert.equal(r.ready, true); assert.equal(count(f.B), 1);
});
test('mapping ready SQL failure cannot roll back completed import; recovery reconciles both logs', t => {
    const f = fixture(t);
    f.syncB.db.exec("CREATE TRIGGER reject_ready BEFORE UPDATE ON sync_mappings WHEN NEW.state='ready' BEGIN SELECT RAISE(ABORT,'ready SQL failure'); END");
    assert.throws(() => f.syncB.receive(f.args), /ready SQL failure/);
    assert.equal(f.syncB.getMapping(f.global).state, 'pending');
    assert.equal(f.B.listProjects().length, 1);
    f.syncB.db.exec('DROP TRIGGER reject_ready');
    assert.equal(f.syncB.resume(f.args.requestId).ready, true);
    assert.equal(count(f.B), 1);
});
test('publication mapping transaction failure replays frozen Hub revision and updates atomically', t => {
    const f = fixture(t, { publish: false });
    f.syncA.db.exec("CREATE TRIGGER reject_publication BEFORE UPDATE ON sync_publications BEGIN SELECT RAISE(ABORT,'publication SQL failure'); END");
    assert.throws(() => f.syncA.publishLocal(f.publishArgs), /publication SQL failure/);
    assert.equal(f.hub.getProject(f.global).revision, 1);
    assert.equal(f.syncA.getMapping(f.global).revision, 0);
    assert.equal(f.syncA.db.prepare('SELECT state FROM sync_publications').get().state, 'planned');
    change(f.A, f.local.id, 'a.txt', Buffer.from('not the frozen checkpoint'));
    f.syncA.db.exec('DROP TRIGGER reject_publication');
    assert.equal(f.syncA.publishLocal(f.publishArgs).revision, 1);
    assert.equal(f.syncA.getMapping(f.global).revision, 1);
    assert.equal(f.syncA.db.prepare('SELECT state FROM sync_publications').get().state, 'published');
    f.syncB.receive(f.args);
    assert.deepEqual(fs.readFileSync(path.join(f.target.root, 'a.txt')), f.text);
});
test('publication request cannot change base revision or lease generation', t => {
    const f = fixture(t);
    assert.throws(() => f.syncA.publishLocal({ ...f.publishArgs, expectedRevision: 1 }), code('REQUEST_CONFLICT'));
    f.hub.releaseLease(f.lease);
    const next = f.hub.acquireLease({ projectId: f.global, holder: 'A', requestId: 'another-A', ttlMs: 300000 });
    assert.throws(() => f.syncA.publishLocal({ ...f.publishArgs, lease: next }), code('REQUEST_CONFLICT'));
    assert.equal(f.hub.getProject(f.global).revision, 1);
});
test('mapping target reservations reject parent, child and case aliases across global projects', t => {
    const f = fixture(t); f.syncB.start(f.args);
    const g = f.hub.registerProject({ originId: 'other-origin', localProjectId: 'p-reserved', name: 'other' });
    const lease = f.hub.acquireLease({ projectId: g.id, holder: 'other', requestId: 'acq-reserved', ttlMs: 300000 });
    f.hub.publishRevision({ ...lease, requestId: 'pub-reserved', expectedRevision: 0, bundleHash: f.revision.bundleHash });
    const roots = [f.workspace, path.join(f.target.root, 'child'), f.target.root.toUpperCase()];
    for (const root of roots) assert.throws(() => f.syncB.start({
        ...f.args, globalProjectId: g.id, requestId: 'overlap', target: { ...f.target, root },
    }), code('MAPPING_CONFLICT'));
    assert.equal(count(f.B), 0);
});
test('origin registration survives lost mapping reply without a second Hub identity', t => {
    const f = fixture(t);
    const root = path.join(f.root, 'another-source'); fs.mkdirSync(root);
    const p = f.A.createProject({ name: 'another-origin', root, workspaceAlias: 'A' });
    let armed = true;
    const s = f.open('A', event => { if (armed && event === 'origin-registered') { armed = false; throw Error('lost registration reply'); } });
    assert.throws(() => s.registerLocal(p.id), /lost registration reply/);
    assert.equal(f.hub.db.prepare('SELECT count(*) AS n FROM hub_projects').get().n, 2);
    assert.ok(s.registerLocal(p.id).globalProjectId);
    assert.equal(f.hub.db.prepare('SELECT count(*) AS n FROM hub_projects').get().n, 2);
});
test('mapping constructor rejects digest-only Hub and reusing publication journal identity', t => {
    const f = fixture(t);
    const raw = new HubStore(path.join(f.root, 'digest-only.db'));
    try {
        assert.throws(() => new ProjectSync(f.B, path.join(f.root, 'B-journal.db'), path.join(f.root, 'B-mapping.db'),
            { hub: raw, deviceId: 'B' }), code('CONTENT_REQUIRED'));
        assert.throws(() => new ProjectSync(f.B, path.join(f.root, 'different-journal.db'), path.join(f.root, 'B-mapping.db'),
            { hub: f.hub, deviceId: 'B' }), code('MAPPING_BINDING'));
    } finally { raw.close(); }
});
test('mapping pin drift is detected before any subsequent mapping mutation', t => {
    const f = fixture(t);
    f.B.db.prepare('DELETE FROM meta WHERE key=?').run(f.syncB.bindingKey);
    assert.throws(() => f.syncB.receive(f.args), code('MAPPING_BINDING'));
    assert.equal(count(f.B), 0);
});
test('moved origin metadata is not published under its old mapping', t => {
    const f = fixture(t);
    f.A.updateProject(f.local.id, { workspaceAlias: 'renamed-workspace' });
    assert.throws(() => f.syncA.publishLocal({ ...f.publishArgs, requestId: 'moved', expectedRevision: 1 }), code('MAPPING_DRIFT'));
    assert.equal(f.hub.getProject(f.global).revision, 1);
});
test('lost publish reply is reconciled after lease rotation without publishing or regaining write rights', t => {
    let armed = true;
    const f = fixture(t, { publish: false, senderHook: event => {
        if (armed && event === 'revision-published') { armed = false; throw Error('lost reply before local commit'); }
    } });
    assert.throws(() => f.syncA.publishLocal(f.publishArgs), /lost reply/);
    assert.equal(f.syncA.getMapping(f.global).revision, 0);
    f.hub.releaseLease(f.lease);
    const next = f.hub.acquireLease({ projectId: f.global, holder: 'B', requestId: 'rotate', ttlMs: 300000 });
    assert.throws(() => f.syncA.publishLocal(f.publishArgs), code('STALE_LEASE'));
    const reconciled = f.open('A').reconcilePublication(f.publishArgs.requestId);
    assert.equal(reconciled.revision, 1); assert.equal(reconciled.recordedPublished, true);
    assert.equal(reconciled.filesystemVerified, false);
    assert.equal(f.syncA.getMapping(f.global).revision, 1);
    assert.equal(f.hub.getProject(f.global).revision, 1);
    assert.equal(f.hub.getProject(f.global).lease.holder, 'B');
    assert.equal(f.hub.getProject(f.global).fence, next.fence);
    assert.throws(() => f.syncA.publishLocal(f.publishArgs), code('STALE_LEASE'));
});
test('unpublished frozen request is not claimed by read-only reconciliation', t => {
    const f = fixture(t, { publish: false, senderHook: event => {
        if (event === 'publication-planned') throw Error('stop before Hub commit');
    } });
    assert.throws(() => f.syncA.publishLocal(f.publishArgs), /stop before Hub commit/);
    assert.throws(() => f.syncA.reconcilePublication(f.publishArgs.requestId), code('PUBLICATION_NOT_FOUND'));
    assert.throws(() => f.syncA.reconcilePublication('missing'), code('NOT_FOUND'));
    assert.equal(f.hub.getProject(f.global).revision, 0); assert.equal(f.syncA.getMapping(f.global).revision, 0);
});
test('same bytes accepted under another request are not misclaimed as this publication', t => {
    const f = fixture(t, { publish: false, senderHook: event => {
        if (event === 'publication-planned') throw Error('stop before Hub commit');
    } });
    assert.throws(() => f.syncA.publishLocal(f.publishArgs), /stop/);
    const attempt = f.syncA.db.prepare('SELECT * FROM sync_publications').get();
    f.hub.publishRevision({ ...f.lease, requestId: 'different-request', expectedRevision: 0, bundleHash: attempt.bundle_hash });
    assert.throws(() => f.syncA.reconcilePublication(f.publishArgs.requestId), code('PUBLICATION_CONFLICT'));
    assert.equal(f.syncA.getMapping(f.global).revision, 0);
});
test('historical reconciliation neither regresses later local checkpoints nor skips content validation', t => {
    const f = fixture(t);
    change(f.A, f.local.id, 'a.txt', Buffer.from('next checkpoint'));
    const next = f.syncA.publishLocal({ ...f.publishArgs, requestId: 'publish-A-2', expectedRevision: 1 });
    f.syncA.reconcilePublication(f.publishArgs.requestId);
    assert.equal(f.syncA.getMapping(f.global).revision, 2);
    assert.equal(f.syncA.getMapping(f.global).bundleHash, next.bundleHash);
    f.content.db.prepare("UPDATE content_bundles SET source_project_id='tampered' WHERE hash=?").run(f.revision.bundleHash);
    assert.throws(() => f.syncA.reconcilePublication(f.publishArgs.requestId), code('CORRUPT_CONTENT'));
});
test('stale local origin cannot fake the advanced Hub base to overwrite another device', t => {
    const f = fixture(t), b = f.syncB.receive(f.args);
    f.hub.releaseLease(f.lease);
    const leaseB = f.hub.acquireLease({ projectId: f.global, holder: 'B', requestId: 'B-write', ttlMs: 300000 });
    change(f.B, b.localProjectId, 'a.txt', Buffer.from('B newer checkpoint'));
    f.syncB.publishLocal({ globalProjectId: f.global, lease: leaseB, requestId: 'B-pub', expectedRevision: 1 });
    f.hub.releaseLease(leaseB);
    const leaseA = f.hub.acquireLease({ projectId: f.global, holder: 'A', requestId: 'A-again', ttlMs: 300000 });
    assert.throws(() => f.syncA.publishLocal({ ...f.publishArgs, lease: leaseA, requestId: 'blind-rebase', expectedRevision: 2 }),
        code('LOCAL_REVISION_CONFLICT'));
    assert.throws(() => f.syncA.publishLocal({ ...f.publishArgs, lease: leaseA, requestId: 'stale-base', expectedRevision: 1 }),
        code('REVISION_CONFLICT'));
    assert.equal(f.hub.getProject(f.global).revision, 2);
    assert.equal(f.syncA.getMapping(f.global).revision, 1);
});
test('original receiver request stays pinned after B publishes and refuses drift without overwriting work', t => {
    const f = fixture(t), b = f.syncB.receive(f.args);
    f.hub.releaseLease(f.lease);
    const lease = f.hub.acquireLease({ projectId: f.global, holder: 'B', requestId: 'B-republish', ttlMs: 300000 });
    const bytes = Buffer.from('B retained local work'); change(f.B, b.localProjectId, 'a.txt', bytes);
    f.syncB.publishLocal({ globalProjectId: f.global, lease, requestId: 'B-next', expectedRevision: 1 });
    const planned = f.syncB.start({ ...f.args, revision: undefined });
    assert.equal(planned.revision, 2); assert.equal(planned.importRevision, 1);
    assert.equal(planned.importBundleHash, f.revision.bundleHash);
    assert.throws(() => f.syncB.resume(f.args.requestId), code('IMPORT_DRIFT'));
    assert.deepEqual(fs.readFileSync(path.join(f.target.root, 'a.txt')), bytes);
    assert.equal(count(f.B), 1);
    assert.equal(f.syncB.registerLocal(b.localProjectId).globalProjectId, f.global);
});
test('complete receipt before mapping-ready cannot fork a new global identity through registerLocal', t => {
    let armed = true;
    const f = fixture(t, { receiverHook: event => {
        if (armed && event === 'takeover-complete') { armed = false; throw Error('stop before ready'); }
    } });
    assert.throws(() => f.syncB.receive(f.args), /stop before ready/);
    const p = f.B.listProjects()[0];
    assert.ok(p); assert.equal(f.syncB.getMapping(f.global).state, 'pending');
    assert.throws(() => f.syncB.registerLocal(p.id), code('MAPPING_DRIFT'));
    assert.equal(f.hub.db.prepare('SELECT count(*) AS n FROM hub_projects').get().n, 1);
    f.syncB.resume(f.args.requestId);
    assert.equal(f.syncB.registerLocal(p.id).globalProjectId, f.global);
});

test('caller mapping, receiving or Hub transactions cannot wrap sync or fake a committed revision', t => {
    const f = fixture(t);
    for (const db of [f.syncB.db, f.B.db, f.hub.db]) {
        db.transaction(() => {
            assert.throws(() => f.syncB.receive(f.args), code('INVALID_ARGUMENT'));
        }).immediate();
    }
    for (const db of [f.syncA.db, f.A.db, f.hub.db]) {
        db.transaction(() => {
            assert.throws(() => f.syncA.reconcilePublication(f.publishArgs.requestId), code('INVALID_ARGUMENT'));
        }).immediate();
    }
    f.hub.db.transaction(() => {
        assert.throws(() => f.hub.publishRevision({ ...f.lease, requestId: 'nested', expectedRevision: 1,
            bundleHash: f.revision.bundleHash }), code('INVALID_ARGUMENT'));
    }).immediate();
    assert.equal(count(f.B), 0); assert.equal(f.hub.getProject(f.global).revision, 1);
    assert.equal(f.syncB.receive(f.args).ready, true);
});