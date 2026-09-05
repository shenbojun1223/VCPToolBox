"use strict";

const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { EventEmitter } = require("events");
const { CodexAppServerProcess } = require("./codexAppServerProcess");
const { GitWorktreeAdapter } = require("./gitWorktreeAdapter");
const { WorktreeWriteSession } = require("./worktreeWriteSession");
const { TrustedValidationRunner } = require("./trustedValidationRunner");
const {
    APP_SERVER_MAX_CONCURRENCY,
    WRITE_MAX_CONCURRENCY,
    getWriteProtocolStatus
} = require("./writeRuntimeConfig");
const {
    SidecarError,
    runtimePaths,
    ensureDirectory,
    writeJsonAtomic,
    readJson,
    updateJsonAtomic,
    updateJobMetaLocked,
    validateJobPaths,
    validatePatchJobPaths,
    assertJobId,
    assertAbsolutePath,
    pinPatchArtifactDirectory,
    verifyPatchArtifactDirectory,
    createPatchArtifactNonce,
    inspectPatchArtifactFile,
    removePatchArtifactExact,
    removeEndpoint,
    getLocalProcessIdentityConfirmed,
    getProcessIdentity,
    getPatchProtocolProof
} = require("./protocol");
const {
    MAX_PATCH_BYTES,
    validatePatchModel,
    validatePatchEffort,
    extractPatchPayload,
    parseUnifiedDiff,
    assertNoSecrets,
    captureGitBaseline,
    startGitBaselineMonitor,
    validateTrackedPaths,
    applyCheck,
    createPrivateCandidate,
    publishCandidateNoOverwrite,
    sha256
} = require("./patchValidator");

const TERMINAL_STATES = new Set(["completed", "cancelled", "failed", "timeout"]);
const SAFE_WRITE_VALIDATION_PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WRITE_REQUEST_FIELDS = new Set([
    "jobId", "projectPath", "text", "model", "effort", "serviceTier", "timeoutSec",
    "metaPath", "outputPath", "codexOutputPath"
]);
const UNCERTAIN_WRITE_CANDIDATE_CODES = new Set([
    "WORKTREE_CANDIDATE_OUTCOME_UNKNOWN",
    "WORKTREE_CANDIDATE_INDEX_ROLLBACK_UNCONFIRMED",
    "WORKTREE_SESSION_OUTCOME_UNCERTAIN"
]);

function safeWriteErrorCode(error) {
    return typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
        ? error.code
        : "AICW_WRITE_FINALIZE_FAILED";
}

function safeValidationSteps(steps) {
    if (!Array.isArray(steps)) return [];
    return steps.map(step => ({
        name: typeof step?.name === "string" ? step.name.slice(0, 64) : "unknown",
        status: typeof step?.status === "string" ? step.status.slice(0, 32) : "unknown",
        exitCode: Number.isInteger(step?.exitCode) ? step.exitCode : null,
        timedOut: step?.timedOut === true
    }));
}

function canonicalWriteRoots(values) {
    if (!Array.isArray(values)) return [];
    const roots = [];
    for (const value of values) {
        if (typeof value !== "string" || !path.isAbsolute(value)) return [];
        try {
            const resolved = path.resolve(value);
            const stat = fs.lstatSync(resolved);
            const realPath = fs.realpathSync.native(resolved);
            if (!stat.isDirectory() || stat.isSymbolicLink() || realPath !== resolved) return [];
            roots.push(realPath);
        } catch {
            return [];
        }
    }
    return [...new Set(roots)];
}

function assertAllowedWriteProject(value, roots) {
    const requested = assertAbsolutePath(value, "projectPath");
    let stat;
    let realPath;
    try {
        stat = fs.lstatSync(requested);
        realPath = fs.realpathSync.native(requested);
    } catch {
        throw new SidecarError("AICW_WRITE_PROJECT_NOT_ALLOWED", "Write project path is unavailable");
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || realPath !== requested) {
        throw new SidecarError("AICW_WRITE_PROJECT_NOT_ALLOWED", "Write project path is not canonical");
    }
    const allowed = roots.some(root => {
        const relative = path.relative(root, realPath);
        return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
    });
    if (!allowed) throw new SidecarError("AICW_WRITE_PROJECT_NOT_ALLOWED", "Write project path is outside server allowed roots");
    return realPath;
}

function validateServiceTierOverride(value) {
    if (value === undefined || value === null || String(value).trim() === "") return null;
    const normalized = String(value).trim().toLowerCase();
    if (normalized !== "default" && normalized !== "fast") {
        throw new SidecarError("CODEX_SERVICE_TIER_INVALID", "serviceTier must be default or fast");
    }
    return normalized;
}

function withSafeIdentityCwd(callback) {
    if (process.platform !== "win32") return callback();
    let originalCwd;
    try { originalCwd = process.cwd(); } catch { return callback(); }
    const safeCwd = process.env.SystemRoot || process.env.WINDIR || path.parse(process.execPath).root;
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

class SidecarServer extends EventEmitter {
    constructor(options = {}) {
        super();
        this.pluginDir = path.resolve(options.pluginDir || process.cwd());
        this.jobRoot = path.resolve(options.jobRoot || path.join(this.pluginDir, "jobs"));
        this.paths = runtimePaths(this.pluginDir, this.jobRoot);
        this.codexBin = options.codexBin || "codex";
        this.codexGlobalArgs = Array.isArray(options.codexGlobalArgs) ? [...options.codexGlobalArgs] : [];
        this.identityProvider = options.identityProvider;
        this.identityDelay = options.identityDelay;
        this.maxConcurrency = Math.max(1, Number(options.maxConcurrency || APP_SERVER_MAX_CONCURRENCY));
        this.requestTimeoutMs = Math.max(500, Number(options.requestTimeoutMs || 10000));
        this.cancelTimeoutMs = Math.max(250, Number(options.cancelTimeoutMs || 3000));
        this.timeoutGraceMs = Math.max(250, Number(options.timeoutGraceMs || Math.min(this.cancelTimeoutMs, 1000)));
        this.drainTimeoutMs = Math.max(500, Number(options.drainTimeoutMs || 2500));
        const maxIpcBufferBytes = Number(options.maxIpcBufferBytes);
        this.maxIpcBufferBytes = Number.isFinite(maxIpcBufferBytes)
            ? Math.max(1024, Math.floor(maxIpcBufferBytes))
            : 1024 * 1024;
        this.testStartupDelayMs = Math.max(0, Number(options.testStartupDelayMs || 0));
        this.patchGitOptions = options.patchGitOptions || {};
        this.patchMonitorIntervalMs = Math.max(50, Number(options.patchMonitorIntervalMs || 500));
        this.patchArtifactHooks = options.patchArtifactHooks || {};
        this.patchMetaOptions = options.patchMetaOptions || {};
        this._writeEnabled = options.writeEnabled === true;
        this._writeAllowedProjectRoots = canonicalWriteRoots(options.writeAllowedProjectRoots);
        this._writeWorkspaceBaseRoot = this._writeEnabled ? options.writeWorkspaceBaseRoot ?? null : null;
        this._writeAdapter = this._writeWorkspaceBaseRoot === null
            ? null
            : new GitWorktreeAdapter({ workspaceBaseRoot: this._writeWorkspaceBaseRoot });
        this._writeValidationRunner = this._writeEnabled && options.writeValidationRunner instanceof TrustedValidationRunner
            ? options.writeValidationRunner
            : null;
        this._writeValidationProfile = this._writeEnabled && typeof options.writeValidationProfile === "string" &&
            SAFE_WRITE_VALIDATION_PROFILE.test(options.writeValidationProfile)
            ? options.writeValidationProfile
            : null;
        this._writeConfigured = Boolean(this._writeEnabled && this._writeAllowedProjectRoots.length > 0 &&
            this._writeAdapter && this._writeValidationRunner && this._writeValidationProfile);
        this._writeConfigurationErrorCode = this._writeConfigured
            ? null
            : this._writeEnabled
                ? String(options.writeConfigurationErrorCode || "AICW_WRITE_CONFIGURATION_INVALID").slice(0, 64)
                : null;
        this.activeJobs = new Map();
        this.seenJobs = new Set();
        this.sockets = new Set();
        this.server = null;
        this.codex = null;
        this.state = null;
        this.shutdownPromise = null;
        this.started = false;
        this.draining = false;
        this._loadSeenJobs();
    }

    _loadSeenJobs() {
        const metaDir = path.join(this.jobRoot, "meta");
        let entries = [];
        try { entries = fs.readdirSync(metaDir); } catch { return; }
        for (const entry of entries) {
            if (!entry.endsWith(".json") || entry.endsWith(".args.json")) continue;
            try {
                const meta = readJson(path.join(metaDir, entry));
                if (meta?.jobId && (meta.sidecarInstanceId || meta.executionBackend || TERMINAL_STATES.has(meta.state))) {
                    this.seenJobs.add(String(meta.jobId));
                }
            } catch {}
        }
    }

    async start() {
        if (this.started) return this;
        const processIdentity = await getLocalProcessIdentityConfirmed({
            identityProvider: this.identityProvider || getProcessIdentitySafely,
            delay: this.identityDelay
        });
        ensureDirectory(this.paths.runtime);
        if (process.platform !== "win32") {
            try { removeEndpoint(this.paths.endpoint); } catch (error) {
                throw new SidecarError("ENDPOINT_CLEANUP_FAILED", "Could not prepare Sidecar endpoint", { cause: error.code });
            }
        }
        this.server = net.createServer(socket => this._acceptSocket(socket));
        await new Promise((resolve, reject) => {
            const onError = error => { this.server?.off("listening", onListening); reject(error); };
            const onListening = () => { this.server?.off("error", onError); resolve(); };
            this.server.once("error", onError);
            this.server.once("listening", onListening);
            this.server.listen(this.paths.endpoint);
        });
        this.state = {
            schemaVersion: 1,
            instanceId: crypto.randomUUID(),
            controlToken: crypto.randomBytes(32).toString("hex"),
            pid: process.pid,
            endpoint: this.paths.endpoint,
            startedAt: new Date().toISOString(),
            processStartedAt: new Date().toISOString(),
            processIdentity,
            ...getPatchProtocolProof(),
            ...getWriteProtocolStatus({
                configured: this._writeConfigured,
                errorCode: this._writeConfigurationErrorCode
            }),
            status: "starting",
            codexBin: this.codexBin,
            codexVersion: null,
            codexPid: null
        };
        writeJsonAtomic(this.paths.statePath, this.state);
        if (this.testStartupDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.testStartupDelayMs));

        this.codex = new CodexAppServerProcess({
            codexBin: this.codexBin,
            codexGlobalArgs: this.codexGlobalArgs,
            cwd: this.pluginDir,
            requestTimeoutMs: this.requestTimeoutMs
        });
        this.codex.on("notification", message => this._handleNotification(message));
        this.codex.on("serverRequest", request => this._handleServerRequest(request));
        this.codex.on("protocolError", error => this._handleProtocolError(error));
        this.codex.once("closed", info => this._handleCodexClosed(info));
        try {
            await this.codex.start();
            this.state.codexVersion = this.codex.version;
            this.state.codexPid = this.codex.codexPid;
            this.state.codexProcessIdentity = this.codex.codexIdentity;
            this.state.status = "ready";
            writeJsonAtomic(this.paths.statePath, this.state);
        } catch (error) {
            this.state.status = "degraded";
            try { writeJsonAtomic(this.paths.statePath, this.state); } catch {}
            await this.codex.stop({ suppressClosed: true });
            await this._closeServer();
            try { fs.unlinkSync(this.paths.statePath); } catch {}
            if (process.platform !== "win32") {
                try { removeEndpoint(this.paths.endpoint); } catch {}
            }
            throw error instanceof SidecarError
                ? error
                : new SidecarError("SIDECAR_START_FAILED", "Sidecar startup failed", { cause: error.code });
        }
        this.started = true;
        return this;
    }

    _acceptSocket(socket) {
        this.sockets.add(socket);
        let buffer = "";
        let handled = false;
        socket.setEncoding("utf8");
        socket.on("data", chunk => {
            if (handled) return;
            buffer += chunk;
            let newline;
            while (!handled) {
                newline = buffer.indexOf("\n");
                if (newline === -1) {
                    if (Buffer.byteLength(buffer, "utf8") > this.maxIpcBufferBytes) {
                        handled = true;
                        buffer = "";
                        this._sendError(socket, null, new SidecarError("SIDECAR_IPC_BUFFER_OVERFLOW", "Sidecar IPC request exceeded the buffer limit"));
                    }
                    return;
                }
                const rawLine = buffer.slice(0, newline);
                if (Buffer.byteLength(rawLine, "utf8") > this.maxIpcBufferBytes) {
                    handled = true;
                    buffer = "";
                    this._sendError(socket, null, new SidecarError("SIDECAR_IPC_BUFFER_OVERFLOW", "Sidecar IPC request exceeded the buffer limit"));
                    return;
                }
                const line = rawLine.replace(/\r$/, "");
                buffer = buffer.slice(newline + 1);
                if (!line.trim()) continue;
                handled = true;
                buffer = "";
                this._handleIpcLine(socket, line).catch(error => this._sendError(socket, null, error));
            }
        });
        socket.once("close", () => this.sockets.delete(socket));
        socket.once("error", () => this.sockets.delete(socket));
    }

    async _handleIpcLine(socket, line) {
        let request;
        try { request = JSON.parse(line); } catch {
            this._sendError(socket, null, new SidecarError("INVALID_IPC_JSON", "Invalid IPC JSON"));
            return;
        }
        const requestId = request?.requestId ?? null;
        if (!request || typeof request !== "object") {
            this._sendError(socket, requestId, new SidecarError("INVALID_IPC_REQUEST", "IPC request must be an object"));
            return;
        }
        if (!this.state || request.token !== this.state.controlToken) {
            this._sendError(socket, requestId, new SidecarError("INVALID_CONTROL_TOKEN", "Invalid Sidecar control token"));
            return;
        }
        try {
            const result = await this._dispatch(request.method, request.params || {});
            this._sendResult(socket, requestId, result);
        } catch (error) {
            this._sendError(socket, requestId, error);
        }
    }

    _sendResult(socket, requestId, result) {
        if (socket.destroyed) return;
        try { socket.end(`${JSON.stringify({ requestId, ok: true, result })}\n`); } catch {}
    }

    _sendError(socket, requestId, error) {
        if (socket.destroyed) return;
        const safe = error instanceof SidecarError
            ? error
            : new SidecarError("SIDECAR_INTERNAL_ERROR", "Sidecar request failed");
        try {
            socket.end(`${JSON.stringify({
                requestId,
                ok: false,
                error: { code: safe.code, message: safe.message, details: safe.details }
            })}\n`);
        } catch {}
    }

    async _dispatch(method, params) {
        if (method === "ping") return { pong: true, instanceId: this.state?.instanceId };
        if (method === "status") return this.status();
        if (method === "submitAnalyzeJob") return this._submitAnalyzeJob(params);
        if (method === "submitPatchJob") return this._submitPatchJob(params);
        if (method === "submitWriteJob") return this._submitWriteJob(params);
        if (method === "cancel") return this._cancel(params);
        if (method === "shutdown") {
            setImmediate(() => { this.shutdown().catch(error => this.emit("protocolError", error)); });
            return { accepted: true };
        }
        throw new SidecarError("UNKNOWN_METHOD", `Unsupported Sidecar method: ${String(method || "")}`);
    }

    status() {
        return {
            instanceId: this.state?.instanceId || null,
            status: this.state?.status || "closed",
            pid: this.state?.pid || null,
            codexPid: this.state?.codexPid || null,
            activeJobs: [...this.activeJobs.values()].map(job => ({
                jobId: job.jobId,
                threadId: job.threadId,
                turnId: job.turnId,
                state: job.state,
                kind: job.kind,
                finalizationFailed: Boolean(job.finalizationFailed),
                errorCode: job.finalizationError?.code || null
            })),
            maxConcurrency: this.maxConcurrency,
            serviceTierOverrideProtocolVersion: 1,
            ...getPatchProtocolProof(),
            ...getWriteProtocolStatus({
                configured: this._writeConfigured,
                errorCode: this._writeConfigurationErrorCode
            })
        };
    }

    async _openWriteSession(params) {
        if (!this._writeConfigured || !this._writeAdapter) {
            throw new SidecarError("AICW_WRITE_NOT_CONFIGURED", "Sidecar write sessions are not configured");
        }
        const jobId = assertJobId(params.jobId);
        const projectPath = assertAllowedWriteProject(params.projectPath, this._writeAllowedProjectRoots);
        const session = new WorktreeWriteSession({
            adapter: this._writeAdapter,
            jobId,
            repoRoot: projectPath,
            workspaceBaseRoot: this._writeWorkspaceBaseRoot
        });
        const handle = await session.open();
        return { session, handle };
    }

    async _submitWriteJob(params) {
        if (!this._writeConfigured || !this._writeAdapter || !this._writeValidationRunner || !this._writeValidationProfile) {
            throw new SidecarError("AICW_WRITE_NOT_CONFIGURED", "Sidecar write Jobs are not configured");
        }
        let plainParams = false;
        try {
            plainParams = Boolean(params) && typeof params === "object" && !Array.isArray(params) &&
                Object.getPrototypeOf(params) === Object.prototype;
        } catch {}
        if (!plainParams) {
            throw new SidecarError("AICW_WRITE_REQUEST_INVALID", "Write Job request must be a plain object");
        }
        if (Object.keys(params).some(key => !WRITE_REQUEST_FIELDS.has(key))) {
            throw new SidecarError("AICW_WRITE_REQUEST_INVALID", "Write Job request contains unsupported fields");
        }
        if (typeof params.jobId !== "string" || typeof params.projectPath !== "string" ||
            typeof params.text !== "string" || params.text.length < 1 || params.text.length > 100_000 ||
            (params.model !== undefined && (typeof params.model !== "string" || params.model.length > 128)) ||
            (params.effort !== undefined && (typeof params.effort !== "string" || params.effort.length > 64))) {
            throw new SidecarError("AICW_WRITE_REQUEST_INVALID", "Write Job request fields are invalid");
        }
        if (this.draining || this.state?.status !== "ready") throw new SidecarError("SIDECAR_NOT_READY", "Sidecar is not ready");
        let activeWriteJobs = 0;
        for (const job of this.activeJobs.values()) {
            if (job.kind === "write") activeWriteJobs++;
        }
        if (activeWriteJobs >= WRITE_MAX_CONCURRENCY) {
            throw new SidecarError("AICW_WRITE_CONCURRENCY_LIMIT", "At most two write Jobs may hold ownership");
        }
        if (this.activeJobs.size >= this.maxConcurrency) throw new SidecarError("CONCURRENCY_LIMIT", "Sidecar concurrency limit reached");
        const jobId = assertJobId(params.jobId);
        const projectPath = assertAllowedWriteProject(params.projectPath, this._writeAllowedProjectRoots);
        const serviceTier = validateServiceTierOverride(params.serviceTier);
        const timeoutSec = params.timeoutSec === undefined ? 600 : Number(params.timeoutSec);
        if (!Number.isFinite(timeoutSec) || timeoutSec <= 0 || timeoutSec > 86400) {
            throw new SidecarError("INVALID_TIMEOUT_SEC", "timeoutSec must be a finite number greater than 0 and at most 86400");
        }
        const paths = validateJobPaths(this.jobRoot, jobId, params);
        if (!fs.existsSync(paths.metaPath)) throw new SidecarError("META_NOT_FOUND", "Job meta file does not exist");
        let meta;
        try { meta = readJson(paths.metaPath); } catch { throw new SidecarError("META_INVALID", "Job meta file is invalid"); }
        if (String(meta.jobId || "") !== jobId) throw new SidecarError("META_JOB_MISMATCH", "Job meta does not match jobId");
        if (this.seenJobs.has(jobId) || this.activeJobs.has(jobId) || meta.sidecarInstanceId || meta.executionBackend || TERMINAL_STATES.has(meta.state)) {
            throw new SidecarError("DUPLICATE_JOB_ID", "jobId has already been submitted");
        }
        const job = {
            jobId,
            kind: "write",
            projectPath,
            model: params.model,
            effort: params.effort,
            paths,
            outputBytes: 0,
            timeoutSec,
            timeoutTimer: null,
            timeoutFinalizeTimer: null,
            cancelTimeoutTimer: null,
            timeoutRequested: false,
            threadId: null,
            turnId: null,
            state: "starting",
            cancelRequested: false,
            terminalClaim: null,
            finalizing: false,
            terminal: false,
            terminalPromise: null,
            resolveTerminal: null,
            finalizationFailed: false,
            finalizationError: null,
            eventChain: Promise.resolve(),
            turnBoundPromise: null,
            resolveTurnBound: null,
            interruptPromise: null,
            interruptRequested: false,
            accepted: false,
            session: null,
            handle: null,
            candidateResult: null
        };
        job.terminalPromise = new Promise(resolve => { job.resolveTerminal = resolve; });
        job.turnBoundPromise = new Promise(resolve => { job.resolveTurnBound = resolve; });
        this.activeJobs.set(jobId, job);
        job.timeoutTimer = setTimeout(() => this._handleTimeout(job), timeoutSec * 1000);
        job.timeoutTimer.unref?.();
        this.seenJobs.add(jobId);
        try {
            await this._updateMeta(job, metaValue => {
                metaValue.sidecarInstanceId = this.state.instanceId;
                metaValue.sidecarPid = this.state.pid;
                metaValue.executionBackend = "codex-app-server";
                metaValue.jobKind = "write";
                metaValue.jobPhase = "worktree-creating";
                metaValue.state = "running";
                metaValue.submissionState = "submitting";
                metaValue.sandboxMode = "workspace-write";
                metaValue.approvalPolicy = "never";
                metaValue.validationProfile = this._writeValidationProfile;
                metaValue.validationPassed = false;
                metaValue.candidateAvailable = false;
            });

            const opened = await this._openWriteSession({ jobId, projectPath });
            job.session = opened.session;
            job.handle = opened.handle;
            job.projectPath = opened.handle.worktreePath;
            await this._updateMeta(job, metaValue => {
                metaValue.gitRepoRoot = opened.handle.repoRoot;
                metaValue.worktreePath = opened.handle.worktreePath;
                metaValue.worktreeBranch = opened.handle.branch;
                metaValue.worktreeLockReason = opened.handle.lockReason;
                metaValue.baseHead = opened.handle.base.baseRevision;
                metaValue.baseTree = opened.handle.base.baseTree;
                metaValue.baseStatusSha256 = opened.handle.base.statusSha256;
                metaValue.worktreeLocked = true;
                metaValue.jobPhase = "running";
            });

            const threadOutcome = await this._awaitStartOrTerminal(job, this.codex.startThread({
                projectPath: opened.handle.worktreePath,
                model: params.model,
                serviceTier,
                writeMode: true
            }));
            if (threadOutcome.terminal) return this._terminalSubmissionResult(job, threadOutcome.terminal);
            const thread = threadOutcome.value;
            job.threadId = thread.id;
            await this._updateMeta(job, metaValue => {
                metaValue.threadId = job.threadId;
                metaValue.jobPhase = "running";
            });
            const turnOutcome = await this._awaitStartOrTerminal(job, this.codex.startTurn({
                threadId: job.threadId,
                text: params.text,
                effort: params.effort,
                serviceTier,
                writeMode: true,
                projectPath: opened.handle.worktreePath,
                model: params.model
            }));
            if (turnOutcome.terminal) return this._terminalSubmissionResult(job, turnOutcome.terminal);
            const turn = turnOutcome.value;
            if (!turn?.id) throw new SidecarError("CODEX_INVALID_RESPONSE", "turn/start did not return turn.id");
            await job.eventChain;
            if (job.finalizationError) throw job.finalizationError;
            if (job.turnId && job.turnId !== turn.id) {
                this._recordProtocolEvent("protocol/turn-id-conflict", { jobId, threadId: job.threadId });
                if (!job.terminal && !job.finalizing) await this._finishJob(job, "failed", 1, "Turn ID conflict", "TURN_ID_CONFLICT");
                throw new SidecarError("TURN_ID_CONFLICT", "turn/start response conflicts with a trusted turn notification");
            }
            if (!job.turnId) this._bindTurn(job, turn.id);
            await job.eventChain;
            if (job.finalizationError) throw job.finalizationError;
            if (job.terminal) {
                return { accepted: true, jobId, threadId: job.threadId, turnId: job.turnId, terminalState: job.state };
            }
            return { accepted: true, jobId, threadId: job.threadId, turnId: job.turnId };
        } catch (error) {
            if (error?.code === "TURN_ID_CONFLICT") throw error;
            if (job.finalizationError) throw job.finalizationError;
            if (job.turnId || job.terminal || job.finalizing) {
                await job.eventChain;
                if (job.finalizationError) throw job.finalizationError;
                return {
                    accepted: true,
                    jobId,
                    threadId: job.threadId,
                    turnId: job.turnId,
                    submissionConfirmedBy: job.turnId ? "notification" : "terminal",
                    ...(job.terminal ? { terminalState: job.state } : {})
                };
            }
            const errorCode = safeWriteErrorCode(error);
            if (job.terminalClaim === "timeout" || job.timeoutRequested) {
                await this._finishJob(job, "timeout", null, "JOB_TIMEOUT", "JOB_TIMEOUT");
            } else if (job.terminalClaim === "cancelled" || job.cancelRequested) {
                await this._finishJob(job, "cancelled", null, null);
            } else {
                await this._finishJob(job, "failed", 1, errorCode, errorCode);
            }
            throw error instanceof SidecarError ? error : new SidecarError(errorCode, "Write Job could not start");
        }
    }

    async _submitAnalyzeJob(params) {
        if (this.draining || this.state?.status !== "ready") throw new SidecarError("SIDECAR_NOT_READY", "Sidecar is not ready");
        if (this.activeJobs.size >= this.maxConcurrency) throw new SidecarError("CONCURRENCY_LIMIT", "Sidecar concurrency limit reached");
        const jobId = assertJobId(params.jobId);
        const projectPath = assertAbsolutePath(params.projectPath, "projectPath");
        const serviceTier = validateServiceTierOverride(params.serviceTier);
        const timeoutSec = params.timeoutSec === undefined ? 600 : Number(params.timeoutSec);
        if (!Number.isFinite(timeoutSec) || timeoutSec <= 0 || timeoutSec > 86400) {
            throw new SidecarError("INVALID_TIMEOUT_SEC", "timeoutSec must be a finite number greater than 0 and at most 86400");
        }
        const paths = validateJobPaths(this.jobRoot, jobId, params);
        if (!fs.existsSync(paths.metaPath)) throw new SidecarError("META_NOT_FOUND", "Job meta file does not exist");
        let meta;
        try { meta = readJson(paths.metaPath); } catch { throw new SidecarError("META_INVALID", "Job meta file is invalid"); }
        if (String(meta.jobId || "") !== jobId) throw new SidecarError("META_JOB_MISMATCH", "Job meta does not match jobId");
        if (this.seenJobs.has(jobId) || this.activeJobs.has(jobId) || meta.sidecarInstanceId || meta.executionBackend || TERMINAL_STATES.has(meta.state)) {
            throw new SidecarError("DUPLICATE_JOB_ID", "jobId has already been submitted");
        }
        const job = {
            jobId,
            projectPath,
            paths,
            outputBytes: 0,
            timeoutSec,
            timeoutTimer: null,
            timeoutFinalizeTimer: null,
            timeoutRequested: false,
            threadId: null,
            turnId: null,
            state: "starting",
            cancelRequested: false,
            terminal: false,
            terminalPromise: null,
            resolveTerminal: null,
            finalizationFailed: false,
            finalizationError: null,
            eventChain: Promise.resolve(),
            turnBoundPromise: null,
            resolveTurnBound: null,
            interruptPromise: null,
            interruptRequested: false,
            accepted: false
        };
        job.terminalPromise = new Promise(resolve => { job.resolveTerminal = resolve; });
        job.turnBoundPromise = new Promise(resolve => { job.resolveTurnBound = resolve; });
        this.activeJobs.set(jobId, job);
        job.timeoutTimer = setTimeout(() => this._handleTimeout(job), timeoutSec * 1000);
        job.timeoutTimer.unref?.();
        this.seenJobs.add(jobId);
        try {
            const threadOutcome = await this._awaitStartOrTerminal(
                job,
                this.codex.startThread({
                    projectPath,
                    model: params.model,
                    serviceTier
                })
            );
            if (threadOutcome.terminal) {
                return this._terminalSubmissionResult(job, threadOutcome.terminal);
            }
            const thread = threadOutcome.value;
            job.threadId = thread.id;
            await this._updateMeta(job, metaValue => {
                metaValue.sidecarInstanceId = this.state.instanceId;
                metaValue.sidecarPid = this.state.pid;
                metaValue.threadId = job.threadId;
                metaValue.executionBackend = "codex-app-server";
                if (Object.prototype.hasOwnProperty.call(metaValue, "submissionState") && metaValue.submissionState !== "accepted") {
                    metaValue.submissionState = "submitting";
                }
                metaValue.state = "running";
            });
            const turnOutcome = await this._awaitStartOrTerminal(
                job,
                this.codex.startTurn({
                    threadId: job.threadId,
                    text: params.text,
                    effort: params.effort,
                    serviceTier
                })
            );
            if (turnOutcome.terminal) {
                return this._terminalSubmissionResult(job, turnOutcome.terminal);
            }
            const turn = turnOutcome.value;
            if (!turn?.id) throw new SidecarError("CODEX_INVALID_RESPONSE", "turn/start did not return turn.id");
            await job.eventChain;
            if (job.finalizationError) throw job.finalizationError;
            if (job.turnId && job.turnId !== turn.id) {
                this._recordProtocolEvent("protocol/turn-id-conflict", { jobId, threadId: job.threadId });
                if (!job.terminal) await this._finishJob(job, "failed", 1, "Turn ID conflict", "TURN_ID_CONFLICT");
                throw new SidecarError("TURN_ID_CONFLICT", "turn/start response conflicts with a trusted turn notification");
            }
            if (!job.turnId) this._bindTurn(job, turn.id);
            await job.eventChain;
            if (job.finalizationError) throw job.finalizationError;
            if (job.terminal) return { accepted: true, jobId, threadId: job.threadId, turnId: job.turnId, terminalState: job.state };
            return { accepted: true, jobId, threadId: job.threadId, turnId: job.turnId };
        } catch (error) {
            if (error?.code === "TURN_ID_CONFLICT") throw error;
            if (error?.code === "META_FINALIZE_FAILED" || job.finalizationError) throw job.finalizationError || error;
            if (job.turnId || job.terminal) {
                await job.eventChain;
                return {
                    accepted: true,
                    jobId,
                    threadId: job.threadId,
                    turnId: job.turnId,
                    submissionConfirmedBy: job.turnId ? "notification" : "terminal",
                    ...(job.terminal ? { terminalState: job.state } : {})
                };
            }
            const errorCode = error.code === "CODEX_RPC_ERROR"
                ? "CODEX_TURN_START_FAILED"
                : (error.code || "CODEX_JOB_START_FAILED");
            if (job.timeoutRequested) {
                await this._finishJob(job, "timeout", null, "JOB_TIMEOUT", "JOB_TIMEOUT");
            } else {
                await this._finishJob(job, "failed", 1, errorCode, errorCode);
            }
            throw error instanceof SidecarError ? error : new SidecarError("CODEX_JOB_START_FAILED", "Job could not start");
        }
    }

    async _submitPatchJob(params) {
        if (this.draining || this.state?.status !== "ready") throw new SidecarError("SIDECAR_NOT_READY", "Sidecar is not ready");
        if (this.activeJobs.size >= this.maxConcurrency) throw new SidecarError("CONCURRENCY_LIMIT", "Sidecar concurrency limit reached");
        if (!this.codex?.isPatchVersionAllowed?.()) {
            throw new SidecarError("AICW_PATCH_CODEX_VERSION_UNVERIFIED", "Codex version is not approved for patch mode");
        }
        const jobId = assertJobId(params.jobId);
        const projectPath = assertAbsolutePath(params.projectPath, "projectPath");
        const model = validatePatchModel(params.model);
        const effort = validatePatchEffort(params.effort);
        const serviceTier = validateServiceTierOverride(params.serviceTier);
        const timeoutSec = params.timeoutSec === undefined ? 600 : Number(params.timeoutSec);
        if (!Number.isFinite(timeoutSec) || timeoutSec <= 0 || timeoutSec > 86400) {
            throw new SidecarError("INVALID_TIMEOUT_SEC", "timeoutSec must be a finite number greater than 0 and at most 86400");
        }
        const paths = validatePatchJobPaths(this.jobRoot, jobId, params);
        if (!fs.existsSync(paths.metaPath)) throw new SidecarError("META_NOT_FOUND", "Job meta file does not exist");
        const patchArtifactDirectoryIdentity = pinPatchArtifactDirectory(this.jobRoot, {
            create: true,
            hooks: this.patchArtifactHooks
        });
        verifyPatchArtifactDirectory(this.jobRoot, patchArtifactDirectoryIdentity, { hooks: this.patchArtifactHooks });
        try {
            fs.lstatSync(paths.patchPath, { bigint: true });
            throw new SidecarError("AICW_PATCH_FILE_WRITE_FAILED", "Public patch artifact already exists");
        } catch (error) {
            if (error?.code !== "ENOENT") throw error;
        }
        const patchArtifactNonce = createPatchArtifactNonce();
        let meta;
        try { meta = readJson(paths.metaPath); } catch { throw new SidecarError("META_INVALID", "Job meta file is invalid"); }
        if (String(meta.jobId || "") !== jobId) throw new SidecarError("META_JOB_MISMATCH", "Job meta does not match jobId");
        if (this.seenJobs.has(jobId) || this.activeJobs.has(jobId) || meta.sidecarInstanceId || meta.executionBackend || TERMINAL_STATES.has(meta.state)) {
            throw new SidecarError("DUPLICATE_JOB_ID", "jobId has already been submitted");
        }
        const job = {
            jobId,
            kind: "patch",
            projectPath,
            model,
            effort,
            paths,
            outputBytes: 0,
            patchInputBytes: 0,
            patchChunks: [],
            patchCollectionError: null,
            baseline: null,
            baselineMonitor: null,
            candidatePath: null,
            candidateIdentity: null,
            publicPublished: false,
            publishedSha256: null,
            publicIdentity: null,
            patchArtifactNonce,
            patchArtifactDirectoryIdentity,
            gitChildren: new Set(),
            timeoutSec,
            timeoutTimer: null,
            timeoutFinalizeTimer: null,
            timeoutRequested: false,
            threadId: null,
            turnId: null,
            state: "starting",
            cancelRequested: false,
            terminalClaim: null,
            finalizing: false,
            terminal: false,
            terminalPromise: null,
            resolveTerminal: null,
            finalizationFailed: false,
            finalizationError: null,
            eventChain: Promise.resolve(),
            turnBoundPromise: null,
            resolveTurnBound: null,
            interruptPromise: null,
            interruptRequested: false,
            accepted: false
        };
        job.terminalPromise = new Promise(resolve => { job.resolveTerminal = resolve; });
        job.turnBoundPromise = new Promise(resolve => { job.resolveTurnBound = resolve; });
        this.activeJobs.set(jobId, job);
        job.timeoutTimer = setTimeout(() => this._handleTimeout(job), timeoutSec * 1000);
        job.timeoutTimer.unref?.();
        this.seenJobs.add(jobId);
        const gitOptions = { ...this.patchGitOptions, childSet: job.gitChildren };
        try {
            await this._updatePatchMeta(job, metaValue => {
                metaValue.sidecarInstanceId = this.state.instanceId;
                metaValue.sidecarPid = this.state.pid;
                metaValue.executionBackend = "codex-app-server";
                metaValue.jobKind = "patch";
                metaValue.jobPhase = "prepared";
                metaValue.patchContractVersion = 1;
                metaValue.sandboxMode = "read-only";
                metaValue.approvalPolicy = "never";
                metaValue.state = "running";
                metaValue.submissionState = "submitting";
                metaValue.patchValidated = false;
                metaValue.applyCheckPassed = false;
                metaValue.baselineStable = false;
                metaValue.patchArtifactNonce = patchArtifactNonce;
                metaValue.patchArtifactDirectoryIdentity = patchArtifactDirectoryIdentity;
            });
            for (const phase of ["submitting", "accepted", "baseline-check"]) {
                await this._updatePatchMeta(job, metaValue => { metaValue.jobPhase = phase; });
            }

            try {
                job.baseline = await captureGitBaseline(job.projectPath, { gitOptions });
            } catch (error) {
                if (error?.details?.baseline) {
                    job.baseline = error.details.baseline;
                    await this._updatePatchMeta(job, metaValue => {
                        Object.assign(metaValue, this._patchBaselineMeta(job.baseline));
                    });
                }
                throw error;
            }
            job.projectPath = job.baseline.repoRoot;
            await this._updatePatchMeta(job, metaValue => {
                Object.assign(metaValue, this._patchBaselineMeta(job.baseline));
                metaValue.jobPhase = "running";
            });
            job.baselineMonitor = startGitBaselineMonitor(job.projectPath, job.baseline, {
                gitOptions,
                intervalMs: this.patchMonitorIntervalMs
            });
            await job.baselineMonitor.assertStable();

            const threadOutcome = await this._awaitStartOrTerminal(
                job,
                this.codex.startThread({
                    projectPath: job.projectPath,
                    model,
                    serviceTier
                })
            );
            if (threadOutcome.terminal) return this._terminalSubmissionResult(job, threadOutcome.terminal);
            const thread = threadOutcome.value;
            job.threadId = thread.id;
            await this._updatePatchMeta(job, metaValue => {
                metaValue.threadId = job.threadId;
                metaValue.jobPhase = "running";
            });
            const turnOutcome = await this._awaitStartOrTerminal(job, this.codex.startTurn({
                threadId: job.threadId,
                text: params.text,
                effort,
                serviceTier,
                patchMode: true,
                projectPath: job.projectPath,
                model
            }));
            if (turnOutcome.terminal) return this._terminalSubmissionResult(job, turnOutcome.terminal);
            const turn = turnOutcome.value;
            if (!turn?.id) throw new SidecarError("CODEX_INVALID_RESPONSE", "turn/start did not return turn.id");
            await job.eventChain;
            if (job.finalizationError) throw job.finalizationError;
            if (job.turnId && job.turnId !== turn.id) {
                this._recordProtocolEvent("protocol/turn-id-conflict", { jobId, threadId: job.threadId });
                if (!job.terminal && !job.finalizing) await this._finishJob(job, "failed", 1, "Turn ID conflict", "TURN_ID_CONFLICT");
                throw new SidecarError("TURN_ID_CONFLICT", "turn/start response conflicts with a trusted turn notification");
            }
            if (!job.turnId) this._bindTurn(job, turn.id);
            await job.eventChain;
            if (job.finalizationError) throw job.finalizationError;
            if (job.terminal) {
                return { accepted: true, jobId, threadId: job.threadId, turnId: job.turnId, terminalState: job.state };
            }
            return { accepted: true, jobId, threadId: job.threadId, turnId: job.turnId };
        } catch (error) {
            if (error?.code === "TURN_ID_CONFLICT") throw error;
            if (job.finalizationError) throw job.finalizationError;
            if (job.turnId || job.terminal || job.finalizing) {
                await job.eventChain;
                if (job.finalizationError) throw job.finalizationError;
                return {
                    accepted: true,
                    jobId,
                    threadId: job.threadId,
                    turnId: job.turnId,
                    submissionConfirmedBy: job.turnId ? "notification" : "terminal",
                    ...(job.terminal ? { terminalState: job.state } : {})
                };
            }
            const errorCode = error?.code || "CODEX_JOB_START_FAILED";
            if (job.terminalClaim === "timeout" || job.timeoutRequested) {
                await this._finishJob(job, "timeout", null, "JOB_TIMEOUT", "JOB_TIMEOUT");
            } else if (job.terminalClaim === "cancelled" || job.cancelRequested) {
                await this._finishJob(job, "cancelled", null, null);
            } else {
                await this._finishJob(job, "failed", 1, errorCode, errorCode);
            }
            throw error instanceof SidecarError ? error : new SidecarError("CODEX_JOB_START_FAILED", "Patch Job could not start");
        }
    }

    _patchBaselineMeta(baseline) {
        return {
            gitRepoRoot: baseline.repoRoot,
            baseHead: baseline.baseHead,
            baseTree: baseline.baseTree,
            baseStatusSha256: baseline.baseStatusSha256,
            baseDirty: baseline.baseDirty,
            baselineCapturedAt: baseline.baselineCapturedAt
        };
    }

    async _cancel(params) {
        const jobId = assertJobId(params.jobId);
        const job = this.activeJobs.get(jobId);
        if (!job) {
            const meta = readJson(path.join(this.jobRoot, "meta", `${jobId}.json`));
            if (TERMINAL_STATES.has(meta?.state)) return { cancelled: false, alreadyTerminal: true, state: meta.state };
            throw new SidecarError("JOB_NOT_ACTIVE", "Job is not active");
        }
        if (job.terminal) return { cancelled: false, alreadyTerminal: true, state: job.state };
        if ((job.kind === "patch" || job.kind === "write") && (job.finalizing || job.terminalClaim === "validation")) {
            return { cancelled: false, alreadyFinalizing: true, state: "running" };
        }
        if ((job.kind === "patch" || job.kind === "write") && job.terminalClaim && job.terminalClaim !== "cancelled") {
            return { cancelled: false, alreadyFinalizing: true, state: job.terminalClaim };
        }
        if (job.kind === "patch" || job.kind === "write") job.terminalClaim = "cancelled";
        job.cancelRequested = true;
        let bindingTimer = null;
        const bindingTimeout = new Promise(resolve => {
            bindingTimer = setTimeout(() => resolve({ timeout: true }), this.cancelTimeoutMs);
            bindingTimer.unref?.();
            job.cancelTimeoutTimer = bindingTimer;
        });
        let boundOrTerminal;
        try {
            boundOrTerminal = await Promise.race([job.turnBoundPromise, job.terminalPromise, bindingTimeout]);
        } finally {
            if (bindingTimer) clearTimeout(bindingTimer);
            if (job.cancelTimeoutTimer === bindingTimer) job.cancelTimeoutTimer = null;
        }
        if (job.terminal) return { cancelled: false, alreadyTerminal: true, state: job.state };
        if ((job.kind === "patch" || job.kind === "write") && (job.finalizing || job.terminalClaim === "validation")) {
            return { cancelled: false, alreadyFinalizing: true, state: "running" };
        }
        if (!job.turnId || boundOrTerminal?.timeout) throw new SidecarError("CANCEL_TIMEOUT", "Timed out waiting for turn binding");
        await this._requestInterruptOnce(job);
        let cancelTimer = null;
        const timeoutPromise = new Promise(resolve => {
            cancelTimer = setTimeout(() => resolve({ timeout: true }), this.cancelTimeoutMs);
            cancelTimer.unref?.();
            job.cancelTimeoutTimer = cancelTimer;
        });
        try {
            const terminal = await Promise.race([job.terminalPromise, timeoutPromise]);
            if (terminal?.timeout) throw new SidecarError("CANCEL_TIMEOUT", "Timed out waiting for interrupted turn");
            return terminal.state === "cancelled"
                ? { cancelled: true, jobId, state: "cancelled" }
                : { cancelled: false, alreadyTerminal: true, state: terminal.state };
        } finally {
            if (cancelTimer) clearTimeout(cancelTimer);
            if (job.cancelTimeoutTimer === cancelTimer) job.cancelTimeoutTimer = null;
        }
    }

    _handleServerRequest(request) {
        const params = request?.params || {};
        const threadId = params.threadId || params.thread?.id;
        const turnId = params.turnId || params.turn?.id;
        let patchJobs = [...this.activeJobs.values()].filter(job => (job.kind === "patch" || job.kind === "write") && !job.terminal);
        if (threadId || turnId) {
            patchJobs = patchJobs.filter(job => (!threadId || job.threadId === threadId) && (!turnId || !job.turnId || job.turnId === turnId));
        }
        this._recordProtocolEvent("serverRequest", {
            method: String(request?.method || "").slice(0, 128),
            handled: false,
            failClosedPatchJobs: patchJobs.length
        });
        for (const job of patchJobs) {
            this._enqueueJobEvent(job, async () => {
                if (job.terminal || job.finalizing) return;
                if (!job.terminalClaim) job.terminalClaim = "failed";
                const code = job.kind === "write" ? "AICW_WRITE_APPROVAL_REQUESTED" : "AICW_PATCH_APPROVAL_REQUESTED";
                await this._finishJob(job, "failed", 1, code, code);
            });
        }
    }

    _handleNotification(message) {
        const method = message?.method;
        const params = message?.params || {};
        if (!method) return;
        const turnId = params.turnId || params.turn?.id;
        const job = this._findJob(params.threadId, turnId);
        if (!job) {
            if (params.threadId || turnId) this._recordProtocolEvent("protocol/notification-mismatch", { method, threadId: params.threadId ? String(params.threadId).slice(0, 128) : null, turnId: turnId ? String(turnId).slice(0, 128) : null });
            return;
        }
        this._enqueueJobEvent(job, async () => {
            if (job.terminal) return;
            if (method === "turn/started") {
                job.state = "running";
                this._recordJobEvent(job, method, params);
                return;
            }
            if (method === "item/agentMessage/delta") {
                const delta = typeof params.delta === "string" ? params.delta : "";
                if (job.kind === "patch") {
                    const bytes = Buffer.byteLength(delta, "utf8");
                    job.outputBytes += bytes;
                    job.patchInputBytes += bytes;
                    if (!job.patchCollectionError && job.patchInputBytes <= MAX_PATCH_BYTES + 1024) {
                        job.patchChunks.push(delta);
                    } else {
                        job.patchChunks = [];
                        job.patchCollectionError = new SidecarError("AICW_PATCH_TOO_LARGE", "Patch candidate exceeded its collection limit");
                    }
                    this._recordJobEvent(job, method, { threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, length: bytes });
                    return;
                }
                try {
                    fs.mkdirSync(path.dirname(job.paths.codexOutputPath), { recursive: true });
                    fs.appendFileSync(job.paths.codexOutputPath, delta, "utf8");
                    job.outputBytes += Buffer.byteLength(delta, "utf8");
                    this._recordJobEvent(job, method, { threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, length: Buffer.byteLength(delta, "utf8") });
                } catch (error) {
                    this._recordProtocolEvent("protocol/output-write-error", { jobId: job.jobId });
                    await this._finishJob(job, "failed", 1, "SIDECAR_OUTPUT_WRITE_FAILED");
                }
                return;
            }
            if (method === "turn/completed") {
                this._recordJobEvent(job, method, params);
                if (job.terminal) return;
                const status = params.turn?.status;
                if (job.kind === "patch") {
                    if (job.terminalClaim === "timeout" || job.timeoutRequested) {
                        await this._finishJob(job, "timeout", null, "JOB_TIMEOUT", "JOB_TIMEOUT");
                    } else if (job.terminalClaim === "cancelled" || job.cancelRequested) {
                        await this._finishJob(job, "cancelled", null, null);
                    } else if (status === "completed") {
                        job.terminalClaim = "validation";
                        job.finalizing = true;
                        job.state = "running";
                        if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
                        job.timeoutTimer = null;
                        await this._finalizePatch(job);
                    } else if (status === "interrupted") {
                        await this._finishJob(job, "failed", 1, "CODEX_TURN_INTERRUPTED");
                    } else {
                        await this._finishJob(job, "failed", 1, "CODEX_TURN_FAILED");
                    }
                } else if (job.kind === "write") {
                    if (job.terminalClaim === "timeout" || job.timeoutRequested) {
                        await this._finishJob(job, "timeout", null, "JOB_TIMEOUT", "JOB_TIMEOUT");
                    } else if (job.terminalClaim === "cancelled" || job.cancelRequested) {
                        await this._finishJob(job, "cancelled", null, null);
                    } else if (status === "completed") {
                        job.terminalClaim = "validation";
                        job.finalizing = true;
                        job.state = "running";
                        if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
                        job.timeoutTimer = null;
                        await this._finalizeWrite(job);
                    } else if (status === "interrupted") {
                        await this._finishJob(job, "failed", 1, "CODEX_TURN_INTERRUPTED", "CODEX_TURN_INTERRUPTED");
                    } else {
                        await this._finishJob(job, "failed", 1, "CODEX_TURN_FAILED", "CODEX_TURN_FAILED");
                    }
                } else if (job.timeoutRequested) await this._finishJob(job, "timeout", null, "JOB_TIMEOUT", "JOB_TIMEOUT");
                else if (status === "completed") await this._finishJob(job, "completed", 0, null);
                else if (status === "interrupted" && job.cancelRequested) await this._finishJob(job, "cancelled", null, null);
                else if (status === "interrupted") await this._finishJob(job, "failed", 1, "CODEX_TURN_INTERRUPTED");
                else await this._finishJob(job, "failed", 1, "CODEX_TURN_FAILED");
                return;
            }
            this._recordJobEvent(job, method, params);
            this._recordProtocolEvent(method, { keys: Object.keys(params).slice(0, 20) });
        });
    }

    _findJob(threadId, turnId) {
        if (!threadId) return null;
        const job = [...this.activeJobs.values()].find(candidate => candidate.threadId === threadId);
        if (!job) return null;
        if (turnId && job.turnId && job.turnId !== turnId) {
            this._recordProtocolEvent("protocol/turn-id-conflict", { jobId: job.jobId, threadId: String(threadId).slice(0, 128) });
            if (!job.terminal) {
                this._enqueueJobEvent(job, async () => {
                    if (job.terminal) return;
                    await this._finishJob(job, "failed", 1, "Turn ID conflict", "TURN_ID_CONFLICT");
                });
            }
            return null;
        }
        if (turnId && !job.turnId) this._bindTurn(job, turnId);
        return job;
    }

    _bindTurn(job, turnId) {
        if (!turnId) return false;
        if (job.turnId && job.turnId !== turnId) return false;
        if (job.turnId) return true;
        job.turnId = String(turnId);
        job.accepted = true;
        job.resolveTurnBound(job.turnId);
        const updateMeta = job.kind === "patch"
            ? updater => this._updatePatchMeta(job, updater)
            : job.kind === "write"
                ? updater => this._updateWriteMeta(job, updater)
                : updater => this._updateMeta(job, updater);
        job.eventChain = job.eventChain.then(() => updateMeta(meta => {
            meta.turnId = job.turnId;
            meta.submissionState = "accepted";
            if (!job.terminal) {
                meta.state = "running";
                if (job.kind === "patch" || job.kind === "write") meta.jobPhase = "running";
            }
        }));
        if (job.kind === "write") {
            job.eventChain = job.eventChain.catch(error => {
                const mapped = this._markWriteFinalizationIncomplete(job, error);
                throw mapped;
            });
        }
        if (job.cancelRequested || job.timeoutRequested) {
            this._requestInterruptOnce(job).catch(() => {});
        }
        return true;
    }

    _handleTimeout(job) {
        if (!job || job.terminal || job.timeoutRequested) return;
        if (job.kind === "patch" || job.kind === "write") {
            if (job.finalizing || job.terminalClaim) return;
            job.terminalClaim = "timeout";
        }
        job.timeoutRequested = true;
        this._scheduleTimeoutFinalize(job);
        if (job.turnId) {
            this._requestInterruptOnce(job).catch(() => {});
        }
    }

    async _awaitStartOrTerminal(job, operation) {
        const outcome = await Promise.race([
            Promise.resolve(operation).then(
                value => ({ value }),
                error => ({ error })
            ),
            job.terminalPromise.then(terminal => ({ terminal }))
        ]);
        if (outcome.error) throw outcome.error;
        return outcome;
    }

    _terminalSubmissionResult(job, terminal) {
        return {
            accepted: true,
            jobId: job.jobId,
            threadId: job.threadId,
            turnId: job.turnId,
            submissionConfirmedBy: "terminal",
            terminalState: terminal?.state || job.state
        };
    }

    _scheduleTimeoutFinalize(job) {
        if (job.timeoutFinalizeTimer || job.terminal) return;
        job.timeoutFinalizeTimer = setTimeout(() => {
            if (!job.terminal) this._finishJob(job, "timeout", null, "JOB_TIMEOUT", "JOB_TIMEOUT").catch(() => {});
        }, this.timeoutGraceMs);
        job.timeoutFinalizeTimer.unref?.();
    }

    _enqueueJobEvent(job, handler) {
        job.eventChain = job.eventChain.then(handler).catch(error => {
            if (error?.code === "META_FINALIZE_FAILED") job.finalizationError = error;
            this._recordProtocolEvent("protocol/event-error", { jobId: job.jobId, code: error.code || "EVENT_HANDLER_FAILED" });
        });
        return job.eventChain;
    }

    _requestInterruptOnce(job) {
        if (job.interruptPromise) return job.interruptPromise;
        if (!job.threadId || !job.turnId || job.terminal || job.finalizing) return Promise.resolve();
        job.interruptRequested = true;
        job.interruptPromise = this.codex.interruptTurn({ threadId: job.threadId, turnId: job.turnId });
        return job.interruptPromise;
    }

    async _finalizeWrite(job) {
        try {
            await job.session.verify();
            const validationStartedAt = new Date().toISOString();
            await this._updateWriteMeta(job, meta => {
                meta.jobPhase = "validating";
                meta.validationStartedAt = validationStartedAt;
                meta.validationPassed = false;
                meta.candidateAvailable = false;
            });
            const validation = await this._writeValidationRunner.run({
                profile: this._writeValidationProfile,
                worktreeRoot: job.handle.worktreePath
            });
            const validationSteps = safeValidationSteps(validation?.steps);
            const validationCompletedAt = new Date().toISOString();
            if (validation?.passed !== true) {
                const validationError = new SidecarError("AICW_WRITE_VALIDATION_FAILED", "Write validation failed");
                validationError.validationCompletedAt = validationCompletedAt;
                validationError.validationSteps = validationSteps;
                throw validationError;
            }
            await this._updateWriteMeta(job, meta => {
                meta.jobPhase = "committing";
                meta.validationCompletedAt = validationCompletedAt;
                meta.validationPassed = true;
                meta.validationSteps = validationSteps;
                meta.candidateAvailable = false;
            });
            job.candidateResult = await job.session.commitCandidate();
            await this._updateWriteMeta(job, meta => {
                meta.state = "completed";
                meta.jobPhase = "completed";
                meta.exitCode = 0;
                meta.completedAt = new Date().toISOString();
                meta.validationCompletedAt = validationCompletedAt;
                meta.validationPassed = true;
                meta.validationSteps = validationSteps;
                meta.candidateAvailable = true;
                meta.resultCommit = job.candidateResult.resultCommit;
                meta.resultTree = job.candidateResult.resultTree;
                meta.changedFiles = job.candidateResult.changedFiles;
                delete meta.errorCode;
                delete meta.exitReason;
            });
            job.terminal = true;
            job.finalizing = false;
            job.state = "completed";
            this._clearJobTimers(job);
            this.activeJobs.delete(job.jobId);
            job.resolveTerminal({ state: "completed", exitCode: 0 });
        } catch (error) {
            if (error?.code === "AICW_WRITE_FINALIZATION_UNCERTAIN" ||
                UNCERTAIN_WRITE_CANDIDATE_CODES.has(error?.code) || job.candidateResult) {
                this._markWriteFinalizationIncomplete(job, error);
                return job.terminalPromise;
            }
            const code = safeWriteErrorCode(error);
            try {
                await this._updateWriteMeta(job, meta => {
                    meta.state = "failed";
                    meta.jobPhase = "failed";
                    meta.exitCode = 1;
                    meta.completedAt = new Date().toISOString();
                    if (error?.validationCompletedAt) meta.validationCompletedAt = error.validationCompletedAt;
                    if (error?.validationSteps) meta.validationSteps = error.validationSteps;
                    meta.validationPassed = false;
                    meta.candidateAvailable = false;
                    meta.errorCode = code;
                    meta.exitReason = code;
                });
            } catch (metaError) {
                this._markWriteFinalizationIncomplete(job, metaError);
                return job.terminalPromise;
            }
            job.terminal = true;
            job.finalizing = false;
            job.state = "failed";
            this._clearJobTimers(job);
            this.activeJobs.delete(job.jobId);
            job.resolveTerminal({ state: "failed", exitCode: 1, reason: code });
        }
        return job.terminalPromise;
    }

    async _finalizePatch(job) {
        let artifact = null;
        try {
            const validationStartedAt = new Date().toISOString();
            await this._updatePatchMeta(job, meta => {
                meta.jobPhase = "validating";
                meta.validationStartedAt = validationStartedAt;
                meta.validationHead = job.baseline.baseHead;
                meta.validationStatusSha256 = job.baseline.baseStatusSha256;
                meta.patchValidated = false;
                meta.applyCheckPassed = false;
                meta.baselineStable = false;
            }, "AICW_PATCH_META_FINALIZE_FAILED");
            await job.baselineMonitor.assertStable();
            if (job.patchCollectionError) throw job.patchCollectionError;

            const patchText = extractPatchPayload(job.patchChunks.join(""));
            job.patchChunks = [];
            verifyPatchArtifactDirectory(this.jobRoot, job.patchArtifactDirectoryIdentity, { hooks: this.patchArtifactHooks });
            const candidate = createPrivateCandidate({
                jobRoot: this.jobRoot,
                jobId: job.jobId,
                sidecarInstanceId: this.state.instanceId,
                patchArtifactNonce: job.patchArtifactNonce,
                patchText,
                patchArtifactDirectoryIdentity: job.patchArtifactDirectoryIdentity
            }, { hooks: this.patchArtifactHooks });
            job.candidatePath = candidate.candidatePath;
            job.candidateIdentity = candidate.candidateIdentity;
            assertNoSecrets(patchText);
            const parsed = parseUnifiedDiff(patchText);
            const gitOptions = { ...this.patchGitOptions, childSet: job.gitChildren };
            await validateTrackedPaths(job.projectPath, parsed, { gitOptions });
            await job.baselineMonitor.assertStable();
            await applyCheck(job.projectPath, job.candidatePath, { gitOptions });
            await job.baselineMonitor.assertStable();

            artifact = {
                patchSha256: sha256(Buffer.from(patchText, "utf8")),
                patchBytes: Buffer.byteLength(patchText, "utf8"),
                patchFileCount: parsed.fileCount,
                validatedAt: new Date().toISOString()
            };
            job.publishedSha256 = artifact.patchSha256;
            await this._updatePatchMeta(job, meta => {
                meta.jobPhase = "publishing";
                meta.patchValidated = false;
                meta.applyCheckPassed = false;
                meta.baselineStable = false;
                meta.validationHead = job.baseline.baseHead;
                meta.validationStatusSha256 = job.baseline.baseStatusSha256;
                meta.patchSha256 = artifact.patchSha256;
                meta.patchBytes = artifact.patchBytes;
                meta.patchFileCount = artifact.patchFileCount;
                meta.validatedAt = artifact.validatedAt;
                meta.patchArtifactNonce = job.patchArtifactNonce;
                meta.patchArtifactDirectoryIdentity = job.patchArtifactDirectoryIdentity;
            }, "AICW_PATCH_META_FINALIZE_FAILED");
            await job.baselineMonitor.assertStable();
            try {
                const published = publishCandidateNoOverwrite({
                    jobRoot: this.jobRoot,
                    jobId: job.jobId,
                    sidecarInstanceId: this.state.instanceId,
                    patchArtifactNonce: job.patchArtifactNonce,
                    patchArtifactDirectoryIdentity: job.patchArtifactDirectoryIdentity,
                    candidateIdentity: job.candidateIdentity,
                    patchSha256: artifact.patchSha256,
                    patchBytes: artifact.patchBytes
                }, { hooks: this.patchArtifactHooks });
                job.publicIdentity = published.publicIdentity;
            } catch (error) {
                if (error?.details?.published && error.details.rollbackFailed) job.publicPublished = true;
                throw error;
            }
            job.publicPublished = true;
            await job.baselineMonitor.assertStable();
            inspectPatchArtifactFile(job.paths.patchPath, job.patchArtifactDirectoryIdentity, {
                jobRoot: this.jobRoot,
                hooks: this.patchArtifactHooks,
                expectedIdentity: job.publicIdentity,
                expectedSha256: artifact.patchSha256,
                expectedBytes: artifact.patchBytes,
                failureCode: "AICW_PATCH_PUBLIC_ARTIFACT_MISMATCH"
            });
            this.patchArtifactHooks.beforeCompletedMeta?.({
                jobRoot: this.jobRoot,
                jobId: job.jobId,
                patchPath: job.paths.patchPath,
                patchArtifactDirectoryIdentity: job.patchArtifactDirectoryIdentity
            });
            verifyPatchArtifactDirectory(this.jobRoot, job.patchArtifactDirectoryIdentity, { hooks: this.patchArtifactHooks });
            inspectPatchArtifactFile(job.paths.patchPath, job.patchArtifactDirectoryIdentity, {
                jobRoot: this.jobRoot,
                hooks: this.patchArtifactHooks,
                expectedIdentity: job.publicIdentity,
                expectedSha256: artifact.patchSha256,
                expectedBytes: artifact.patchBytes,
                failureCode: "AICW_PATCH_PUBLIC_ARTIFACT_MISMATCH"
            });
            if (!(await this._closePatchValidationResources(job))) {
                throw new SidecarError("AICW_PATCH_ARTIFACT_CLEANUP_FAILED", "Patch validation resources could not be closed");
            }

            await this._updatePatchMeta(job, meta => {
                meta.state = "completed";
                meta.jobPhase = "completed";
                meta.patchValidated = true;
                meta.applyCheckPassed = true;
                meta.baselineStable = true;
                meta.patchArtifactPublicIdentity = job.publicIdentity;
                meta.completedAt = new Date().toISOString();
                meta.exitCode = 0;
                delete meta.errorCode;
                delete meta.exitReason;
            }, "AICW_PATCH_META_FINALIZE_FAILED");
            await this._settleCompletedPatch(job);
        } catch (error) {
            const safe = error instanceof SidecarError
                ? error
                : new SidecarError("AICW_PATCH_FORMAT_INVALID", "Patch validation failed");
            await this._settleFailedPatchLease(job, safe, artifact);
        }
    }

    async _settleCompletedPatch(job) {
        if (!(await this._closePatchResources(job))) {
            throw new SidecarError("AICW_PATCH_ARTIFACT_CLEANUP_FAILED", "Patch candidate cleanup could not be confirmed");
        }
        job.terminal = true;
        job.finalizing = false;
        job.state = "completed";
        this._clearJobTimers(job);
        this.activeJobs.delete(job.jobId);
        job.resolveTerminal({ state: "completed", exitCode: 0 });
        return job.terminalPromise;
    }

    async _settleFailedPatchLease(job, error, artifact) {
        let cleanupConfirmed = true;
        if (job.publicPublished) {
            cleanupConfirmed = removePatchArtifactExact(job.paths.patchPath, job.patchArtifactDirectoryIdentity, {
                jobRoot: this.jobRoot,
                hooks: this.patchArtifactHooks,
                expectedIdentity: job.publicIdentity || undefined,
                expectedSha256: artifact?.patchSha256 || job.publishedSha256,
                expectedBytes: artifact?.patchBytes,
                failureCode: "AICW_PATCH_ARTIFACT_CLEANUP_FAILED"
            });
            if (cleanupConfirmed) job.publicPublished = false;
        }
        cleanupConfirmed = (await this._closePatchResources(job, {
            verifyBaseline: false
        })) && cleanupConfirmed;
        if (!cleanupConfirmed) {
            const cleanupError = new SidecarError("AICW_PATCH_ARTIFACT_CLEANUP_FAILED", "Patch artifact cleanup could not be confirmed");
            this._markPatchFinalizationIncomplete(job, cleanupError);
            throw cleanupError;
        }
        try {
            await this._updatePatchMeta(job, meta => {
                meta.state = "failed";
                meta.jobPhase = "failed";
                meta.patchValidated = false;
                meta.applyCheckPassed = false;
                meta.baselineStable = false;
                meta.completedAt = new Date().toISOString();
                meta.exitCode = 1;
                meta.errorCode = error.code || "AICW_PATCH_FORMAT_INVALID";
                meta.exitReason = error.code || "AICW_PATCH_FORMAT_INVALID";
            }, "AICW_PATCH_META_FINALIZE_FAILED");
        } catch (metaError) {
            this._markPatchFinalizationIncomplete(job, metaError);
            throw metaError;
        }
        job.terminal = true;
        job.finalizing = false;
        job.state = "failed";
        this._clearJobTimers(job);
        this.activeJobs.delete(job.jobId);
        job.resolveTerminal({ state: "failed", exitCode: 1, reason: error.code });
        return job.terminalPromise;
    }

    _markPatchFinalizationIncomplete(job, error) {
        job.finalizationFailed = true;
        job.finalizationError = error;
        job.state = "finalizationFailed";
        this._clearJobTimers(job);
        if (this.state) {
            this.state.status = "degraded";
            try { writeJsonAtomic(this.paths.statePath, this.state); } catch {}
        }
        this.emit("protocolError", error);
        job.resolveTerminal({ state: job.state, errorCode: error.code });
    }

    _clearJobTimers(job) {
        if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
        if (job.timeoutFinalizeTimer) clearTimeout(job.timeoutFinalizeTimer);
        if (job.cancelTimeoutTimer) clearTimeout(job.cancelTimeoutTimer);
        job.timeoutTimer = null;
        job.timeoutFinalizeTimer = null;
        job.cancelTimeoutTimer = null;
    }

    async _closePatchValidationResources(job, options = {}) {
        let complete = true;
        let closeError = null;
        if (job.baselineMonitor) {
            try {
                if ((await job.baselineMonitor.close({
                    verifyBaseline: options.verifyBaseline !== false
                })) === false) complete = false;
            } catch (error) {
                closeError = error;
            }
            job.baselineMonitor = null;
        }
        for (const child of job.gitChildren || []) {
            try {
                if (child.exitCode === null && child.signalCode === null && child.kill("SIGKILL") === false) complete = false;
            } catch { complete = false; }
        }
        job.gitChildren?.clear();
        if (closeError) throw closeError;
        return complete;
    }

    async _closePatchResources(job, options = {}) {
        let complete = await this._closePatchValidationResources(job, options);
        if (job.candidatePath) {
            const removed = removePatchArtifactExact(job.candidatePath, job.patchArtifactDirectoryIdentity, {
                jobRoot: this.jobRoot,
                hooks: this.patchArtifactHooks,
                expectedIdentity: job.candidateIdentity || undefined,
                expectedSha256: job.publishedSha256 || undefined,
                failureCode: "AICW_PATCH_ARTIFACT_CLEANUP_FAILED"
            });
            if (!removed) complete = false;
            if (complete) job.candidatePath = null;
        }
        try { verifyPatchArtifactDirectory(this.jobRoot, job.patchArtifactDirectoryIdentity, { hooks: this.patchArtifactHooks }); } catch { complete = false; }
        job.patchChunks = [];
        return complete;
    }

    _recordJobEvent(job, method, params) {
        try {
            fs.mkdirSync(path.dirname(job.paths.outputPath), { recursive: true });
            const safeParams = method === "item/agentMessage/delta"
                ? { threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, length: params.length }
                : method.startsWith("turn/")
                    ? { threadId: params.threadId, turnId: params.turn?.id, status: params.turn?.status, text: this._safeText(params.error?.message || params.message) }
                    : { keys: params && typeof params === "object" ? Object.keys(params).slice(0, 20) : [] };
            fs.appendFileSync(job.paths.outputPath, `${JSON.stringify({
                source: "codex-app-server",
                method,
                at: new Date().toISOString(),
                params: safeParams
            })}\n`, "utf8");
        } catch (error) {
            this._handleProtocolError(new SidecarError("OUTPUT_WRITE_FAILED", "Could not append job event", { cause: error.code }));
            this._finishJob(job, "failed", 1, "SIDECAR_OUTPUT_WRITE_FAILED").catch(() => {});
        }
    }

    _safeText(value) {
        return String(value || "").replace(/(Bearer\s+|api[_-]?key\s*[:=]\s*|token\s*[:=]\s*|password\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]").slice(0, 512);
    }

    _recordProtocolEvent(method, details) {
        this.emit("protocolEvent", { method, details });
    }

    _handleProtocolError(error) {
        this.emit("protocolError", error);
        if (this.draining) return;
        this.state && (this.state.status = "degraded");
        try { if (this.state) writeJsonAtomic(this.paths.statePath, this.state); } catch {}
        for (const job of this.activeJobs.values()) {
            if ((job.kind === "patch" || job.kind === "write") && job.finalizing) continue;
            this._finishJob(job, "failed", 1, "CODEX_PROTOCOL_ERROR").catch(() => {});
        }
    }

    _handleCodexClosed(info) {
        if (this.draining || info?.intentional) return;
        if (this.state) {
            this.state.status = "degraded";
            try { writeJsonAtomic(this.paths.statePath, this.state); } catch {}
        }
        for (const job of [...this.activeJobs.values()]) {
            if ((job.kind === "patch" || job.kind === "write") && job.finalizing) continue;
            this._finishJob(job, "failed", 1, "CODEX_APP_SERVER_EXITED").catch(() => {});
        }
        this.emit("protocolEvent", { method: "codex/closed", details: { unexpected: true } });
    }

    async _updateMeta(job, updater) {
        try {
            await updateJobMetaLocked(this.jobRoot, job.jobId, job.paths.metaPath, meta => {
                if (String(meta.jobId || "") !== job.jobId) throw new SidecarError("META_JOB_MISMATCH", "Job meta changed identity");
                if (meta.executionBackend && meta.executionBackend !== "codex-app-server") {
                    throw new SidecarError("META_BACKEND_MISMATCH", "Job meta backend changed identity");
                }
                if (meta.sidecarInstanceId && meta.sidecarInstanceId !== this.state?.instanceId) {
                    throw new SidecarError("META_INSTANCE_MISMATCH", "Job meta Sidecar instance changed identity");
                }
                updater(meta);
                return meta;
            });
        } catch (error) {
            this._handleProtocolError(error instanceof SidecarError ? error : new SidecarError("META_WRITE_FAILED", "Could not update job meta", { cause: error.code }));
            throw error instanceof SidecarError ? error : new SidecarError("META_WRITE_FAILED", "Could not update job meta");
        }
    }

    async _updateWriteMeta(job, updater) {
        try {
            await updateJobMetaLocked(this.jobRoot, job.jobId, job.paths.metaPath, meta => {
                if (String(meta.jobId || "") !== job.jobId) throw new SidecarError("META_JOB_MISMATCH", "Job meta changed identity");
                if (meta.executionBackend && meta.executionBackend !== "codex-app-server") {
                    throw new SidecarError("META_BACKEND_MISMATCH", "Job meta backend changed identity");
                }
                if (meta.sidecarInstanceId && meta.sidecarInstanceId !== this.state?.instanceId) {
                    throw new SidecarError("META_INSTANCE_MISMATCH", "Job meta Sidecar instance changed identity");
                }
                updater(meta);
                return meta;
            });
        } catch (error) {
            const mapped = error instanceof SidecarError && error.code === "AICW_WRITE_FINALIZATION_UNCERTAIN"
                ? error
                : new SidecarError("AICW_WRITE_FINALIZATION_UNCERTAIN", "Could not finalize write Job meta", { cause: error?.code });
            if (this.state) {
                this.state.status = "degraded";
                try { writeJsonAtomic(this.paths.statePath, this.state); } catch {}
            }
            this.emit("protocolError", mapped);
            throw mapped;
        }
    }

    _markWriteFinalizationIncomplete(job, error) {
        if (job.finalizationFailed && job.finalizationError) return job.finalizationError;
        const mapped = error instanceof SidecarError && error.code === "AICW_WRITE_FINALIZATION_UNCERTAIN"
            ? error
            : new SidecarError("AICW_WRITE_FINALIZATION_UNCERTAIN", "Write Job finalization outcome is uncertain", { cause: error?.code });
        job.finalizationFailed = true;
        job.finalizationError = mapped;
        job.state = "finalizationFailed";
        job.terminal = true;
        this._clearJobTimers(job);
        if (this.state) {
            this.state.status = "degraded";
            try { writeJsonAtomic(this.paths.statePath, this.state); } catch {}
        }
        this.emit("protocolError", mapped);
        job.resolveTerminal({ state: job.state, errorCode: mapped.code });
        return mapped;
    }

    async _updatePatchMeta(job, updater, failureCode = "META_WRITE_FAILED") {
        try {
            await updateJobMetaLocked(this.jobRoot, job.jobId, job.paths.metaPath, meta => {
                if (String(meta.jobId || "") !== job.jobId) throw new SidecarError("META_JOB_MISMATCH", "Job meta changed identity");
                if (meta.executionBackend && meta.executionBackend !== "codex-app-server") {
                    throw new SidecarError("META_BACKEND_MISMATCH", "Job meta backend changed identity");
                }
                if (meta.sidecarInstanceId && meta.sidecarInstanceId !== this.state?.instanceId) {
                    throw new SidecarError("META_INSTANCE_MISMATCH", "Job meta Sidecar instance changed identity");
                }
                updater(meta);
                return meta;
            }, this.patchMetaOptions);
        } catch (error) {
            const mapped = error instanceof SidecarError && error.code === failureCode
                ? error
                : new SidecarError(failureCode, "Could not finalize patch Job meta", { cause: error?.code });
            if (this.state) {
                this.state.status = "degraded";
                try { writeJsonAtomic(this.paths.statePath, this.state); } catch {}
            }
            this.emit("protocolError", mapped);
            throw mapped;
        }
    }

    async _finishJob(job, state, exitCode, reason, errorCode) {
        if (!job || job.terminal) return job?.terminalPromise;
        if ((job.kind === "patch" || job.kind === "write") && job.finalizing) return job.terminalPromise;
        job.terminal = true;
        job.state = state;
        this._clearJobTimers(job);
        if (job.kind === "patch" && !(await this._closePatchResources(job, {
            verifyBaseline: false
        }))) {
            const cleanupError = new SidecarError("AICW_PATCH_ARTIFACT_CLEANUP_FAILED", "Patch resources could not be closed");
            this._markPatchFinalizationIncomplete(job, cleanupError);
            throw cleanupError;
        }
        try {
            const updateMeta = job.kind === "patch"
                ? updater => this._updatePatchMeta(job, updater, "AICW_PATCH_META_FINALIZE_FAILED")
                : job.kind === "write"
                    ? updater => this._updateWriteMeta(job, updater)
                    : updater => this._updateMeta(job, updater);
            await updateMeta(meta => {
                meta.state = state;
                if (job.kind === "patch") {
                    meta.jobPhase = state;
                    meta.patchValidated = false;
                    meta.applyCheckPassed = false;
                    meta.baselineStable = false;
                } else if (job.kind === "write") {
                    meta.jobPhase = state;
                    meta.candidateAvailable = false;
                }
                meta.exitCode = exitCode;
                meta.completedAt = new Date().toISOString();
                if (reason) meta.exitReason = reason;
                if (state === "timeout") {
                    meta.errorCode = "JOB_TIMEOUT";
                } else if (state === "failed") {
                    meta.errorCode = errorCode || reason || "JOB_FAILED";
                    if (!job.accepted && !job.turnId && Object.prototype.hasOwnProperty.call(meta, "submissionState")) {
                        meta.submissionState = "rejected";
                    }
                }
            });
        } catch (error) {
            if (job.kind === "write") {
                const finalizeError = this._markWriteFinalizationIncomplete(job, error);
                throw finalizeError;
            }
            const expectedCode = job.kind === "patch" ? "AICW_PATCH_META_FINALIZE_FAILED" : "META_FINALIZE_FAILED";
            const finalizeError = error instanceof SidecarError && error.code === expectedCode
                ? error
                : new SidecarError(expectedCode, "Could not finalize Job meta");
            job.finalizationFailed = true;
            job.finalizationError = finalizeError;
            job.state = "finalizationFailed";
            if (this.state) {
                this.state.status = "degraded";
                try { writeJsonAtomic(this.paths.statePath, this.state); } catch {}
            }
            this.emit("protocolError", finalizeError);
            job.resolveTerminal({ state: job.state, errorCode: finalizeError.code });
            throw finalizeError;
        }
        this.activeJobs.delete(job.jobId);
        job.resolveTerminal({ state, exitCode, reason });
        return job.terminalPromise;
    }

    async shutdown() {
        if (this.shutdownPromise) return this.shutdownPromise;
        this.shutdownPromise = this._shutdownImpl();
        return this.shutdownPromise;
    }

    async _shutdownImpl() {
        this.draining = true;
        if (this.state) {
            this.state.status = "draining";
            try { writeJsonAtomic(this.paths.statePath, this.state); } catch {}
        }
        const interrupts = [];
        for (const job of this.activeJobs.values()) {
            if (job.threadId && job.turnId) {
                interrupts.push(this.codex.interruptTurn({ threadId: job.threadId, turnId: job.turnId }).catch(() => {}));
            }
        }
        await Promise.race([
            Promise.allSettled(interrupts),
            new Promise(resolve => setTimeout(resolve, this.drainTimeoutMs))
        ]);
        for (const job of [...this.activeJobs.values()]) {
            await this._finishJob(job, "failed", 1, "SIDECAR_SHUTDOWN");
        }
        if (this.codex) await this.codex.stop({ suppressClosed: true });
        await this._closeServer();
        try { fs.unlinkSync(this.paths.statePath); } catch (error) { if (error.code !== "ENOENT") this.emit("protocolError", error); }
        if (process.platform !== "win32") {
            try { removeEndpoint(this.paths.endpoint); } catch (error) { this.emit("protocolError", error); }
        }
        if (this.state) this.state.status = "closed";
        this.started = false;
    }

    _closeServer() {
        if (!this.server) return Promise.resolve();
        const server = this.server;
        this.server = null;
        return new Promise(resolve => {
            let settled = false;
            const finish = () => { if (!settled) { settled = true; resolve(); } };
            try { server.close(finish); } catch { finish(); }
            setTimeout(() => {
                for (const socket of this.sockets) {
                    try { socket.destroy(); } catch {}
                }
                finish();
            }, 250);
        });
    }
}

module.exports = { SidecarServer };
