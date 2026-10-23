'use strict';
const path = require('node:path');
const { check } = require('./hubNetworkProtocol');
const { CatalogPublishJournal } = require('./catalogPublishJournal');
const { CatalogPublisher } = require('./catalogPublisher');
const { collectCatalog } = require('./catalogCollect');

// Host owns this adapter, not the renderer. The business Store and event bus
// are borrowed; stop() must finish BEFORE the host closes the business Store.
class CatalogHost {
    constructor({ config, getStore, authorize, events } = {}) {
        check(config && typeof config.read === 'boolean' && config.client);
        check(config.read || config.publish);
        this.client = config.client;
        this.read = config.read;
        this.sourceId = config.publish?.sourceId || null;
        this.browser = config.read ? new (require('./catalogBrowser').CatalogBrowser)(config.client) : null;
        this.details = new Map();
        this.browseError = null;
        this.publisher = null;
        this.journal = null;
        this.events = events;
        this.listener = null;
        this.stopping = null;
        this.closed = false;
        this.started = false;
        if (!config.publish) return; // Read-only catalog never opens business DB.
        check(config.publish.allProjects === true && typeof getStore === 'function' &&
            typeof authorize === 'function');
        check(events && typeof events.on === 'function' && typeof events.removeListener === 'function');
        const store = getStore();
        check(store?.db?.open && typeof store.dbPath === 'string');
        const sourceId = config.publish.sourceId;
        const sharing = () => {
            check(config.publish.engineeringDetails === undefined ||
                typeof config.publish.engineeringDetails === 'boolean');
            return config.publish.engineeringDetails === true;
        };
        const codeSharing = () => {
            check(config.publish.codeSnapshots === undefined ||
                typeof config.publish.codeSnapshots === 'boolean');
            const enabled = config.publish.codeSnapshots === true;
            check(!enabled || sharing(), 'FORBIDDEN');
            return enabled;
        };
        const collect = () => collectCatalog(store, {
            sourceId, authorize, engineeringDetails: sharing(), codeSnapshots: codeSharing(),
        });
        // Fail before creating the journal when the sharing scope is incomplete.
        // A transient BUSY state is retried by the publisher instead.
        try { collect(); } catch (error) { if (error.code !== 'BUSY') throw error; }
        try {
            this.journal = new CatalogPublishJournal(config.publish.journalPath, {
                hubId: this.client.hubId, deviceId: this.client.deviceId,
                sourceId, storePath: path.resolve(store.dbPath),
            });
            this.publisher = new CatalogPublisher({
                client: this.client, journal: this.journal, collect,
                intervalMs: config.publish.intervalMs,
                authorizePending: request => {
                    check(request.sourceId === sourceId, 'CONTENT_BINDING');
                    // Revocation blocks even frozen enhanced payloads. Do not
                    // discard or rewrite an ambiguously committed request.
                    if (request.protocolVersion !== undefined || Object.hasOwn(request, 'details')) {
                        check([2, 3].includes(request.protocolVersion) && Array.isArray(request.details),
                            'CONTENT_BINDING');
                        check(sharing(), 'FORBIDDEN');
                    }
                    const withCode = request.protocolVersion === 3;
                    check(withCode === Object.hasOwn(request, 'codes'), 'CONTENT_BINDING');
                    if (withCode) {
                        check(Array.isArray(request.codes), 'CONTENT_BINDING');
                        check(codeSharing(), 'FORBIDDEN');
                    }
                    // Recheck every project's current authorization in a read
                    // snapshot before retrying bytes persisted in a former run.
                    const current = collect();
                    const ordinary = new Set(current.records.map(r => r.project.id));
                    // Missing/purged/delegated pending records need explicit
                    // reconciliation, not rewriting an ambiguous committed request.
                    return request.records.every(r => ordinary.has(r.project.id));
                },
            });
        } catch (error) {
            this.journal?.close(); this.journal = null;
            throw error;
        }
    }

    status() {
        return {
            read: this.read,
            publisher: this.publisher?.status() || { phase: this.closed ? 'stopped' : 'disabled' },
        };
    }

    async listRemote() {
        check(!this.closed && this.browser, 'FORBIDDEN');
        const { remoteSummary } = require('./catalogView');
        try {
            const entries = await this.browser.refresh();
            this.browseError = null;
            // Detail caches belong to the previous index snapshot.
            this.details.clear();
            return {
                projects: entries.map(entry => remoteSummary(entry)),
                status: { phase: 'online', error: null, cached: false },
            };
        } catch (error) {
            const offline = ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'BUSY'].includes(error?.code);
            this.browseError = offline ? error.code : 'CATALOG_READ_FAILED';
            if (!offline || this.closed) {
                this.browser.clear(); this.details.clear();
                throw Object.assign(new Error(this.browseError), { code: this.browseError });
            }
            return {
                projects: [...this.browser.entries.values()].map(entry =>
                    remoteSummary(entry, { stale: true, error: this.browseError })),
                status: { phase: 'offline', error: this.browseError, cached: this.browser.entries.size > 0 },
            };
        }
    }

    _rememberDetail(id, detail) {
        // Bound retained serialized content, not total V8 heap usage.
        const maximum = 8 * 1024 * 1024;
        const size = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
        const bytes = size(detail);
        this.details.delete(id);
        if (bytes > maximum) return;
        let total = bytes;
        for (const cached of this.details.values()) total += size(cached);
        while (this.details.size && (this.details.size >= 16 || total > maximum)) {
            const oldest = this.details.keys().next().value;
            total -= size(this.details.get(oldest));
            this.details.delete(oldest);
        }
        this.details.set(id, detail);
    }

    async getRemote(id) {
        check(!this.closed && this.browser, 'FORBIDDEN');
        const { remoteDetail } = require('./catalogView');
        const entry = this.browser.entries.get(id);
        check(entry, 'NOT_FOUND');
        const generation = this.browser.generation;
        try {
            const detail = await this.browser.detail(id);
            check(!this.closed, 'CLOSED');
            check(this.browser.generation === generation, 'REQUEST_CONFLICT');
            this._rememberDetail(id, detail);
            return remoteDetail(entry, detail);
        } catch (error) {
            const denied = ['FORBIDDEN', 'UNAUTHENTICATED'].includes(error?.code);
            // A superseded response must not clear a newer index or use its
            // detail cache. Explicit authentication denial still invalidates all.
            if (!denied && (this.closed || this.browser.generation !== generation)) {
                const code = this.closed ? 'CLOSED' : 'REQUEST_CONFLICT';
                throw Object.assign(new Error(code), { code });
            }
            const offline = ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'BUSY'].includes(error?.code);
            if (offline && !this.closed && this.details.has(id)) {
                return remoteDetail(entry, this.details.get(id), { stale: true, error: error.code });
            }
            if (!offline) {
                this.browser.clear(); this.details.clear();
            }
            throw Object.assign(new Error(offline ? error.code : 'CATALOG_READ_FAILED'),
                { code: offline ? error.code : 'CATALOG_READ_FAILED' });
        }
    }

    async getRemoteCode(id, options) {
        check(!this.closed && this.browser, 'FORBIDDEN');
        const { fields, integer, hash } = require('./hubNetworkProtocol');
        fields(options, ['version', 'digest', 'node']);
        integer(options.version, 1); hash(options.digest); integer(options.node, 1);
        const entry = this.browser.entries.get(id);
        check(entry && entry.kind === 'source', 'NOT_FOUND');
        check(entry.pin.version === options.version && entry.pin.digest === options.digest,
            'REQUEST_CONFLICT');
        const generation = this.browser.generation;
        try {
            // A list refresh or bounded-cache eviction must not break a still-valid pin.
            // Fetch metadata online on a miss; never substitute stale source bytes.
            const detail = this.details.get(id) || await this.browser.detail(id);
            check(!this.closed, 'CLOSED');
            check(this.browser.generation === generation, 'REQUEST_CONFLICT');
            const result = await this.browser.code(id, options, detail.engineering);
            check(!this.closed, 'CLOSED');
            check(this.browser.generation === generation, 'REQUEST_CONFLICT');
            return result;
        } catch (error) {
            const denied = ['FORBIDDEN', 'UNAUTHENTICATED'].includes(error?.code);
            if (denied) {
                this.browser.clear(); this.details.clear();
            } else if (this.closed || this.browser.generation !== generation) {
                const code = this.closed ? 'CLOSED' : 'REQUEST_CONFLICT';
                throw Object.assign(new Error(code), { code });
            } else if (!['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'BUSY', 'NOT_FOUND',
                'CONTENT_NOT_FOUND', 'REQUEST_CONFLICT', 'INVALID_ARGUMENT',
                'INVALID_BODY'].includes(error?.code)) {
                this.browser.clear(); this.details.clear();
            }
            const code = ['FORBIDDEN', 'UNAUTHENTICATED', 'NETWORK_ERROR', 'REQUEST_TIMEOUT',
                'BUSY', 'NOT_FOUND', 'CONTENT_NOT_FOUND', 'REQUEST_CONFLICT',
                'INVALID_RESPONSE', 'LIMIT_EXCEEDED', 'INVALID_ARGUMENT', 'INVALID_BODY']
                .includes(error?.code) ? error.code : 'CATALOG_READ_FAILED';
            throw Object.assign(new Error(code), { code });
        }
    }

    start() {
        check(!this.closed, 'CLOSED');
        if (!this.started) {
            this.started = true;
            if (this.publisher) {
                this.listener = () => { void this.publisher.flush(); };
                this.events.on('changed', this.listener);
            }
        }
        return this.publisher ? this.publisher.start() : Promise.resolve(this.status());
    }

    stop() {
        if (this.stopping) return this.stopping;
        this.closed = true;
        this.browser?.close(); this.details.clear();
        if (this.listener) this.events.removeListener('changed', this.listener);
        this.listener = null;
        this.stopping = (async () => {
            if (this.publisher) await this.publisher.stop();
            this.journal?.close();
            return this.status();
        })();
        return this.stopping;
    }
}
module.exports = { CatalogHost };