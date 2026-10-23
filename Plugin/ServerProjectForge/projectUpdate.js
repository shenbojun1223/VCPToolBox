'use strict';
// Trusted local cooperative updater; not an OS sandbox or a power-loss protocol.
// Journal + metadata share the receiving DB. Filesystem and mapping DB still do not.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const C = require('./projectCheckpoint');
const { metadataHash } = require('./projectAvailability');
const { SyncError } = require('./projectSync');
const check = (ok, code) => { if (!ok) throw new SyncError(code, code); };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const prefix = 'project_update:';
function exists(db) { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_update_jobs'").get(); }
function active(store, projectId) {
    if (!exists(store.db)) return null;
    return store.db.prepare("SELECT * FROM project_update_jobs WHERE project_id=? AND state!='complete'").get(projectId) || null;
}
function initialize(store) {
    const db = store.db;
    db.transaction(() => {
        if (!exists(db)) {
            db.exec(`CREATE TABLE project_update_jobs(
                request_id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),
                binding_json TEXT NOT NULL,base_revision INTEGER NOT NULL,revision INTEGER NOT NULL,
                bundle_hash TEXT NOT NULL,root_json TEXT NOT NULL,local_base BLOB,incoming BLOB,
                metadata_hash TEXT NOT NULL,plan_json TEXT NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('planned','applied','complete')),result_json TEXT);
                CREATE UNIQUE INDEX pf_update_active ON project_update_jobs(project_id) WHERE state!='complete';`);
            db.prepare('INSERT INTO meta VALUES (?,?)').run('project_updates_version', '1');
        }
        check(db.prepare("SELECT value FROM meta WHERE key='project_updates_version'").get()?.value === '1', 'SCHEMA_VERSION');
        db.prepare("UPDATE meta SET value='6' WHERE key='schema_version'").run();
    }).immediate();
}
function noLinks(file) {
    const resolved = path.resolve(file), root = path.parse(resolved).root;
    let current = root;
    for (const part of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        try { check(!fs.lstatSync(current).isSymbolicLink(), 'UNSAFE_PATH'); }
        catch (e) { if (e.code === 'ENOENT') return;
            check(e.code !== 'ENOTDIR', 'STRUCTURAL_CONFLICT'); throw e; }
    }
}
function identity(root) {
    noLinks(root);
    let stat;
    try { stat = fs.lstatSync(root, { bigint: true }); }
    catch (e) { check(!['ENOENT', 'ENOTDIR'].includes(e.code), 'IDENTITY_MISMATCH'); throw e; }
    check(stat.isDirectory() && stat.ino !== 0n, 'IDENTITY_MISMATCH');
    return { root, dev: String(stat.dev), ino: String(stat.ino) };
}
function sameId(a, b) { return a?.dev === b?.dev && a?.ino === b?.ino; }
function disk(file) {
    noLinks(file);
    let st;
    try { st = fs.lstatSync(file, { bigint: true }); } catch (e) { if (e.code === 'ENOENT') return null;
        check(e.code !== 'ENOTDIR', 'STRUCTURAL_CONFLICT'); throw e; }
    check(st.isFile() && st.nlink === 1n && st.size <= 8n * 1024n * 1024n, 'UNSAFE_PATH');
    const fd = fs.openSync(file, 'r');
    try {
        const opened = fs.fstatSync(fd, { bigint: true });
        check(sameId({ dev: String(st.dev), ino: String(st.ino) },
            { dev: String(opened.dev), ino: String(opened.ino) }) && opened.nlink === 1n &&
            opened.isFile() && opened.size === st.size, 'FILE_DRIFT');
        const bytes = Buffer.alloc(Number(st.size) + 1); let count = 0;
        while (count < bytes.length) {
            const n = fs.readSync(fd, bytes, count, bytes.length - count, null);
            if (!n) break; count += n;
        }
        check(count === Number(st.size), 'FILE_DRIFT');
        return { hash: sha(bytes.subarray(0, count)), dev: String(st.dev), ino: String(st.ino) };
    } finally { fs.closeSync(fd); }
}
function matches(actual, hash, id) { return hash === null ? actual === null : actual?.hash === hash && sameId(actual, id); }
function writePlan(store, row, plan) {
    store.db.prepare('UPDATE project_update_jobs SET plan_json=? WHERE request_id=?').run(JSON.stringify(plan), row.request_id);
}
function entry(store, row, binding, authorize) {
    check(typeof authorize === 'function', 'UPDATE_AUTHORIZATION_REQUIRED');
    authorize();
    check(row.binding_json === JSON.stringify(binding), 'MAPPING_BINDING');
    const root = JSON.parse(row.root_json);
    check(sameId(identity(root.root), root), 'IDENTITY_MISMATCH');
    check(store.db.prepare('SELECT value FROM meta WHERE key=?').get(prefix + row.project_id)?.value === row.request_id,
        'UPDATE_GATE_DRIFT');
    return root.root;
}
function prepare(store, { projectId, binding, baseRevision, revision, baseBytes, nextBytes, expectedHash, authorize, emit = () => {} }) {
    const previous = active(store, projectId);
    if (previous) { entry(store, previous, binding, authorize); return previous; }
    check(Number.isSafeInteger(baseRevision) && baseRevision >= 1 && Number.isSafeInteger(revision) && revision > baseRevision,
        'INVALID_ARGUMENT');
    authorize();
    const local = C.assertClean(store, projectId, baseBytes);
    C.assertForward(baseBytes, nextBytes);
    const next = C.decode(nextBytes, expectedHash), original = C.decode(local.bytes);
    const project = store.getProject(projectId); check(project, 'MAPPING_DRIFT');
    const root = identity(project.root);
    const oldFiles = new Map(original.files.map(f => [f.file_path, f.hash]));
    const nextFiles = new Map(next.files.map(f => [f.file_path, f.hash]));
    // An omitted old tombstone is harmless; omission of an existing old file means deletion.
    const plan = [...new Set([...oldFiles.keys(), ...nextFiles.keys()])].sort().map(relative => {
        const before = oldFiles.get(relative) ?? null, after = nextFiles.get(relative) ?? null;
        const actual = disk(path.join(root.root, ...relative.split('/')));
        check(actual?.hash === before || (!actual && before === null), 'LOCAL_CHANGES');
        if (!oldFiles.has(relative)) check(actual === null, 'UNTRACKED_COLLISION');
        return { path: relative, before, after, beforeId: actual, stage: null, attempts: 0, intent: false, done: false };
    });
    // Check all parents before hiding or changing any live bytes.
    for (const op of plan) {
        let parent = path.dirname(path.join(root.root, ...op.path.split('/')));
        while (parent !== root.root) {
            noLinks(parent);
            try { check(fs.lstatSync(parent).isDirectory(), 'STRUCTURAL_CONFLICT'); }
            catch (e) { if (e.code !== 'ENOENT') throw e; }
            parent = path.dirname(parent);
        }
    }
    const oldHash = metadataHash(store.db, projectId), requestId = 'update-' + crypto.randomUUID();
    initialize(store);
    store.db.transaction(() => {
        authorize(); check(metadataHash(store.db, projectId) === oldHash && !active(store, projectId), 'LOCAL_CHANGES');
        store.db.prepare('INSERT INTO project_update_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
            requestId, projectId, JSON.stringify(binding), baseRevision, revision, expectedHash, JSON.stringify(root),
            local.bytes, nextBytes, oldHash, JSON.stringify(plan), 'planned', null);
        store.db.prepare('INSERT INTO meta VALUES (?,?)').run(prefix + projectId, requestId);
    }).immediate();
    const row = active(store, projectId); emit('update-planned', { requestId }); return row;
}
function verifyFiles(root, plan) {
    for (const op of plan) {
        const current = disk(path.join(root, ...op.path.split('/')));
        const owner = op.before === op.after ? op.beforeId : op.stage?.id;
        check(matches(current, op.after, owner), 'FILE_DRIFT');
    }
}
function apply(store, row, binding, { authorize, emit = () => {} }) {
    const root = entry(store, row, binding, authorize);
    const plan = JSON.parse(row.plan_json);
    C.decode(row.incoming, row.bundle_hash);
    if (row.state === 'applied') {
        check(metadataHash(store.db, row.project_id) === JSON.parse(row.result_json).metadataHash, 'LOCAL_CHANGES');
        verifyFiles(root, plan); return row;
    }
    check(row.state === 'planned' && metadataHash(store.db, row.project_id) === row.metadata_hash, 'LOCAL_CHANGES');
    const incoming = C.decode(row.incoming), blobs = new Map(incoming.blobs.map(b => [b.hash, Buffer.from(b.base64, 'base64')]));
    for (const op of plan) {
        const file = path.join(root, ...op.path.split('/'));
        entry(store, row, binding, authorize);
        let current = disk(file);
        if (op.before === op.after) { check(matches(current, op.before, op.beforeId), 'FILE_DRIFT'); continue; }
        // A rename may have succeeded immediately before process exit. Only our staged inode can claim it.
        if (op.intent && matches(current, op.after, op.stage?.id)) {
            op.done = true; writePlan(store, row, plan); continue;
        }
        check(!op.done && matches(current, op.before, op.beforeId), 'FILE_DRIFT');
        if (op.after === null) {
            op.intent = true; writePlan(store, row, plan);
            entry(store, row, binding, authorize); check(matches(disk(file), op.before, op.beforeId), 'FILE_DRIFT');
            fs.unlinkSync(file); emit('update-file-installed', { requestId: row.request_id, path: op.path });
            op.done = true; writePlan(store, row, plan); continue;
        }
        const parent = path.dirname(file);
        entry(store, row, binding, authorize); noLinks(parent); fs.mkdirSync(parent, { recursive: true });
        if (op.stage?.state === 'ready') {
            check(matches(disk(op.stage.path), op.after, op.stage.id), 'FILE_DRIFT');
        } else {
            check(op.attempts < 16, 'UPDATE_ATTEMPTS_EXHAUSTED');
            op.attempts++;
            op.stage = { path: path.join(parent, '.pf-update-' + crypto.randomUUID()), state: 'writing' };
            writePlan(store, row, plan);
            entry(store, row, binding, authorize);
            const fd = fs.openSync(op.stage.path, 'wx');
            try { fs.writeFileSync(fd, blobs.get(op.after)); fs.fsyncSync(fd); }
            finally { fs.closeSync(fd); }
            op.stage.id = disk(op.stage.path); check(op.stage.id?.hash === op.after, 'HASH_MISMATCH');
            op.stage.state = 'ready'; writePlan(store, row, plan);
            emit('update-file-staged', { requestId: row.request_id, path: op.path });
        }
        op.intent = true; writePlan(store, row, plan);
        entry(store, row, binding, authorize); check(matches(disk(file), op.before, op.beforeId), 'FILE_DRIFT');
        // Same-directory atomic file rename on the supported local Windows filesystem; external writers must be stopped.
        fs.renameSync(op.stage.path, file);
        emit('update-file-installed', { requestId: row.request_id, path: op.path });
        op.done = true; writePlan(store, row, plan);
    }
    verifyFiles(root, plan);
    store.db.transaction(() => {
        entry(store, row, binding, authorize);
        check(metadataHash(store.db, row.project_id) === row.metadata_hash, 'LOCAL_CHANGES');
        const idMap = C.applyMetadata(store, row.project_id, row.local_base, row.incoming);
        const result = { idMap, metadataHash: metadataHash(store.db, row.project_id) };
        store.db.prepare("UPDATE project_update_jobs SET state='applied',result_json=? WHERE request_id=?")
            .run(JSON.stringify(result), row.request_id);
    }).immediate();
    emit('update-metadata-applied', { requestId: row.request_id });
    return active(store, row.project_id);
}
function finish(store, row, binding, { authorize, emit = () => {} }) {
    const root = entry(store, row, binding, authorize);
    check(row.state === 'applied' && metadataHash(store.db, row.project_id) === JSON.parse(row.result_json).metadataHash, 'LOCAL_CHANGES');
    verifyFiles(root, JSON.parse(row.plan_json));
    store.db.transaction(() => {
        entry(store, row, binding, authorize);
        store.db.prepare('DELETE FROM meta WHERE key=? AND value=?').run(prefix + row.project_id, row.request_id);
        store.db.prepare("UPDATE project_update_jobs SET state='complete',local_base=NULL,incoming=NULL WHERE request_id=?").run(row.request_id);
    }).immediate();
    emit('update-complete', { requestId: row.request_id });
}
module.exports = { active, prepare, apply, finish };