'use strict';
// Explicit async transport. No auto-retry, background scheduling or local mapping mutation.
// A failed write may already have committed: recover using the original persistent requestId.
const http = require('node:http'), https = require('node:https');
const { validateProjectBundle } = require('./projectBundle');
const P = require('./hubNetworkProtocol');
const { check, identifier, integer, hash, fields } = P;
const GLOBAL = /^g_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function globalId(value) { check(typeof value === 'string' && GLOBAL.test(value)); return value; }
function revisionOf(value, projectId, revision) {
    check(value && value.projectId === projectId && value.revision === revision, 'INVALID_RESPONSE');
    hash(value.bundleHash); integer(value.baseRevision); integer(value.fence, 1);
    identifier(value.holder); identifier(value.requestId); integer(value.publishedAt);
    check(value.baseRevision + 1 === value.revision, 'INVALID_RESPONSE');
    return value;
}
class HubNetworkClient {
    #token;
    #endpoint;
    #ca;
    #pathPrefix;
    constructor(baseUrl, { token, hubId, deviceId, limits, ca, pathPrefix = '' } = {}) {
        this.#endpoint = P.origin(baseUrl);
        check(typeof pathPrefix === 'string' && pathPrefix.length <= 128 &&
            (pathPrefix === '' || /^\/[A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)*$/.test(pathPrefix)),
        'UNSAFE_ENDPOINT');
        this.#pathPrefix = pathPrefix;
        this.#token = P.bearer(token);
        check(typeof hubId === 'string' && /^hub-[0-9a-f-]{36}$/.test(hubId));
        this.hubId = hubId; this.deviceId = identifier(deviceId); this.limits = P.limits(limits);
        check(ca === undefined || Buffer.isBuffer(ca) || typeof ca === 'string');
        this.#ca = ca === undefined ? undefined : Buffer.isBuffer(ca) ? Buffer.from(ca) : ca;
        Object.freeze(this.limits);
        Object.freeze(this);
    }
    _lease(args) {
        globalId(args.projectId); hash(args.leaseId); integer(args.fence, 1);
        check(args.holder === this.deviceId, 'INVALID_ARGUMENT');
        return { leaseId: args.leaseId, fence: args.fence };
    }
    _request(method, route, { value, bytes, headers = {}, maximum = this.limits.maxResponseBytes, binary = false } = {}) {
        check(route.startsWith('/v1/') && !/[?%#\\]/.test(route));
        let payload;
        if (bytes !== undefined) {
            check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= this.limits.maxBundleBytes, 'LIMIT_EXCEEDED');
            payload = Buffer.from(bytes);
        } else if (value !== undefined) {
            payload = Buffer.from(JSON.stringify(value));
            check(payload.length <= this.limits.maxJsonBytes, 'LIMIT_EXCEEDED');
        }
        const requestHeaders = {
            Authorization: 'Bearer ' + this.#token,
            Accept: binary ? 'application/octet-stream' : 'application/json',
            Connection: 'close', ...headers, 'X-PF-Hub-Id': this.hubId,
        };
        if (payload) {
            requestHeaders['Content-Type'] = bytes === undefined ? 'application/json' : 'application/octet-stream';
            requestHeaders['Content-Length'] = String(payload.length);
        }
        return new Promise((resolve, reject) => {
            let settled = false, response, timer, req;
            const finish = (error, result) => {
                if (settled) return;
                settled = true; clearTimeout(timer);
                if (error) { reject(error); response?.destroy(); req?.destroy(); }
                else resolve(result);
            };
            const fail = code => finish(new P.NetworkError(code));
            try {
                req = (this.#endpoint.protocol === 'https:' ? https : http).request({
                    protocol: this.#endpoint.protocol, hostname: this.#endpoint.hostname.replace(/^\[|\]$/g, ''),
                    port: this.#endpoint.port || undefined, path: this.#pathPrefix + route, method, headers: requestHeaders,
                    agent: false, maxHeaderSize: 8192, rejectUnauthorized: true, minVersion: 'TLSv1.2',
                    ...(this.#ca === undefined ? {} : { ca: this.#ca }),
                }, res => {
                    response = res;
                    if (settled) { res.destroy(); return; }
                    if (res.statusCode >= 300 && res.statusCode < 400) { fail('REDIRECT_REFUSED'); return; }
                    const successful = res.statusCode === 200;
                    const max = successful ? maximum : this.limits.maxResponseBytes;
                    const counts = new Map();
                    for (let i = 0; i < res.rawHeaders.length; i += 2) {
                        const k = res.rawHeaders[i].toLowerCase(); counts.set(k, (counts.get(k) || 0) + 1);
                    }
                    const length = res.headers['content-length'];
                    if (['content-length', 'content-type', 'x-pf-hub-id', 'x-pf-bundle-hash']
                        .some(k => (counts.get(k) || 0) > 1) ||
                        res.headers['content-encoding'] || res.headers['transfer-encoding'] ||
                        typeof length !== 'string' || !/^(0|[1-9][0-9]*)$/.test(length)) {
                        fail('INVALID_RESPONSE'); return;
                    }
                    const expected = Number(length);
                    if (!Number.isSafeInteger(expected) || expected > max) { fail('RESPONSE_TOO_LARGE'); return; }
                    const wantType = successful && binary ? 'application/octet-stream' : 'application/json';
                    if (res.headers['content-type'] !== wantType) { fail('INVALID_RESPONSE'); return; }
                    const chunks = []; let received = 0;
                    res.on('data', chunk => {
                        if (settled) return;
                        received += chunk.length;
                        if (received > max || received > expected) { fail('RESPONSE_TOO_LARGE'); return; }
                        chunks.push(chunk);
                    });
                    res.once('aborted', () => fail('NETWORK_ERROR'));
                    res.once('error', () => fail('NETWORK_ERROR'));
                    res.once('end', () => {
                        if (settled) return;
                        if (received !== expected) { fail('INVALID_RESPONSE'); return; }
                        const data = Buffer.concat(chunks, received);
                        if (successful && binary) {
                            if (res.headers['x-pf-hub-id'] !== this.hubId) { fail('HUB_MISMATCH'); return; }
                            finish(null, { bytes: data, hash: res.headers['x-pf-bundle-hash'] }); return;
                        }
                        let parsed;
                        try {
                            check(Buffer.from(data.toString('utf8'), 'utf8').equals(data));
                            parsed = JSON.parse(data.toString('utf8'));
                        } catch { fail('INVALID_RESPONSE'); return; }
                        if (!successful) {
                            const code = parsed?.error?.code;
                            fail(typeof code === 'string' && P.safeCode({ code }) === code ? code : 'REMOTE_ERROR'); return;
                        }
                        if (parsed?.hubId !== this.hubId) { fail('HUB_MISMATCH'); return; }
                        if (!Object.hasOwn(parsed, 'result')) { fail('INVALID_RESPONSE'); return; }
                        finish(null, parsed.result);
                    });
                });
                req.once('error', () => fail('NETWORK_ERROR'));
                timer = setTimeout(() => fail('REQUEST_TIMEOUT'), this.limits.requestMs);
                req.end(payload);
            } catch { fail('NETWORK_ERROR'); }
        });
    }
    async identity() {
        const result = await this._request('GET', '/v1/identity');
        check(result?.protocol === 1 && result.deviceId === this.deviceId, 'IDENTITY_MISMATCH');
        return { hubId: this.hubId, ...result };
    }
    async registerProject(args) {
        fields(args, ['originId', 'localProjectId', 'name']);
        identifier(args.originId); identifier(args.localProjectId);
        const result = await this._request('POST', '/v1/projects', { value: args });
        globalId(result?.id);
        check(result.originId === args.originId && result.localProjectId === args.localProjectId, 'INVALID_RESPONSE');
        return result;
    }
    async getProject(projectId) {
        globalId(projectId);
        const result = await this._request('GET', '/v1/projects/' + projectId);
        check(result?.id === projectId, 'INVALID_RESPONSE'); integer(result.revision);
        return result;
    }
    async acquireLease({ projectId, requestId, ttlMs }) {
        globalId(projectId); identifier(requestId);
        const result = await this._request('POST', '/v1/projects/' + projectId + '/lease/acquire',
            { value: { requestId, ...(ttlMs === undefined ? {} : { ttlMs }) } });
        this._lease(result); check(result.projectId === projectId, 'INVALID_RESPONSE');
        integer(result.expiresAt); integer(result.revision); return result;
    }
    async renewLease(args) {
        const value = this._lease(args);
        if (args.ttlMs !== undefined) value.ttlMs = args.ttlMs;
        const result = await this._request('POST', '/v1/projects/' + args.projectId + '/lease/renew', { value });
        this._lease(result);
        check(result.projectId === args.projectId && result.leaseId === args.leaseId && result.fence === args.fence, 'INVALID_RESPONSE');
        integer(result.expiresAt); integer(result.revision); return result;
    }
    async releaseLease(args) {
        const result = await this._request('POST', '/v1/projects/' + args.projectId + '/lease/release', { value: this._lease(args) });
        check(result?.projectId === args.projectId && result.fence === args.fence && result.released === true, 'INVALID_RESPONSE');
        return result;
    }
    async uploadBundle({ projectId, bundle, expectedHash, lease }) {
        globalId(projectId); hash(expectedHash);
        check(lease?.projectId === projectId); this._lease(lease);
        check(Buffer.isBuffer(bundle) && bundle.length <= this.limits.maxBundleBytes, 'LIMIT_EXCEEDED');
        validateProjectBundle(bundle, { expectedHash });
        const result = await this._request('PUT', '/v1/projects/' + projectId + '/bundles/' + expectedHash, {
            bytes: bundle, headers: { 'X-PF-Lease-Id': lease.leaseId, 'X-PF-Fence': String(lease.fence) },
        });
        check(result?.hash === expectedHash && result.size === bundle.length && result.stored === true, 'INVALID_RESPONSE');
        return result;
    }
    async publishRevision(args) {
        const lease = this._lease(args); identifier(args.requestId); integer(args.expectedRevision); hash(args.bundleHash);
        const result = await this._request('POST', '/v1/projects/' + args.projectId + '/revisions', {
            value: { ...lease, requestId: args.requestId, expectedRevision: args.expectedRevision, bundleHash: args.bundleHash },
        });
        revisionOf(result, args.projectId, args.expectedRevision + 1);
        check(result.requestId === args.requestId && result.bundleHash === args.bundleHash &&
            result.holder === this.deviceId && result.fence === args.fence, 'INVALID_RESPONSE');
        return result;
    }
    async getRevision(projectId, revision) {
        globalId(projectId); integer(revision, 1);
        return revisionOf(await this._request('GET', '/v1/projects/' + projectId + '/revisions/' + revision), projectId, revision);
    }
    async downloadRevision(projectId, revision) {
        const published = await this.getRevision(projectId, revision);
        const result = await this._request('GET', '/v1/projects/' + projectId + '/revisions/' + revision + '/bundle',
            { binary: true, maximum: this.limits.maxBundleBytes });
        check(result.hash === published.bundleHash, 'HASH_MISMATCH');
        validateProjectBundle(result.bytes, { expectedHash: published.bundleHash });
        return { revision: published, bytes: result.bytes };
    }
}
module.exports = { HubNetworkClient };