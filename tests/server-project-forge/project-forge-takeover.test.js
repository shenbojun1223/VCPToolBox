'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const plugin = path.resolve(__dirname, '../../Plugin/ServerProjectForge');
const { ProjectStore, sha256 } = require(path.join(plugin, 'store'));
const { exportProjectBundle, getProjectImportReceipt } = require(path.join(plugin, 'projectBundle'));
const { ProjectTakeover } = require(path.join(plugin, 'projectTakeover'));
const winTest = (name, fn) => test(name, { skip: process.platform !== 'win32' }, fn);
const code = expected => error => error.code === expected;

function snapshot(store) {
    const tables = ['meta', 'projects', 'todos', 'batches', 'nodes', 'blobs',
        'captures', 'capture_files', 'file_state', 'project_import_receipts', 'sqlite_sequence'];
    return Object.fromEntries(tables.map(table => [
        table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ]));
}
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-takeover-'));
    const sourceRoot = path.join(root, 'source');
    const parent = path.join(root, 'targets');
    fs.mkdirSync(sourceRoot); fs.mkdirSync(parent);
    const source = new ProjectStore(path.join(root, 'source.db'));
    const targetPath = path.join(root, 'target.db');
    const target = new ProjectStore(targetPath);
    const project = source.createProject({
        name: '跨端工程', root: sourceRoot, workspaceAlias: 'source', createdBy: 'Kerr',
    });
    const bytes = Buffer.from('\uFEFF中文 bytes\r\n');
    const binary = Buffer.from([0, 3, 255]);
    source.addTodos(project.id, ['施工', '验收'], 'Kerr');
    const todo = source.listTodos(project.id)[0];
    for (const [file, buffer] of [['a.txt', bytes], ['nested/b.bin', binary]]) {
        const absolute = path.join(sourceRoot, file);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, buffer);
        const batch = source.createBatch(project.id, 'create', 'source history', 'Worker');
        source.addNode({ projectId: project.id, batchId: batch, filePath: file,
            beforeHash: null, afterHash: source.putBlob(buffer), op: 'create', todoId: todo.id });
    }
    const capture = source.createCapture({ projectId: project.id, root: sourceRoot,
        requestId: 'no-change', reason: 'capture-only',
        files: [{ path: 'empty.txt', buffer: Buffer.alloc(0) }] });
    fs.writeFileSync(path.join(sourceRoot, 'empty.txt'), '');
    source.finishCapture(project.id, capture.id);
    source.updateProject(project.id, { status: 'accepted', report: '来源验收，不代表目标运行验收', reportBy: 'Reviewer' });
    const noise = target.createProject({ name: '既有工程', root: path.join(root, 'old'), workspaceAlias: 'old' });
    target.addTodos(noise.id, ['不许碰']);
    const bundle = exportProjectBundle(source, project.id);
    const bundlePath = path.join(root, 'bundle.json');
    fs.writeFileSync(bundlePath, bundle.bytes);
    const journal = path.join(root, 'publication.db');
    const coordinators = [];
    const open = (options = {}, journalPath = journal) => {
        const coordinator = new ProjectTakeover(target, journalPath, options);
        coordinators.push(coordinator);
        return coordinator;
    };
    const coordinator = open();
    t.after(() => {
        for (const instance of coordinators) instance.close();
        target.close(); source.close();
        fs.rmSync(root, { recursive: true, force: true });
    });
    const destination = path.join(parent, 'new-tree');
    const local = { root: destination, workspaceId: 'target-ws', workspaceAlias: 'target', subpath: 'new-tree' };
    const args = { requestId: 'takeover-1', bundle: bundle.bytes, target: local, expectedHash: bundle.sha256 };
    const inspect = () => {
        assert.deepEqual(fs.readFileSync(path.join(destination, 'a.txt')), bytes);
        assert.deepEqual(fs.readFileSync(path.join(destination, 'nested/b.bin')), binary);
        assert.deepEqual(fs.readFileSync(path.join(destination, 'empty.txt')), Buffer.alloc(0));
    };
    const count = () => target.db.prepare('SELECT COUNT(*) AS n FROM projects WHERE id!=?').get(noise.id).n;
    return { root, source, target, targetPath, journal, parent, local, destination,
        coordinator, open, args, bundle, bundlePath, noise, inspect, count };
}

function crash(f, event) {
    const script = `
        const fs=require('node:fs');
        const {ProjectStore}=require(${JSON.stringify(path.join(plugin, 'store'))});
        const {ProjectTakeover}=require(${JSON.stringify(path.join(plugin, 'projectTakeover'))});
        const store=new ProjectStore(${JSON.stringify(f.targetPath)});
        const coordinator=new ProjectTakeover(store,${JSON.stringify(f.journal)},{
            _testHook:name=>{if(name===${JSON.stringify(event)})process.exit(73);}
        });
        coordinator.takeover({requestId:'takeover-1',target:${JSON.stringify(f.local)},
            bundle:fs.readFileSync(${JSON.stringify(f.bundlePath)}),
            expectedHash:${JSON.stringify(f.bundle.sha256)}});
        process.exit(74);
    `;
    const child = spawnSync(process.execPath, ['-e', script], {
        encoding: 'utf8', timeout: 20000, windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 73, child.stdout + '\n' + child.stderr);
}

winTest('pending metadata is hidden; complete takeover preserves source history and exposes one verified project', t => {
    const f = fixture(t);
    const before = f.target.getProject(f.noise.id);
    const start = f.coordinator.start(f.args);
    assert.equal(start.ready, false);
    assert.equal(f.target.getProject(start.projectId), null);
    assert.ok(!f.target.listProjects().some(row => row.id === start.projectId));
    assert.equal(fs.existsSync(f.destination), false);
    const receipt = getProjectImportReceipt(f.target, f.args.requestId);
    assert.equal(receipt.state, 'pending');
    assert.equal(receipt.projectId, start.projectId);
    assert.equal(f.count(), 1);
    const result = f.coordinator.resume(f.args.requestId, f.bundle.bytes, { expectedHash: f.bundle.sha256 });
    assert.equal(result.projectId, start.projectId);
    assert.equal(result.state, 'complete');
    assert.equal(result.ready, true);
    assert.equal(result.requiresMaterialization, false);
    const imported = f.target.getProject(start.projectId);
    assert.equal(imported.status, 'accepted');
    assert.equal(imported.report, '来源验收，不代表目标运行验收');
    assert.equal(f.target.listTodos(imported.id).length, 2);
    assert.equal(f.target.projectStats(imported.id).nodeCount, 2);
    assert.equal(f.target.captureByRequest(imported.id, 'no-change').status, 'finished');
    assert.deepEqual(f.target.getProject(f.noise.id), before);
    f.inspect();
});

winTest('lost acknowledgement replays same project and ID map without another import or publication', t => {
    const f = fixture(t);
    const one = f.coordinator.takeover(f.args);
    const repeated = f.open().takeover(f.args);
    assert.deepEqual(repeated, one);
    assert.equal(f.count(), 1);
    assert.equal(f.coordinator.materializer.db.prepare('SELECT COUNT(*) AS n FROM materialize_jobs').get().n, 1);
    assert.equal(f.coordinator.materializer.db.prepare('SELECT COUNT(*) AS n FROM materialize_attempts').get().n, 1);
});

winTest('recorded task query is not reported as a fresh filesystem verification', t => {
    const f = fixture(t);
    assert.equal(f.coordinator.getTask('unknown'), null);
    const completed = f.coordinator.takeover(f.args);
    const view = f.coordinator.getTask(f.args.requestId);
    assert.equal(view.projectId, completed.projectId);
    assert.equal(view.recordedComplete, true);
    assert.equal(view.ready, false);
    assert.equal(view.filesystemVerified, false);
});

for (const event of [
    'job-created', 'import-before-commit', 'metadata-committed',
    'materializer:stage-created', 'materializer:file-written', 'materializer:committed:ready',
    'materializer:renamed', 'files-published', 'complete-before-commit', 'complete-committed',
]) {
    winTest(`real process exit at ${event} recovers exactly one imported project`, t => {
        const f = fixture(t);
        crash(f, event);
        const receipt = getProjectImportReceipt(f.target, f.args.requestId);
        const priorId = receipt?.projectId;
        if (receipt && receipt.state === 'pending') assert.equal(f.target.getProject(priorId), null);
        const before = f.count();
        assert.ok(before <= 1);
        const result = f.open().takeover(f.args);
        if (priorId) assert.equal(result.projectId, priorId);
        assert.equal(result.ready, true);
        assert.equal(f.count(), 1);
        f.inspect();
        assert.equal(f.open().takeover(f.args).projectId, result.projectId);
        assert.equal(f.count(), 1);
    });
}

winTest('receipt insert SQL failure rolls back all metadata, IDs and snapshots; retry reuses planned publication', t => {
    const f = fixture(t);
    f.target.db.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON project_import_receipts
        BEGIN SELECT RAISE(ABORT,'receipt failure'); END;`);
    const before = snapshot(f.target);
    assert.throws(() => f.coordinator.start(f.args), /receipt failure/);
    assert.deepEqual(snapshot(f.target), before);
    assert.equal(f.count(), 0);
    assert.equal(fs.existsSync(f.destination), false);
    assert.equal(f.coordinator.materializer.db.prepare('SELECT COUNT(*) AS n FROM materialize_jobs').get().n, 1);
    f.target.db.exec('DROP TRIGGER reject_receipt');
    assert.equal(f.coordinator.takeover(f.args).ready, true);
    assert.equal(f.count(), 1);
});

winTest('completion SQL failure leaves project hidden and published tree intact until recovery', t => {
    const f = fixture(t);
    const start = f.coordinator.start(f.args);
    f.target.db.exec(`CREATE TRIGGER reject_complete BEFORE UPDATE ON project_import_receipts
        WHEN NEW.state='complete' BEGIN SELECT RAISE(ABORT,'completion failure'); END;`);
    assert.throws(() => f.coordinator.resume(f.args.requestId, f.bundle.bytes,
        { expectedHash: f.bundle.sha256 }), /completion failure/);
    f.inspect();
    assert.equal(f.target.getProject(start.projectId), null);
    assert.equal(getProjectImportReceipt(f.target, f.args.requestId).state, 'pending');
    f.target.db.exec('DROP TRIGGER reject_complete');
    assert.equal(f.open().takeover(f.args).projectId, start.projectId);
    assert.equal(f.count(), 1);
});

winTest('changed workspace mapping, digest or destination cannot reuse a request', t => {
    const f = fixture(t);
    f.coordinator.start(f.args);
    for (const target of [
        { ...f.local, workspaceAlias: 'different' },
        { ...f.local, workspaceId: 'another' },
        { ...f.local, subpath: 'other' },
        { ...f.local, root: path.join(f.parent, 'another') },
    ]) assert.throws(() => f.coordinator.start({ ...f.args, target }), code('REQUEST_CONFLICT'));
    const data = JSON.parse(f.bundle.bytes);
    data.project.name = 'different';
    const bytes = Buffer.from(JSON.stringify(data));
    assert.throws(() => f.coordinator.start({ ...f.args, bundle: bytes, expectedHash: sha256(bytes) }),
        code('REQUEST_CONFLICT'));
    assert.equal(f.count(), 1);
    assert.equal(fs.existsSync(f.destination), false);
});

winTest('receipt is bound to its publication journal, not merely a matching destination name', t => {
    const f = fixture(t);
    f.coordinator.start(f.args);
    const other = f.open({}, path.join(f.root, 'different-journal.db'));
    assert.throws(() => other.takeover(f.args), code('JOURNAL_MISMATCH'));
    assert.equal(f.count(), 1);
    assert.equal(fs.existsSync(f.destination), false);
    assert.equal(other.materializer.db.prepare('SELECT COUNT(*) AS n FROM materialize_jobs').get().n, 0);
});

winTest('new journal at original path cannot impersonate the recorded journal identity', t => {
    const f = fixture(t);
    f.coordinator.start(f.args);
    f.coordinator.close();
    fs.renameSync(f.journal, path.join(f.root, 'original-journal.db'));
    const replacement = f.open();
    assert.throws(() => replacement.takeover(f.args), code('JOURNAL_MISMATCH'));
    assert.equal(fs.existsSync(f.destination), false);
});

winTest('different requests cannot reserve the same target twice', t => {
    const f = fixture(t);
    f.coordinator.start(f.args);
    assert.throws(() => f.coordinator.start({ ...f.args, requestId: 'takeover-2' }), code('DESTINATION_BUSY'));
    assert.equal(f.count(), 1);
});

winTest('pending metadata drift and manual unquarantine stop recovery before filesystem writes', t => {
    const f = fixture(t);
    const started = f.coordinator.start(f.args);
    assert.throws(() => f.target.updateProject(started.projectId, { name: 'unauthorized metadata change' }),
        code('PROJECT_UNAVAILABLE'));
    // Raw SQL is a trusted internal/admin capability; simulate corruption to keep drift coverage.
    f.target.db.prepare('UPDATE projects SET name=? WHERE id=?').run('tampered', started.projectId);
    assert.throws(() => f.coordinator.takeover(f.args), code('IMPORT_DRIFT'));
    assert.equal(fs.existsSync(f.destination), false);
    assert.equal(f.count(), 1);
});

winTest('pending import cannot be silently restored through the ordinary soft-delete API', t => {
    const f = fixture(t);
    const started = f.coordinator.start(f.args);
    assert.throws(() => f.target.restoreProjects([started.projectId]), code('PROJECT_UNAVAILABLE'));
    assert.equal(f.target.getProject(started.projectId, { includeDeleted: true }), null);
    assert.equal(fs.existsSync(f.destination), false);
    assert.equal(f.coordinator.takeover(f.args).projectId, started.projectId);
});

winTest('receipt FK prevents purge from erasing identity and causing duplicate retry import', t => {
    const f = fixture(t);
    const started = f.coordinator.start(f.args);
    assert.throws(() => f.target.purgeProjects([started.projectId]), code('PROJECT_UNAVAILABLE'));
    assert.equal(getProjectImportReceipt(f.target, f.args.requestId).projectId, started.projectId);
    assert.equal(f.coordinator.takeover(f.args).projectId, started.projectId);
});

winTest('published drift before completion preserves quarantine instead of declaring readiness', t => {
    const f = fixture(t);
    const started = f.coordinator.start(f.args);
    const injecting = f.open({ _testHook(event) {
        if (event === 'files-published') fs.writeFileSync(path.join(f.destination, 'a.txt'), 'changed');
    } });
    assert.throws(() => injecting.resume(f.args.requestId, f.bundle.bytes,
        { expectedHash: f.bundle.sha256 }), code('TREE_DRIFT'));
    assert.equal(f.target.getProject(started.projectId), null);
    assert.equal(getProjectImportReceipt(f.target, f.args.requestId).state, 'pending');
    assert.equal(fs.readFileSync(path.join(f.destination, 'a.txt'), 'utf8'), 'changed');
});

winTest('completed retry checks current files, never overwrites later edits or duplicates project', t => {
    const f = fixture(t);
    const completed = f.coordinator.takeover(f.args);
    fs.writeFileSync(path.join(f.destination, 'a.txt'), 'later user edit');
    assert.throws(() => f.open().takeover(f.args), code('TREE_DRIFT'));
    assert.equal(f.count(), 1);
    assert.equal(f.target.getProject(completed.projectId).id, completed.projectId);
    assert.equal(fs.readFileSync(path.join(f.destination, 'a.txt'), 'utf8'), 'later user edit');
});

winTest('existing destination is never overwritten and no metadata receipt is created', t => {
    const f = fixture(t);
    fs.mkdirSync(f.destination);
    fs.writeFileSync(path.join(f.destination, 'sentinel'), 'original');
    assert.throws(() => f.coordinator.takeover(f.args), code('DESTINATION_EXISTS'));
    assert.equal(f.count(), 0);
    assert.equal(getProjectImportReceipt(f.target, f.args.requestId), null);
    assert.equal(fs.readFileSync(path.join(f.destination, 'sentinel'), 'utf8'), 'original');
});

winTest('missing receipts, caller transactions and missing trusted digest fail closed', t => {
    const f = fixture(t);
    assert.throws(() => f.coordinator.resume('unknown', f.bundle.bytes,
        { expectedHash: f.bundle.sha256 }), code('NOT_FOUND'));
    assert.throws(() => f.coordinator.start({ ...f.args, expectedHash: undefined }), code('INVALID_ARGUMENT'));
    f.target.db.transaction(() => {
        assert.throws(() => f.coordinator.start(f.args), code('INVALID_ARGUMENT'));
    })();
    assert.equal(f.count(), 0);
    assert.equal(fs.existsSync(f.destination), false);
});

winTest('four independent connections converge on one receipt, one project and one publication', async t => {
    const f = fixture(t);
    const workers = [];
    t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
    const script = `
        const fs=require('node:fs');
        const {parentPort,workerData:d}=require('node:worker_threads');
        const {ProjectStore}=require(d.plugin+'/store');
        const {ProjectTakeover}=require(d.plugin+'/projectTakeover');
        let store,coordinator;
        try {
            store=new ProjectStore(d.targetPath);
            coordinator=new ProjectTakeover(store,d.journal);
            parentPort.postMessage({ready:true});
            parentPort.once('message',()=>{
                let result;
                try {
                    const value=coordinator.takeover({requestId:'takeover-1',bundle:fs.readFileSync(d.bundlePath),
                        target:d.local,expectedHash:d.hash});
                    result={ok:true,projectId:value.projectId,jobId:value.materializeJobId,ready:value.ready};
                } catch(error){result={ok:false,code:error.code,message:error.message};}
                coordinator.close();store.close();parentPort.postMessage({result});parentPort.close();
            });
        } catch(error) {
            if(coordinator)coordinator.close();if(store)store.close();
            parentPort.postMessage({fatal:error.stack});parentPort.close();
        }
    `;
    const jobs = Array.from({ length: 4 }, () => {
        const worker = new Worker(script, { eval: true, workerData: {
            plugin, targetPath: f.targetPath, journal: f.journal,
            bundlePath: f.bundlePath, hash: f.bundle.sha256, local: f.local,
        } });
        workers.push(worker);
        let ready;
        const barrier = new Promise(resolve => { ready = resolve; });
        const done = new Promise((resolve, reject) => {
            let result;
            const timer = setTimeout(() => reject(new Error('Concurrent takeover timed out')), 20000);
            worker.on('message', value => {
                if (value.ready) ready();
                if (value.fatal) reject(new Error(value.fatal));
                if (value.result) result = value.result;
            });
            worker.once('error', reject);
            worker.once('exit', exit => {
                clearTimeout(timer);
                if (exit === 0 && result) resolve(result);
                else reject(new Error('Worker ended without result: ' + exit));
            });
        });
        done.catch(() => {});
        return { worker, barrier, done };
    });
    await Promise.all(jobs.map(job => Promise.race([
        job.barrier, job.done.then(() => { throw new Error('Worker not ready'); }),
    ])));
    for (const job of jobs) job.worker.postMessage('go');
    const results = await Promise.all(jobs.map(job => job.done));
    assert.ok(results.every(item => item.ok && item.ready), JSON.stringify(results));
    assert.equal(new Set(results.map(item => item.projectId)).size, 1);
    assert.equal(new Set(results.map(item => item.jobId)).size, 1);
    assert.equal(f.count(), 1);
    assert.equal(f.target.db.prepare('SELECT COUNT(*) AS n FROM project_import_receipts').get().n, 1);
    f.inspect();
});