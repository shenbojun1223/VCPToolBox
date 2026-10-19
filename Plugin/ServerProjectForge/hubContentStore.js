'use strict';
// Internal append-only content capability. No authentication, transport, eviction or secret scanning.
// SQLite BLOB + metadata commit together. Recovery guarantee is ordinary process exit, not backup rollback.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { validateProjectBundle, DEFAULT_LIMITS } = require('./projectBundle');

const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_BUNDLES = 1024;
const TABLES = ['content_bundles', 'content_meta'];
const SCHEMA = `
CREATE TABLE content_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE content_bundles(
 hash TEXT PRIMARY KEY,size INTEGER NOT NULL CHECK(size>0),data BLOB NOT NULL,
 source_project_id TEXT NOT NULL,created_at TEXT NOT NULL,
 CHECK(length(data)=size)
);`;
class ContentError extends Error {
    constructor(code, message) { super(message); this.name = 'ContentError'; this.code = code; }
}
function check(ok, code, message) { if (!ok) throw new ContentError(code, message); }
function hashOf(hash) {
    check(typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash), 'INVALID_ARGUMENT', 'Explicit lowercase SHA-256 required');
    return hash;
}
function bounded(value, max) { return Number.isSafeInteger(value) && value > 0 && value <= max; }

class HubContentStore {
    constructor(dbPath, { maxTotalBytes, maxBundles, busyTimeoutMs = 5000, _testHook = null } = {}) {
        check(typeof dbPath === 'string' && path.isAbsolute(dbPath), 'INVALID_ARGUMENT', 'Dedicated absolute content database path required');
        check(Number.isSafeInteger(busyTimeoutMs) && busyTimeoutMs >= 0 && busyTimeoutMs <= 60000,
            'INVALID_ARGUMENT', 'Invalid busy timeout');
        check(_testHook === null || typeof _testHook === 'function', 'INVALID_ARGUMENT', 'Invalid test hook');
        if (maxTotalBytes !== undefined) check(bounded(maxTotalBytes, MAX_TOTAL_BYTES), 'INVALID_ARGUMENT', 'Invalid content capacity');
        if (maxBundles !== undefined) check(bounded(maxBundles, MAX_BUNDLES), 'INVALID_ARGUMENT', 'Invalid bundle count bound');
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        this.db = null;
        this._testHook = _testHook;
        const db = new Database(dbPath);
        try {
            db.pragma(`busy_timeout = ${busyTimeoutMs}`);
            db.transaction(() => {
                const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
                    .all().map(row => row.name);
                if (!tables.length) {
                    db.exec(SCHEMA);
                    const put = db.prepare('INSERT INTO content_meta VALUES (?,?)');
                    for (const [key, value] of Object.entries({
                        schema_version: '1', store_id: 'content-' + crypto.randomUUID(),
                        max_total_bytes: String(maxTotalBytes ?? MAX_TOTAL_BYTES), max_bundles: String(maxBundles ?? MAX_BUNDLES),
                    })) put.run(key, value);
                } else {
                    check(JSON.stringify(tables) === JSON.stringify(TABLES), 'WRONG_DATABASE', 'Not a dedicated content database');
                    check(db.prepare("SELECT value FROM content_meta WHERE key='schema_version'").get()?.value === '1',
                        'SCHEMA_VERSION', 'Unsupported content schema');
                }
                const meta = Object.fromEntries(db.prepare('SELECT * FROM content_meta').all().map(row => [row.key, row.value]));
                check(/^content-[0-9a-f-]{36}$/.test(meta.store_id), 'CORRUPT_CONTENT', 'Invalid content store identity');
                const total = Number(meta.max_total_bytes), count = Number(meta.max_bundles);
                check(bounded(total, MAX_TOTAL_BYTES) && bounded(count, MAX_BUNDLES), 'CORRUPT_CONTENT', 'Invalid persisted quotas');
                check((maxTotalBytes === undefined || maxTotalBytes === total) && (maxBundles === undefined || maxBundles === count),
                    'QUOTA_MISMATCH', 'Content quotas are persistent, not per-connection overrides');
                this.id = meta.store_id; this.maxTotalBytes = total; this.maxBundles = count;
            }).immediate();
            db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
            this.db = db;
        } catch (error) { db.close(); throw error; }
    }

    close() { if (this.db?.open) this.db.close(); this.db = null; }
    _db() {
        check(this.db?.open, 'CLOSED', 'Content store is closed');
        check(!this.db.inTransaction, 'INVALID_ARGUMENT', 'Caller content transactions are unsupported');
        return this.db;
    }
    getId() { this._db(); return this.id; }
    _emit(event) { if (this._testHook) this._testHook(event); }
    _verify(row, hash) {
        check(row && Buffer.isBuffer(row.data) && bounded(row.size, DEFAULT_LIMITS.maxBundleBytes) &&
            row.size === row.data.length, 'CORRUPT_CONTENT', 'Incomplete content row');
        const summary = validateProjectBundle(row.data, { expectedHash: hash });
        check(summary.sourceProjectId === row.source_project_id, 'CORRUPT_CONTENT', 'Content source metadata differs');
        return summary;
    }
    put(bundle, { expectedHash } = {}) {
        hashOf(expectedHash);
        check(Buffer.isBuffer(bundle) && bounded(bundle.length, DEFAULT_LIMITS.maxBundleBytes),
            'LIMIT_EXCEEDED', 'Bounded Buffer required');
        const bytes = Buffer.from(bundle);
        const summary = validateProjectBundle(bytes, { expectedHash });
        const db = this._db();
        const result = db.transaction(() => {
            const previous = db.prepare('SELECT * FROM content_bundles WHERE hash=?').get(expectedHash);
            if (previous) {
                this._verify(previous, expectedHash);
                check(previous.data.equals(bytes), 'CORRUPT_CONTENT', 'Existing content differs');
                return { hash: expectedHash, size: previous.size, stored: true };
            }
            const used = db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM content_bundles').get();
            check(used.count < this.maxBundles && used.bytes + bytes.length <= this.maxTotalBytes,
                'CAPACITY_EXCEEDED', 'Content capacity exhausted; nothing evicted');
            db.prepare('INSERT INTO content_bundles VALUES (?,?,?,?,?)')
                .run(expectedHash, bytes.length, bytes, summary.sourceProjectId, new Date().toISOString());
            this._emit('content-inserted');
            return { hash: expectedHash, size: bytes.length, stored: true };
        }).immediate();
        this._emit('content-committed');
        return result;
    }
    get(hash) {
        hashOf(hash);
        const db = this._db();
        return db.transaction(() => {
            // Bound length before loading bytes, including databases damaged outside this capability.
            const header = db.prepare('SELECT size,length(data) AS actual FROM content_bundles WHERE hash=?').get(hash);
            check(header, 'CONTENT_NOT_FOUND', 'Bundle has not been stored');
            check(bounded(header.size, DEFAULT_LIMITS.maxBundleBytes) && header.actual === header.size,
                'CORRUPT_CONTENT', 'Stored content size differs');
            const row = db.prepare('SELECT * FROM content_bundles WHERE hash=?').get(hash);
            this._verify(row, hash);
            return Buffer.from(row.data);
        })();
    }
}
module.exports = { HubContentStore, ContentError, MAX_TOTAL_BYTES, MAX_BUNDLES };