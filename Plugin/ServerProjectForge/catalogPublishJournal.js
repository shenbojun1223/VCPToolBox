'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { check, fields, identifier, integer, hash } = require('./hubNetworkProtocol');
const { canonicalRecords, MAX_BYTES } = require('./catalogInventory');

// Dedicated publisher journal, never the business DB. No network on import,
// construction or stage. Caller retries pending() before collecting a new view.
class CatalogPublishJournal {
    constructor(filename, binding) {
        fields(binding, ['hubId', 'deviceId', 'sourceId', 'storePath']);
        check(typeof binding.hubId === 'string' && /^hub-[0-9a-f-]{36}$/.test(binding.hubId));
        identifier(binding.deviceId); identifier(binding.sourceId);
        check(typeof binding.storePath === 'string' && path.isAbsolute(binding.storePath));
        check(typeof filename === 'string' && path.isAbsolute(filename));
        const normalized = value => {
            const absolute = path.resolve(value);
            return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
        };
        check(normalized(filename) !== normalized(binding.storePath), 'CONTENT_BINDING');
        const bindingJSON = JSON.stringify({
            hubId: binding.hubId, deviceId: binding.deviceId,
            sourceId: binding.sourceId, storePath: normalized(binding.storePath),
        });
        const db = new Database(filename);
        try {
            db.pragma('busy_timeout = 5000');
            db.transaction(() => {
                const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
                    .all().map(r => r.name);
                if (!tables.length) {
                    db.exec(`CREATE TABLE catalog_publish_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                        CREATE TABLE catalog_publish_state(
                            id INTEGER PRIMARY KEY CHECK(id=1),
                            version INTEGER NOT NULL,ack_digest TEXT,
                            request_id TEXT,payload TEXT,payload_digest TEXT);`);
                    const put = db.prepare('INSERT INTO catalog_publish_meta VALUES (?,?)');
                    put.run('version', '1'); put.run('binding', bindingJSON);
                    db.exec('INSERT INTO catalog_publish_state VALUES (1,0,NULL,NULL,NULL,NULL)');
                } else {
                    check(JSON.stringify(tables) === JSON.stringify(
                        ['catalog_publish_meta', 'catalog_publish_state']), 'WRONG_DATABASE');
                    const meta = Object.fromEntries(db.prepare('SELECT * FROM catalog_publish_meta').all()
                        .map(r => [r.key, r.value]));
                    check(meta.version === '1', 'SCHEMA_VERSION');
                    check(meta.binding === bindingJSON, 'CONTENT_BINDING');
                }
            }).immediate();
            db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
            this.db = db; this.sourceId = binding.sourceId;
            this.pending(); // Refuse corrupt persisted state before use.
        } catch (error) { db.close(); this.db = null; throw error; }
    }

    _db() {
        check(this.db?.open, 'CLOSED');
        check(!this.db.inTransaction, 'INVALID_ARGUMENT');
        return this.db;
    }

    _row(db) {
        const row = db.prepare('SELECT * FROM catalog_publish_state WHERE id=1').get();
        check(row, 'CORRUPT_CONTENT');
        integer(row.version);
        if (row.ack_digest !== null) hash(row.ack_digest);
        check((row.version === 0) === (row.ack_digest === null), 'CORRUPT_CONTENT');
        return row;
    }

    _pending(row) {
        if (row.request_id === null) {
            check(row.payload === null && row.payload_digest === null, 'CORRUPT_CONTENT');
            return null;
        }
        identifier(row.request_id); hash(row.payload_digest);
        check(typeof row.payload === 'string' &&
            Buffer.byteLength(row.payload, 'utf8') <= MAX_BYTES, 'CORRUPT_CONTENT');
        const decoded = JSON.parse(row.payload);
        const enhanced = !Array.isArray(decoded);
        let normalized;
        if (enhanced) {
            fields(decoded, ['version', 'records', 'details'],
                decoded.version === 3 ? ['codes'] : []);
            check(decoded.version === 2 || decoded.version === 3, 'CORRUPT_CONTENT');
            normalized = decoded.version === 3
                ? require('./catalogCodeInventory').canonicalCodeInventory(
                    this.sourceId, decoded.records, decoded.details, decoded.codes)
                : require('./catalogEngineeringInventory').canonicalEngineeringInventory(
                    this.sourceId, decoded.records, decoded.details);
        } else {
            normalized = canonicalRecords(this.sourceId, decoded);
        }
        check(normalized.payload === row.payload && normalized.digest === row.payload_digest, 'CORRUPT_CONTENT');
        return { sourceId: this.sourceId, expectedVersion: row.version,
            requestId: row.request_id,
            records: enhanced ? decoded.records : decoded,
            ...(enhanced ? { protocolVersion: decoded.version, details: decoded.details } : {}),
            ...(decoded.version === 3 ? { codes: decoded.codes } : {}) };
    }

    pending() { return this._pending(this._row(this._db())); }

    stage(records, options = {}) {
        fields(options, [], ['details', 'codes']);
        const enhanced = Object.hasOwn(options, 'details');
        const withCode = Object.hasOwn(options, 'codes');
        check(!withCode || enhanced, 'INVALID_BODY');
        const normalized = withCode
            ? require('./catalogCodeInventory').canonicalCodeInventory(
                this.sourceId, records, options.details, options.codes)
            : enhanced
                ? require('./catalogEngineeringInventory').canonicalEngineeringInventory(
                    this.sourceId, records, options.details)
                : canonicalRecords(this.sourceId, records);
        const db = this._db();
        return db.transaction(() => {
            const row = this._row(db);
            const pending = this._pending(row);
            if (pending) {
                check(row.payload_digest === normalized.digest, 'REQUEST_CONFLICT');
                return pending;
            }
            if (row.ack_digest === normalized.digest) return null;
            check(row.version < Number.MAX_SAFE_INTEGER, 'COUNTER_EXHAUSTED');
            const requestId = 'catalog-' + crypto.randomUUID();
            const decoded = JSON.parse(normalized.payload);
            const request = { sourceId: this.sourceId, expectedVersion: row.version,
                requestId, records: enhanced ? decoded.records : decoded,
                ...(enhanced ? { protocolVersion: decoded.version, details: decoded.details } : {}),
                ...(withCode ? { codes: decoded.codes } : {}) };
            check(Buffer.byteLength(JSON.stringify(request), 'utf8') <= MAX_BYTES, 'LIMIT_EXCEEDED');
            db.prepare(`UPDATE catalog_publish_state SET request_id=?,payload=?,payload_digest=? WHERE id=1`)
                .run(requestId, normalized.payload, normalized.digest);
            return request;
        }).immediate();
    }

    acknowledge(requestId, receipt) {
        identifier(requestId);
        fields(receipt, ['sourceId', 'version', 'digest', 'receivedAt']);
        integer(receipt.version, 1); hash(receipt.digest); integer(receipt.receivedAt);
        const db = this._db();
        return db.transaction(() => {
            const row = this._row(db);
            check(this._pending(row) !== null && row.request_id === requestId, 'REQUEST_CONFLICT');
            check(receipt.sourceId === this.sourceId && receipt.version === row.version + 1 &&
                receipt.digest === row.payload_digest, 'REQUEST_CONFLICT');
            db.prepare(`UPDATE catalog_publish_state SET version=?,ack_digest=?,
                request_id=NULL,payload=NULL,payload_digest=NULL WHERE id=1`)
                .run(receipt.version, receipt.digest);
            return { version: receipt.version, digest: receipt.digest };
        }).immediate();
    }

    close() { if (this.db?.open) this.db.close(); this.db = null; }
}
module.exports = { CatalogPublishJournal };