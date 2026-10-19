'use strict';
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { ProjectNetworkSync } = require('./projectNetworkSync');
const W = require('./projectWriteGate');
const check = (ok, code) => { if (!ok) throw new W.WriteGateError(code); };
const id = prefix => prefix + crypto.randomUUID();
const LOCAL_CONFLICTS = new Set([
    'LOCAL_CHANGES', 'DRIFT', 'OPEN_CAPTURE', 'HISTORY_CONFLICT', 'STRUCTURAL_CONFLICT',
    'UNTRACKED_COLLISION', 'FILE_DRIFT', 'IDENTITY_MISMATCH', 'CHECKPOINT_AMBIGUOUS',
    'LOCAL_REVISION_CONFLICT', 'MAPPING_DRIFT', 'MAPPING_BINDING', 'UPDATE_GATE_DRIFT',
    'AUTO_TARGET_UNAUTHORIZED', 'UNSAFE_PATH', 'INCONSISTENT_TREE', 'AMBIGUOUS_STATE',
    'CORRUPT_BLOB', 'CORRUPT_CONTENT', 'CORRUPT_CHECKPOINT',
]);
function alive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
// One fixed, explicitly authorized global project; no discovery service, credentials store or Worker scheduler.
class ProjectAutoResume {
    constructor(store, { client, journalPath, mappingPath, localProjectId, globalProjectId, target,
        ttlMs = 60000, pollMs = 250, checkpointMs = 1000, safetyMs = 250, drainMs = 15000, _testHook = null, authorizeTarget = null } = {}) {
        check(client && Boolean(localProjectId) !== Boolean(globalProjectId), 'INVALID_ARGUMENT');
        check(Number.isSafeInteger(ttlMs) && ttlMs >= 1000 && ttlMs <= 300000 &&
            Number.isSafeInteger(pollMs) && pollMs >= 10 && pollMs < ttlMs / 2 &&
            Number.isSafeInteger(checkpointMs) && checkpointMs >= 0 && safetyMs < ttlMs / 2, 'INVALID_ARGUMENT');
        this.store = store; this.client = client; this.ttlMs = ttlMs; this.pollMs = pollMs; this.checkpointMs = checkpointMs;
        this.localId = localProjectId || null; this.globalId = globalProjectId || null; this.target = target;
        this.gate = new W.WriterGate({ safetyMs, drainMs });
        this.owner = JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID() });
        this.phase = 'closed'; this.lastError = null; this.busy = null; this.running = false; this.closing = false;
        this.dirty = true; this.lastCheckpoint = 0; this.lastRenew = 0; this.timer = null; this.lease = null;
        this.sync = new ProjectNetworkSync(store, journalPath, mappingPath, {
            client, _testHook, authorizeTarget, onLocal: (local, global) => this._bind(local, global),
        });
        const config = JSON.stringify({ localProjectId: localProjectId || null, globalProjectId: globalProjectId || null, target: target || null });
        try {
            this.sync.db.transaction(() => {
                const old = this._get('auto_config');
                check(!old || old === config, 'AUTO_BINDING');
                const owner = this._get('auto_owner');
                check(!owner || !alive(JSON.parse(owner).pid), 'AUTO_ALREADY_RUNNING');
                this._set('auto_config', config); this._set('auto_owner', this.owner);
            }).immediate();
            this.gate.verify = () => check(this._get('auto_owner') === this.owner, 'AUTO_OWNER_CHANGED');
            this.gate.onChanged = () => { this.dirty = true; };
            if (this.localId) this._bind(this.localId, null); // Close ordinary writes BEFORE the first network await.
        } catch (e) {
            if (this._get('auto_owner') === this.owner) this.sync.db.prepare("DELETE FROM sync_meta WHERE key='auto_owner'").run();
            this.sync.close(); throw e;
        }
    }
    _get(k) { return this.sync._db().prepare('SELECT value FROM sync_meta WHERE key=?').get(k)?.value; }
    _set(k, v) { this.sync._db().prepare('INSERT OR REPLACE INTO sync_meta VALUES (?,?)').run(k, v); }
    _bind(local, global) {
        const previous = W.binding(this.store, local);
        W.bind(this.store, local, { hubId: this.client.hubId,
            globalProjectId: global ?? previous?.globalProjectId ?? null, mappingId: this.sync.mappingId }, this.gate);
        this.localId = local; if (global) this.globalId = global;
    }
    _leaseRequest() {
        let request = this._get('auto_lease_request');
        if (!request) { request = id('lease-'); this._set('auto_lease_request', request); }
        return request;
    }
    async _recover() {
        for (const requestId of this.sync.pendingPublications(this.globalId)) {
            try { await this.sync.reconcilePublication(requestId); }
            catch (e) {
                if (e.code !== 'PUBLICATION_NOT_FOUND') throw e;
                check(this.lease, 'WRITE_LEASE_REQUIRED');
                const a = this.sync._attempt(requestId);
                await this.sync.publishLocal({ globalProjectId: this.globalId, lease: this.lease,
                    requestId, expectedRevision: a.base_revision });
            }
        }
    }
    async _activate() {
        if (!this.globalId) {
            const mapped = await this.sync.registerLocal(this.localId);
            this._bind(this.localId, mapped.globalProjectId);
        }
        let mapping = this.sync.getMapping(this.globalId);
        if (mapping) {
            check(mapping.state !== 'purged', 'IMPORT_PURGED');
            for (const requestId of this.sync.pendingPublications(this.globalId)) {
                try { await this.sync.reconcilePublication(requestId); }
                catch (e) { if (e.code !== 'PUBLICATION_NOT_FOUND') throw e; }
            }
        }
        const head = await this.client.getProject(this.globalId);
        if (head.lease && head.lease.holder !== this.client.deviceId) { this.phase = 'waiting'; return; }
        if (!mapping && head.revision < 1) { this.phase = 'waiting'; return; }
        const began = performance.now();
        try {
            this.lease = await this.client.acquireLease({
                projectId: this.globalId, requestId: this._leaseRequest(), ttlMs: this.ttlMs,
            });
        } catch (e) {
            if (e.code === 'STALE_REQUEST') this.sync.db.prepare("DELETE FROM sync_meta WHERE key='auto_lease_request'").run();
            if (['LEASE_BUSY', 'STALE_REQUEST'].includes(e.code)) { this.phase = 'waiting'; return; }
            throw e;
        }
        if (!mapping) {
            await this.sync.receive({ globalProjectId: this.globalId, revision: this.lease.revision,
                requestId: 'receive-' + crypto.createHash('sha256').update(this.sync.mappingId + this.globalId).digest('hex'),
                target: this.target });
        } else if (mapping.state === 'pending') {
            await this.sync.resume(mapping.requestId);
        } else {
            if (!require('./projectUpdate').active(this.store, mapping.localProjectId)) {
                this.sync._local(this.sync._row(this.globalId)); // Do not replay the old first-import receipt.
            }
            this._bind(mapping.localProjectId, this.globalId);
        }
        await this._recover();
        mapping = this.sync.getMapping(this.globalId);
        if (mapping.revision < this.lease.revision || require('./projectUpdate').active(this.store, mapping.localProjectId)) {
            check(this.gate.active === 0 && this.gate.phase !== 'open', 'WRITER_ACTIVE');
            await this.sync.advanceLocal({ globalProjectId: this.globalId, revision: this.lease.revision,
                lease: { ...this.lease, ttlMs: this.ttlMs }, safetyMs: this.gate.safetyMs,
                authorize: () => {
                    check(!this.closing && this.gate.active === 0 && this.gate.phase !== 'open', 'WRITER_ACTIVE');
                    check(this._get('auto_owner') === this.owner, 'AUTO_OWNER_CHANGED');
                } });
            mapping = this.sync.getMapping(this.globalId);
        }
        check(mapping.state === 'ready' && mapping.revision === (await this.client.getProject(this.globalId)).revision,
            'LOCAL_REVISION_CONFLICT');
        check(!this.closing, 'WRITER_CLOSING');
        // acquire request replay can return an OLD still-live grant. Only renew establishes a fresh TTL.
        const renewedAt = performance.now();
        this.lease = await this.client.renewLease({ ...this.lease, ttlMs: this.ttlMs });
        check(this.lease.revision === mapping.revision && !this.closing, 'LOCAL_REVISION_CONFLICT');
        this.gate.grant(this.lease, renewedAt, this.ttlMs);
        this.lastRenew = renewedAt; this.phase = 'writer'; this.lastError = null; this.dirty = true;
    }
    async _renew() {
        this.gate.assert();
        const began = performance.now(), lease = await this.client.renewLease({ ...this.lease, ttlMs: this.ttlMs });
        // An uncertain/expired grant cannot silently revive an old in-flight Worker.
        this.gate.assert(); check(lease.fence === this.lease.fence, 'STALE_LEASE');
        this.gate.grant(lease, began, this.ttlMs); this.lease = lease; this.lastRenew = began;
    }
    _openCapture() {
        return this.store.db.prepare("SELECT 1 FROM captures WHERE project_id=? AND status='open' LIMIT 1").get(this.localId);
    }
    async _checkpoint(final = false) {
        if (!final && this._openCapture()) return;
        await this.gate.drain({ stopExternal: final });
        check(!this._openCapture(), 'OPEN_CAPTURE');
        await this._recover();
        const m = this.sync.getMapping(this.globalId);
        this.dirty = false;
        const result = await this.sync.publishLocal({ globalProjectId: this.globalId, lease: this.lease,
            requestId: id('checkpoint-'), expectedRevision: m.revision });
        this.lastCheckpoint = performance.now();
        if (!final && !this.closing) this.gate.reopen();
        return result;
    }
    async _tick() {
        check(this._get('auto_owner') === this.owner, 'AUTO_OWNER_CHANGED');
        if (this.closing) return;
        if (this.gate.phase !== 'open') { await this._activate(); return; }
        if (performance.now() - this.lastRenew >= this.ttlMs / 3) await this._renew();
        if (this.dirty && performance.now() - this.lastCheckpoint >= this.checkpointMs) await this._checkpoint();
    }
    tick() {
        if (this.busy) return this.busy;
        if (this.phase === 'conflict') return Promise.resolve(this.status());
        const p = this._tick().catch(async e => {
            this.gate.lose(); this.phase = 'blocked';
            this.lastError = /^[A-Z_]+$/.test(e.code || '') ? e.code : 'AUTO_ERROR';
            if (LOCAL_CONFLICTS.has(e.code)) {
                this.phase = 'conflict'; this.running = false; clearTimeout(this.timer);
                this.leaseRelease = this.lease ? 'deferred-active' : 'not-held';
                if (this.lease && this.gate.active === 0) {
                    this.leaseRelease = 'unconfirmed';
                    try {
                        await this.client.releaseLease(this.lease);
                        this.sync.db.prepare("DELETE FROM sync_meta WHERE key='auto_lease_request'").run();
                        this.lease = null; this.leaseRelease = 'released';
                    } catch { /* May have committed. No blind retry, new request or successful-handoff claim. */ }
                }
            }
            throw e;
        });
        this.busy = p;
        const clear = () => { if (this.busy === p) this.busy = null; };
        p.then(clear, clear); return p;
    }
    _schedule() {
        if (!this.running || this.closing) return;
        this.timer = setTimeout(async () => {
            try { await this.tick(); } catch { /* status contains only a safe stable code */ }
            this._schedule();
        }, this.pollMs);
        this.timer.unref?.();
    }
    async start() {
        check(!this.running, 'AUTO_ALREADY_RUNNING'); this.running = true;
        try { await this.client.identity(); await this.tick(); }
        catch (e) { this.gate.lose(); if (this.phase !== 'conflict') this.phase = 'blocked';
            this.lastError = /^[A-Z_]+$/.test(e.code || '') ? e.code : 'AUTO_ERROR'; }
        this._schedule(); return this.status();
    }
    status() {
        return { phase: this.phase, globalProjectId: this.globalId, localProjectId: this.localId,
            ...this.gate.status(), phase: this.phase, gatePhase: this.gate.phase, error: this.lastError,
            leaseRelease: this.leaseRelease ?? null,
            revision: this.globalId && this.sync.db?.open ? this.sync.getMapping(this.globalId)?.revision : null };
    }
    runWorker(fn) {
        check(typeof fn === 'function', 'INVALID_ARGUMENT');
        // The adapter must actually await termination; AbortSignal is cooperative, not an OS sandbox.
        return this.gate.run(fn);
    }
    async handoff() {
        check(!this.closing, 'WRITER_CLOSING');
        this.closing = true; this.running = false; clearTimeout(this.timer);
        if (['open', 'draining', 'frozen'].includes(this.gate.phase)) this.gate.seal(true);
        try {
            if (this.busy) await this.busy;
            check(this.lease && ['draining', 'frozen'].includes(this.gate.phase), 'WRITE_LEASE_REQUIRED');
            const revision = await this._checkpoint(true);
            const released = await this.client.releaseLease(this.lease);
            this.gate.close(); this.phase = 'released';
            this.sync.db.prepare("DELETE FROM sync_meta WHERE key='auto_lease_request'").run();
            return { released: released.released, revision: revision.revision, globalProjectId: this.globalId };
        } catch (e) {
            this.gate.lose(); this.phase = 'blocked'; this.lastError = e.code || 'AUTO_ERROR'; throw e;
        }
    }
    async stop() {
        if (this.stopped) return;
        this.running = false; this.closing = true; clearTimeout(this.timer); this.gate.close();
        if (this.busy) try { await this.busy; } catch {}
        check(this.gate.active === 0, 'WRITER_ACTIVE');
        if (this._get('auto_owner') === this.owner) this.sync.db.prepare("DELETE FROM sync_meta WHERE key='auto_owner'").run();
        if (this.localId) W.detach(this.store, this.localId, this.gate);
        this.sync.close();
        this.stopped = true; this.phase = 'stopped';
    }
}
module.exports = { ProjectAutoResume };