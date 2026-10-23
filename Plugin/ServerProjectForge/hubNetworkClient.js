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
    async getCatalogCode(sourceId, options) {
        fields(options, ['localProjectId', 'version', 'digest', 'node'], ['cursor']);
        const { codeBinding, validateCodePage } = require('./catalogCodePages');
        const binding = codeBinding({
            sourceId, localProjectId: options.localProjectId,
            version: options.version, digest: options.digest, node: options.node,
        });
        const cursor = options.cursor === undefined ? null : options.cursor;
        if (cursor !== null) {
            fields(cursor, ['snapshot', 'offset']);
            hash(cursor.snapshot);
            integer(cursor.offset, 1, require('./catalogCodePages').MAX_CODE_BYTES - 1);
        }
        const result = await this._request('POST', '/v1/catalog/code/detail', {
            value: { ...binding, cursor },
        });
        try {
            fields(result, ['sourceId', 'localProjectId', 'version', 'digest', 'node', 'page']);
            for (const key of Object.keys(binding)) check(result[key] === binding[key]);
            validateCodePage(result.page, cursor);
        } catch {
            throw new P.NetworkError('INVALID_RESPONSE');
        }
        return result;
    }

    async publishCatalogSource(args) {
        fields(args, ['sourceId', 'expectedVersion', 'requestId', 'records'],
            ['protocolVersion', 'details', 'codes']);
        identifier(args.sourceId); identifier(args.requestId);
        integer(args.expectedVersion, 0, Number.MAX_SAFE_INTEGER - 1);
        const enhanced = Object.hasOwn(args, 'protocolVersion');
        check(enhanced === Object.hasOwn(args, 'details'), 'INVALID_BODY');
        if (enhanced) check([2, 3].includes(args.protocolVersion), 'INVALID_BODY');
        const withCode = args.protocolVersion === 3;
        check(withCode === Object.hasOwn(args, 'codes'), 'INVALID_BODY');
        const { canonicalRecords, MAX_BYTES } = require('./catalogInventory');
        const { payload, digest } = withCode
            ? require('./catalogCodeInventory').canonicalCodeInventory(
                args.sourceId, args.records, args.details, args.codes)
            : enhanced
                ? require('./catalogEngineeringInventory').canonicalEngineeringInventory(
                    args.sourceId, args.records, args.details)
                : canonicalRecords(args.sourceId, args.records);
        const decoded = JSON.parse(payload);
        const bytes = Buffer.from(JSON.stringify({
            sourceId: args.sourceId, expectedVersion: args.expectedVersion,
            requestId: args.requestId, records: enhanced ? decoded.records : decoded,
            ...(enhanced ? { protocolVersion: decoded.version, details: decoded.details } : {}),
            ...(withCode ? { codes: decoded.codes } : {}),
        }), 'utf8');
        check(bytes.length <= Math.min(MAX_BYTES, this.limits.maxBundleBytes), 'LIMIT_EXCEEDED');
        // Caller must persist the request ID, base version and frozen records
        // before calling. A bad/lost reply does NOT prove the write failed.
        // Never retry enhanced content through the legacy route: that could
        // acknowledge a publication after silently discarding its details.
        const route = withCode ? '/v1/catalog/code/publish'
            : enhanced ? '/v1/catalog/engineering/publish' : '/v1/catalog/source/publish';
        const result = await this._request('POST', route, { bytes });
        try {
            fields(result, ['sourceId', 'version', 'digest', 'receivedAt']);
            check(result.sourceId === args.sourceId &&
                result.version === args.expectedVersion + 1 && result.digest === digest);
            integer(result.receivedAt);
        } catch { throw new P.NetworkError('INVALID_RESPONSE'); }
        return result;
    }

    async getCatalogEngineering(sourceId, options) {
        identifier(sourceId);
        fields(options, ['localProjectId', 'version', 'digest', 'section'],
            ['cursor', 'limit']);
        const { localProjectId, version, digest, section, cursor = null, limit = 50 } = options;
        identifier(localProjectId); integer(version, 1); hash(digest);
        check(['report', 'timeline', 'files'].includes(section));
        integer(limit, 1, 200);
        if (cursor !== null) {
            fields(cursor, ['snapshot', 'section', 'offset']);
            hash(cursor.snapshot);
            check(cursor.section === section);
            integer(cursor.offset, 1);
        }
        const result = await this._request('POST', '/v1/catalog/engineering/detail', {
            value: { sourceId, localProjectId, version, digest, section, cursor, limit },
        });
        try {
            const { DETAIL_LIMITS: L } = require('./catalogEngineeringDetail');
            const { validateEngineeringDetail } = require('./catalogEngineeringInventory');
            fields(result, ['sourceId', 'localProjectId', 'version', 'digest', 'page']);
            check(result.sourceId === sourceId && result.localProjectId === localProjectId &&
                result.version === version && result.digest === digest);
            const page = result.page;
            fields(page, ['snapshot', 'section', 'state', 'metadata', 'total', 'items', 'next']);
            hash(page.snapshot);
            check(page.section === section && ['shared', 'not-shared'].includes(page.state));
            check(Buffer.byteLength(JSON.stringify(page), 'utf8') <= 32 * 1024);
            const maximum = section === 'report' ? Math.ceil(L.reportChars / 1023)
                : section === 'timeline' ? L.maxBatches : L.maxFiles;
            integer(page.total, 0, maximum);
            check(Array.isArray(page.items) && page.items.length <= limit);
            const start = cursor === null ? 0 : cursor.offset;
            if (cursor !== null) {
                check(cursor.snapshot === page.snapshot && start < page.total);
            }
            const end = start + page.items.length;
            check(end <= page.total && (page.items.length > 0 || end === page.total));
            if (end < page.total) {
                fields(page.next, ['snapshot', 'section', 'offset']);
                check(page.next.snapshot === page.snapshot && page.next.section === section);
                integer(page.next.offset, 1);
                check(page.next.offset === end);
            } else {
                check(page.next === null);
            }
            if (page.state === 'not-shared') {
                check(page.metadata === null && page.total === 0 &&
                    page.items.length === 0 && page.next === null && cursor === null);
                return result;
            }
            if (section === 'report') {
                const m = page.metadata;
                fields(m, ['present', 'by', 'truncated']);
                check(typeof m.present === 'boolean');
                check(m.by === null || (typeof m.by === 'string' && m.by.length <= L.authorChars));
                check(Array.isArray(m.truncated) && m.truncated.length <= 2 &&
                    new Set(m.truncated).size === m.truncated.length &&
                    m.truncated.every(k => k === 'text' || k === 'by'));
                if (m.truncated.includes('text')) check(m.present && page.total > 0);
                if (m.truncated.includes('by')) {
                    check(typeof m.by === 'string' && m.by.length >= L.authorChars - 1);
                }
                if (!m.present) check(page.total === 0 && !m.truncated.includes('text'));
                let expectedOffset = start === 0 ? 0 : null;
                for (const chunk of page.items) {
                    fields(chunk, ['offset', 'text']);
                    integer(chunk.offset, 0, L.reportChars - 1);
                    check(typeof chunk.text === 'string' &&
                        chunk.text.length > 0 && chunk.text.length <= 1024);
                    check(chunk.offset + chunk.text.length <= L.reportChars);
                    if (expectedOffset !== null) check(chunk.offset === expectedOffset);
                    check(!/[\uD800-\uDBFF]$/.test(chunk.text) &&
                        !/^[\uDC00-\uDFFF]/.test(chunk.text));
                    expectedOffset = chunk.offset + chunk.text.length;
                }
            } else {
                const m = page.metadata;
                fields(m, ['total', 'truncated']);
                integer(m.total);
                check(typeof m.truncated === 'boolean' && m.total >= page.total &&
                    m.truncated === (m.total > page.total));
                check(m.total === 0 || page.total > 0);
                // Reuse strict row validation on a page-sized synthetic detail.
                // Whole-section counts are checked separately above.
                const partial = {
                    version: 1, state: 'shared',
                    report: { text: null, by: null, truncated: [] },
                    timeline: { items: [], total: 0, truncated: false },
                    files: { items: [], total: 0, truncated: false },
                };
                partial[section] = {
                    items: page.items, total: page.items.length, truncated: false,
                };
                validateEngineeringDetail(partial);
            }
        } catch {
            throw new P.NetworkError('INVALID_RESPONSE');
        }
        return result;
    }

    async listCatalogSources({ after = '', limit = 20 } = {}) {
        if (after !== '') identifier(after);
        integer(limit, 1, 20);
        const result = await this._request('POST', '/v1/catalog/sources', { value: { after, limit } });
        try {
            fields(result, ['items', 'next']);
            check(Array.isArray(result.items) && result.items.length <= limit);
            let previous = after;
            for (const item of result.items) {
                fields(item, ['sourceId', 'version', 'digest', 'receivedAt']);
                identifier(item.sourceId); integer(item.version, 1);
                hash(item.digest); integer(item.receivedAt);
                check(item.sourceId > previous);
                previous = item.sourceId;
            }
            check(result.next === null || (result.items.length === limit &&
                result.next === previous));
        } catch { throw new P.NetworkError('INVALID_RESPONSE'); }
        return result;
    }

    async getCatalogSource(sourceId, options = {}) {
        identifier(sourceId);
        fields(options, [], ['version', 'digest', 'key', 'cursor', 'limit']);
        const { version, digest, key, cursor = null, limit = 50 } = options;
        integer(limit, 1, 200);
        check((version === undefined) === (digest === undefined));
        if (version !== undefined) { integer(version, 1); hash(digest); }
        const { catalogIdentity, projectSummary, todoDetail } = require('./catalogProjection');
        let localProjectId;
        if (key !== undefined) {
            check(typeof key === 'string' && key.length <= 512);
            let tuple;
            try { tuple = JSON.parse(key); } catch { throw new P.NetworkError('INVALID_ARGUMENT'); }
            check(Array.isArray(tuple) && tuple.length === 3 && tuple[0] === 'local' && tuple[1] === sourceId);
            localProjectId = identifier(tuple[2]);
            check(catalogIdentity({ sourceId, localProjectId }).key === key);
        }
        // Detail and continuation reads must belong to the inventory selected
        // by the caller, never silently switch to the newest source version.
        if (key !== undefined || cursor !== null) check(version !== undefined);
        const result = await this._request('POST', '/v1/catalog/source', {
            value: { sourceId, ...options, cursor, limit },
        });
        try {
            fields(result, ['sourceId', 'version', 'digest', 'receivedAt', 'page']);
            check(result.sourceId === sourceId);
            integer(result.version, 1); hash(result.digest); integer(result.receivedAt);
            if (version !== undefined) check(result.version === version && result.digest === digest);
            const page = result.page, kind = key === undefined ? 'projects' : 'todos';
            const pageKey = key === undefined ? null : key;
            fields(page, ['snapshot', 'kind', 'key', 'total', 'items', 'next']);
            hash(page.snapshot);
            check(page.kind === kind && page.key === pageKey);
            integer(page.total, 0, kind === 'projects' ? 8192 : 50000);
            check(Array.isArray(page.items) && page.items.length <= limit);
            const offsetOf = value => {
                fields(value, ['snapshot', 'kind', 'key', 'offset']);
                check(value.snapshot === page.snapshot && value.kind === kind && value.key === pageKey);
                integer(value.offset, 1, page.total);
                return value.offset;
            };
            const start = cursor === null ? 0 : offsetOf(cursor);
            const end = start + page.items.length;
            check(end <= page.total && (page.items.length > 0 || end === page.total));
            if (page.next === null) check(end === page.total);
            else check(offsetOf(page.next) === end && end < page.total);
            let previous = kind === 'projects' ? '' : 0;
            for (const item of page.items) {
                if (kind === 'projects') {
                    fields(item, ['key', 'sourceId', 'localProjectId', 'globalProjectId',
                        'name', 'status', 'createdAt', 'updatedAt', 'deletedAt', 'progress']);
                    const identity = catalogIdentity(item);
                    check(item.sourceId === sourceId && item.globalProjectId === null &&
                        item.key === identity.key && item.key > previous);
                    check(item.deletedAt === null || typeof item.deletedAt === 'string');
                    projectSummary({
                        id: item.localProjectId, name: item.name, status: item.status,
                        availability: 'ready', created_at: item.createdAt,
                        updated_at: item.updatedAt, deleted_at: item.deletedAt,
                    }, [], identity);
                    fields(item.progress, ['total', 'pending', 'doing', 'done', 'blocked']);
                    Object.values(item.progress).forEach(n => integer(n, 0, 50000));
                    check(item.progress.total === item.progress.pending + item.progress.doing +
                        item.progress.done + item.progress.blocked);
                    previous = item.key;
                } else {
                    fields(item, ['seq', 'status', 'title', 'note', 'updatedBy', 'updatedAt', 'truncated']);
                    check(item.note === null || typeof item.note === 'string');
                    check(item.updatedBy === null || typeof item.updatedBy === 'string');
                    const normalized = todoDetail({
                        project_id: localProjectId, seq: item.seq, status: item.status,
                        title: item.title, note: item.note, updated_by: item.updatedBy, updated_at: item.updatedAt,
                    }, localProjectId);
                    check(item.seq > previous && normalized.truncated.length === 0);
                    check(Array.isArray(item.truncated) && item.truncated.length <= 3 &&
                        new Set(item.truncated).size === item.truncated.length &&
                        item.truncated.every(field => ['title', 'note', 'updatedBy'].includes(field)));
                    previous = item.seq;
                }
            }
        } catch { throw new P.NetworkError('INVALID_RESPONSE'); }
        return result;
    }

    async listCatalogProjects({ after = '', limit = 20 } = {}) {
        if (after !== '') globalId(after);
        integer(limit, 1, 20);
        const result = await this._request('POST', '/v1/catalog/projects', { value: { after, limit } });
        fields(result, ['items', 'next']);
        check(Array.isArray(result.items) && result.items.length <= limit, 'INVALID_RESPONSE');
        let previous = after;
        for (const item of result.items) {
            fields(item, ['id', 'originId', 'localProjectId', 'name', 'revision',
                'bundleHash', 'fence', 'lease', 'createdAt', 'updatedAt']);
            globalId(item.id); identifier(item.originId); identifier(item.localProjectId);
            check(item.id > previous && typeof item.name === 'string' &&
                item.name.length <= 256, 'INVALID_RESPONSE');
            integer(item.revision); integer(item.fence);
            integer(item.createdAt); integer(item.updatedAt);
            if (item.bundleHash !== null) hash(item.bundleHash);
            if (item.lease !== null) {
                fields(item.lease, ['holder', 'fence', 'expiresAt']);
                identifier(item.lease.holder); integer(item.lease.fence, 1);
                integer(item.lease.expiresAt);
            }
            previous = item.id;
        }
        check(result.next === null || (result.items.length === limit &&
            result.next === previous), 'INVALID_RESPONSE');
        return result;
    }

    async getCatalogPlan(projectId, { cursor = null, limit = 50 } = {}) {
        globalId(projectId); integer(limit, 1, 200);
        const result = await this._request('POST', '/v1/catalog/plan', {
            value: { projectId, cursor, limit },
        });
        try {
            fields(result, ['summary', 'publication', 'todos']);
            const { summary: s, publication: p, todos: page } = result;
            fields(s, ['key', 'sourceId', 'localProjectId', 'globalProjectId',
                'name', 'status', 'createdAt', 'updatedAt', 'deletedAt', 'progress']);
            const { catalogIdentity, projectSummary, todoDetail } = require('./catalogProjection');
            const identity = catalogIdentity(s);
            check(identity.globalProjectId === projectId && identity.key === s.key);
            // Reuse presentation field validation without inventing synthetic todos.
            projectSummary({
                id: s.localProjectId, name: s.name, status: s.status, availability: 'ready',
                created_at: s.createdAt, updated_at: s.updatedAt, deleted_at: s.deletedAt,
            }, [], identity);
            fields(s.progress, ['total', 'pending', 'doing', 'done', 'blocked']);
            Object.values(s.progress).forEach(value => integer(value, 0, 50000));
            check(s.progress.total === s.progress.pending + s.progress.doing +
                s.progress.done + s.progress.blocked);
            fields(p, ['globalProjectId', 'revision', 'bundleHash', 'publishedAt']);
            check(p.globalProjectId === projectId);
            integer(p.revision, 1); hash(p.bundleHash); integer(p.publishedAt);
            fields(page, ['snapshot', 'kind', 'key', 'total', 'items', 'next']);
            hash(page.snapshot);
            check(page.kind === 'todos' && page.key === s.key && page.total === s.progress.total);
            check(Array.isArray(page.items) && page.items.length <= limit);
            const validateCursor = value => {
                fields(value, ['revision', 'bundleHash', 'page']);
                check(value.revision === p.revision && value.bundleHash === p.bundleHash);
                fields(value.page, ['snapshot', 'kind', 'key', 'offset']);
                check(value.page.snapshot === page.snapshot && value.page.kind === 'todos' &&
                    value.page.key === s.key);
                integer(value.page.offset, 1, page.total);
                return value.page.offset;
            };
            const start = cursor === null ? 0 : validateCursor(cursor);
            const end = start + page.items.length;
            check(end <= page.total && (page.items.length > 0 || start === page.total));
            if (page.next === null) check(end === page.total);
            else check(validateCursor(page.next) === end && end < page.total);
            let previous = 0;
            const counts = { pending: 0, doing: 0, done: 0, blocked: 0 };
            for (const item of page.items) {
                fields(item, ['seq', 'status', 'title', 'note', 'updatedBy', 'updatedAt', 'truncated']);
                const normalized = todoDetail({
                    project_id: s.localProjectId, seq: item.seq, status: item.status,
                    title: item.title, note: item.note,
                    updated_by: item.updatedBy, updated_at: item.updatedAt,
                }, s.localProjectId);
                check(item.seq > previous && normalized.truncated.length === 0);
                check(Array.isArray(item.truncated) && item.truncated.length <= 3 &&
                    new Set(item.truncated).size === item.truncated.length &&
                    item.truncated.every(field => ['title', 'note', 'updatedBy'].includes(field)));
                previous = item.seq;
                counts[item.status]++;
            }
            for (const state of Object.keys(counts)) check(counts[state] <= s.progress[state]);
            if (start === 0 && page.next === null) {
                for (const state of Object.keys(counts)) check(counts[state] === s.progress[state]);
            }
        } catch {
            throw new P.NetworkError('INVALID_RESPONSE');
        }
        return result;
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