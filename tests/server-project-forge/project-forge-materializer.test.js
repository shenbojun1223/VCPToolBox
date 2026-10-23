'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { ProjectStore, sha256 } = require('../../Plugin/ServerProjectForge/store');
const { exportProjectBundle, validateProjectBundle } = require('../../Plugin/ServerProjectForge/projectBundle');
const modulePath = path.resolve(__dirname, '../../Plugin/ServerProjectForge/worktreeMaterializer.js');
const { WorktreeMaterializer } = require(modulePath);
const hasCode = code => error => error.code === code;
const winTest = (name, fn) => test(name, { skip: process.platform !== 'win32' }, fn);

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-materialize-'));
    const sourceRoot = path.join(root, 'source');
    const parent = path.join(root, 'targets');
    fs.mkdirSync(sourceRoot); fs.mkdirSync(parent);
    const source = new ProjectStore(path.join(root, 'forge.db'));
    const project = source.createProject({ name: 'materialize', root: sourceRoot, workspaceAlias: 'source' });
    const content = new Map([
        ['a.txt', Buffer.from('\uFEFF中文\r\n')],
        ['中文目录/binary.bin', Buffer.from([0, 3, 255, 7])],
        ['empty.txt', Buffer.alloc(0)],
    ]);
    for (const [file, bytes] of content) {
        const absolute = path.join(sourceRoot, file);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, bytes);
        source.addNode({ projectId: project.id, filePath: file, op: 'create',
            beforeHash: null, afterHash: source.putBlob(bytes) });
    }
    source.setFileState(project.id, 'deleted.txt', null);
    const bundle = exportProjectBundle(source, project.id);
    const bundlePath = path.join(root, 'bundle.json');
    fs.writeFileSync(bundlePath, bundle.bytes);
    const journalPath = path.join(root, 'materialize.db');
    const stores = [];
    const open = options => {
        const store = new WorktreeMaterializer(journalPath, options);
        stores.push(store);
        return store;
    };
    t.after(() => {
        for (const store of stores) store.close();
        source.close();
        fs.rmSync(root, { recursive: true, force: true });
    });
    const store = open();
    const destination = path.join(parent, 'new-tree');
    const create = (extra = {}) => store.createJob({
        requestId: 'request-1', destination, bundle: bundle.bytes, expectedHash: bundle.sha256, ...extra,
    });
    const options = { expectedHash: bundle.sha256 };
    const inspect = (directory = destination) => {
        for (const [file, bytes] of content) assert.deepEqual(fs.readFileSync(path.join(directory, file)), bytes);
        assert.equal(fs.existsSync(path.join(directory, 'deleted.txt')), false);
        assert.deepEqual(fs.readdirSync(directory).sort(), ['a.txt', 'empty.txt', '中文目录'].sort());
    };
    const ready = id => {
        store.advance(id, bundle.bytes, options);
        return store.advance(id, bundle.bytes, options);
    };
    return { root, parent, source, project, sourceRoot, content, bundle, bundlePath,
        journalPath, store, open, destination, create, options, inspect, ready };
}

function crash(f, jobId, event) {
    const script = `
        const fs = require('node:fs');
        const { WorktreeMaterializer } = require(${JSON.stringify(modulePath)});
        const store = new WorktreeMaterializer(${JSON.stringify(f.journalPath)}, {
            _testHook: name => { if (name === ${JSON.stringify(event)}) process.exit(73); },
        });
        store.resume(${JSON.stringify(jobId)}, fs.readFileSync(${JSON.stringify(f.bundlePath)}),
            { expectedHash: ${JSON.stringify(f.bundle.sha256)} });
        store.close();
        process.exit(74);
    `;
    const child = spawnSync(process.execPath, ['-e', script], {
        encoding: 'utf8', timeout: 20000, windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 73, child.stdout + '\n' + child.stderr);
}

winTest('actual runtime refuses renaming over an empty directory and preserves identity on publication', t => {
    const f = fixture(t);
    const stage = path.join(f.parent, 'probe-stage');
    const target = path.join(f.parent, 'probe-target');
    fs.mkdirSync(stage); fs.mkdirSync(target);
    fs.writeFileSync(path.join(stage, 'sentinel'), 'source');
    assert.throws(() => fs.renameSync(stage, target),
        error => ['EPERM', 'EEXIST', 'EACCES', 'ENOTEMPTY'].includes(error.code));
    assert.deepEqual(fs.readdirSync(target), []);
    fs.rmdirSync(target);
    const before = fs.statSync(stage, { bigint: true });
    fs.renameSync(stage, target);
    const after = fs.statSync(target, { bigint: true });
    assert.notEqual(after.ino, 0n);
    assert.equal(after.ino, before.ino);
    assert.equal(after.dev, before.dev);
    assert.equal(fs.readFileSync(path.join(target, 'sentinel'), 'utf8'), 'source');
});

winTest('publishes exact bytes; reopening replays original job and imports no Forge metadata', t => {
    const f = fixture(t);
    const before = f.source.db.prepare('SELECT * FROM projects').all();
    const job = f.create();
    assert.equal(job.state, 'planned');
    assert.equal(fs.existsSync(f.destination), false);
    const ready = f.ready(job.id);
    assert.equal(ready.state, 'ready');
    assert.equal(fs.existsSync(f.destination), false);
    const published = f.store.advance(job.id, f.bundle.bytes, f.options);
    assert.equal(published.state, 'published');
    assert.equal(published.metadataImported, false);
    f.inspect();
    assert.deepEqual(f.source.db.prepare('SELECT * FROM projects').all(), before);
    f.store.close();
    const reopened = f.open();
    assert.equal(reopened.resume(job.id, f.bundle.bytes, f.options).state, 'published');
    assert.equal(reopened.getJob(job.id).attempt, 1);
    assert.equal(reopened.createJob({
        requestId: 'request-1', destination: f.destination, bundle: f.bundle.bytes,
        expectedHash: f.bundle.sha256,
    }).id, job.id);
});

winTest('request replay is stable; changed payload and destination aliases are rejected', t => {
    const f = fixture(t);
    assert.equal(f.create().id, f.create().id);
    assert.throws(() => f.create({ destination: path.join(f.parent, 'other') }), hasCode('REQUEST_CONFLICT'));
    assert.throws(() => f.create({ requestId: 'request-2' }), hasCode('DESTINATION_BUSY'));
    assert.throws(() => f.create({ requestId: 'request-2', destination: f.destination.toUpperCase() }),
        hasCode('DESTINATION_BUSY'));
});

winTest('requires trusted digest and binds every recovery step to the original bundle', t => {
    const f = fixture(t);
    assert.throws(() => f.create({ expectedHash: undefined }), hasCode('INVALID_ARGUMENT'));
    assert.throws(() => f.create({ expectedHash: '0'.repeat(64) }), hasCode('HASH_MISMATCH'));
    const job = f.create();
    const data = JSON.parse(f.bundle.bytes);
    data.project.name = 'changed';
    const bytes = Buffer.from(JSON.stringify(data));
    assert.throws(() => f.store.resume(job.id, bytes, { expectedHash: sha256(bytes) }), hasCode('REQUEST_CONFLICT'));
    assert.equal(f.store.getJob(job.id).state, 'planned');
});

winTest('preexisting empty and nonempty destinations remain untouched', t => {
    const f = fixture(t);
    fs.mkdirSync(f.destination);
    assert.throws(f.create, hasCode('DESTINATION_EXISTS'));
    assert.deepEqual(fs.readdirSync(f.destination), []);
    fs.writeFileSync(path.join(f.destination, 'sentinel'), 'outside');
    assert.throws(f.create, hasCode('DESTINATION_EXISTS'));
    assert.equal(fs.readFileSync(path.join(f.destination, 'sentinel'), 'utf8'), 'outside');
});

winTest('destination appearing after READY blocks publication and preserves both trees', t => {
    const f = fixture(t);
    const job = f.create(), ready = f.ready(job.id);
    fs.mkdirSync(f.destination);
    fs.writeFileSync(path.join(f.destination, 'sentinel'), 'outside');
    assert.throws(() => f.store.resume(job.id, f.bundle.bytes, f.options), hasCode('DESTINATION_EXISTS'));
    f.inspect(ready.stage);
    assert.equal(fs.readFileSync(path.join(f.destination, 'sentinel'), 'utf8'), 'outside');
    assert.equal(f.store.getJob(job.id).state, 'ready');
});

winTest('Windows rename rejects a last-moment competing empty destination', t => {
    const f = fixture(t);
    const job = f.create(), ready = f.ready(job.id);
    const racing = f.open({ _testHook(event) { if (event === 'before-publish') fs.mkdirSync(f.destination); } });
    assert.throws(() => racing.advance(job.id, f.bundle.bytes, f.options),
        error => ['EPERM', 'EEXIST', 'EACCES', 'ENOTEMPTY'].includes(error.code));
    assert.deepEqual(fs.readdirSync(f.destination), []);
    f.inspect(ready.stage);
    assert.equal(f.store.getJob(job.id).state, 'ready');
});

for (const [event, state] of [
    ['committed:staging', 'staging'], ['stage-created', 'staging'],
    ['file-written', 'staging'], ['stage-verified', 'staging'],
    ['committed:ready', 'ready'], ['before-publish', 'ready'],
    ['renamed', 'ready'], ['committed:published', 'published'],
]) {
    winTest(`real child process exit at ${event} resumes without overwriting`, t => {
        const f = fixture(t), job = f.create();
        crash(f, job.id, event);
        const before = f.store.getJob(job.id);
        assert.equal(before.state, state);
        const retained = state === 'staging' && fs.existsSync(before.stage);
        const result = f.open().resume(job.id, f.bundle.bytes, f.options);
        assert.equal(result.state, 'published');
        assert.equal(result.attempt, retained ? 2 : 1);
        if (retained) {
            assert.ok(result.retainedStages.includes(before.stage));
            assert.equal(fs.existsSync(before.stage), true);
        }
        f.inspect();
    });
}

winTest('unknown partial stage is retained rather than repaired or deleted', t => {
    const f = fixture(t), job = f.create();
    const staging = f.store.advance(job.id, f.bundle.bytes, f.options);
    fs.mkdirSync(staging.stage);
    fs.writeFileSync(path.join(staging.stage, 'a.txt'), 'partial');
    fs.writeFileSync(path.join(staging.stage, 'unknown'), 'preserve');
    const result = f.store.resume(job.id, f.bundle.bytes, f.options);
    assert.equal(result.attempt, 2);
    assert.equal(fs.readFileSync(path.join(staging.stage, 'a.txt'), 'utf8'), 'partial');
    assert.equal(fs.readFileSync(path.join(staging.stage, 'unknown'), 'utf8'), 'preserve');
    f.inspect();
});

winTest('READY SQL failure rolls back journal and retains stage for inspection', t => {
    const f = fixture(t), job = f.create();
    const staging = f.store.advance(job.id, f.bundle.bytes, f.options);
    f.store.db.exec(`CREATE TRIGGER reject_ready BEFORE UPDATE ON materialize_jobs
        WHEN NEW.state='ready' BEGIN SELECT RAISE(ABORT,'ready failure'); END;`);
    assert.throws(() => f.store.advance(job.id, f.bundle.bytes, f.options), /ready failure/);
    assert.equal(f.store.getJob(job.id).state, 'staging');
    f.inspect(staging.stage);
    f.store.db.exec('DROP TRIGGER reject_ready');
    assert.equal(f.store.resume(job.id, f.bundle.bytes, f.options).attempt, 2);
    assert.equal(fs.existsSync(staging.stage), true);
});

winTest('PUBLISHED SQL failure recovers the already-renamed directory without recreating it', t => {
    const f = fixture(t), job = f.create(), ready = f.ready(job.id);
    f.store.db.exec(`CREATE TRIGGER reject_publish BEFORE UPDATE ON materialize_jobs
        WHEN NEW.state='published' BEGIN SELECT RAISE(ABORT,'publish failure'); END;`);
    assert.throws(() => f.store.advance(job.id, f.bundle.bytes, f.options), /publish failure/);
    assert.equal(f.store.getJob(job.id).state, 'ready');
    assert.equal(fs.existsSync(ready.stage), false);
    const inode = fs.statSync(f.destination, { bigint: true }).ino;
    f.store.db.exec('DROP TRIGGER reject_publish');
    assert.equal(f.open().resume(job.id, f.bundle.bytes, f.options).state, 'published');
    assert.equal(fs.statSync(f.destination, { bigint: true }).ino, inode);
    f.inspect();
});

winTest('identical bytes in a different inode cannot impersonate a published stage', t => {
    const f = fixture(t), job = f.create();
    crash(f, job.id, 'renamed');
    const original = path.join(f.parent, 'original-published');
    fs.renameSync(f.destination, original);
    fs.cpSync(original, f.destination, { recursive: true });
    f.inspect();
    assert.throws(() => f.store.resume(job.id, f.bundle.bytes, f.options), hasCode('IDENTITY_MISMATCH'));
    f.inspect(original);
});

winTest('unexpected READY entries stop publication without automatic cleanup', t => {
    const f = fixture(t), job = f.create(), ready = f.ready(job.id);
    fs.writeFileSync(path.join(ready.stage, 'surprise'), 'unknown');
    assert.throws(() => f.store.advance(job.id, f.bundle.bytes, f.options), hasCode('TREE_DRIFT'));
    assert.equal(fs.existsSync(f.destination), false);
    assert.equal(fs.readFileSync(path.join(ready.stage, 'surprise'), 'utf8'), 'unknown');
});

winTest('published byte drift is reported and never overwritten', t => {
    const f = fixture(t), job = f.create();
    f.store.resume(job.id, f.bundle.bytes, f.options);
    const changed = Buffer.alloc(f.content.get('a.txt').length, 42);
    fs.writeFileSync(path.join(f.destination, 'a.txt'), changed);
    assert.throws(() => f.store.resume(job.id, f.bundle.bytes, f.options), hasCode('TREE_DRIFT'));
    assert.deepEqual(fs.readFileSync(path.join(f.destination, 'a.txt')), changed);
});

winTest('hardlinked READY files are refused', t => {
    const f = fixture(t), job = f.create(), ready = f.ready(job.id);
    fs.linkSync(path.join(ready.stage, 'a.txt'), path.join(f.root, 'outside-link'));
    assert.throws(() => f.store.advance(job.id, f.bundle.bytes, f.options), hasCode('TREE_DRIFT'));
});

winTest('replacing the destination parent prevents recovery under a different directory identity', t => {
    const f = fixture(t), job = f.create();
    fs.renameSync(f.parent, path.join(f.root, 'original-parent'));
    fs.mkdirSync(f.parent);
    assert.throws(() => f.store.resume(job.id, f.bundle.bytes, f.options), hasCode('IDENTITY_MISMATCH'));
    assert.deepEqual(fs.readdirSync(f.parent), []);
});

winTest('junction stage is neither followed nor removed', t => {
    const f = fixture(t), job = f.create();
    const staging = f.store.advance(job.id, f.bundle.bytes, f.options);
    const foreign = path.join(f.root, 'foreign');
    fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'sentinel'), 'safe');
    fs.symlinkSync(foreign, staging.stage, 'junction');
    assert.throws(() => f.store.resume(job.id, f.bundle.bytes, f.options), hasCode('UNSAFE_PATH'));
    assert.equal(fs.readFileSync(path.join(foreign, 'sentinel'), 'utf8'), 'safe');
});

winTest('caps retained attempts instead of infinitely allocating new stages', t => {
    const f = fixture(t), job = f.create();
    f.store.advance(job.id, f.bundle.bytes, f.options);
    for (let i = 1; i <= 16; i++) {
        fs.mkdirSync(f.store.getJob(job.id).stage);
        if (i < 16) f.store.advance(job.id, f.bundle.bytes, f.options);
    }
    assert.throws(() => f.store.resume(job.id, f.bundle.bytes, f.options), hasCode('ATTEMPT_LIMIT'));
    assert.equal(f.store.getJob(job.id).attempt, 16);
    assert.equal(fs.existsSync(f.destination), false);
});

winTest('rejects tombstone/live-directory contradiction before allocating a job', t => {
    const f = fixture(t);
    const data = JSON.parse(f.bundle.bytes);
    data.files.push({ file_path: '中文目录', hash: null });
    const bytes = Buffer.from(JSON.stringify(data));
    validateProjectBundle(bytes);
    assert.throws(() => f.create({ bundle: bytes, expectedHash: sha256(bytes) }), hasCode('INCONSISTENT_TREE'));
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM materialize_jobs').get().n, 0);
});

winTest('empty recorded project publishes an empty new directory', t => {
    const f = fixture(t);
    const empty = f.source.createProject({ name: 'empty', root: f.sourceRoot });
    const bundle = exportProjectBundle(f.source, empty.id);
    const job = f.create({ bundle: bundle.bytes, expectedHash: bundle.sha256 });
    f.store.resume(job.id, bundle.bytes, { expectedHash: bundle.sha256 });
    assert.deepEqual(fs.readdirSync(f.destination), []);
});

winTest('requires dedicated journal and rejects unsafe target names or missing parent', t => {
    const f = fixture(t);
    assert.throws(() => new WorktreeMaterializer(f.source.dbPath), hasCode('WRONG_DATABASE'));
    for (const destination of ['relative', path.parse(f.root).root, path.join(f.parent, 'NUL'),
        path.join(f.parent, 'bad.'), path.join(f.parent, '.pf-stage-untrusted')]) {
        assert.throws(() => f.create({ destination }));
    }
    assert.throws(() => f.create({ destination: path.join(f.root, 'missing', 'child') }));
    f.store.close();
    assert.throws(() => f.store.getJob('valid'), hasCode('CLOSED'));
});

winTest('caller transaction is rejected before filesystem or journal mutations', t => {
    const f = fixture(t), job = f.create();
    f.store.db.transaction(() => {
        assert.throws(() => f.store.advance(job.id, f.bundle.bytes, f.options), hasCode('INVALID_ARGUMENT'));
    })();
    assert.equal(f.store.getJob(job.id).state, 'planned');
    assert.deepEqual(fs.readdirSync(f.parent), []);
});

winTest('missing stage and destination stop recovery for inspection', t => {
    const f = fixture(t), job = f.create(), ready = f.ready(job.id);
    fs.renameSync(ready.stage, path.join(f.parent, 'moved-stage'));
    assert.throws(() => f.store.resume(job.id, f.bundle.bytes, f.options), hasCode('MISSING_STAGE'));
});

winTest('four independent SQLite connections resume one job without duplicate publication', async t => {
    const f = fixture(t), job = f.create();
    const workers = [];
    t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
    const script = `
        const fs = require('node:fs');
        const { parentPort,workerData:d } = require('node:worker_threads');
        const { WorktreeMaterializer } = require(d.modulePath);
        let store;
        try {
            store = new WorktreeMaterializer(d.journalPath,{busyTimeoutMs:10000});
            parentPort.postMessage({ready:true});
            parentPort.once('message',()=>{
                let result;
                try {
                    const value = store.resume(d.jobId,fs.readFileSync(d.bundlePath),{expectedHash:d.hash});
                    result = {ok:true,id:value.id,state:value.state,attempt:value.attempt};
                } catch(error) { result = {ok:false,code:error.code,message:error.message}; }
                store.close();
                parentPort.postMessage({result});
                parentPort.close();
            });
        } catch(error) {
            if(store)store.close();
            parentPort.postMessage({fatal:error.stack}); parentPort.close();
        }
    `;
    const jobs = Array.from({ length: 4 }, () => {
        const worker = new Worker(script, { eval: true, workerData: {
            modulePath, journalPath: f.journalPath, jobId: job.id,
            bundlePath: f.bundlePath, hash: f.bundle.sha256,
        } });
        workers.push(worker);
        let markReady;
        const ready = new Promise(resolve => { markReady = resolve; });
        const done = new Promise((resolve, reject) => {
            let result;
            const timer = setTimeout(() => reject(new Error('Concurrent recovery timed out')), 20000);
            worker.on('message', message => {
                if (message.ready) markReady();
                if (message.fatal) reject(new Error(message.fatal));
                if (message.result) result = message.result;
            });
            worker.once('error', reject);
            worker.once('exit', exit => {
                clearTimeout(timer);
                if (exit === 0 && result) resolve(result);
                else reject(new Error('Worker exited without a successful result: ' + exit));
            });
        });
        done.catch(() => {});
        return { worker, ready, done };
    });
    await Promise.all(jobs.map(job => Promise.race([
        job.ready, job.done.then(() => { throw new Error('Worker did not become ready'); }),
    ])));
    for (const job of jobs) job.worker.postMessage('go');
    const results = await Promise.all(jobs.map(job => job.done));
    assert.ok(results.every(result => result.ok && result.id === job.id &&
        result.state === 'published' && result.attempt === 1), JSON.stringify(results));
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM materialize_attempts').get().n, 1);
    f.inspect();
});