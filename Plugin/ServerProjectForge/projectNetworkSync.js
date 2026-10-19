'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { ProjectSync, SyncError } = require('./projectSync');
const { exportProjectBundle, validateProjectBundle, getProjectImportReceipt } = require('./projectBundle');
const check = (ok, code) => { if (!ok) throw new SyncError(code, code); };
const digest = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const key = v => process.platform === 'win32' ? v.toLowerCase() : v;
function targetOf(p) {
    const t = { root: path.resolve(p.root), workspaceId: p.workspaceId ?? p.workspace_id ?? null,
        workspaceAlias: p.workspaceAlias ?? p.workspace_alias, subpath: p.subpath ?? '' };
    check(path.isAbsolute(p.root) && t.root !== path.parse(t.root).root && !t.root.startsWith('\\\\') &&
        typeof t.workspaceAlias === 'string' && t.workspaceAlias.trim(), 'INVALID_ARGUMENT');
    return t;
}
function view(r) {
    return r && { globalProjectId: r.global_id, localProjectId: r.local_project_id, requestId: r.request_id,
        role: r.role, revision: r.revision, bundleHash: r.bundle_hash, state: r.state,
        importRevision: r.import_revision, importBundleHash: r.import_hash, target: JSON.parse(r.target_json),
        recordedComplete: r.state === 'ready', ready: false, filesystemVerified: false };
}
// No synchronous network facade: only the base's LOCAL mapping primitives are reused.
class ProjectNetworkSync extends ProjectSync {
    constructor(store, journalPath, mappingPath, { client, deviceId = client?.deviceId, onLocal = null, _testHook = null, authorizeTarget = null } = {}) {
        check(client && client.deviceId === deviceId && typeof client.hubId === 'string', 'INVALID_ARGUMENT');
        super(store, journalPath, mappingPath, {
            hub: { getHubId: () => client.hubId, downloadRevision() { throw new SyncError('ASYNC_REQUIRED', 'Async transport required'); } },
            deviceId, _testHook, _network: true,
        });
        this.client = client; this.onLocal = onLocal; this.authorizeTarget = authorizeTarget;
    }
    _authorize(target) {
        if (this.authorizeTarget) check(JSON.stringify(targetOf(this.authorizeTarget(target))) ===
            JSON.stringify(targetOf(target)), 'AUTO_TARGET_UNAUTHORIZED');
    }
    _local(row) {
        check(row?.state === 'ready', 'MAPPING_CONFLICT');
        const p = this.store.getProject(row.local_project_id);
        check(p && JSON.stringify(targetOf(p)) === row.target_json, 'MAPPING_DRIFT');
        return p;
    }
    async registerLocal(localProjectId) {
        this._entry();
        const recovering = this._db().prepare('SELECT * FROM sync_mappings WHERE local_project_id=?').get(localProjectId);
        if (recovering && require('./projectUpdate').active(this.store, localProjectId)) {
            const project = this.store.db.prepare('SELECT * FROM projects WHERE id=?').get(localProjectId);
            check(recovering.state === 'ready' && project && project.availability === 'ready' &&
                project.deleted_at === null && JSON.stringify(targetOf(project)) === recovering.target_json, 'MAPPING_DRIFT');
            return view(recovering);
        }
        const p = this.store.getProject(localProjectId); check(p, 'NOT_FOUND');
        const target = targetOf(p), json = JSON.stringify(target);
        const mapped = this._db().prepare('SELECT * FROM sync_mappings WHERE local_project_id=?').get(localProjectId);
        if (mapped) { this._local(mapped); return view(mapped); }
        const global = await this.client.registerProject({ originId: this.takeover.storeId, localProjectId, name: p.name });
        this._entry();
        const current = this.store.getProject(localProjectId);
        check(current && current.name === p.name && JSON.stringify(targetOf(current)) === json, 'MAPPING_DRIFT');
        this._emit('origin-registered', global);
        return this.db.transaction(() => {
            const old = this._row(global.id);
            if (old) { check(old.local_project_id === localProjectId && old.target_json === json && old.state === 'ready', 'MAPPING_CONFLICT'); return view(old); }
            this._assertFree(target.root);
            const now = new Date().toISOString();
            this.db.prepare('INSERT INTO sync_mappings VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
                global.id, 'origin-' + digest([this.hubId, global.id]), 'origin', 0, null, null, null,
                json, key(target.root), localProjectId, 'ready', now, now);
            return view(this._row(global.id));
        }).immediate();
    }
    _attempt(requestId) { return this._db().prepare('SELECT * FROM sync_publications WHERE request_id=?').get(requestId); }
    pendingPublications(globalId) {
        return this._db().prepare("SELECT request_id FROM sync_publications WHERE global_id=? AND state='planned'").all(globalId).map(r => r.request_id);
    }
    _recordPublication(row, requestId, revision) {
        this._db().transaction(() => {
            const attempt = this._attempt(requestId);
            check(attempt && revision.projectId === attempt.global_id && revision.requestId === requestId &&
                revision.baseRevision === attempt.base_revision && revision.revision === attempt.base_revision + 1 &&
                revision.bundleHash === attempt.bundle_hash && revision.fence === attempt.fence &&
                revision.holder === attempt.holder, 'PUBLICATION_CONFLICT');
            super._recordPublication(row, requestId, revision);
            this.db.prepare('DELETE FROM sync_payloads WHERE request_id=?').run(requestId);
        }).immediate();
    }
    async publishLocal({ globalProjectId, lease, requestId, expectedRevision }) {
        this._entry();
        check(typeof requestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId), 'INVALID_ARGUMENT');
        check(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0 &&
            lease?.projectId === globalProjectId && lease.holder === this.deviceId, 'INVALID_ARGUMENT');
        const row = this._row(globalProjectId); this._local(row);
        let attempt = this._attempt(requestId);
        if (!attempt) {
            // Export is synchronous; normal host mutations are drained by the lifecycle coordinator.
            const bundle = exportProjectBundle(this.store, row.local_project_id);
            attempt = this._db().transaction(() => {
                const prior = this._attempt(requestId); if (prior) return prior;
                check(this._row(globalProjectId).revision === expectedRevision, 'LOCAL_REVISION_CONFLICT');
                check(!this.pendingPublications(globalProjectId).length, 'CHECKPOINT_PENDING');
                // One unacknowledged frozen checkpoint per project, <=96 MiB; no unbounded offline queue.
                check(this.db.prepare('SELECT count(*) AS n FROM sync_payloads').get().n < 2, 'CAPACITY_EXCEEDED');
                this.db.prepare('INSERT INTO sync_publications VALUES (?,?,?,?,?,?,?,?)').run(
                    requestId, globalProjectId, expectedRevision, bundle.sha256, lease.fence, lease.holder, 'planned', null);
                this.db.prepare('INSERT INTO sync_payloads VALUES (?,?)').run(requestId, bundle.bytes);
                return this._attempt(requestId);
            }).immediate();
            this._emit('checkpoint-frozen', { requestId, bundleHash: attempt.bundle_hash });
        }
        check(attempt.global_id === globalProjectId && attempt.base_revision === expectedRevision &&
            attempt.holder === lease.holder, 'REQUEST_CONFLICT');
        if (attempt.state === 'published') return this.reconcilePublication(requestId);
        if (attempt.fence !== lease.fence) {
            try { return await this.reconcilePublication(requestId); }
            catch (e) { if (e.code !== 'PUBLICATION_NOT_FOUND') throw e; }
            const confirmed = await this.client.renewLease(lease);
            check(confirmed.projectId === globalProjectId && confirmed.fence === lease.fence &&
                confirmed.leaseId === lease.leaseId && confirmed.revision === expectedRevision, 'STALE_LEASE');
            const head = await this.client.getProject(globalProjectId);
            this._entry();
            check(head.revision === expectedRevision && lease.fence > attempt.fence, 'LOCAL_REVISION_CONFLICT');
            // A newer valid fence excludes any late commit by the old writer. Bytes/base/request stay fixed.
            this.db.transaction(() => {
                const old = this._attempt(requestId);
                check(old.state === 'planned' && old.fence === attempt.fence, 'REQUEST_CONFLICT');
                this.db.prepare('UPDATE sync_publications SET fence=? WHERE request_id=?').run(lease.fence, requestId);
            }).immediate();
            attempt = this._attempt(requestId);
        }
        const payload = this._db().prepare('SELECT bytes FROM sync_payloads WHERE request_id=?').get(requestId);
        check(payload && payload.bytes.length <= 96 * 1024 * 1024, 'CORRUPT_CHECKPOINT');
        validateProjectBundle(payload.bytes, { expectedHash: attempt.bundle_hash });
        await this.client.uploadBundle({ projectId: globalProjectId, bundle: payload.bytes, expectedHash: attempt.bundle_hash, lease });
        this._entry(); this._local(this._row(globalProjectId));
        this._emit('bundle-uploaded', { requestId });
        const revision = await this.client.publishRevision({ ...lease, requestId, expectedRevision, bundleHash: attempt.bundle_hash });
        this._entry(); this._emit('revision-published', revision);
        this._recordPublication(row, requestId, revision);
        return revision;
    }
    async reconcilePublication(requestId) {
        this._entry();
        const a = this._attempt(requestId); check(a, 'NOT_FOUND');
        let r;
        try { r = await this.client.getRevision(a.global_id, a.base_revision + 1); }
        catch (e) { if (e.code === 'NOT_FOUND') throw new SyncError('PUBLICATION_NOT_FOUND', 'Checkpoint not published'); throw e; }
        check(r.requestId === requestId && r.bundleHash === a.bundle_hash && r.baseRevision === a.base_revision &&
            r.fence === a.fence && r.holder === a.holder, 'PUBLICATION_CONFLICT');
        const downloaded = await this.client.downloadRevision(a.global_id, r.revision);
        check(downloaded.revision.bundleHash === a.bundle_hash, 'MAPPING_DRIFT');
        this._entry(); const row = this._row(a.global_id); this._local(row);
        this._recordPublication(row, requestId, r);
        return { ...r, recordedPublished: true, filesystemVerified: false };
    }
    async start({ globalProjectId, revision, requestId, target }) {
        this._entry(); const local = targetOf(target), json = JSON.stringify(local), old = this._request(requestId);
        const selected = revision ?? old?.import_revision ?? (await this.client.getProject(globalProjectId)).revision;
        check(Number.isSafeInteger(selected) && selected >= 1, 'INVALID_ARGUMENT');
        const remote = await this.client.getRevision(globalProjectId, selected);
        this._entry(); this._authorize(local);
        const row = this.db.transaction(() => {
            const prior = this._request(requestId);
            if (prior) {
                check(prior.global_id === globalProjectId && prior.import_revision === selected &&
                    prior.import_hash === remote.bundleHash && prior.target_json === json && prior.role === 'replica', 'REQUEST_CONFLICT');
                check(prior.state !== 'purged', 'IMPORT_PURGED'); return prior;
            }
            check(!this._row(globalProjectId), 'MAPPING_CONFLICT'); this._assertFree(local.root);
            const now = new Date().toISOString();
            this.db.prepare('INSERT INTO sync_mappings VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
                globalProjectId, requestId, 'replica', selected, remote.bundleHash, selected, remote.bundleHash,
                json, key(local.root), null, 'pending', now, now);
            return this._request(requestId);
        }).immediate();
        this._emit('mapping-planned', view(row)); return view(row);
    }
    async resume(requestId) {
        this._entry(); const row = this._request(requestId);
        check(row?.role === 'replica', 'NOT_FOUND'); check(row.state !== 'purged', 'IMPORT_PURGED');
        const downloaded = await this.client.downloadRevision(row.global_id, row.import_revision);
        this._entry(); check(downloaded.revision.bundleHash === row.import_hash, 'MAPPING_DRIFT');
        const args = { requestId: this._takeoverRequest(row), bundle: downloaded.bytes,
            expectedHash: row.import_hash, target: JSON.parse(row.target_json) };
        try {
            this._authorize(args.target);
            const started = this.takeover.start(args);
            // Reserve writer binding BEFORE the pending project is made ordinarily available.
            if (this.onLocal) this.onLocal(started.projectId, row.global_id);
            this._emit('takeover-started', started); this._linkLocal(row, started.projectId, 'pending');
            this._authorize(args.target);
            const done = this.takeover.resume(args.requestId, args.bundle, { expectedHash: args.expectedHash });
            this._emit('takeover-complete', done); this._linkLocal(row, done.projectId, 'ready');
            return { ...view(this._request(requestId)), ready: true, filesystemVerified: true };
        } catch (e) {
            if (e.code === 'IMPORT_PURGED') {
                const receipt = getProjectImportReceipt(this.store, args.requestId);
                check(receipt?.state === 'purged', 'MAPPING_DRIFT');
                this.db.transaction(() => this.db.prepare("UPDATE sync_mappings SET state='purged',local_project_id=? WHERE request_id=?")
                    .run(receipt.projectId, requestId)).immediate();
            }
            throw e;
        }
    }
    async advanceLocal({ globalProjectId, revision, lease, authorize, safetyMs = 250 }) {
        this._entry();
        const U = require('./projectUpdate');
        const { performance } = require('node:perf_hooks');
        let row = this._row(globalProjectId);
        check(row?.state === 'ready' && lease?.projectId === globalProjectId && lease.holder === this.deviceId &&
            typeof authorize === 'function' && Number.isFinite(safetyMs) && safetyMs >= 0, 'INVALID_ARGUMENT');
        check(!this.pendingPublications(globalProjectId).length, 'CHECKPOINT_PENDING');
        const target = JSON.parse(row.target_json);
        const binding = { hubId: this.hubId, globalProjectId, mappingId: this.mappingId,
            receiverId: this.takeover.storeId, target };
        let job = U.active(this.store, row.local_project_id), baseBytes, nextBytes;
        if (job) {
            check(job.binding_json === JSON.stringify(binding), 'MAPPING_BINDING');
            revision = job.revision; nextBytes = job.incoming;
        } else {
            check(Number.isSafeInteger(revision) && revision > row.revision && row.revision >= 1, 'LOCAL_REVISION_CONFLICT');
            this._local(row); authorize(); this._authorize(target);
            const base = await this.client.downloadRevision(globalProjectId, row.revision);
            check(base.revision.bundleHash === row.bundle_hash, 'MAPPING_DRIFT');
            const next = await this.client.downloadRevision(globalProjectId, revision);
            baseBytes = base.bytes; nextBytes = next.bytes;
        }
        // No await after confirmation until the local protocol has durably finished.
        // A conservative monotonic budget excludes the network round-trip and never trusts wall-clock skew.
        const ttlMs = lease.ttlMs ?? 60000;
        check(Number.isSafeInteger(ttlMs) && ttlMs >= 1000 && ttlMs <= 300000, 'INVALID_ARGUMENT');
        const began = performance.now(), confirmed = await this.client.renewLease({ ...lease, ttlMs });
        this._entry(); row = this._row(globalProjectId);
        check(confirmed.projectId === globalProjectId && confirmed.holder === this.deviceId &&
            confirmed.fence === lease.fence && confirmed.leaseId === lease.leaseId &&
            Number.isSafeInteger(confirmed.expiresAt) && Number.isSafeInteger(confirmed.revision) &&
            confirmed.revision >= revision, 'STALE_LEASE');
        const deadline = began + ttlMs - safetyMs;
        const authorized = () => {
            check(performance.now() < deadline, 'LEASE_EXPIRED');
            authorize(); this._authorize(target); this._db();
            const current = this._row(globalProjectId);
            check(current?.state === 'ready' && current.local_project_id === row.local_project_id &&
                current.target_json === row.target_json, 'MAPPING_DRIFT');
        };
        authorized();
        if (!job) {
            check(row.revision < revision, 'LOCAL_REVISION_CONFLICT');
            job = U.prepare(this.store, { projectId: row.local_project_id, binding,
                baseRevision: row.revision, revision, baseBytes, nextBytes,
                expectedHash: require('node:crypto').createHash('sha256').update(nextBytes).digest('hex'),
                authorize: authorized, emit: (event, value) => this._emit(event, value) });
        }
        job = U.apply(this.store, job, binding, { authorize: authorized, emit: (event, value) => this._emit(event, value) });
        this.db.transaction(() => {
            authorized();
            const current = this._row(globalProjectId);
            check(current.revision === job.base_revision || (current.revision === job.revision && current.bundle_hash === job.bundle_hash),
                'MAPPING_DRIFT');
            this.db.prepare('UPDATE sync_mappings SET revision=?,bundle_hash=?,updated_at=? WHERE global_id=?')
                .run(job.revision, job.bundle_hash, new Date().toISOString(), globalProjectId);
        }).immediate();
        this._emit('update-mapping-recorded', { requestId: job.request_id });
        U.finish(this.store, job, binding, { authorize: authorized, emit: (event, value) => this._emit(event, value) });
        return { ...this.getMapping(globalProjectId), ready: true, filesystemVerified: true };
    }
    async receive(args) { await this.start(args); return this.resume(args.requestId); }
}
module.exports = { ProjectNetworkSync };