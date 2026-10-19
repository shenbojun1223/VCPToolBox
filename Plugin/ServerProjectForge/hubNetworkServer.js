'use strict';
// Opt-in standalone capability. Does not install routes, load credentials or start listening on import.
// TLS terminates here for non-loopback binds; proxy forwarding headers confer no trust.
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const crypto = require('node:crypto'), http = require('node:http'), https = require('node:https');
const Database = require('better-sqlite3');
const { HubStore } = require('./hubStore');
const P = require('./hubNetworkProtocol');
const { check, fields, identifier, integer, hash } = P;
const TABLES = ['network_meta', 'network_uploads'];
const SCHEMA = `
CREATE TABLE network_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE network_uploads(
 project_id TEXT NOT NULL,bundle_hash TEXT NOT NULL,size INTEGER NOT NULL,
 uploaded_by TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(project_id,bundle_hash)
);`;
const GLOBAL = 'g_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROUTE = new RegExp('^/v1/projects/(' + GLOBAL + ')(?:/(lease/(acquire|renew|release)|bundles/([0-9a-f]{64})|revisions(?:/([1-9][0-9]{0,14})(/bundle)?)?))?$');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function principalsOf(entries) {
    check(Array.isArray(entries) && entries.length > 0 && entries.length <= 128);
    const result = new Map();
    for (const entry of entries) {
        fields(entry, ['token', 'deviceId', 'originIds', 'projectIds', 'permissions']);
        const token = sha(P.bearer(entry.token));
        identifier(entry.deviceId);
        check(!result.has(token));
        for (const key of ['originIds', 'projectIds', 'permissions']) {
            check(Array.isArray(entry[key]) && entry[key].length <= 256);
        }
        entry.originIds.forEach(identifier); entry.projectIds.forEach(identifier);
        check(entry.permissions.length > 0 && entry.permissions.every(v => ['read', 'write', 'register'].includes(v)));
        result.set(token, {
            deviceId: entry.deviceId, origins: new Set(entry.originIds),
            projects: new Set(entry.projectIds), permissions: new Set(entry.permissions),
        });
    }
    return result;
}
function openReceipts(file, binding, maxReceipts) {
    check(typeof file === 'string' && path.isAbsolute(file));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    try {
        db.pragma('busy_timeout = 5000');
        db.transaction(() => {
            const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
                .all().map(row => row.name);
            if (!tables.length) {
                db.exec(SCHEMA);
                const insert = db.prepare('INSERT INTO network_meta VALUES (?,?)');
                for (const [k, v] of Object.entries({ version: '1', ...binding, max_receipts: String(maxReceipts) })) insert.run(k, v);
            } else {
                check(JSON.stringify(tables) === JSON.stringify(TABLES), 'WRONG_DATABASE');
                const meta = Object.fromEntries(db.prepare('SELECT * FROM network_meta').all().map(r => [r.key, r.value]));
                check(meta.version === '1', 'SCHEMA_VERSION');
                check(Object.entries(binding).every(([k, v]) => meta[k] === v), 'CONTENT_BINDING');
                check(meta.max_receipts === String(maxReceipts), 'QUOTA_MISMATCH');
            }
        }).immediate();
        db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
        return db;
    } catch (error) { db.close(); throw error; }
}
function readBody(req, maximum, binary) {
    const contentType = binary ? 'application/octet-stream' : 'application/json';
    check(req.headers['content-type'] === contentType, 'UNSUPPORTED_MEDIA');
    check(!req.headers['content-encoding'] && !req.headers['transfer-encoding'], 'UNSUPPORTED_MEDIA');
    const raw = req.headers['content-length'];
    check(typeof raw === 'string' && /^(0|[1-9][0-9]*)$/.test(raw), 'BAD_LENGTH');
    const expected = Number(raw);
    check(Number.isSafeInteger(expected) && expected <= maximum, 'BODY_TOO_LARGE');
    return new Promise((resolve, reject) => {
        const chunks = []; let length = 0, ended = false;
        const fail = code => { if (!ended) { ended = true; reject(new P.NetworkError(code)); } };
        req.on('data', chunk => {
            if (ended) return;
            length += chunk.length;
            if (length > maximum || length > expected) { fail('BODY_TOO_LARGE'); return; }
            chunks.push(chunk);
        });
        req.once('aborted', () => fail('BAD_LENGTH'));
        req.once('error', () => fail('BAD_LENGTH'));
        req.once('end', () => {
            if (ended) return;
            ended = true;
            if (length !== expected) { reject(new P.NetworkError('BAD_LENGTH')); return; }
            const bytes = Buffer.concat(chunks, length);
            if (binary) { resolve(bytes); return; }
            try {
                check(Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes), 'INVALID_JSON');
                resolve(JSON.parse(bytes.toString('utf8')));
            } catch { reject(new P.NetworkError('INVALID_JSON')); }
        });
    });
}
class HubNetworkServer {
    constructor(hub, receiptPath, { principals, host = '127.0.0.1', port = 0, tls = null,
        limits: overrides, _testHook = null } = {}) {
        check(hub instanceof HubStore);
        this.hub = hub; this.hubId = hub.getHubId(); this.contentId = hub.contentStore.getId();
        check(!hub.db.inTransaction);
        check(net.isIP(host) !== 0); integer(port, 0, 65535);
        check(P.loopback(host) || tls, 'TLS_REQUIRED');
        check(!['0.0.0.0', '::'].includes(host), 'INVALID_ARGUMENT'); // Concrete bind address defines allowed Host.
        if (tls !== null) fields(tls, ['key', 'cert']);
        check(tls === null || (tls && (Buffer.isBuffer(tls.key) || typeof tls.key === 'string') &&
            (Buffer.isBuffer(tls.cert) || typeof tls.cert === 'string')));
        check(_testHook === null || typeof _testHook === 'function');
        this.host = host; this.port = port; this.limits = P.limits(overrides);
        this._principals = principalsOf(principals); this._testHook = _testHook;
        this.db = openReceipts(receiptPath, { hub_id: this.hubId, content_id: this.contentId }, this.limits.maxReceipts);
        this.active = 0; this.closed = false; this.authority = null; this.sockets = new Set();
        try {
            this.server = (tls ? https : http).createServer({
                ...(tls || {}), minVersion: 'TLSv1.2', maxHeaderSize: 8192, connectionsCheckingInterval: 100,
            }, (req, res) => { void this._handle(req, res); });
        } catch (error) { this.db.close(); this.db = null; throw error; }
        this.server.on('connection', socket => {
            this.sockets.add(socket);
            socket.once('close', () => this.sockets.delete(socket));
            // Bound partial headers and TLS handshakes even before a request callback exists.
            const timer = setTimeout(() => socket.destroy(), this.limits.requestMs);
            const clear = () => clearTimeout(timer);
            socket.once('close', clear);

        });
        this.protocol = tls ? 'https:' : 'http:';
        this.server.maxConnections = this.limits.maxConnections;
        this.server.maxHeadersCount = 0; // Collect bounded raw headers; reject rather than silently truncate.
        this.server.headersTimeout = Math.min(5000, this.limits.requestMs);
        this.server.requestTimeout = this.limits.requestMs;
        this.server.setTimeout(this.limits.requestMs, socket => socket.destroy());
        this.server.on('clientError', (_error, socket) => { socket.destroy(); });
        this.server.on('checkContinue', (_req, res) => {
            res.writeHead(417, { Connection: 'close', 'Content-Length': '0' }); res.end();
        });
        this.server.on('checkExpectation', (_req, res) => {
            res.writeHead(417, { Connection: 'close', 'Content-Length': '0' }); res.end();
        });
    }
    _emit(event) { if (this._testHook) this._testHook(event); }
    _bound() {
        check(!this.closed && this.db?.open, 'CLOSED');
        check(!this.db.inTransaction && !this.hub.db?.inTransaction, 'INVALID_ARGUMENT');
        check(this.hub.getHubId() === this.hubId && this.hub.contentStore.getId() === this.contentId, 'CONTENT_BINDING');
    }
    async listen() {
        check(!this.closed && !this.authority && !this.server.listening);
        // Store the authority in the listening callback, before HTTP requests may be handled.
        await new Promise((resolve, reject) => {
            const onError = error => { this.server.off('listening', onListen); reject(error); };
            const onListen = () => {
                this.server.off('error', onError);
                const address = this.server.address();
                this.authority = (this.host.includes(':') ? '[' + this.host + ']' : this.host) + ':' + address.port;
                resolve();
            };
            this.server.once('error', onError); this.server.once('listening', onListen);
            this.server.listen({ host: this.host, port: this.port });
        });
        return { baseUrl: this.protocol + '//' + this.authority, hubId: this.hubId };
    }
    async close() {
        if (this.closed) return;
        this.closed = true;
        await new Promise(resolve => {
            this.server.close(() => resolve());
            this.server.closeAllConnections();
            for (const socket of this.sockets) socket.destroy();
        });
        if (this.db?.open) this.db.close();
        this.db = null;
    }
    _send(res, value, code = 200) {
        if (res.destroyed || res.writableEnded) return;
        let bytes = Buffer.from(JSON.stringify(value));
        if (bytes.length > this.limits.maxResponseBytes) {
            bytes = Buffer.from('{"error":{"code":"LIMIT_EXCEEDED"}}');
            code = 413;
        }
        res.writeHead(code, {
            'Content-Type': 'application/json', 'Content-Length': String(bytes.length),
            'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close',
        });
        res.end(bytes);
    }
    _authorize(principal, id, permission) {
        check(principal.permissions.has(permission), 'FORBIDDEN');
        let project;
        try { project = this.hub.getProject(id); } catch { throw new P.NetworkError('FORBIDDEN'); }
        check(principal.projects.has(id) || principal.origins.has(project.originId), 'FORBIDDEN');
        return project;
    }
    _lease(principal, projectId, value) {
        hash(value.leaseId); integer(value.fence, 1);
        return { projectId, holder: principal.deviceId, leaseId: value.leaseId, fence: value.fence };
    }
    async _handle(req, res) {
        req.on('error', () => {});
        res.on('error', () => {});
        let counted = false, timer;
        const finish = () => { clearTimeout(timer); if (counted) { counted = false; this.active--; } };
        res.once('finish', finish); res.once('close', finish);
        const deadline = Date.now() + this.limits.requestMs;
        const live = () => check(!req.aborted && !res.destroyed && Date.now() < deadline, 'REQUEST_TIMEOUT');
        try {
            this._bound();
            check(this.active < this.limits.maxInflight, 'BUSY');
            this.active++; counted = true;
            timer = setTimeout(() => { this._send(res, { error: { code: 'REQUEST_TIMEOUT' } }, 408); req.destroy(); }, this.limits.requestMs);
            check(req.rawHeaders.length <= 64, 'INVALID_HEADERS');
            const counts = new Map();
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
                const key = req.rawHeaders[i].toLowerCase(); counts.set(key, (counts.get(key) || 0) + 1);
            }
            for (const key of ['host', 'authorization', 'content-length', 'content-type', 'content-encoding',
                'transfer-encoding', 'x-pf-lease-id', 'x-pf-fence', 'x-pf-hub-id']) check((counts.get(key) || 0) <= 1, 'INVALID_HEADERS');
            check(req.headers.host === this.authority && !counts.has('origin') &&
                !req.headers['transfer-encoding'] && !req.headers['content-encoding'], 'INVALID_HEADERS');
            const auth = req.headers.authorization;
            check(typeof auth === 'string' && /^Bearer [A-Za-z0-9_-]{43,128}$/.test(auth), 'UNAUTHENTICATED');
            const principal = this._principals.get(sha(auth.slice(7)));
            check(principal, 'UNAUTHENTICATED');
            check(req.headers['x-pf-hub-id'] === this.hubId, 'HUB_MISMATCH');
            check(typeof req.url === 'string' && req.url.length <= 512 && !/[?%#\\]/.test(req.url), 'NOT_FOUND');
            if (req.method === 'GET') check(!req.headers['content-length'] || req.headers['content-length'] === '0', 'BAD_LENGTH');
            if (req.method === 'GET' && req.url === '/v1/identity') {
                this._send(res, { hubId: this.hubId, result: { protocol: 1, deviceId: principal.deviceId } }); return;
            }
            if (req.method === 'POST' && req.url === '/v1/projects') {
                check(principal.permissions.has('register'), 'FORBIDDEN');
                const body = fields(await readBody(req, this.limits.maxJsonBytes, false), ['originId', 'localProjectId', 'name']);
                live(); identifier(body.originId); identifier(body.localProjectId);
                check(principal.origins.has(body.originId), 'FORBIDDEN');
                this._send(res, { hubId: this.hubId, result: this.hub.registerProject(body) }); return;
            }
            const match = ROUTE.exec(req.url); check(match, 'NOT_FOUND');
            const [, id, suffix, action, bundleHash, revisionText, bundleSuffix] = match;
            const permission = req.method === 'GET' ? 'read' : 'write';
            this._authorize(principal, id, permission);
            if (!suffix && req.method === 'GET') {
                this._send(res, { hubId: this.hubId, result: this.hub.getProject(id) }); return;
            }
            if (action && req.method === 'POST') {
                const body = await readBody(req, this.limits.maxJsonBytes, false); live();
                let result;
                if (action === 'acquire') {
                    fields(body, ['requestId'], ['ttlMs']);
                    result = this.hub.acquireLease({ ...body, projectId: id, holder: principal.deviceId });
                } else {
                    fields(body, ['leaseId', 'fence'], action === 'renew' ? ['ttlMs'] : []);
                    const args = { ...this._lease(principal, id, body), ...(action === 'renew' ? { ttlMs: body.ttlMs } : {}) };
                    result = action === 'renew' ? this.hub.renewLease(args) : this.hub.releaseLease(args);
                }
                this._send(res, { hubId: this.hubId, result }); return;
            }
            if (bundleHash && req.method === 'PUT') {
                const rawFence = req.headers['x-pf-fence'];
                check(typeof rawFence === 'string' && /^[1-9][0-9]{0,14}$/.test(rawFence));
                const lease = this._lease(principal, id, { leaseId: req.headers['x-pf-lease-id'], fence: Number(rawFence) });
                this.hub.assertLease(lease);
                const bytes = await readBody(req, this.limits.maxBundleBytes, true);
                live(); this._authorize(principal, id, 'write'); this.hub.assertLease(lease);
                const stored = this.hub.contentStore.put(bytes, { expectedHash: bundleHash });
                this._emit('upload-content-stored');
                live(); this.hub.assertLease(lease);
                this.db.transaction(() => {
                    if (!this.db.prepare('SELECT 1 FROM network_uploads WHERE project_id=? AND bundle_hash=?').get(id, bundleHash)) {
                        check(this.db.prepare('SELECT COUNT(*) AS n FROM network_uploads').get().n < this.limits.maxReceipts, 'CAPACITY_EXCEEDED');
                        this.db.prepare('INSERT INTO network_uploads VALUES (?,?,?,?,?)')
                            .run(id, bundleHash, stored.size, principal.deviceId, new Date().toISOString());
                    }
                }).immediate();
                this._emit('upload-receipt-committed');
                this._send(res, { hubId: this.hubId, result: stored }); return;
            }
            if (suffix === 'revisions' && req.method === 'POST') {
                const body = fields(await readBody(req, this.limits.maxJsonBytes, false),
                    ['leaseId', 'fence', 'requestId', 'expectedRevision', 'bundleHash']);
                live(); const lease = this._lease(principal, id, body); hash(body.bundleHash);
                check(this.db.prepare('SELECT 1 FROM network_uploads WHERE project_id=? AND bundle_hash=?').get(id, body.bundleHash), 'UPLOAD_REQUIRED');
                const result = this.hub.publishRevision({ ...body, ...lease });
                this._emit('revision-published');
                this._send(res, { hubId: this.hubId, result }); return;
            }
            if (revisionText && req.method === 'GET') {
                const revision = integer(Number(revisionText), 1);
                if (bundleSuffix) {
                    const downloaded = this.hub.downloadRevision(id, revision); live();
                    check(downloaded.bytes.length <= this.limits.maxBundleBytes, 'LIMIT_EXCEEDED');
                    res.writeHead(200, {
                        'Content-Type': 'application/octet-stream', 'Content-Length': String(downloaded.bytes.length),
                        'X-PF-Hub-Id': this.hubId, 'X-PF-Bundle-Hash': downloaded.revision.bundleHash,
                        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close',
                    });
                    res.end(downloaded.bytes);
                } else {
                    const result = this.hub.getRevision(id, revision); check(result, 'NOT_FOUND');
                    this._send(res, { hubId: this.hubId, result });
                }
                return;
            }
            throw new P.NetworkError('METHOD_NOT_ALLOWED');
        } catch (error) {
            const code = P.safeCode(error);
            this._send(res, { error: { code } }, P.status(code));
        }
    }
}
module.exports = { HubNetworkServer };