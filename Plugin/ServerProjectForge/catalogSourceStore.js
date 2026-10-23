'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { check, identifier, integer, fields, hash } = require('./hubNetworkProtocol');
const { CatalogSnapshot } = require('./catalogSnapshot');
const { canonicalRecords, MAX_BYTES } = require('./catalogInventory');

// INTERNAL: publisher/source authorization must occur before invoking this
// capability. deviceId must come from authentication, not request JSON.
// Each publication is a COMPLETE source inventory, never a partial scan.
// Missing entries disappear from that inventory, not from the origin Forge DB.

class CatalogSourceStore {
    constructor(filename, { hubId, maxSources = 128 } = {}) {
        check(filename === ':memory:' || (typeof filename === 'string' && path.isAbsolute(filename)));
        check(typeof hubId === 'string' && /^hub-[0-9a-f-]{36}$/.test(hubId));
        integer(maxSources, 1, 128);
        const db = new Database(filename);
        try {
            db.pragma('busy_timeout = 5000');
            db.transaction(() => {
                const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
                    .all().map(r => r.name);
                if (!tables.length) {
                    db.exec(`CREATE TABLE catalog_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                        CREATE TABLE catalog_sources(
                            source_id TEXT PRIMARY KEY,device_id TEXT NOT NULL,
                            version INTEGER NOT NULL,request_id TEXT NOT NULL,
                            base_version INTEGER NOT NULL,digest TEXT NOT NULL,
                            payload TEXT NOT NULL,received_at INTEGER NOT NULL);`);
                    const put = db.prepare('INSERT INTO catalog_meta VALUES (?,?)');
                    put.run('version', '1'); put.run('hub_id', hubId);
                    put.run('max_sources', String(maxSources));
                } else {
                    check(JSON.stringify(tables) === JSON.stringify(['catalog_meta', 'catalog_sources']), 'WRONG_DATABASE');
                    const meta = Object.fromEntries(db.prepare('SELECT * FROM catalog_meta').all().map(r => [r.key, r.value]));
                    check(meta.version === '1', 'SCHEMA_VERSION');
                    check(meta.hub_id === hubId && meta.max_sources === String(maxSources), 'CONTENT_BINDING');
                }
            }).immediate();
            db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
            this.db = db; this.maxSources = maxSources;
        } catch (error) { db.close(); throw error; }
    }

    _db() {
        check(this.db?.open, 'CLOSED');
        check(!this.db.inTransaction, 'INVALID_ARGUMENT');
        return this.db;
    }

    publish(args) {
        fields(args, ['sourceId', 'deviceId', 'expectedVersion', 'requestId', 'records'],
            ['protocolVersion', 'details', 'codes']);
        const { sourceId, deviceId, expectedVersion, requestId, records } = args;
        identifier(sourceId); identifier(deviceId); identifier(requestId);
        integer(expectedVersion);
        const enhanced = Object.hasOwn(args, 'protocolVersion');
        check(enhanced === Object.hasOwn(args, 'details'), 'INVALID_BODY');
        if (enhanced) check([2, 3].includes(args.protocolVersion), 'INVALID_BODY');
        const withCode = args.protocolVersion === 3;
        check(withCode === Object.hasOwn(args, 'codes'), 'INVALID_BODY');
        const { payload, digest } = withCode
            ? require('./catalogCodeInventory').canonicalCodeInventory(
                sourceId, records, args.details, args.codes)
            : enhanced
                ? require('./catalogEngineeringInventory').canonicalEngineeringInventory(
                    sourceId, records, args.details)
                : canonicalRecords(sourceId, records);
        const db = this._db();
        return db.transaction(() => {
            const old = db.prepare('SELECT * FROM catalog_sources WHERE source_id=?').get(sourceId);
            if (old) {
                check(old.device_id === deviceId, 'FORBIDDEN');
                if (old.request_id === requestId) {
                    check(old.base_version === expectedVersion && old.digest === digest, 'REQUEST_CONFLICT');
                    return this._receipt(old);
                }
            }
            check((old?.version ?? 0) === expectedVersion, 'REVISION_CONFLICT');
            check(expectedVersion < Number.MAX_SAFE_INTEGER, 'COUNTER_EXHAUSTED');
            if (!old) check(db.prepare('SELECT count(*) AS n FROM catalog_sources').get().n < this.maxSources,
                'CAPACITY_EXCEEDED');
            const receivedAt = Date.now();
            db.prepare(`INSERT INTO catalog_sources VALUES (?,?,?,?,?,?,?,?)
                ON CONFLICT(source_id) DO UPDATE SET
                version=excluded.version,request_id=excluded.request_id,base_version=excluded.base_version,
                digest=excluded.digest,payload=excluded.payload,received_at=excluded.received_at`)
                .run(sourceId, deviceId, expectedVersion + 1, requestId, expectedVersion, digest, payload, receivedAt);
            return this._receipt(db.prepare('SELECT * FROM catalog_sources WHERE source_id=?').get(sourceId));
        }).immediate();
    }

    _receipt(row) {
        return { sourceId: row.source_id, version: row.version, digest: row.digest, receivedAt: row.received_at };
    }

    // Scopes are supplied by the authenticated host, never request JSON.
    list({ sourceIds = [], after = '', limit = 20 } = {}) {
        check(Array.isArray(sourceIds) && sourceIds.length <= 256);
        sourceIds.forEach(identifier);
        if (after !== '') identifier(after);
        integer(limit, 1, 20);
        const db = this._db();
        const ids = [...new Set(sourceIds)];
        if (!ids.length) return { items: [], next: null };
        const rows = db.prepare(
            `SELECT source_id,version,digest,received_at FROM catalog_sources
             WHERE source_id IN (${ids.map(() => '?').join(',')}) AND source_id > ?
             ORDER BY source_id LIMIT ?`
        ).all(...ids, after, limit + 1);
        const selected = rows.slice(0, limit);
        return {
            items: selected.map(row => this._receipt(row)),
            next: rows.length > limit ? selected[selected.length - 1].source_id : null,
        };
    }

    // One SELECT captures a complete committed publication. No subsequent
    // lookup may mix its pinned metadata with another publication's contents.
    _readSource(sourceId) {
        identifier(sourceId);
        const row = this._db().prepare('SELECT * FROM catalog_sources WHERE source_id=?').get(sourceId);
        if (!row) return null;
        check(typeof row.payload === 'string' &&
            Buffer.byteLength(row.payload, 'utf8') <= MAX_BYTES, 'CORRUPT_CONTENT');
        check(crypto.createHash('sha256').update(row.payload).digest('hex') === row.digest, 'CORRUPT_CONTENT');
        let decoded, normalized, records, details = null, codes = null;
        try {
            decoded = JSON.parse(row.payload);
            if (Array.isArray(decoded)) {
                records = decoded;
                normalized = canonicalRecords(sourceId, records);
            } else {
                const withCode = decoded.version === 3;
                fields(decoded, ['version', 'records', 'details'], withCode ? ['codes'] : []);
                check(decoded.version === 2 || withCode);
                normalized = withCode
                    ? require('./catalogCodeInventory').canonicalCodeInventory(
                        sourceId, decoded.records, decoded.details, decoded.codes)
                    : require('./catalogEngineeringInventory').canonicalEngineeringInventory(
                        sourceId, decoded.records, decoded.details);
                records = decoded.records;
                details = decoded.details;
                codes = withCode ? decoded.codes : null;
            }
            check(normalized.payload === row.payload && normalized.digest === row.digest);
        } catch {
            throw Object.assign(new Error('CORRUPT_CONTENT'), { code: 'CORRUPT_CONTENT' });
        }
        return { row, records, details, codes };
    }

    // Scope filtering belongs to the authenticated caller. Legacy responses
    // deliberately retain their shape and never include engineering content.
    get(sourceId) {
        const source = this._readSource(sourceId);
        if (!source) return null;
        return { ...this._receipt(source.row), snapshot: new CatalogSnapshot(source.records) };
    }

    // INTERNAL only: authorization is mandatory at the transport boundary.
    // A version/digest pin establishes consistency, never access permission.
    getEngineering(sourceId, options) {
        fields(options, ['version', 'digest', 'localProjectId']);
        integer(options.version, 1); hash(options.digest); identifier(options.localProjectId);
        const source = this._readSource(sourceId);
        check(source !== null, 'CONTENT_NOT_FOUND');
        check(source.row.version === options.version && source.row.digest === options.digest,
            'REQUEST_CONFLICT');
        check(source.records.some(r => r.project.id === options.localProjectId), 'NOT_FOUND');
        if (source.details === null) return { version: 1, state: 'not-shared' };
        const entry = source.details.find(r => r.localProjectId === options.localProjectId);
        check(entry, 'CORRUPT_CONTENT');
        return JSON.parse(JSON.stringify(entry.detail));
    }

    // INTERNAL: transport must independently authorize code access AND source scope.
    // Node IDs are source/project-local. Never resolve an arbitrary blob hash.
    getCode(sourceId, options) {
        fields(options, ['version', 'digest', 'localProjectId', 'node']);
        integer(options.version, 1); hash(options.digest);
        identifier(options.localProjectId); integer(options.node, 1);
        const source = this._readSource(sourceId);
        check(source !== null, 'CONTENT_NOT_FOUND');
        check(source.row.version === options.version && source.row.digest === options.digest,
            'REQUEST_CONFLICT');
        check(source.records.some(r => r.project.id === options.localProjectId), 'NOT_FOUND');
        if (source.codes === null) return { version: 1, state: 'not-shared' };
        const entry = source.codes.find(r => r.localProjectId === options.localProjectId);
        check(entry, 'CORRUPT_CONTENT');
        if (entry.code.state === 'not-shared') return { version: 1, state: 'not-shared' };
        const file = entry.code.files.find(row => row.node === options.node);
        check(file, 'NOT_FOUND');
        return { version: 1, state: 'shared', file: JSON.parse(JSON.stringify(file)) };
    }

    close() { if (this.db?.open) this.db.close(); this.db = null; }
}
module.exports = { CatalogSourceStore };