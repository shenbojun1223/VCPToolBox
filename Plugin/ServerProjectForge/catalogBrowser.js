'use strict';
const crypto = require('node:crypto');
const { check } = require('./hubNetworkProtocol');
const clone = value => JSON.parse(JSON.stringify(value));
const MAX_ITEMS = 8192;
const MAX_BYTES = 16 * 1024 * 1024;
const remoteId = (hubId, key) => 'remote:' +
    crypto.createHash('sha256').update(JSON.stringify([hubId, key])).digest('hex');

// Read-only transport adapter. No lease acquisition, worktree import or DB.
// Results commit only after every page succeeds. Cache policy belongs to host.
class CatalogBrowser {
    constructor(client) {
        check(client && typeof client.hubId === 'string');
        this.client = client;
        this.entries = new Map();
        this.generation = {};
        this.busy = null;
        this.closed = false;
    }

    _assertGeneration(generation) {
        check(!this.closed, 'CLOSED');
        check(this.generation === generation, 'REQUEST_CONFLICT');
    }

    _budget(generation) {
        const deadline = Date.now() + 60000;
        let requests = 0, bytes = 0;
        return async operation => {
            this._assertGeneration(generation);
            check(Date.now() < deadline && ++requests <= 1024, 'LIMIT_EXCEEDED');
            const value = await operation();
            this._assertGeneration(generation);
            check(Date.now() < deadline, 'REQUEST_TIMEOUT');
            bytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
            check(bytes <= MAX_BYTES, 'LIMIT_EXCEEDED');
            return value;
        };
    }

    refresh() {
        if (this.busy) return this.busy;
        this.busy = this._refresh().finally(() => { this.busy = null; });
        return this.busy;
    }

    async _refresh() {
        const generation = this.generation;
        const request = this._budget(generation), next = new Map();
        const add = (key, value) => {
            const id = remoteId(this.client.hubId, key);
            check(!next.has(id), 'CONTENT_BINDING');
            check(next.size < MAX_ITEMS, 'LIMIT_EXCEEDED');
            next.set(id, { ...value, id });
        };
        let after = '';
        const seenSources = new Set();
        do {
            const page = await request(() => this.client.listCatalogSources({ after }));
            for (const source of page.items) {
                check(!seenSources.has(source.sourceId), 'CONTENT_BINDING');
                seenSources.add(source.sourceId);
                check(seenSources.size <= 128, 'LIMIT_EXCEEDED');
                let cursor = null, snapshot = null, total = null, count = 0, lastKey = '';
                do {
                    const result = await request(() => this.client.getCatalogSource(source.sourceId, {
                        version: source.version, digest: source.digest, cursor, limit: 200,
                    }));
                    if (snapshot === null) { snapshot = result.page.snapshot; total = result.page.total; }
                    check(result.page.snapshot === snapshot && result.page.total === total, 'REQUEST_CONFLICT');
                    for (const summary of result.page.items) {
                        check(summary.key > lastKey, 'INVALID_RESPONSE');
                        lastKey = summary.key; count++;
                        add(summary.key, { kind: 'source', summary,
                            pin: { sourceId: source.sourceId, version: source.version, digest: source.digest },
                            observedAt: Date.now() });
                    }
                    cursor = result.page.next;
                } while (cursor !== null);
                check(count === total, 'INVALID_RESPONSE');
            }
            if (page.next !== null) check(page.next > after, 'INVALID_RESPONSE');
            after = page.next;
        } while (after !== null);
        after = '';
        do {
            const page = await request(() => this.client.listCatalogProjects({ after }));
            for (const project of page.items) {
                const key = JSON.stringify(['global', project.id]);
                add(key, { kind: 'global', global: project, key, observedAt: Date.now() });
            }
            if (page.next !== null) check(page.next > after, 'INVALID_RESPONSE');
            after = page.next;
        } while (after !== null);
        this._assertGeneration(generation);
        this.entries = next;
        // Invalidate details started against the previous index even when
        // content and observedAt happen to be identical.
        this.generation = {};
        return clone([...next.values()]);
    }

    async _engineering(entry, request, generation) {
        const unavailable = reason => ({ version: 1, state: 'unavailable', reason });
        if (entry.kind !== 'source') return unavailable('global-detail-not-supported');
        if (typeof this.client.getCatalogEngineering !== 'function') {
            return unavailable('client-not-supported');
        }
        const { validateEngineeringDetail } = require('./catalogEngineeringInventory');
        const { EngineeringSnapshot } = require('./catalogEngineeringPages');
        const { DETAIL_LIMITS: L } = require('./catalogEngineeringDetail');
        const binding = { ...entry.pin, localProjectId: entry.summary.localProjectId };
        const sections = {};
        let snapshot = null, state = null, received = 0;
        for (const section of ['report', 'timeline', 'files']) {
            let cursor = null, total = null, metadata = null;
            const items = [];
            do {
                let result;
                try {
                    result = await request(() => this.client.getCatalogEngineering(binding.sourceId, {
                        localProjectId: binding.localProjectId, version: binding.version,
                        digest: binding.digest, section, cursor, limit: 200,
                    }));
                } catch (error) {
                    // Authentication denial must reach the host even after a
                    // refresh so it can invalidate all cached permissions.
                    if (['FORBIDDEN', 'UNAUTHENTICATED'].includes(error?.code)) throw error;
                    this._assertGeneration(generation);
                    if (snapshot === null && section === 'report' && cursor === null &&
                        error?.code === 'NOT_FOUND') {
                        return unavailable('endpoint-or-resource-unavailable');
                    }
                    throw error;
                }
                check(result.sourceId === binding.sourceId &&
                    result.localProjectId === binding.localProjectId &&
                    result.version === binding.version && result.digest === binding.digest,
                'INVALID_RESPONSE');
                const page = result.page;
                check(page && page.section === section && Array.isArray(page.items),
                    'INVALID_RESPONSE');
                received += Buffer.byteLength(JSON.stringify(result), 'utf8');
                check(received <= 512 * 1024, 'LIMIT_EXCEEDED');
                if (snapshot === null) {
                    snapshot = page.snapshot;
                    state = page.state;
                }
                check(page.snapshot === snapshot && page.state === state, 'REQUEST_CONFLICT');
                if (state === 'not-shared') {
                    check(section === 'report' && cursor === null && page.total === 0 &&
                        page.items.length === 0 && page.next === null && page.metadata === null,
                    'INVALID_RESPONSE');
                    const value = { version: 1, state: 'not-shared' };
                    check(new EngineeringSnapshot(value, binding).page('report').snapshot === snapshot,
                        'INVALID_RESPONSE');
                    return value;
                }
                check(state === 'shared', 'INVALID_RESPONSE');
                const maximum = section === 'report' ? Math.ceil(L.reportChars / 1023)
                    : section === 'timeline' ? L.maxBatches : L.maxFiles;
                check(Number.isSafeInteger(page.total) && page.total >= 0 &&
                    page.total <= maximum, 'INVALID_RESPONSE');
                if (total === null) {
                    total = page.total;
                    metadata = clone(page.metadata);
                }
                check(page.total === total &&
                    JSON.stringify(page.metadata) === JSON.stringify(metadata), 'REQUEST_CONFLICT');
                const start = items.length;
                check(start + page.items.length <= total &&
                    (page.items.length > 0 || start === total), 'INVALID_RESPONSE');
                items.push(...page.items);
                if (page.next !== null) {
                    check(page.next && page.next.snapshot === snapshot &&
                        page.next.section === section && page.next.offset === items.length &&
                        items.length > start && items.length < total, 'INVALID_RESPONSE');
                } else check(items.length === total, 'INVALID_RESPONSE');
                cursor = page.next;
            } while (cursor !== null);
            sections[section] = { items, metadata };
        }
        const report = sections.report;
        check(typeof report.metadata?.present === 'boolean', 'INVALID_RESPONSE');
        let text = '';
        for (const chunk of report.items) {
            check(chunk && chunk.offset === text.length && typeof chunk.text === 'string' &&
                chunk.text.length > 0 && chunk.text.length <= 1024, 'INVALID_RESPONSE');
            check(text.length + chunk.text.length <= L.reportChars, 'LIMIT_EXCEEDED');
            text += chunk.text;
        }
        check(report.metadata.present || report.items.length === 0, 'INVALID_RESPONSE');
        const value = {
            version: 1, state: 'shared',
            report: { text: report.metadata.present ? text : null,
                by: report.metadata.by, truncated: report.metadata.truncated },
            timeline: { items: sections.timeline.items, ...sections.timeline.metadata },
            files: { items: sections.files.items, ...sections.files.metadata },
        };
        let verified;
        try {
            verified = validateEngineeringDetail(value);
            check(new EngineeringSnapshot(verified, binding).page('report').snapshot === snapshot);
        } catch {
            throw Object.assign(new Error('INVALID_RESPONSE'), { code: 'INVALID_RESPONSE' });
        }
        this._assertGeneration(generation);
        return verified;
    }

    async code(id, options, engineering) {
        const { fields, integer, hash } = require('./hubNetworkProtocol');
        const { codeBinding, codeDigest, validateCodePage, MAX_CODE_BYTES } = require('./catalogCodePages');
        const { validateEngineeringDetail } = require('./catalogEngineeringInventory');
        const { validateSide } = require('./catalogCodeSnapshot');
        fields(options, ['version', 'digest', 'node']);
        integer(options.version, 1); hash(options.digest); integer(options.node, 1);
        check(typeof id === 'string' && this.entries.has(id), 'NOT_FOUND');
        const generation = this.generation;
        const entry = clone(this.entries.get(id));
        check(entry.kind === 'source', 'NOT_FOUND');
        check(entry.pin.version === options.version && entry.pin.digest === options.digest,
            'REQUEST_CONFLICT');
        const detail = validateEngineeringDetail(engineering);
        check(detail.state === 'shared', 'CONTENT_NOT_FOUND');
        const expected = detail.files.items.find(row => row.last_node === options.node);
        check(expected, 'NOT_FOUND');
        check(typeof this.client.getCatalogCode === 'function', 'NOT_FOUND');
        const binding = codeBinding({ ...entry.pin,
            localProjectId: entry.summary.localProjectId, node: options.node });
        const request = this._budget(generation);
        let cursor = null, snapshot = null, total = null, received = 0;
        const chunks = [];
        do {
            const result = await request(() => this.client.getCatalogCode(binding.sourceId, {
                localProjectId: binding.localProjectId, version: binding.version,
                digest: binding.digest, node: binding.node, cursor,
            }));
            fields(result, ['sourceId', 'localProjectId', 'version', 'digest', 'node', 'page']);
            for (const key of Object.keys(binding)) {
                check(result[key] === binding[key], 'INVALID_RESPONSE');
            }
            const bytes = validateCodePage(result.page, cursor);
            if (snapshot === null) {
                snapshot = result.page.snapshot; total = result.page.total;
            }
            check(result.page.snapshot === snapshot && result.page.total === total,
                'INVALID_RESPONSE');
            check(result.page.offset === received, 'INVALID_RESPONSE');
            received += bytes.length;
            check(received <= MAX_CODE_BYTES && received <= total, 'LIMIT_EXCEEDED');
            chunks.push(bytes);
            cursor = result.page.next;
        } while (cursor !== null);
        check(received === total, 'INVALID_RESPONSE');
        const bytes = Buffer.concat(chunks, received);
        let value;
        try {
            check(codeDigest(binding, bytes) === snapshot);
            const text = bytes.toString('utf8');
            check(Buffer.from(text, 'utf8').equals(bytes));
            value = JSON.parse(text);
            fields(value, ['version', 'state'], ['file']);
            check(value.version === 1);
            if (value.state === 'not-shared') fields(value, ['version', 'state']);
            else {
                check(value.state === 'shared');
                fields(value, ['version', 'state', 'file']);
                fields(value.file, ['file_path', 'node', 'batch', 'before', 'after']);
                check(value.file.file_path === expected.file_path &&
                    value.file.node === expected.last_node);
                integer(value.file.batch, 1);
                value.file.before = validateSide(value.file.before);
                value.file.after = validateSide(value.file.after);
            }
        } catch {
            throw Object.assign(new Error('INVALID_RESPONSE'), { code: 'INVALID_RESPONSE' });
        }
        this._assertGeneration(generation);
        check(JSON.stringify(this.entries.get(id)) === JSON.stringify(entry), 'REQUEST_CONFLICT');
        return clone({ binding, ...value });
    }

    async detail(id) {
        check(typeof id === 'string' && this.entries.has(id), 'NOT_FOUND');
        const generation = this.generation;
        const entry = clone(this.entries.get(id));
        const request = this._budget(generation);
        let cursor = null, summary = entry.summary || null, snapshot = null, total = null;
        let publication = null, previous = 0;
        const todos = [];
        do {
            const result = entry.kind === 'source'
                ? await request(() => this.client.getCatalogSource(entry.pin.sourceId, {
                    version: entry.pin.version, digest: entry.pin.digest,
                    key: entry.summary.key, cursor, limit: 200,
                }))
                : await request(() => this.client.getCatalogPlan(entry.global.id, { cursor, limit: 200 }));
            const page = entry.kind === 'source' ? result.page : result.todos;
            if (entry.kind === 'global') {
                check(result.publication.revision === entry.global.revision &&
                    result.publication.bundleHash === entry.global.bundleHash, 'REQUEST_CONFLICT');
                if (summary !== null) check(JSON.stringify(summary) === JSON.stringify(result.summary), 'REQUEST_CONFLICT');
                summary = result.summary;
                publication = result.publication;
            }
            if (snapshot === null) { snapshot = page.snapshot; total = page.total; }
            check(page.snapshot === snapshot && page.total === total, 'REQUEST_CONFLICT');
            for (const todo of page.items) {
                check(todo.seq > previous && todos.length < 50000, 'INVALID_RESPONSE');
                previous = todo.seq; todos.push(todo);
            }
            cursor = page.next;
        } while (cursor !== null);
        check(summary && todos.length === total && total === summary.progress.total, 'INVALID_RESPONSE');
        for (const state of ['pending', 'doing', 'done', 'blocked']) {
            check(todos.filter(t => t.status === state).length === summary.progress[state], 'INVALID_RESPONSE');
        }
        const engineering = await this._engineering(entry, request, generation);
        // A concurrent refresh may revoke or replace this entry while loading.
        this._assertGeneration(generation);
        check(JSON.stringify(this.entries.get(id)) === JSON.stringify(entry), 'REQUEST_CONFLICT');
        return clone({ id, summary, todos, publication, engineering, observedAt: Date.now() });
    }

    clear() { this.generation = {}; this.entries.clear(); }
    close() { this.closed = true; this.clear(); }
}
module.exports = { CatalogBrowser };