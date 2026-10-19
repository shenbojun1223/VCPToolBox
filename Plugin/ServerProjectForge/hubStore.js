'use strict';
// Internal Hub arbitration; optional durable content binding. No HTTP or local Forge migration.
// Stop old schema1 processes before binding: a schema marker cannot fence code already running.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { HubContentStore } = require('./hubContentStore');

const SCHEMA_VERSION = '1';
const BOUND_VERSION = '2';
const DEFAULT_TTL_MS = 60000;
const MIN_TTL_MS = 1000;
const MAX_TTL_MS = 300000;
const TABLES = ['hub_lease_requests', 'hub_meta', 'hub_projects', 'hub_revisions'];
const SCHEMA = `
CREATE TABLE hub_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE hub_projects (
    id TEXT PRIMARY KEY,
    origin_id TEXT NOT NULL,
    local_project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    bundle_hash TEXT,
    fence INTEGER NOT NULL DEFAULT 0 CHECK(fence >= 0),
    lease_id TEXT,
    lease_holder TEXT,
    lease_expires_at INTEGER,
    clock_ms INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(origin_id, local_project_id)
);
CREATE TABLE hub_lease_requests (
    project_id TEXT NOT NULL REFERENCES hub_projects(id),
    holder TEXT NOT NULL,
    request_id TEXT NOT NULL,
    lease_id TEXT NOT NULL,
    fence INTEGER NOT NULL,
    ttl_ms INTEGER NOT NULL,
    granted_at INTEGER NOT NULL,
    PRIMARY KEY(project_id, holder, request_id)
);
CREATE TABLE hub_revisions (
    project_id TEXT NOT NULL REFERENCES hub_projects(id),
    revision INTEGER NOT NULL,
    base_revision INTEGER NOT NULL,
    bundle_hash TEXT NOT NULL,
    fence INTEGER NOT NULL,
    holder TEXT NOT NULL,
    request_id TEXT NOT NULL,
    published_at INTEGER NOT NULL,
    PRIMARY KEY(project_id, revision),
    UNIQUE(project_id, request_id)
);
`;

class HubError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'HubError';
        this.code = code;
    }
}

function fail(code, message) {
    throw new HubError(code, message);
}

function identifier(value, label) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
        fail('INVALID_ARGUMENT', `${label} must be a 1-128 character identifier`);
    }
    return value;
}

function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        fail('INVALID_ARGUMENT', `${label} must be an integer in [${min}, ${max}]`);
    }
    return value;
}

function token(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
        fail('INVALID_ARGUMENT', 'leaseId must be a 256-bit lowercase hex token');
    }
    return value;
}

function ttl(value = DEFAULT_TTL_MS) {
    return integer(value, 'ttlMs', MIN_TTL_MS, MAX_TTL_MS);
}

function addSafe(a, b) {
    const value = a + b;
    if (!Number.isSafeInteger(value)) fail('COUNTER_EXHAUSTED', 'Safe integer capacity exhausted');
    return value;
}

function revisionView(row) {
    return {
        projectId: row.project_id, revision: row.revision, baseRevision: row.base_revision,
        bundleHash: row.bundle_hash, fence: row.fence, holder: row.holder,
        requestId: row.request_id, publishedAt: row.published_at,
    };
}

class HubStore {
    constructor(dbPath, { clock = Date.now, busyTimeoutMs = 5000, contentStore = null } = {}) {
        if (contentStore !== null && !(contentStore instanceof HubContentStore)) fail('INVALID_ARGUMENT', 'Trusted HubContentStore required');
        if (typeof dbPath !== 'string' || !dbPath.trim()) {
            fail('INVALID_ARGUMENT', 'An explicit dedicated Hub database path is required');
        }
        if (typeof clock !== 'function') fail('INVALID_ARGUMENT', 'clock must be a function');
        integer(busyTimeoutMs, 'busyTimeoutMs', 0, 60000);
        this.clock = clock;
        this.db = null;
        if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
        const db = new Database(dbPath);
        try {
            db.pragma(`busy_timeout = ${busyTimeoutMs}`);
            db.pragma('foreign_keys = ON');
            db.transaction(() => {
                const tables = db.prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
                ).all().map(row => row.name);
                if (tables.length === 0) {
                    db.exec(SCHEMA);
                    db.prepare('INSERT INTO hub_meta(key,value) VALUES (?,?)').run('schema_version', SCHEMA_VERSION);
                } else {
                    if (JSON.stringify(tables) !== JSON.stringify(TABLES)) {
                        fail('WRONG_DATABASE', 'Refusing non-Hub database or unexpected schema');
                    }
                    const version = db.prepare("SELECT value FROM hub_meta WHERE key='schema_version'").get()?.value;
                    if (![SCHEMA_VERSION, BOUND_VERSION].includes(version)) fail('SCHEMA_VERSION', 'Unsupported Hub schema version');
                }
                const version = db.prepare("SELECT value FROM hub_meta WHERE key='schema_version'").get().value;
                if (version === BOUND_VERSION) {
                    if (!contentStore) fail('CONTENT_REQUIRED', 'Content-bound Hub cannot reopen as digest-only arbitration');
                    const bound = db.prepare("SELECT value FROM hub_meta WHERE key='content_store_id'").get()?.value;
                    if (bound !== contentStore.getId()) fail('CONTENT_BINDING', 'Hub belongs to another content store');
                    const hubId = db.prepare("SELECT value FROM hub_meta WHERE key='hub_id'").get()?.value;
                    if (!/^hub-[0-9a-f-]{36}$/.test(hubId)) fail('CONTENT_BINDING', 'Invalid Hub identity');
                } else if (contentStore) {
                    // Migration only succeeds if every existing digest reference already has complete content.
                    for (const row of db.prepare('SELECT DISTINCT bundle_hash FROM hub_revisions').all()) contentStore.get(row.bundle_hash);
                    db.prepare('INSERT INTO hub_meta VALUES (?,?)').run('hub_id', 'hub-' + crypto.randomUUID());
                    db.prepare('INSERT INTO hub_meta VALUES (?,?)').run('content_store_id', contentStore.getId());
                    db.prepare("UPDATE hub_meta SET value=? WHERE key='schema_version'").run(BOUND_VERSION);
                }
            }).immediate();
            db.pragma('journal_mode = WAL');
            // A durable lease grant must not regress after ordinary process/OS restart.
            db.pragma('synchronous = FULL');
            this.db = db;
            this.contentStore = contentStore;
        } catch (error) {
            db.close();
            throw error;
        }
    }

    close() {
        if (this.db?.open) this.db.close();
        this.db = null;
    }

    _connection() {
        if (!this.db?.open) fail('CLOSED', 'HubStore is closed');
        return this.db;
    }

    _content() {
        const db = this._connection();
        if (db.prepare("SELECT value FROM hub_meta WHERE key='schema_version'").get()?.value !== BOUND_VERSION ||
            !this.contentStore) fail('CONTENT_REQUIRED', 'This operation requires a content-bound Hub');
        if (db.prepare("SELECT value FROM hub_meta WHERE key='content_store_id'").get()?.value !== this.contentStore.getId()) {
            fail('CONTENT_BINDING', 'Content store identity differs');
        }
        return this.contentStore;
    }

    getHubId() {
        this._content();
        return this.db.prepare("SELECT value FROM hub_meta WHERE key='hub_id'").get().value;
    }

    downloadRevision(projectId, revision) {
        const content = this._content();
        const published = this.getRevision(projectId, revision);
        if (!published) fail('NOT_FOUND', 'Unknown published revision');
        return { revision: published, bytes: content.get(published.bundleHash) };
    }

    _write(fn) {
        // A caller-owned transaction would turn our COMMIT into a non-durable savepoint.
        const db = this._connection();
        if (db.inTransaction) fail('INVALID_ARGUMENT', 'Caller Hub transactions are unsupported');
        // Acquire SQLite's write reservation BEFORE reading shared state.
        return db.transaction(fn).immediate();
    }

    _project(id) {
        identifier(id, 'projectId');
        const row = this._connection().prepare('SELECT * FROM hub_projects WHERE id=?').get(id);
        if (!row) fail('NOT_FOUND', 'Unknown global project');
        return row;
    }

    _time(row = null) {
        const now = this.clock();
        integer(now, 'Hub clock', 0);
        if (row && now < row.clock_ms) fail('CLOCK_ROLLBACK', 'Hub clock moved behind last committed project mutation');
        return now;
    }

    _view(row, now) {
        return {
            id: row.id, originId: row.origin_id, localProjectId: row.local_project_id,
            name: row.name, revision: row.revision, bundleHash: row.bundle_hash, fence: row.fence,
            lease: row.lease_id && row.lease_expires_at > now
                ? { holder: row.lease_holder, fence: row.fence, expiresAt: row.lease_expires_at } : null,
            createdAt: row.created_at, updatedAt: row.updated_at,
        };
    }

    _handle(row) {
        return {
            projectId: row.id, holder: row.lease_holder, leaseId: row.lease_id,
            fence: row.fence, expiresAt: row.lease_expires_at, revision: row.revision,
        };
    }

    _credential(args) {
        identifier(args.projectId, 'projectId');
        identifier(args.holder, 'holder');
        token(args.leaseId);
        integer(args.fence, 'fence', 1);
    }

    _requireLease(row, args, now) {
        if (!row.lease_id || row.lease_id !== args.leaseId ||
            row.lease_holder !== args.holder || row.fence !== args.fence) {
            fail('STALE_LEASE', 'Lease credential is stale or does not own this project');
        }
        if (row.lease_expires_at <= now) fail('LEASE_EXPIRED', 'Lease has expired');
    }

    registerProject({ originId, localProjectId, name }) {
        identifier(originId, 'originId');
        identifier(localProjectId, 'localProjectId');
        if (typeof name !== 'string' || !name.trim() || name.length > 256) {
            fail('INVALID_ARGUMENT', 'name must contain 1-256 characters');
        }
        return this._write(() => {
            const existing = this.db.prepare(
                'SELECT * FROM hub_projects WHERE origin_id=? AND local_project_id=?'
            ).get(originId, localProjectId);
            if (existing) {
                if (existing.name !== name) fail('REQUEST_CONFLICT', 'Registration payload changed');
                return this._view(existing, this._time(existing));
            }
            const now = this._time();
            const id = `g_${crypto.randomUUID()}`;
            this.db.prepare(`INSERT INTO hub_projects
                (id,origin_id,local_project_id,name,clock_ms,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?)`).run(id, originId, localProjectId, name, now, now, now);
            return this._view(this._project(id), now);
        });
    }

    getProject(projectId) {
        const row = this._project(projectId);
        return this._view(row, this._time(row));
    }

    assertLease(args) {
        this._credential(args);
        return this._write(() => {
            const row = this._project(args.projectId);
            this._requireLease(row, args, this._time(row));
            return {
                projectId: row.id, holder: row.lease_holder, fence: row.fence,
                expiresAt: row.lease_expires_at, revision: row.revision,
            };
        });
    }

    acquireLease({ projectId, holder, requestId, ttlMs = DEFAULT_TTL_MS }) {
        identifier(projectId, 'projectId');
        identifier(holder, 'holder');
        identifier(requestId, 'requestId');
        ttl(ttlMs);
        return this._write(() => {
            const row = this._project(projectId);
            const now = this._time(row);
            const previous = this.db.prepare(
                'SELECT * FROM hub_lease_requests WHERE project_id=? AND holder=? AND request_id=?'
            ).get(projectId, holder, requestId);
            if (previous) {
                if (previous.ttl_ms !== ttlMs) fail('REQUEST_CONFLICT', 'Lease request payload changed');
                if (row.lease_id !== previous.lease_id || row.fence !== previous.fence ||
                    row.lease_expires_at <= now) {
                    fail('STALE_REQUEST', 'Consumed lease request cannot grant a new lease; use a new requestId');
                }
                return this._handle(row);
            }
            if (row.lease_id && row.lease_expires_at > now) {
                fail('LEASE_BUSY', 'Project already has an active writer (including the same holder name)');
            }
            const fence = addSafe(row.fence, 1);
            const expiresAt = addSafe(now, ttlMs);
            const leaseId = crypto.randomBytes(32).toString('hex');
            this.db.prepare(`UPDATE hub_projects SET
                fence=?,lease_id=?,lease_holder=?,lease_expires_at=?,clock_ms=?,updated_at=? WHERE id=?`
            ).run(fence, leaseId, holder, expiresAt, now, now, projectId);
            this.db.prepare(`INSERT INTO hub_lease_requests
                (project_id,holder,request_id,lease_id,fence,ttl_ms,granted_at) VALUES (?,?,?,?,?,?,?)`
            ).run(projectId, holder, requestId, leaseId, fence, ttlMs, now);
            return this._handle(this._project(projectId));
        });
    }

    renewLease(args) {
        this._credential(args);
        const ttlMs = ttl(args.ttlMs);
        return this._write(() => {
            const row = this._project(args.projectId);
            const now = this._time(row);
            this._requireLease(row, args, now);
            const expiresAt = Math.max(row.lease_expires_at, addSafe(now, ttlMs));
            this.db.prepare('UPDATE hub_projects SET lease_expires_at=?,clock_ms=?,updated_at=? WHERE id=?')
                .run(expiresAt, now, now, row.id);
            return this._handle(this._project(row.id));
        });
    }

    releaseLease(args) {
        this._credential(args);
        return this._write(() => {
            const row = this._project(args.projectId);
            const now = this._time(row);
            this._requireLease(row, args, now);
            this.db.prepare(`UPDATE hub_projects SET lease_id=NULL,lease_holder=NULL,
                lease_expires_at=NULL,clock_ms=?,updated_at=? WHERE id=?`).run(now, now, row.id);
            return { projectId: row.id, fence: row.fence, released: true };
        });
    }

    publishRevision(args) {
        this._credential(args);
        identifier(args.requestId, 'requestId');
        integer(args.expectedRevision, 'expectedRevision');
        if (typeof args.bundleHash !== 'string' || !/^[0-9a-f]{64}$/.test(args.bundleHash)) {
            fail('INVALID_ARGUMENT', 'bundleHash must be a lowercase SHA-256 reference');
        }
        return this._write(() => {
            const row = this._project(args.projectId);
            const beganAt = this._time(row);
            // Even replay requires a CURRENT credential: stale writers never bypass fencing.
            this._requireLease(row, args, beganAt);
            // Re-read the durable mode: another connection may have bound a formerly digest-only Hub.
            if (this.db.prepare("SELECT value FROM hub_meta WHERE key='schema_version'").get().value === BOUND_VERSION) {
                this._content().get(args.bundleHash);
            }
            // Synchronous validation may outlive a lease. Recheck immediately before any revision action.
            const now = this._time(row);
            if (now < beganAt) fail('CLOCK_ROLLBACK', 'Hub clock moved backward during content validation');
            this._requireLease(row, args, now);
            const previous = this.db.prepare(
                'SELECT * FROM hub_revisions WHERE project_id=? AND request_id=?'
            ).get(row.id, args.requestId);
            if (previous) {
                if (previous.base_revision !== args.expectedRevision || previous.bundle_hash !== args.bundleHash ||
                    previous.fence !== args.fence || previous.holder !== args.holder) {
                    fail('REQUEST_CONFLICT', 'Publish request payload or lease generation changed');
                }
                return revisionView(previous);
            }
            if (row.revision !== args.expectedRevision) fail('REVISION_CONFLICT', 'Base revision is not current');
            const revision = addSafe(row.revision, 1);
            this.db.prepare(`INSERT INTO hub_revisions
                (project_id,revision,base_revision,bundle_hash,fence,holder,request_id,published_at)
                VALUES (?,?,?,?,?,?,?,?)`).run(row.id, revision, row.revision, args.bundleHash,
                row.fence, args.holder, args.requestId, now);
            this.db.prepare(`UPDATE hub_projects SET
                revision=?,bundle_hash=?,clock_ms=?,updated_at=? WHERE id=?`
            ).run(revision, args.bundleHash, now, now, row.id);
            return revisionView(this.db.prepare(
                'SELECT * FROM hub_revisions WHERE project_id=? AND revision=?'
            ).get(row.id, revision));
        });
    }

    getRevision(projectId, revision) {
        identifier(projectId, 'projectId');
        integer(revision, 'revision', 1);
        this._project(projectId);
        const row = this.db.prepare('SELECT * FROM hub_revisions WHERE project_id=? AND revision=?')
            .get(projectId, revision);
        return row ? revisionView(row) : null;
    }
}

module.exports = { HubStore, HubError, DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS };