"use strict";

const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");
const {
    SidecarError,
    runtimePaths,
    ensureDirectory,
    readStateStrict,
    validateStateRecord,
    isPidAlive,
    getProcessIdentity,
    getLocalProcessIdentity,
    getLocalProcessIdentityConfirmed,
    sameProcessIdentity,
    terminateOwnedChild,
    reconcileDeadSidecarJobs,
    removeEndpoint,
    writeJsonAtomic,
    assertJobId,
    jobPaths,
    projectPatchProtocolProof
} = require("./protocol");
const {
    APP_SERVER_MAX_CONCURRENCY,
    isWriteProtocolProof,
    projectWriteProtocolStatus
} = require("./writeRuntimeConfig");

const OWNED_CHILD_TERMINATION_PROOFS = new WeakSet();
const SERVICE_TIER_OVERRIDE_PROTOCOL_VERSION = 1;

function hasExplicitServiceTierOverride(params) {
    if (!params || !Object.prototype.hasOwnProperty.call(params, "serviceTier")) return false;
    const value = params.serviceTier;
    return value !== undefined && value !== null && String(value).trim() !== "";
}

function getSafeIdentityCwd() {
    if (process.platform !== "win32") return null;
    return process.env.SystemRoot || process.env.WINDIR || path.parse(process.execPath).root;
}

function withSafeIdentityCwd(callback) {
    if (process.platform !== "win32") return callback();
    let originalCwd;
    try { originalCwd = process.cwd(); } catch { return callback(); }
    const safeCwd = getSafeIdentityCwd();
    if (!safeCwd || path.resolve(originalCwd).toLowerCase() === path.resolve(safeCwd).toLowerCase()) return callback();
    let changed = false;
    try {
        process.chdir(safeCwd);
        changed = true;
    } catch {}
    try {
        return callback();
    } finally {
        if (changed) {
            try { process.chdir(originalCwd); } catch {}
        }
    }
}

function getProcessIdentitySafely(pid) {
    return withSafeIdentityCwd(() => getProcessIdentity(pid));
}

function getLocalProcessIdentitySafely() {
    return withSafeIdentityCwd(() => getLocalProcessIdentity());
}

class SidecarClient {
    constructor(options = {}) {
        this.pluginDir = path.resolve(options.pluginDir || process.cwd());
        this.jobRoot = path.resolve(options.jobRoot || path.join(this.pluginDir, "jobs"));
        this.paths = runtimePaths(this.pluginDir, this.jobRoot);
        this.entryPath = path.resolve(options.entryPath || path.join(__dirname, "sidecar-entry.js"));
        this.codexBin = options.codexBin || "codex";
        this.codexGlobalArgs = Array.isArray(options.codexGlobalArgs) ? [...options.codexGlobalArgs] : [];
        this.identityProvider = options.identityProvider || getProcessIdentitySafely;
        this.identityDelay = options.identityDelay;
        this.processIdentity = Object.prototype.hasOwnProperty.call(options, "processIdentity")
            ? options.processIdentity
            : getLocalProcessIdentitySafely();
        this.maxConcurrency = Math.max(1, Number(options.maxConcurrency || APP_SERVER_MAX_CONCURRENCY));
        this.connectTimeoutMs = Math.max(250, Number(options.connectTimeoutMs || 1500));
        this.requestTimeoutMs = Math.max(500, Number(options.requestTimeoutMs || 10000));
        this.startupTimeoutMs = Math.max(1000, Number(options.startupTimeoutMs || 15000));
        this.startingTimeoutMs = Math.max(100, Number(options.startingTimeoutMs || this.startupTimeoutMs));
        this.lockWaitMs = Math.max(1000, Number(options.lockWaitMs || 20000));
        this.staleLockMs = Math.max(1000, Number(options.staleLockMs || 5000));
        const maxIpcBufferBytes = Number(options.maxIpcBufferBytes);
        this.maxIpcBufferBytes = Number.isFinite(maxIpcBufferBytes)
            ? Math.max(1024, Math.floor(maxIpcBufferBytes))
            : 1024 * 1024;
        this.cleanupHooks = options.cleanupHooks || options.hooks || {};
        this.stateReader = options.stateReader || options.readState || options.testHooks?.readState || this.cleanupHooks.readState || null;
        this.testStartupDelayMs = Math.max(0, Number(options.testStartupDelayMs || 0));
        this.reconcile = options.reconcileDeadSidecarJobs || reconcileDeadSidecarJobs;
        this.reconcileOptions = options.reconcileOptions || {};
        this.requestCounter = 1;
        this.sidecarChild = null;
    }

    async ensure() {
        const existing = await this._probeExisting(false, null);
        if (existing) return this._assertCompatibleConcurrency(existing);
        try {
            await this._ensureLocalProcessIdentity();
        } catch (error) {
            const observed = await this._probeExisting(false, null);
            if (observed) return this._assertCompatibleConcurrency(observed);
            throw error;
        }
        ensureDirectory(this.paths.runtime);
        const startedAt = Date.now();
        while (Date.now() - startedAt < this.lockWaitMs) {
            let lock;
            try {
                lock = this._tryAcquireLock();
            } catch (error) {
                const observed = await this._probeExisting(false, null);
                if (observed) return this._assertCompatibleConcurrency(observed);
                throw error;
            }
            if (lock) {
                try {
                    const afterLock = await this._probeExisting(false, lock);
                    if (afterLock) return this._assertCompatibleConcurrency(afterLock);
                    const child = this._spawnSidecar();
                    try {
                        const state = await this._waitForReady(child);
                        return this._assertCompatibleConcurrency(state);
                    } catch (error) {
                        let termination;
                        try {
                            termination = await terminateOwnedChild(child, {
                                identity: child.processIdentity,
                                gracefulTimeoutMs: 500
                            });
                        } catch {
                            termination = { confirmed: false };
                        }
                        if (termination?.confirmed === true) {
                            const provenError = new SidecarError(error?.code || "SIDECAR_START_FAILED", error?.message, {
                                ...(error?.details && typeof error.details === "object" && !Array.isArray(error.details)
                                    ? error.details
                                    : {}),
                                safeToFallback: true,
                                fallbackEvidence: "owned-child-termination-confirmed"
                            });
                            OWNED_CHILD_TERMINATION_PROOFS.add(provenError);
                            throw provenError;
                        }
                        throw error;
                    }
                } finally {
                    if (this._lockIsOwner(lock)) this._releaseLock(lock);
                }
            }
            await this._delay(50);
            const observed = await this._probeExisting(false, null);
            if (observed) return this._assertCompatibleConcurrency(observed);
        }
        throw new SidecarError("SIDECAR_START_TIMEOUT", "Timed out waiting for Sidecar startup lock");
    }

    async submitAnalyzeJob(params) {
        const state = await this.ensure();
        this._assertServiceTierOverrideCompatible(state, params);
        return this._callWithState(state, "submitAnalyzeJob", params);
    }

    async submitPatchJob(params = {}) {
        const jobId = assertJobId(params.jobId);
        const fixedPaths = jobPaths(this.jobRoot, jobId);
        const state = await this.ensure();
        this._assertServiceTierOverrideCompatible(state, params);
        try {
            return await this._callWithState(state, "submitPatchJob", {
                ...params,
                jobId,
                metaPath: fixedPaths.metaPath,
                outputPath: fixedPaths.outputPath,
                codexOutputPath: fixedPaths.codexOutputPath,
                patchPath: fixedPaths.patchPath
            });
        } catch (error) {
            const unknownTransportCodes = new Set([
                "SIDECAR_IPC_TIMEOUT",
                "SIDECAR_IPC_ERROR",
                "SIDECAR_IPC_CLOSED",
                "SIDECAR_IPC_WRITE_FAILED",
                "SIDECAR_IPC_BUFFER_OVERFLOW",
                "SIDECAR_RESPONSE_MISMATCH",
                "INVALID_SIDECAR_RESPONSE"
            ]);
            if (!unknownTransportCodes.has(error?.code)) throw error;
            throw new SidecarError(
                "AICW_APP_SERVER_PATCH_SUBMISSION_UNKNOWN",
                "Patch submission outcome is unknown and must not be replayed",
                { transportCode: error.code }
            );
        }
    }

    async submitWriteJob(params = {}) {
        const jobId = assertJobId(params.jobId);
        const fixedPaths = jobPaths(this.jobRoot, jobId);
        const state = await this.ensure();
        this._assertWriteSubmissionCompatible(state);
        this._assertServiceTierOverrideCompatible(state, params);
        try {
            return await this._callWithState(state, "submitWriteJob", {
                ...params,
                jobId,
                metaPath: fixedPaths.metaPath,
                outputPath: fixedPaths.outputPath,
                codexOutputPath: fixedPaths.codexOutputPath
            });
        } catch (error) {
            const unknownTransportCodes = new Set([
                "SIDECAR_IPC_TIMEOUT",
                "SIDECAR_IPC_ERROR",
                "SIDECAR_IPC_CLOSED",
                "SIDECAR_IPC_WRITE_FAILED",
                "SIDECAR_IPC_BUFFER_OVERFLOW",
                "SIDECAR_RESPONSE_MISMATCH",
                "INVALID_SIDECAR_RESPONSE"
            ]);
            if (!unknownTransportCodes.has(error?.code)) throw error;
            throw new SidecarError(
                "AICW_APP_SERVER_WRITE_SUBMISSION_UNKNOWN",
                "Write submission outcome is unknown and must not be replayed",
                { transportCode: error.code }
            );
        }
    }

    /**
     * Observe Sidecar state without starting, cleaning, or taking over anything.
     * This is intentionally separate from _probeExisting(): the latter is part
     * of ensure() and may reconcile a dead instance while acquiring a lock.
     */
    async inspectNoStart(options = {}) {
        let state;
        try {
            state = this._readState();
        } catch (error) {
            return this._inspectionError(error);
        }

        if (!state) {
            let lock;
            try {
                lock = this._readLockRecord();
            } catch (error) {
                return this._inspectionError(error);
            }
            if (!lock) return {
                status: "absent",
                activeJobs: 0,
                maxConcurrency: this.maxConcurrency,
                ...projectPatchProtocolProof(null),
                ...projectWriteProtocolStatus(null)
            };
            const lockStatus = this._inspectStartupLock(lock);
            return {
                status: lockStatus.status,
                pid: lock.pid,
                activeJobs: 0,
                maxConcurrency: this.maxConcurrency,
                ...projectPatchProtocolProof(null),
                ...projectWriteProtocolStatus(null),
                ...(lockStatus.errorCode ? { errorCode: lockStatus.errorCode } : {})
            };
        }

        if (!["starting", "ready", "degraded"].includes(state.status)) {
            return this._inspectionError(new SidecarError("SIDECAR_STATE_INVALID", "Sidecar state status is invalid"), state);
        }
        const inspection = this._inspectStateProcess(state);
        if (inspection.mismatch || !inspection.alive) {
            return this._safeInspection(state, "dead");
        }
        if (inspection.unknown) {
            return this._inspectionError(new SidecarError(
                state.status === "starting" ? "SIDECAR_STARTING_UNVERIFIED" : "SIDECAR_STATE_PROCESS_UNVERIFIED",
                "Sidecar process identity cannot be verified"
            ), state);
        }
        const lockWarning = this._liveStateLockWarning();
        if (state.status === "starting") return this._safeInspection(state, "starting", null, lockWarning);
        if (state.status === "degraded") return this._safeInspection(state, "degraded", null, lockWarning);

        if (options.ping === false) return this._safeInspection(state, "ready", null, lockWarning);
        try {
            const status = await this._callWithState(
                state,
                "status",
                {},
                { timeoutMs: Math.min(this.requestTimeoutMs, Math.max(250, Number(options.pingTimeoutMs || 750))) }
            );
            const inspection = this._safeInspection(state, "ready", status, lockWarning);
            if (Number(status?.maxConcurrency) !== this.maxConcurrency) {
                inspection.status = "error";
                inspection.errorCode = "SIDECAR_CONCURRENCY_MISMATCH";
            }
            return inspection;
        } catch (error) {
            const currentInspection = this._inspectStateProcess(state);
            if (!currentInspection.alive || currentInspection.mismatch) return this._safeInspection(state, "dead", null, lockWarning);
            return this._safeInspection(state, "unresponsive", {
                errorCode: error?.code || "SIDECAR_UNRESPONSIVE"
            }, lockWarning);
        }
    }

    /**
     * Reconcile only a confirmed dead Sidecar. Live, starting, degraded and
     * unresponsive instances are returned untouched; malformed/stale locks
     * remain fail-closed.
     */
    async reconcileDeadInstance() {
        const inspection = await this.inspectNoStart();
        if (inspection.status !== "dead") return inspection;

        let state;
        try {
            state = this._readState();
        } catch (error) {
            return this._inspectionError(error);
        }
        if (!state) return {
            status: "absent",
            activeJobs: 0,
            maxConcurrency: this.maxConcurrency,
            ...projectPatchProtocolProof(null),
            ...projectWriteProtocolStatus(null)
        };

        try {
            const cleaned = await this._cleanDeadState(state);
            if (!cleaned) {
                const replacement = this._readState();
                if (replacement && !this._sameStateIdentity(replacement, state)) return this.inspectNoStart();
                return { ...this._safeInspection(state, "dead"), errorCode: "SIDECAR_RECONCILIATION_NOT_PERFORMED" };
            }
            const replacement = this._readState();
            return replacement
                ? this.inspectNoStart()
                : {
                    status: "absent",
                    activeJobs: 0,
                    maxConcurrency: this.maxConcurrency,
                    reconciled: true,
                    ...projectPatchProtocolProof(null),
                    ...projectWriteProtocolStatus(null)
                };
        } catch (error) {
            const replacement = this._readState();
            if (replacement && !this._sameStateIdentity(replacement, state)) return this.inspectNoStart();
            return this._inspectionError(error, state);
        }
    }

    async ping() {
        const state = await this._requireExisting();
        return this._callWithState(state, "ping", {});
    }

    async status() {
        const state = this._readState();
        if (!state) throw new SidecarError("SIDECAR_NOT_RUNNING", "Sidecar state does not exist");
        const inspection = this._inspectStateProcess(state);
        if (state.status === "starting" && inspection.unknown && !state.processIdentity) throw new SidecarError("SIDECAR_STARTING_UNVERIFIED", "Starting Sidecar identity cannot be verified");
        if (!inspection.alive || inspection.mismatch) {
            await this._cleanDeadState(state);
            throw new SidecarError("SIDECAR_NOT_RUNNING", "Sidecar process is not running");
        }
        const status = await this._callWithState(state, "status", {});
        return {
            ...status,
            ...projectPatchProtocolProof(status),
            ...projectWriteProtocolStatus(status)
        };
    }

    async cancel(params) {
        const state = await this._requireExisting();
        return this._callWithState(state, "cancel", params);
    }

    async shutdown() {
        const state = await this._requireExisting();
        return this._callWithState(state, "shutdown", {});
    }

    _inspectionError(error, state = null) {
        return {
            ...this._safeInspection(state, "error"),
            errorCode: error?.code || "SIDECAR_INSPECTION_FAILED"
        };
    }

    _safeInspection(state, status, statusResult = null, warnings = null) {
        const result = {
            status,
            instanceId: state?.instanceId || statusResult?.instanceId || null,
            pid: state?.pid || statusResult?.pid || null,
            activeJobs: Array.isArray(statusResult?.activeJobs)
                ? statusResult.activeJobs.length
                : Number.isInteger(statusResult?.activeJobs)
                    ? statusResult.activeJobs
                    : 0,
            maxConcurrency: Number(statusResult?.maxConcurrency || this.maxConcurrency)
        };
        result.runtimeMaxConcurrency = Number.isSafeInteger(statusResult?.maxConcurrency)
            ? statusResult.maxConcurrency
            : null;
        Object.assign(result, projectPatchProtocolProof(
            statusResult === null || statusResult === undefined ? state : statusResult
        ));
        Object.assign(result, projectWriteProtocolStatus(
            statusResult === null || statusResult === undefined ? state : statusResult
        ));
        if (statusResult?.errorCode) result.errorCode = statusResult.errorCode;
        if (warnings) result.warnings = [warnings];
        return result;
    }

    _liveStateLockWarning() {
        try {
            const lock = this._readLockRecord();
            if (!lock) return null;
            const lockStatus = this._inspectStartupLock(lock);
            return lockStatus.status === "stale-lock" ? lockStatus.errorCode : null;
        } catch (error) {
            return error?.code === "SIDECAR_LOCK_INVALID" ? "SIDECAR_STARTUP_LOCK_INVALID" : "SIDECAR_STARTUP_LOCK_UNREADABLE";
        }
    }

    _inspectStartupLock(lock) {
        if (!isPidAlive(lock.pid)) {
            return { status: "stale-lock", errorCode: "SIDECAR_STARTUP_LOCK_STALE" };
        }
        const currentIdentity = getProcessIdentitySafely(lock.pid);
        if (!currentIdentity || !sameProcessIdentity(lock.processIdentity, currentIdentity)) {
            return { status: "stale-lock", errorCode: "SIDECAR_STARTUP_LOCK_STALE" };
        }
        return { status: "starting", errorCode: "SIDECAR_STARTUP_LOCK_BUSY" };
    }

    async _requireExisting() {
        const state = await this._probeExisting(true, null);
        if (!state) throw new SidecarError("SIDECAR_NOT_RUNNING", "Sidecar state does not exist");
        return this._assertCompatibleConcurrency(state);
    }

    async _probeExisting(throwOnUnresponsive, heldLock = null) {
        const state = this._readState();
        if (!state) return null;
        const inspection = this._inspectStateProcess(state);
        if (state.status === "starting") {
            if (inspection.unknown && !state.processIdentity) throw new SidecarError("SIDECAR_STARTING_UNVERIFIED", "Starting Sidecar identity cannot be verified");
            if (!inspection.alive || inspection.mismatch) {
                const cleaned = await this._cleanDeadState(state, heldLock);
                if (!cleaned) {
                    const replacement = this._readState();
                    if (replacement && replacement.instanceId !== state.instanceId) return this._probeExisting(throwOnUnresponsive, heldLock);
                }
                return null;
            }
            return this._waitForStarting(state, heldLock);
        }
        if (!inspection.alive || inspection.mismatch) {
            const cleaned = await this._cleanDeadState(state, heldLock);
            if (!cleaned) {
                const replacement = this._readState();
                if (replacement && replacement.instanceId !== state.instanceId) return this._probeExisting(throwOnUnresponsive, heldLock);
            }
            return null;
        }
        if (inspection.unknown) throw new SidecarError("SIDECAR_STATE_PROCESS_UNVERIFIED", "Sidecar process identity cannot be verified");
        if (state.status === "degraded") throw new SidecarError("SIDECAR_DEGRADED", "Sidecar is degraded and will not accept new work");
        try {
            await this._callWithState(state, "ping", {});
            return state;
        } catch (error) {
            throw new SidecarError("SIDECAR_UNRESPONSIVE", "Sidecar process is alive but IPC probe failed", { cause: error.code });
        }
    }

    _inspectStateProcess(state) {
        if (!isPidAlive(state?.pid)) return { alive: false, confirmed: false, mismatch: false, unknown: false };
        if (!state.processIdentity) return { alive: true, confirmed: false, mismatch: false, unknown: true };
        const current = getProcessIdentitySafely(state.pid);
        if (!current) return { alive: true, confirmed: false, mismatch: false, unknown: true };
        if (!sameProcessIdentity(state.processIdentity, current)) return { alive: true, confirmed: false, mismatch: true, unknown: false };
        return { alive: true, confirmed: true, mismatch: false, unknown: false };
    }

    _stateProcessAlive(state) {
        const inspection = this._inspectStateProcess(state);
        return inspection.alive && !inspection.mismatch && (!state?.processIdentity || inspection.confirmed);
    }

    async _waitForStarting(expectedState, heldLock = null) {
        const deadline = Date.now() + this.startingTimeoutMs;
        const identityRetryDeadline = Date.now() + Math.min(1000, this.startingTimeoutMs);
        while (Date.now() < deadline) {
            const state = this._readState();
            if (!state) return null;
            if (!this._sameStateIdentity(state, expectedState)) return this._probeExisting(false, heldLock);
            const inspection = this._inspectStateProcess(state);
            if (inspection.unknown) {
                if (!state.processIdentity || Date.now() >= identityRetryDeadline) {
                    throw new SidecarError("SIDECAR_STARTING_UNVERIFIED", "Starting Sidecar identity cannot be verified");
                }
                await this._delay(50);
                continue;
            }
            if (!inspection.alive || inspection.mismatch) {
                const cleaned = await this._cleanDeadState(state, heldLock);
                return cleaned ? null : this._probeExisting(false, heldLock);
            }
            if (state.status === "degraded") throw new SidecarError("SIDECAR_DEGRADED", "Sidecar is degraded and will not accept new work");
            if (state.status === "ready") {
                try {
                    await this._callWithState(state, "ping", {});
                    return state;
                } catch (error) {
                    const currentInspection = this._inspectStateProcess(state);
                    if (!currentInspection.alive || currentInspection.mismatch) {
                        const cleaned = await this._cleanDeadState(state, heldLock);
                        if (cleaned) return null;
                    }
                }
            } else if (state.status !== "starting") {
                throw new SidecarError("SIDECAR_STARTING_FAILED", `Sidecar left starting state: ${state.status}`);
            }
            await this._delay(50);
        }
        throw new SidecarError("SIDECAR_STARTING_TIMEOUT", "Sidecar remained live and starting past the startup deadline");
    }

    async _cleanDeadState(state, heldLock = null) {
        let lock = heldLock;
        let ownsLock = false;
        if (lock) {
            if (!this._lockIsOwner(lock)) return false;
        } else {
            lock = await this._waitForLock();
            if (!lock) return false;
            ownsLock = true;
        }
        try {
            if (!this._lockIsOwner(lock)) return false;
            const current = this._readState();
            if (!current) return true;
            if (!this._sameStateIdentity(current, state)) return false;
            let reconciliation;
            try {
                reconciliation = await this.reconcile(this.jobRoot, current, this.reconcileOptions);
            } catch {
                reconciliation = { complete: false, failures: [{ code: "RECONCILIATION_EXCEPTION" }] };
            }
            if (!reconciliation || reconciliation.complete !== true) {
                throw new SidecarError("SIDECAR_RECONCILIATION_FAILED", "Dead Sidecar reconciliation was incomplete");
            }
            const confirmed = this._readState();
            if (!this._sameStateIdentity(confirmed, state)) return false;
            const finalCheckHook = this.cleanupHooks.afterFinalStateCheck || this.cleanupHooks.beforeUnlink;
            if (finalCheckHook) await finalCheckHook(confirmed, lock);
            const finalState = this._readState();
            if (!this._sameStateIdentity(finalState, state)) return false;
            let deleted;
            try { deleted = this._unlinkState(); } catch (error) {
                if (error.code !== "ENOENT") throw error;
                return false;
            }
            if (!deleted) return false;
            if (process.platform !== "win32" && state?.endpoint) {
                const afterDelete = this._readState();
                if (!afterDelete) {
                    try { removeEndpoint(state.endpoint); } catch {}
                }
            }
            return true;
        } finally {
            if (ownsLock && this._lockIsOwner(lock)) this._releaseLock(lock);
        }
    }

    _readState() {
        if (typeof this.stateReader === "function") {
            let state;
            try { state = this.stateReader(); } catch (error) {
                if (error?.code === "ENOENT") return null;
                if (error instanceof SidecarError) throw error;
                throw new SidecarError("SIDECAR_STATE_READ_FAILED", "Could not read Sidecar state", { cause: error?.code });
            }
            if (state === null || state === undefined) return null;
            return validateStateRecord(state);
        }
        return readStateStrict(this.paths.statePath);
    }

    _unlinkState() {
        if (typeof this.cleanupHooks.unlinkState === "function") return this.cleanupHooks.unlinkState() !== false;
        try { fs.unlinkSync(this.paths.statePath); return true; } catch (error) { if (error.code !== "ENOENT") throw error; return false; }
    }

    _sameStateIdentity(left, right) {
        return Boolean(left && right && left.instanceId && left.controlToken &&
            left.instanceId === right.instanceId && left.controlToken === right.controlToken &&
            Number(left.pid) === Number(right.pid));
    }

    _lockIsOwner(lock) {
        if (!lock?.ownerToken) return false;
        let current;
        try { current = this._readLockRecord(); } catch { return false; }
        const identity = this.processIdentity;
        return Boolean(current && identity && current.ownerToken === lock.ownerToken &&
            Number(current.pid) === process.pid && sameProcessIdentity(current.processIdentity, lock.record?.processIdentity) &&
            sameProcessIdentity(current.processIdentity, identity));
    }

    async _ensureLocalProcessIdentity() {
        if (this.processIdentity) return this.processIdentity;
        this.processIdentity = await getLocalProcessIdentityConfirmed({
            identityProvider: this.identityProvider,
            delay: this.identityDelay
        });
        return this.processIdentity;
    }

    async _assertCompatibleConcurrency(state) {
        const status = await this._callWithState(state, "status", {});
        if (status?.instanceId !== state.instanceId) {
            throw new SidecarError("SIDECAR_INSTANCE_MISMATCH", "Sidecar status instance does not match the connected state", {
                expected: state.instanceId || null,
                actual: status?.instanceId || null
            });
        }
        if (Number(status?.maxConcurrency) !== this.maxConcurrency) {
            throw new SidecarError("SIDECAR_CONCURRENCY_MISMATCH", "Existing Sidecar concurrency does not match the required limit", {
                expected: this.maxConcurrency,
                actual: Number.isFinite(Number(status?.maxConcurrency)) ? Number(status.maxConcurrency) : null
            });
        }
        return {
            ...state,
            serviceTierOverrideProtocolVersion:
                status?.serviceTierOverrideProtocolVersion === SERVICE_TIER_OVERRIDE_PROTOCOL_VERSION
                    ? SERVICE_TIER_OVERRIDE_PROTOCOL_VERSION
                    : null,
            ...projectPatchProtocolProof(status),
            ...projectWriteProtocolStatus(status)
        };
    }

    _assertWriteSubmissionCompatible(state) {
        if (!isWriteProtocolProof(state)) {
            throw new SidecarError(
                "AICW_APP_SERVER_WRITE_SIDECAR_UNSUPPORTED",
                "The active Sidecar does not provide the required write protocol proof"
            );
        }
        if (state.writeConfigured !== true) {
            throw new SidecarError(
                "AICW_APP_SERVER_WRITE_NOT_CONFIGURED",
                "The active Sidecar has no usable server-side write configuration",
                state.writeConfigurationErrorCode
                    ? { cause: state.writeConfigurationErrorCode }
                    : undefined
            );
        }
    }

    _assertServiceTierOverrideCompatible(state, params) {
        if (!hasExplicitServiceTierOverride(params)) return;
        if (state?.serviceTierOverrideProtocolVersion === SERVICE_TIER_OVERRIDE_PROTOCOL_VERSION) return;
        throw new SidecarError(
            "AICW_SERVICE_TIER_SIDECAR_UNSUPPORTED",
            "The active Sidecar does not support explicit per-Job service tier overrides"
        );
    }

    async _waitForLock() {
        await this._ensureLocalProcessIdentity();
        const startedAt = Date.now();
        while (Date.now() - startedAt < this.lockWaitMs) {
            const lock = this._tryAcquireLock();
            if (lock) return lock;
            await this._delay(50);
        }
        return null;
    }

    _tryAcquireLock() {
        const ownerToken = crypto.randomBytes(16).toString("hex");
        const processIdentity = this.processIdentity;
        if (!processIdentity) throw new SidecarError("SIDECAR_LOCK_INVALID", "Current process identity could not be verified");
        const record = { ownerToken, pid: process.pid, processIdentity, createdAt: Date.now() };
        const temporary = `${this.paths.lockPath}.${process.pid}.${ownerToken}.tmp`;
        let fd;
        let published = false;
        try {
            fd = fs.openSync(temporary, "wx", 0o600);
            fs.writeFileSync(fd, JSON.stringify(record), "utf8");
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            fd = undefined;
            try {
                fs.linkSync(temporary, this.paths.lockPath);
                published = true;
            } catch (error) {
                if (error?.code !== "EEXIST") throw error;
            }
        } catch (error) {
            if (fd !== undefined) {
                try { fs.closeSync(fd); } catch {}
            }
            throw new SidecarError("SIDECAR_LOCK_FAILED", "Could not acquire Sidecar lock", { cause: error?.code });
        } finally {
            try { fs.unlinkSync(temporary); } catch {}
        }
        if (published) return { ownerToken, record };

        const existing = this._readLockRecord();
        if (!existing) return null;
        if (!isPidAlive(existing.pid)) {
            throw new SidecarError("SIDECAR_STARTUP_LOCK_STALE", "Sidecar startup lock owner is not alive");
        }
        const currentIdentity = getProcessIdentitySafely(existing.pid);
        if (!currentIdentity) throw new SidecarError("SIDECAR_LOCK_INVALID", "Sidecar startup lock owner identity cannot be verified");
        if (!sameProcessIdentity(existing.processIdentity, currentIdentity)) {
            throw new SidecarError("SIDECAR_STARTUP_LOCK_STALE", "Sidecar startup lock owner identity does not match");
        }
        return null;
    }

    _readLockRecord() {
        let record;
        try {
            record = JSON.parse(fs.readFileSync(this.paths.lockPath, "utf8"));
        } catch (error) {
            if (error?.code === "ENOENT") return null;
            if (error instanceof SyntaxError) throw new SidecarError("SIDECAR_LOCK_INVALID", "Sidecar startup lock is malformed");
            throw new SidecarError("SIDECAR_LOCK_INVALID", "Sidecar startup lock could not be read", { cause: error?.code });
        }
        if (!record || typeof record !== "object" || Array.isArray(record) ||
            typeof record.ownerToken !== "string" || !record.ownerToken ||
            !Number.isInteger(record.pid) || record.pid <= 0 ||
            !Number.isFinite(record.createdAt) || !record.processIdentity || typeof record.processIdentity !== "object") {
            throw new SidecarError("SIDECAR_LOCK_INVALID", "Sidecar startup lock record is invalid");
        }
        return record;
    }

    _releaseLock(lock) {
        if (!this._lockIsOwner(lock)) return;
        const current = this._readLockRecord();
        if (!current || current.ownerToken !== lock.ownerToken || !sameProcessIdentity(current.processIdentity, lock.record?.processIdentity)) return;
        try { fs.unlinkSync(this.paths.lockPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }

    _spawnSidecar() {
        const args = [
            this.entryPath,
            "--plugin-dir", this.pluginDir,
            "--job-root", this.jobRoot,
            "--codex-bin", this.codexBin,
            "--codex-global-args", JSON.stringify(this.codexGlobalArgs),
            "--max-concurrency", String(this.maxConcurrency),
            ...(this.testStartupDelayMs > 0 ? ["--test-startup-delay-ms", String(this.testStartupDelayMs)] : [])
        ];
        let child;
        try {
            child = spawn(process.execPath, args, {
                cwd: getSafeIdentityCwd() || this.pluginDir,
                env: { ...process.env },
                shell: false,
                detached: true,
                stdio: "ignore",
                windowsHide: true
            });
        } catch (error) {
            throw new SidecarError("SIDECAR_SPAWN_FAILED", "Could not start Sidecar", {
                cause: error.code,
                safeToFallback: true,
                fallbackEvidence: "spawn-not-created"
            });
        }
        child.processIdentity = getProcessIdentitySafely(child.pid);
        this.sidecarChild = child;
        child.unref();
        return child;
    }

    async _waitForReady(child) {
        const deadline = Date.now() + this.startupTimeoutMs;
        while (Date.now() < deadline) {
            const state = this._readState();
            if (state && state.pid === child.pid && state.status === "ready" &&
                (!state.processIdentity || !child.processIdentity || sameProcessIdentity(state.processIdentity, child.processIdentity))) {
                try {
                    await this._callWithState(state, "ping", {});
                    if (!state.processIdentity && child.processIdentity) {
                        state.processIdentity = child.processIdentity;
                        writeJsonAtomic(this.paths.statePath, state);
                    }
                    return state;
                } catch (error) {
                    if (!this._stateProcessAlive(state)) throw new SidecarError("SIDECAR_START_FAILED", "Sidecar exited during startup");
                }
            }
            if (child.exitCode !== null || child.signalCode !== null || !isPidAlive(child.pid)) {
                throw new SidecarError("SIDECAR_START_FAILED", "Sidecar exited during startup");
            }
            await this._delay(50);
        }
        throw new SidecarError("SIDECAR_START_TIMEOUT", "Timed out waiting for Sidecar readiness");
    }

    _callWithState(state, method, params, options = {}) {
        if (!state?.endpoint || !state.controlToken) return Promise.reject(new SidecarError("SIDECAR_STATE_INVALID", "Sidecar state is incomplete"));
        const requestId = String(this.requestCounter++);
        return new Promise((resolve, reject) => {
            let settled = false;
            let buffer = "";
            let socket;
            const finish = (error, value) => {
                if (settled) return;
                settled = true;
                buffer = "";
                clearTimeout(timeout);
                if (socket && !socket.destroyed) socket.destroy();
                if (error) reject(error); else resolve(value);
            };
            const timeoutMs = Math.max(250, Number(options.timeoutMs || this.requestTimeoutMs));
            const timeout = setTimeout(() => finish(new SidecarError("SIDECAR_IPC_TIMEOUT", `Sidecar request timed out: ${method}`)), timeoutMs);
            try {
                socket = net.createConnection(state.endpoint);
                socket.setEncoding("utf8");
                socket.setTimeout(this.connectTimeoutMs, () => finish(new SidecarError("SIDECAR_IPC_TIMEOUT", "Sidecar IPC connection timed out")));
                socket.once("connect", () => {
                    socket.setTimeout(0);
                    try { socket.write(`${JSON.stringify({ requestId, token: state.controlToken, method, params })}\n`); } catch (error) { finish(new SidecarError("SIDECAR_IPC_WRITE_FAILED", "Could not write Sidecar request", { cause: error.code })); }
                });
                socket.on("data", chunk => {
                    if (settled) return;
                    buffer += chunk;
                    const newline = buffer.indexOf("\n");
                    if (newline === -1) {
                        if (Buffer.byteLength(buffer, "utf8") > this.maxIpcBufferBytes) {
                            finish(new SidecarError("SIDECAR_IPC_BUFFER_OVERFLOW", "Sidecar IPC response exceeded the buffer limit"));
                        }
                        return;
                    }
                    const lineBytes = Buffer.byteLength(buffer.slice(0, newline), "utf8");
                    if (lineBytes > this.maxIpcBufferBytes) {
                        finish(new SidecarError("SIDECAR_IPC_BUFFER_OVERFLOW", "Sidecar IPC response exceeded the buffer limit"));
                        return;
                    }
                    const line = buffer.slice(0, newline);
                    buffer = "";
                    let response;
                    try { response = JSON.parse(line); } catch { finish(new SidecarError("INVALID_SIDECAR_RESPONSE", "Sidecar returned invalid JSON")); return; }
                    if (!response || typeof response !== "object" || Array.isArray(response)) {
                        finish(new SidecarError("INVALID_SIDECAR_RESPONSE", "Sidecar response envelope is invalid"));
                        return;
                    }
                    if (response.requestId !== requestId) {
                        finish(new SidecarError("SIDECAR_RESPONSE_MISMATCH", "Sidecar response requestId mismatch"));
                        return;
                    }
                    const isObject = value => value && typeof value === "object" && !Array.isArray(value);
                    const hasText = value => typeof value === "string" && value.trim().length > 0;
                    if (response.ok === true && isObject(response.result)) {
                        finish(null, response.result);
                        return;
                    }
                    if (response.ok === false && isObject(response.error) &&
                        hasText(response.error.code) && hasText(response.error.message)) {
                        finish(new SidecarError(response.error.code.trim(), response.error.message.trim(), response.error.details));
                        return;
                    }
                    finish(new SidecarError("INVALID_SIDECAR_RESPONSE", "Sidecar response envelope is invalid"));
                });
                socket.once("error", error => finish(new SidecarError("SIDECAR_IPC_ERROR", "Sidecar IPC failed", { cause: error.code })));
                socket.once("close", () => {
                    if (!settled) finish(new SidecarError("SIDECAR_IPC_CLOSED", "Sidecar IPC closed before response"));
                });
            } catch (error) {
                finish(new SidecarError("SIDECAR_IPC_ERROR", "Sidecar IPC failed", { cause: error.code }));
            }
        });
    }

    _delay(milliseconds) {
        return new Promise(resolve => setTimeout(resolve, milliseconds));
    }
}

function hasOwnedChildTerminationProof(error) {
    return (typeof error === "object" && error !== null) || typeof error === "function"
        ? OWNED_CHILD_TERMINATION_PROOFS.has(error)
        : false;
}

module.exports = { SidecarClient, hasOwnedChildTerminationProof };
