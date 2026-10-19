'use strict';
// Internal orchestration. The caller authorizes the workspace and keeps external writers stopped.
// Target Forge DB and publication journal are separate transactions, intentionally NOT a distributed transaction.
const path = require('node:path');
const crypto = require('node:crypto');
const {
    validateProjectBundle, initializeProjectImports, getProjectImportReceipt,
    importProjectBundleOnce, completeProjectImport,
} = require('./projectBundle');
const { WorktreeMaterializer } = require('./worktreeMaterializer');

class TakeoverError extends Error {
    constructor(code, message) { super(message); this.name = 'TakeoverError'; this.code = code; }
}
function check(ok, code, message) { if (!ok) throw new TakeoverError(code, message); }
function request(value) {
    check(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value),
        'INVALID_ARGUMENT', 'Persistent takeover requestId required');
}
function verifyBundle(bundle, expectedHash) {
    check(typeof expectedHash === 'string' && /^[0-9a-f]{64}$/.test(expectedHash),
        'INVALID_ARGUMENT', 'Trusted bundle SHA-256 required');
    return validateProjectBundle(bundle, { expectedHash });
}
function validateTarget(target) {
    check(target && typeof target === 'object' && typeof target.root === 'string' &&
        path.isAbsolute(target.root) && typeof target.workspaceAlias === 'string' &&
        target.workspaceAlias.trim(), 'INVALID_ARGUMENT', 'Explicit authorized local target required');
}

class ProjectTakeover {
    constructor(store, journalPath, { _testHook = null } = {}) {
        check(_testHook === null || typeof _testHook === 'function', 'INVALID_ARGUMENT', 'Invalid test hook');
        this.store = store;
        this._testHook = _testHook;
        this.materializer = new WorktreeMaterializer(journalPath, {
            _testHook: (event, row) => this._emit('materializer:' + event, row),
        });
        try {
            this.storeId = initializeProjectImports(store);
            this.journalId = this.materializer.getJournalId();
            this.journalPath = this.materializer.journalPath;
        } catch (error) {
            this.materializer.close();
            throw error;
        }
    }

    close() { this.materializer.close(); } // The receiving ProjectStore belongs to its caller.
    _emit(event, value) { if (this._testHook) this._testHook(event, value); }
    _link(jobId) { return { journalId: this.journalId, journalPath: this.journalPath, jobId }; }
    _assertLink(receipt) {
        check(receipt.state !== 'purged', 'IMPORT_PURGED', 'Import was purged; never recreate this request');
        const link = receipt.publication;
        check(link.journalId === this.journalId && link.journalPath === this.journalPath,
            'JOURNAL_MISMATCH', 'Receipt belongs to a different publication journal');
        const job = this.materializer.getJob(link.jobId);
        check(job.bundleHash === receipt.bundleHash && job.destination === receipt.target.root,
            'REQUEST_CONFLICT', 'Publication job disagrees with metadata receipt');
        return job;
    }
    _jobRequest(requestId) {
        return 'takeover-' + crypto.createHash('sha256')
            .update(JSON.stringify([this.storeId, requestId]), 'utf8').digest('hex');
    }

    getTask(requestId) {
        request(requestId);
        const receipt = getProjectImportReceipt(this.store, requestId);
        if (!receipt) return null;
        if (receipt.state === 'purged') return {
            requestId, projectId: receipt.projectId, state: 'purged', target: receipt.target,
            materializeJobId: receipt.publication.jobId, ready: false, filesystemVerified: false,
            recordedComplete: false, purgedAt: receipt.purgedAt,
        };
        const job = this._assertLink(receipt);
        return {
            requestId, projectId: receipt.projectId, state: receipt.state,
            materializeJobId: job.id, publicationState: job.state,
            target: receipt.target, ready: false, filesystemVerified: false,
            // Reading persisted COMPLETE is not a fresh verification of later filesystem edits.
            recordedComplete: receipt.state === 'complete',
        };
    }

    start({ requestId, bundle, target, expectedHash }) {
        request(requestId);
        verifyBundle(bundle, expectedHash);
        validateTarget(target);
        const previous = getProjectImportReceipt(this.store, requestId);
        if (previous) this._assertLink(previous);
        const job = this.materializer.createJob({
            requestId: this._jobRequest(requestId), destination: target.root, bundle, expectedHash,
        });
        this._emit('job-created', job);
        const receipt = importProjectBundleOnce(this.store, bundle, { ...target, root: job.destination }, {
            requestId, publication: this._link(job.id), expectedHash,
            _testHook: (event, value) => this._emit(event, value),
        });
        this._emit('metadata-committed', receipt);
        return {
            requestId, projectId: receipt.projectId, materializeJobId: job.id,
            state: receipt.state, ready: false, filesystemVerified: false,
        };
    }

    resume(requestId, bundle, { expectedHash } = {}) {
        request(requestId);
        verifyBundle(bundle, expectedHash);
        const receipt = getProjectImportReceipt(this.store, requestId);
        check(receipt, 'NOT_FOUND', 'No import receipt yet; retry start with the original target');
        this._assertLink(receipt);
        // Recheck frozen metadata and blobs BEFORE any filesystem work; replay does not require absent root.
        importProjectBundleOnce(this.store, bundle, receipt.target, {
            requestId, publication: this._link(receipt.publication.jobId), expectedHash,
        });
        const published = this.materializer.resume(receipt.publication.jobId, bundle, { expectedHash });
        check(published.state === 'published', 'NOT_PUBLISHED', 'Publication has not completed');
        this._emit('files-published', published);
        // The completion hook is not an attestation: revalidate after any interruption/injected action.
        this.materializer.resume(published.id, bundle, { expectedHash });
        const completed = completeProjectImport(this.store, bundle, {
            requestId, publication: this._link(published.id), expectedHash,
            _testHook: (event, value) => this._emit(event, value),
        });
        this._emit('complete-committed', completed);
        this.materializer.resume(published.id, bundle, { expectedHash });
        return {
            ...completed.result, requestId, projectId: completed.projectId,
            materializeJobId: published.id, destination: completed.target.root,
            state: 'complete', ready: true, filesystemVerified: true,
            requiresMaterialization: false, metadataImported: true,
            // This is structural recovery verification, NOT a business/GUI/test acceptance report.
        };
    }

    takeover(args) {
        this.start(args);
        return this.resume(args.requestId, args.bundle, { expectedHash: args.expectedHash });
    }
}

module.exports = { ProjectTakeover, TakeoverError };