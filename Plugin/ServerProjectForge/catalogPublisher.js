'use strict';
const { check, integer } = require('./hubNetworkProtocol');

const RETRYABLE = new Set(['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'BUSY', 'CAPACITY_EXCEEDED']);

// Host-owned controller; construction has no network/timer effects.
// collect and authorizePending are synchronous trusted callbacks.
// authorizePending must recheck current sharing scope AND reject records now
// delegated to a global project; pending bytes are never silently rewritten.
// The real HubNetworkClient bounds every network request by requestMs.
class CatalogPublisher {
    constructor({ client, journal, collect, authorizePending, intervalMs = 5000 } = {}) {
        check(client && typeof client.publishCatalogSource === 'function');
        check(journal && ['pending', 'stage', 'acknowledge'].every(k => typeof journal[k] === 'function'));
        check(typeof collect === 'function' && typeof authorizePending === 'function');
        integer(intervalMs, 100, 300000);
        this.client = client; this.journal = journal;
        this.collect = collect; this.authorizePending = authorizePending;
        this.intervalMs = intervalMs;
        this.busy = null; this.timer = null; this.running = false;
        this.closed = false; this.blocked = false; this.lastError = null;
        this.lastSuccessAt = null;
    }

    status() {
        return {
            phase: this.closed ? 'stopped' : this.blocked ? 'blocked'
                : this.busy ? 'publishing' : this.running ? 'watching' : 'idle',
            lastError: this.lastError, lastSuccessAt: this.lastSuccessAt,
        };
    }

    async _send(request) {
        // Pass a detached copy to the authorization callback so it cannot
        // accidentally alter the frozen request being sent.
        check(this.authorizePending(JSON.parse(JSON.stringify(request))) === true, 'FORBIDDEN');
        const receipt = await this.client.publishCatalogSource(request);
        // Even during shutdown, record a valid receipt before releasing DBs.
        this.journal.acknowledge(request.requestId, receipt);
        this.lastSuccessAt = Date.now();
    }

    async _cycle() {
        const pending = this.journal.pending();
        if (pending) await this._send(pending);
        if (this.closed) return;
        const inventory = this.collect();
        check(inventory && typeof inventory.then !== 'function' && Array.isArray(inventory.records));
        const enhanced = Object.hasOwn(inventory, 'protocolVersion');
        check(enhanced === Object.hasOwn(inventory, 'details'), 'INVALID_BODY');
        if (enhanced) check([2, 3].includes(inventory.protocolVersion), 'INVALID_BODY');
        const withCode = inventory.protocolVersion === 3;
        check(withCode === Object.hasOwn(inventory, 'codes'), 'INVALID_BODY');
        const request = enhanced
            ? this.journal.stage(inventory.records, {
                details: inventory.details, ...(withCode ? { codes: inventory.codes } : {}),
            })
            : this.journal.stage(inventory.records);
        if (request && !this.closed) await this._send(request);
        // Changes arriving during a request are collected on the next tick.
        // At most one recovery plus one fresh publication per cycle.
    }

    flush() {
        if (this.closed || this.blocked) return Promise.resolve(this.status());
        if (this.busy) return this.busy;
        this.busy = Promise.resolve().then(() => {
            if (!this.closed) return this._cycle();
        }).then(() => {
            this.lastError = null;
        }).catch(error => {
            const code = typeof error?.code === 'string' ? error.code : 'INTERNAL';
            this.lastError = RETRYABLE.has(code) || [
                'FORBIDDEN', 'UNAUTHENTICATED', 'REVISION_CONFLICT', 'REQUEST_CONFLICT',
                'CONTENT_BINDING', 'INVALID_RESPONSE', 'LIMIT_EXCEEDED',
            ].includes(code) ? code : 'INTERNAL';
            if (!RETRYABLE.has(code)) {
                this.blocked = true;
                clearInterval(this.timer); this.timer = null;
            }
        }).finally(() => { this.busy = null; }).then(() => this.status());
        return this.busy;
    }

    start() {
        check(!this.closed, 'CLOSED');
        if (!this.running && !this.blocked) {
            this.running = true;
            this.timer = setInterval(() => { void this.flush(); }, this.intervalMs);
            this.timer.unref?.();
        }
        return this.flush();
    }

    async stop() {
        this.closed = true; this.running = false;
        clearInterval(this.timer); this.timer = null;
        if (this.busy) await this.busy;
        // No final send here. Any unacknowledged request stays durable.
        return this.status();
    }
}
module.exports = { CatalogPublisher };