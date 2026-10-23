'use strict';
// Internal, synchronous, cooperative protocol. No network, background triggers or writer authorization.
// Mapping DB, receiving DB, content DB, Hub DB, publication journal and filesystem are NOT jointly atomic.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { ProjectTakeover } = require('./projectTakeover');
const { exportProjectBundle, getProjectImportReceipt } = require('./projectBundle');

const TABLES = ['sync_mappings', 'sync_meta', 'sync_publications'];
const SCHEMA = `
CREATE TABLE sync_publications(
 request_id TEXT PRIMARY KEY,global_id TEXT NOT NULL,base_revision INTEGER NOT NULL,
 bundle_hash TEXT NOT NULL,fence INTEGER NOT NULL,holder TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('planned','published')),result_json TEXT
);
CREATE TABLE sync_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE sync_mappings(
 global_id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,role TEXT NOT NULL CHECK(role IN ('origin','replica')),
 revision INTEGER NOT NULL CHECK(revision>=0),bundle_hash TEXT,
 import_revision INTEGER,import_hash TEXT,
 target_json TEXT NOT NULL,destination_key TEXT NOT NULL UNIQUE,
 local_project_id TEXT UNIQUE,state TEXT NOT NULL CHECK(state IN ('pending','ready','purged')),
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);`;
class SyncError extends Error {
    constructor(code, message) { super(message); this.name = 'SyncError'; this.code = code; }
}
function check(ok, code, message) { if (!ok) throw new SyncError(code, message); }
function identifier(value) {
    check(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value),
        'INVALID_ARGUMENT', 'Bounded identifier required'); return value;
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const keyOf = value => process.platform === 'win32' ? value.toLowerCase() : value;
function targetOf(target) {
    check(target && typeof target === 'object' && typeof target.root === 'string' && path.isAbsolute(target.root),
        'INVALID_ARGUMENT', 'Explicit authorized target required');
    const root = path.resolve(target.root);
    check(root !== path.parse(root).root && !root.startsWith('\\\\') &&
        typeof target.workspaceAlias === 'string' && target.workspaceAlias.trim() &&
        (target.workspaceId == null || typeof target.workspaceId === 'string') &&
        (target.subpath === undefined || typeof target.subpath === 'string'),
    'INVALID_ARGUMENT', 'Invalid local target');
    return { root, workspaceId: target.workspaceId ?? null, workspaceAlias: target.workspaceAlias, subpath: target.subpath ?? '' };
}
function overlaps(a, b) {
    a = keyOf(a); b = keyOf(b);
    return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
}
function view(row) {
    if (!row) return null;
    return {
        globalProjectId: row.global_id, requestId: row.request_id, role: row.role,
        revision: row.revision, bundleHash: row.bundle_hash, importRevision: row.import_revision,
        importBundleHash: row.import_hash, localProjectId: row.local_project_id,
        target: JSON.parse(row.target_json), state: row.state, recordedComplete: row.state === 'ready',
        // Persisted state is not an attestation of current files or business acceptance.
        ready: false, filesystemVerified: false,
    };
}

class ProjectSync {
    constructor(store, journalPath, mappingPath, { hub, deviceId, _testHook = null, _network = false } = {}) {
        this.networkMode = _network === true;
        identifier(deviceId);
        check(hub && typeof hub.getHubId === 'function' && typeof hub.downloadRevision === 'function',
            'INVALID_ARGUMENT', 'Content-bound Hub capability required');
        check(typeof mappingPath === 'string' && path.isAbsolute(mappingPath), 'INVALID_ARGUMENT', 'Dedicated absolute mapping path required');
        check(_testHook === null || typeof _testHook === 'function', 'INVALID_ARGUMENT', 'Invalid hook');
        // Check capabilities and paths before constructing receiving-store extensions.
        this.hubId = hub.getHubId(); this.hub = hub; this.store = store; this.deviceId = deviceId;
        this._testHook = _testHook; this.db = null;
        this.takeover = new ProjectTakeover(store, journalPath, {
            _testHook: (event, value) => this._emit('takeover:' + event, value),
        });
        let db;
        try {
            fs.mkdirSync(path.dirname(mappingPath), { recursive: true });
            db = new Database(mappingPath);
            db.pragma('busy_timeout = 5000');
            const binding = {
                hub_id: this.hubId, device_id: deviceId, receiver_id: this.takeover.storeId,
                journal_id: this.takeover.journalId, journal_path: this.takeover.journalPath,
            };
            db.transaction(() => {
                const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
                    .all().map(row => row.name);
                if (!tables.length) {
                    db.exec(SCHEMA);
                    const insert = db.prepare('INSERT INTO sync_meta VALUES (?,?)');
                    for (const [key, value] of Object.entries({ schema_version: '1', mapping_id: 'mapping-' + crypto.randomUUID(), ...binding })) {
                        insert.run(key, value);
                    }
                } else {
                    const expected = this.networkMode && tables.includes('sync_payloads')
                        ? [...TABLES, 'sync_payloads'].sort() : TABLES;
                    check(JSON.stringify(tables) === JSON.stringify(expected), 'WRONG_DATABASE', 'Not a dedicated sync mapping database');
                    const meta = Object.fromEntries(db.prepare('SELECT * FROM sync_meta').all().map(row => [row.key, row.value]));
                    check(meta.schema_version === '1' || (this.networkMode && meta.schema_version === '2'),
                        'SCHEMA_VERSION', 'Unsupported sync mapping schema');
                    check(Object.entries(binding).every(([key, value]) => meta[key] === value),
                        'MAPPING_BINDING', 'Mapping belongs to another Hub, device, receiving store or journal');
                }
                if (this.networkMode) {
                    const version = db.prepare("SELECT value FROM sync_meta WHERE key='schema_version'").get().value;
                    if (version === '1') {
                        check(!db.prepare("SELECT 1 FROM sync_publications WHERE state='planned' LIMIT 1").get(),
                            'MIGRATION_PENDING', 'Reconcile synchronous publications before enabling network mode');
                        db.exec('CREATE TABLE sync_payloads(request_id TEXT PRIMARY KEY,bytes BLOB NOT NULL)');
                        db.prepare("UPDATE sync_meta SET value='2' WHERE key='schema_version'").run();
                    }
                }
                this.mappingId = db.prepare("SELECT value FROM sync_meta WHERE key='mapping_id'").get()?.value;
                check(/^mapping-[0-9a-f-]{36}$/.test(this.mappingId), 'MAPPING_BINDING', 'Invalid mapping identity');
            }).immediate();
            db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
            this.mappingPath = path.resolve(mappingPath);
            this.bindingKey = 'project_sync_binding:' + digest(this.hubId);
            this.bindingValue = JSON.stringify({ mappingId: this.mappingId, mappingPath: this.mappingPath, ...binding });
            // Pin exactly one mapping coordinator per receiving store + Hub, even across mapping DB files.
            store.db.transaction(() => {
                const previous = store.db.prepare('SELECT value FROM meta WHERE key=?').get(this.bindingKey);
                check(!previous || previous.value === this.bindingValue, 'MAPPING_BINDING', 'Receiving store already pins a different mapping coordinator');
                if (!previous) store.db.prepare('INSERT INTO meta VALUES (?,?)').run(this.bindingKey, this.bindingValue);
            }).immediate();
            this.db = db;
        } catch (error) { if (db?.open) db.close(); this.takeover.close(); throw error; }
    }

    close() { if (this.db?.open) this.db.close(); this.db = null; this.takeover.close(); }
    _db() {
        check(this.db?.open, 'CLOSED', 'Sync mapping is closed');
        check(this.hub.getHubId() === this.hubId, 'MAPPING_BINDING', 'Hub identity changed');
        check(this.db.prepare("SELECT value FROM sync_meta WHERE key='schema_version'").get()?.value ===
            (this.networkMode ? '2' : '1'), 'SCHEMA_VERSION', 'Mapping mode changed; stop old coordinators');
        check(this.store.db?.open && this.store.db.prepare('SELECT value FROM meta WHERE key=?')
            .get(this.bindingKey)?.value === this.bindingValue, 'MAPPING_BINDING', 'Receiving-store mapping pin differs');
        return this.db;
    }
    _entry() {
        this._db();
        check(!this.db.inTransaction && !this.store.db.inTransaction && !this.hub.db?.inTransaction,
            'INVALID_ARGUMENT', 'Caller transactions cannot wrap this cross-database protocol');
    }
    _emit(event, value) { if (this._testHook) this._testHook(event, value); }
    _row(globalProjectId) {
        identifier(globalProjectId);
        return this._db().prepare('SELECT * FROM sync_mappings WHERE global_id=?').get(globalProjectId);
    }
    getMapping(globalProjectId) { return view(this._row(globalProjectId)); }
    _request(requestId) {
        identifier(requestId);
        return this._db().prepare('SELECT * FROM sync_mappings WHERE request_id=?').get(requestId);
    }
    _assertFree(root) {
        check(!this.db.prepare('SELECT target_json FROM sync_mappings').all()
            .some(row => overlaps(root, JSON.parse(row.target_json).root)),
        'MAPPING_CONFLICT', 'Local target overlaps a persistent mapping');
    }
    registerLocal(localProjectId) {
        this._entry();
        identifier(localProjectId);
        const project = this.store.getProject(localProjectId);
        check(project, 'NOT_FOUND', 'Local project is unavailable or deleted');
        const mapped = this._db().prepare('SELECT * FROM sync_mappings WHERE local_project_id=?').get(localProjectId);
        if (mapped) {
            const target = targetOf({ root: project.root, workspaceId: project.workspace_id,
                workspaceAlias: project.workspace_alias, subpath: project.subpath });
            check(mapped.state === 'ready' && mapped.target_json === JSON.stringify(target),
                'MAPPING_DRIFT', 'Mapped local project is unavailable or moved');
            return view(mapped); // A received replica must NEVER fork a second global identity.
        }
        // Receiving-store identity, not a short device label, namespaces local IDs across databases.
        const global = this.hub.registerProject({
            originId: this.takeover.storeId, localProjectId, name: project.name,
        });
        this._emit('origin-registered', global);
        const target = targetOf({
            root: project.root, workspaceId: project.workspace_id,
            workspaceAlias: project.workspace_alias, subpath: project.subpath,
        });
        return this._db().transaction(() => {
            const old = this._row(global.id);
            if (old) {
                check(old.role === 'origin' && old.local_project_id === localProjectId &&
                    old.target_json === JSON.stringify(target), 'MAPPING_CONFLICT', 'Origin mapping changed');
                return view(old);
            }
            this._assertFree(target.root);
            const now = new Date().toISOString();
            this.db.prepare('INSERT INTO sync_mappings VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
                global.id, 'origin-' + digest([this.hubId, global.id]), 'origin', 0, null, null, null,
                JSON.stringify(target), keyOf(target.root), localProjectId, 'ready', now, now);
            return view(this._row(global.id));
        }).immediate();
    }
    publishLocal({ globalProjectId, lease, requestId, expectedRevision }) {
        this._entry();
        identifier(requestId);
        check(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0,
            'INVALID_ARGUMENT', 'Explicit base revision required');
        const row = this._row(globalProjectId);
        check(row?.state === 'ready', 'MAPPING_CONFLICT', 'A ready local mapping is required');
        check(lease?.projectId === globalProjectId && lease.holder === this.deviceId,
            'INVALID_ARGUMENT', 'Lease must bind the mapped project and this device');
        const project = this.store.getProject(row.local_project_id);
        check(project && JSON.stringify(targetOf({ root: project.root, workspaceId: project.workspace_id,
            workspaceAlias: project.workspace_alias, subpath: project.subpath })) === row.target_json,
            'MAPPING_DRIFT', 'Mapped local project moved or disappeared');
        let attempt = this._db().prepare('SELECT * FROM sync_publications WHERE request_id=?').get(requestId);
        if (!attempt) {
            check(row.revision === expectedRevision, 'LOCAL_REVISION_CONFLICT',
                'The local checkpoint does not match this base revision; no blind rebase or overwrite');
            const bundle = exportProjectBundle(this.store, row.local_project_id);
            this.hub.contentStore.put(bundle.bytes, { expectedHash: bundle.sha256 });
            this._emit('bundle-uploaded', { bundleHash: bundle.sha256 });
            attempt = this._db().transaction(() => {
                const prior = this.db.prepare('SELECT * FROM sync_publications WHERE request_id=?').get(requestId);
                if (prior) return prior;
                this.db.prepare('INSERT INTO sync_publications VALUES (?,?,?,?,?,?,?,?)').run(
                    requestId, globalProjectId, expectedRevision, bundle.sha256, lease.fence, lease.holder, 'planned', null);
                return this.db.prepare('SELECT * FROM sync_publications WHERE request_id=?').get(requestId);
            }).immediate();
        }
        check(attempt.global_id === globalProjectId && attempt.base_revision === expectedRevision &&
            attempt.fence === lease.fence && attempt.holder === lease.holder,
            'REQUEST_CONFLICT', 'Publication request binding changed');
        this._emit('publication-planned', { requestId, bundleHash: attempt.bundle_hash });
        const revision = this.hub.publishRevision({
            ...lease, projectId: globalProjectId, requestId, expectedRevision, bundleHash: attempt.bundle_hash,
        });
        this._emit('revision-published', revision);
        this._recordPublication(row, requestId, revision);
        return revision;
    }
    _recordPublication(row, requestId, revision) {
        this._db().transaction(() => {
            const current = this._row(row.global_id);
            check(current?.local_project_id === row.local_project_id && current.state === 'ready' &&
                current.target_json === row.target_json, 'MAPPING_DRIFT', 'Local binding changed');
            if (current.revision <= revision.revision) this.db.prepare(
                'UPDATE sync_mappings SET revision=?,bundle_hash=?,updated_at=? WHERE global_id=?'
            ).run(revision.revision, revision.bundleHash, new Date().toISOString(), row.global_id);
            this.db.prepare("UPDATE sync_publications SET state='published',result_json=? WHERE request_id=?")
                .run(JSON.stringify(revision), requestId);
        }).immediate();
    }

    reconcilePublication(requestId) {
        this._entry();
        identifier(requestId);
        const attempt = this._db().prepare('SELECT * FROM sync_publications WHERE request_id=?').get(requestId);
        check(attempt, 'NOT_FOUND', 'No persisted publication request');
        const revision = this.hub.getRevision(attempt.global_id, attempt.base_revision + 1);
        check(revision, 'PUBLICATION_NOT_FOUND', 'This checkpoint has not been published; no write was attempted');
        check(revision.requestId === requestId && revision.bundleHash === attempt.bundle_hash &&
            revision.baseRevision === attempt.base_revision && revision.fence === attempt.fence &&
            revision.holder === attempt.holder, 'PUBLICATION_CONFLICT', 'Another publication occupies this revision');
        this.hub.downloadRevision(attempt.global_id, revision.revision); // Fully verify retained bytes.
        const row = this._row(attempt.global_id);
        check(row?.state === 'ready', 'MAPPING_DRIFT', 'Local mapping is unavailable');
        const project = this.store.getProject(row.local_project_id);
        check(project && JSON.stringify(targetOf({ root: project.root, workspaceId: project.workspace_id,
            workspaceAlias: project.workspace_alias, subpath: project.subpath })) === row.target_json,
            'MAPPING_DRIFT', 'Mapped project moved or disappeared');
        this._recordPublication(row, requestId, revision);
        // Reading a historical accepted revision is not a new publish or a fresh file verification.
        return { ...revision, recordedPublished: true, filesystemVerified: false };
    }

    start({ globalProjectId, revision, requestId, target }) {
        this._entry();
        identifier(globalProjectId); identifier(requestId);
        const local = targetOf(target);
        const old = this._request(requestId);
        const selected = revision ?? old?.import_revision ?? this.hub.getProject(globalProjectId).revision;
        check(Number.isSafeInteger(selected) && selected >= 1, 'INVALID_ARGUMENT', 'Published revision required');
        const remote = this.hub.getRevision(globalProjectId, selected);
        check(remote, 'NOT_FOUND', 'Unknown published revision');
        const row = this._db().transaction(() => {
            const previous = this._request(requestId);
            if (previous) {
                check(previous.global_id === globalProjectId && previous.import_revision === selected &&
                    previous.import_hash === remote.bundleHash && previous.target_json === JSON.stringify(local) &&
                    previous.role === 'replica', 'REQUEST_CONFLICT', 'Import mapping request changed');
                check(previous.state !== 'purged', 'IMPORT_PURGED', 'Mapped import was purged'); return previous;
            }
            check(!this._row(globalProjectId), 'MAPPING_CONFLICT', 'Global project is already mapped; no implicit overwrite or revision upgrade');
            this._assertFree(local.root);
            const now = new Date().toISOString();
            this.db.prepare('INSERT INTO sync_mappings VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
                globalProjectId, requestId, 'replica', selected, remote.bundleHash, selected, remote.bundleHash, JSON.stringify(local),
                keyOf(local.root), null, 'pending', now, now);
            return this._request(requestId);
        }).immediate();
        this._emit('mapping-planned', view(row));
        return view(row);
    }
    _takeoverRequest(row) {
        return 'sync-' + digest([this.hubId, this.mappingId, row.request_id]);
    }
    resume(requestId) {
        this._entry();
        const row = this._request(requestId);
        check(row && row.role === 'replica', 'NOT_FOUND', 'No receiving mapping request');
        check(row.state !== 'purged', 'IMPORT_PURGED', 'Mapped import was purged');
        const downloaded = this.hub.downloadRevision(row.global_id, row.import_revision);
        check(downloaded.revision.bundleHash === row.import_hash, 'MAPPING_DRIFT', 'Pinned Hub revision changed');
        const args = {
            requestId: this._takeoverRequest(row), bundle: downloaded.bytes, expectedHash: row.import_hash,
            target: JSON.parse(row.target_json),
        };
        try {
            const started = this.takeover.start(args);
            this._emit('takeover-started', started);
            this._linkLocal(row, started.projectId, 'pending');
            const completed = this.takeover.resume(args.requestId, args.bundle, { expectedHash: args.expectedHash });
            this._emit('takeover-complete', completed);
            this._linkLocal(row, completed.projectId, 'ready');
            this._emit('mapping-ready', completed);
            return { ...view(this._request(requestId)), ready: true, filesystemVerified: true };
        } catch (error) {
            if (error.code === 'IMPORT_PURGED') this._db().transaction(() => {
                const receipt = getProjectImportReceipt(this.store, args.requestId);
                check(receipt?.state === 'purged', 'MAPPING_DRIFT', 'Purged receipt disappeared');
                this.db.prepare("UPDATE sync_mappings SET state='purged',local_project_id=?,updated_at=? WHERE request_id=?")
                    .run(receipt.projectId, new Date().toISOString(), requestId);
            }).immediate();
            throw error;
        }
    }
    _linkLocal(row, projectId, state) {
        this._db().transaction(() => {
            const current = this._request(row.request_id);
            check(current && current.global_id === row.global_id && current.import_hash === row.import_hash &&
                (current.local_project_id === null || current.local_project_id === projectId),
            'MAPPING_DRIFT', 'Local import identity differs');
            check(current.state !== 'purged', 'IMPORT_PURGED', 'Mapping was purged');
            this.db.prepare('UPDATE sync_mappings SET local_project_id=?,state=?,updated_at=? WHERE request_id=?')
                .run(projectId, current.state === 'ready' ? 'ready' : state, new Date().toISOString(), row.request_id);
        }).immediate();
    }
    receive(args) { this.start(args); return this.resume(args.requestId); }
}
module.exports = { ProjectSync, SyncError };