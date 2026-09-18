"use strict";

const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const path = require("path");
const { JsonLineRpcConnection } = require("./jsonLineRpcConnection");
const { resolveFrameLimit } = require("./frameTransport");
const { SidecarError, getProcessIdentity, terminateOwnedChild } = require("./protocol");

const PATCH_CODEX_VERSION = "codex-cli 0.144.5";
const SERVICE_TIER_OVERRIDES = new Set(["default", "fast"]);

function normalizeServiceTierOverride(value) {
    if (value === undefined || value === null || String(value).trim() === "") return null;
    const normalized = String(value).trim().toLowerCase();
    if (!SERVICE_TIER_OVERRIDES.has(normalized)) {
        throw new SidecarError("CODEX_SERVICE_TIER_INVALID", "serviceTier must be default or fast");
    }
    return normalized;
}

class CodexAppServerProcess extends EventEmitter {
    constructor(options = {}) {
        super();
        this.maxCodexFrameBytes = resolveFrameLimit(options.maxCodexFrameBytes, "maxCodexFrameBytes");
        this.codexBin = options.codexBin || "codex";
        this.codexGlobalArgs = Array.isArray(options.codexGlobalArgs) ? [...options.codexGlobalArgs] : [];
        this.clientVersion = options.clientVersion || "vcp-aicodeworker-sidecar/1.0";
        this.clientTitle = options.clientTitle || "VCP AICodeWorker Sidecar";
        this.cwd = options.cwd || process.cwd();
        this.env = options.env || process.env;
        this.requestTimeoutMs = Math.max(500, Number(options.requestTimeoutMs || 10000));
        this.versionTimeoutMs = Math.max(500, Number(options.versionTimeoutMs || 5000));
        this.child = null;
        this.connection = null;
        this.version = null;
        this.codexPid = null;
        this.codexIdentity = null;
        this.started = false;
        this.stopping = false;
        this._stopPromise = null;
        this._stopTargets = new Map();
        this._starting = null;
        this.closed = false;
        this._versionChild = null;
        this._versionIdentity = null;
    }

    async _readVersion() {
        if (this._stopPromise || this.connection || this.child || this.codexPid || this.codexIdentity ||
            this._versionChild || this._versionIdentity || this._stopTargets.size) {
            throw new SidecarError("CODEX_START_BLOCKED", "Codex ownership is not clear");
        }
        const args = [...this.codexGlobalArgs, "--version"];
        return new Promise((resolve, reject) => {
            let settled = false, timer, reason;
            let versionChild;
            let stdout = "";
            const probe = { kind: "version", identity: null, pending: null, closed: false };
            const finish = (error, value) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    if (error) reject(error);
                    else resolve(value);
                }
                // Only this completed probe's close/termination proves its ownership ended.
                if (!probe.pending && (probe.closed || probe.confirmed)) {
                    probe.confirmed = true;
                    if (this._versionChild === versionChild ||
                        (!this._versionChild && this._versionIdentity === probe.identity)) {
                        this._versionChild = null;
                        this._versionIdentity = null;
                    }
                    if (!this._stopPromise && this._stopTargets.get(versionChild) === probe) {
                        this._stopTargets.delete(versionChild);
                    }
                }
            };
            probe.cancel = () => { reason ||= "CODEX_VERSION_STOPPED"; clearTimeout(timer); };
            probe.finish = () => finish(new SidecarError(
                reason || "CODEX_VERSION_STOPPED", "Codex version probe interrupted"));
            try {
                versionChild = spawn(this.codexBin, args, {
                    cwd: this.cwd,
                    env: this.env,
                    shell: false,
                    stdio: ["ignore", "pipe", "ignore"],
                    windowsHide: true
                });
            } catch {
                finish(new SidecarError("CODEX_VERSION_SPAWN_FAILED", "Could not start Codex version probe"));
                return;
            }
            this._versionChild = versionChild;
            try { probe.identity = getProcessIdentity(versionChild.pid); } catch {}
            this._versionIdentity = probe.identity;
            this._stopTargets.set(versionChild, probe);
            timer = setTimeout(() => {
                if (settled) return;
                reason = "CODEX_VERSION_TIMEOUT";
                const pending = Promise.resolve().then(() => terminateOwnedChild(versionChild, {
                    identity: probe.identity, gracefulTimeoutMs: 250,
                    forceConfirmationTimeoutMs: 1000, requireProcessTree: false
                })).then(result => ({ result, failed: false }), () => ({ failed: true }));
                probe.pending = pending;
                void pending.then(({ result, failed }) => {
                    if (probe.pending === pending) probe.pending = null;
                    probe.confirmed = probe.closed || (result?.confirmed === true &&
                        !result.identityMismatch && !result.identityMissing);
                    finish(new SidecarError("CODEX_VERSION_TIMEOUT", "Codex version probe timed out",
                        { confirmed: probe.confirmed, terminationFailed: failed }));
                });
            }, this.versionTimeoutMs);
            versionChild.stdout?.on("data", chunk => { stdout += String(chunk).slice(0, 512); });
            versionChild.once("error", () => {
                finish(new SidecarError("CODEX_VERSION_SPAWN_FAILED", "Codex version probe failed"));
            });
            versionChild.once("close", (code) => {
                probe.closed = true;
                clearTimeout(timer);
                if (probe.pending) return;
                if (reason) return probe.finish();
                if (code !== 0) {
                    finish(new SidecarError("CODEX_VERSION_FAILED", "Codex version probe returned an error",
                        { exitCode: Number.isInteger(code) ? code : null }));
                    return;
                }
                finish(null, stdout.trim().split(/\r?\n/, 1)[0].slice(0, 128) || "unknown");
            });
        });
    }

    async start() {
        if (this._starting || this._stopPromise || this.stopping) {
            throw new SidecarError("CODEX_START_BLOCKED", "Codex lifecycle is busy");
        }
        if (this.started && !this.closed) return this;
        if (this.connection || this.child || this.codexPid || this.codexIdentity || this._versionChild ||
            this._versionIdentity || this._stopTargets.size) {
            throw new SidecarError("CODEX_START_BLOCKED", "Codex ownership is not clear");
        }
        const attempt = { cancelled: false };
        this._starting = attempt;
        this.closed = false;
        let child = null;
        try {
            this.version = await this._readVersion();
            if (attempt.cancelled || this._stopPromise || this._stopTargets.size) {
                throw new SidecarError("CODEX_START_ABORTED", "Codex start was stopped");
            }
            const args = [...this.codexGlobalArgs, "app-server", "--stdio"];
            try {
                child = spawn(this.codexBin, args, {
                    cwd: this.cwd,
                    env: this.env,
                    shell: false,
                    stdio: ["pipe", "pipe", "pipe"],
                    windowsHide: true
                });
            } catch (error) {
                throw new SidecarError("CODEX_APP_SERVER_SPAWN_FAILED", "Could not start Codex app-server", { cause: "SPAWN_FAILED" });
            }
            this.child = child;
            this.codexPid = child.pid || null;
            try { this.codexIdentity = getProcessIdentity(child.pid); } catch {}
            this._stopTargets.set(child, { kind: "main", identity: this.codexIdentity });
            this.connection = new JsonLineRpcConnection(child, {
                defaultTimeoutMs: this.requestTimeoutMs, maxBufferBytes: this.maxCodexFrameBytes
            });
            this.connection.on("notification", message => this.emit("notification", message));
            this.connection.on("serverRequest", request => this.emit("serverRequest", request));
            this.connection.on("protocolError", error => this.emit("protocolError", error));
            this.connection.once("closed", info => this._onClosed(info));

            await this.connection.request("initialize", {
                clientInfo: {
                    name: "vcp-aicodeworker-sidecar",
                    title: this.clientTitle,
                    version: this.clientVersion
                },
                capabilities: {
                    experimentalApi: true,
                    requestAttestation: false,
                    mcpServerOpenaiFormElicitation: false,
                    optOutNotificationMethods: []
                }
            });
            if (attempt.cancelled || this._stopPromise || this.child !== child || this.closed) {
                throw new SidecarError("CODEX_START_ABORTED", "Codex start was stopped");
            }
            if (!this.connection._write({ jsonrpc: "2.0", method: "initialized" })) {
                throw new SidecarError("CODEX_INITIALIZE_FAILED", "Could not send initialized notification");
            }
            if (attempt.cancelled || this._stopPromise || this.child !== child || this.closed) {
                throw new SidecarError("CODEX_START_ABORTED", "Codex start was stopped");
            }
            this.started = true;
            return this;
        } catch (error) {
            await this.stop({ suppressClosed: true });
            if (error instanceof SidecarError) throw error;
            throw new SidecarError("CODEX_INITIALIZE_FAILED", "Codex app-server initialization failed", { cause: "INITIALIZE_FAILED" });
        } finally {
            if (this._starting === attempt) this._starting = null;
        }
    }

    async startThread({ projectPath, model, serviceTier, writeMode = false } = {}) {
        if (writeMode && (!projectPath || !path.isAbsolute(projectPath))) {
            throw new SidecarError("CODEX_WRITE_PROJECT_PATH_INVALID", "writeMode requires an absolute projectPath");
        }
        if (!this.connection || this.closed) throw new SidecarError("CODEX_NOT_READY", "Codex app-server is not ready");
        const params = {
            cwd: projectPath,
            ephemeral: true,
            sandbox: writeMode ? "workspace-write" : "read-only",
            approvalPolicy: "never"
        };
        if (model) params.model = model;
        const normalizedServiceTier = normalizeServiceTierOverride(serviceTier);
        if (normalizedServiceTier) params.serviceTier = normalizedServiceTier;
        const result = await this.connection.request("thread/start", params);
        const threadId = result?.thread?.id;
        if (!threadId) throw new SidecarError("CODEX_INVALID_RESPONSE", "thread/start did not return thread.id");
        return result.thread;
    }

    isPatchVersionAllowed() {
        return this.version === PATCH_CODEX_VERSION;
    }

    async startTurn({ threadId, text, effort, serviceTier, patchMode = false, writeMode = false, projectPath, model } = {}) {
        if (patchMode && writeMode) {
            throw new SidecarError("CODEX_MODE_CONFLICT", "patchMode and writeMode cannot be enabled together");
        }
        if (writeMode && (!projectPath || !path.isAbsolute(projectPath))) {
            throw new SidecarError("CODEX_WRITE_PROJECT_PATH_INVALID", "writeMode requires an absolute projectPath");
        }
        if (!this.connection || this.closed) throw new SidecarError("CODEX_NOT_READY", "Codex app-server is not ready");
        const params = {
            threadId,
            input: [{ type: "text", text: String(text || ""), text_elements: [] }]
        };
        if (patchMode) {
            params.cwd = projectPath;
            params.sandboxPolicy = { type: "readOnly", networkAccess: false };
            params.approvalPolicy = "never";
            params.model = model;
        }
        if (writeMode) {
            params.cwd = projectPath;
            params.sandboxPolicy = { type: "workspaceWrite", writableRoots: [projectPath], networkAccess: false };
            params.approvalPolicy = "never";
            params.model = model;
        }
        if (effort) params.effort = effort;
        const normalizedServiceTier = normalizeServiceTierOverride(serviceTier);
        if (normalizedServiceTier) params.serviceTier = normalizedServiceTier;
        const result = await this.connection.request("turn/start", params);
        const turnId = result?.turn?.id;
        if (!turnId) throw new SidecarError("CODEX_INVALID_RESPONSE", "turn/start did not return turn.id");
        return result.turn;
    }

    async interruptTurn({ threadId, turnId } = {}) {
        if (!this.connection || this.closed) throw new SidecarError("CODEX_NOT_READY", "Codex app-server is not ready");
        return this.connection.request("turn/interrupt", { threadId, turnId });
    }

    stop(options = {}) {
        const remember = (child, identity, kind, capture = false) => {
            if (!child || this._stopTargets.has(child)) return;
            // An override is captured once; existing startup evidence is never refreshed.
            if (capture) { try { identity = getProcessIdentity(child.pid); } catch {} }
            this._stopTargets.set(child, { identity, kind });
        };
        remember(this.child, this.codexIdentity, "main");
        remember(this._versionChild, this._versionIdentity, "version");
        remember(options.childOverride, null, "main", true);
        if (this._stopPromise) return this._stopPromise;
        const targets = [...this._stopTargets];
        const connection = this.connection;
        this.stopping = true;
        this.started = false;
        if (this._starting) this._starting.cancelled = true;
        this._stopPromise = Promise.resolve().then(async () => {
            let connectionCloseFailed = false;
            try {
                if (connection && !connection.closed) connection.close("intentional stop");
            } catch { connectionCloseFailed = true; }
            const results = [];
            for (const [child, ownership] of targets) {
                const main = ownership.kind === "main";
                ownership.cancel?.();
                const pid = Number.isInteger(child.pid) && child.pid > 0 ? child.pid : null;
                const identity = ownership.identity;
                const identityMissing = main && (!identity || identity.pid !== pid ||
                    !(identity.startTime || identity.startTimeTicks));
                const rootAlreadyExited = main && (child.exitCode != null || child.signalCode != null);
                let result, failed = false;
                if (!ownership.confirmed) {
                    const pending = ownership.pending || Promise.resolve().then(() =>
                        terminateOwnedChild(child, {
                            identity, gracefulTimeoutMs: 750,
                            forceConfirmationTimeoutMs: 1000, requireProcessTree: main
                        })).then(value => ({ result: value, failed: false }), () => ({ failed: true }));
                    ownership.pending = pending;
                    ({ result, failed } = await pending);
                    if (ownership.pending === pending) ownership.pending = null;
                }
                const confirmed = ownership.confirmed === true || (!main && ownership.closed === true) ||
                    (!failed && !identityMissing && !rootAlreadyExited &&
                        result?.confirmed === true && !result.identityMissing &&
                        !result.identityMismatch && !result.rootAlreadyExited &&
                        (!main || result.treeTermination === "confirmed"));
                ownership.confirmed = confirmed;
                ownership.finish?.();
                results.push({
                    pid, kind: ownership.kind, confirmed, failed,
                    terminated: result?.terminated === true,
                    code: failed ? "TERMINATION_FAILED" : confirmed ? "CONFIRMED" :
                        identityMissing || result?.identityMissing ? "IDENTITY_MISSING" :
                        result?.identityMismatch ? "IDENTITY_MISMATCH" :
                        rootAlreadyExited || result?.rootAlreadyExited ? "ROOT_ALREADY_EXITED" :
                        main ? "TREE_UNCONFIRMED" : "PROBE_UNCONFIRMED"
                });
                if (!confirmed) continue;
                if (this.child === child) {
                    this.child = null;
                    this.codexPid = null;
                    this.codexIdentity = null;
                }
                if (this._versionChild === child ||
                    (!this._versionChild && this._versionIdentity === identity)) {
                    this._versionChild = null;
                    this._versionIdentity = null;
                }
            }
            const pendingTargets = [...this._stopTargets.values()].filter(item => !item.confirmed).length;
            const orphanedOwnership = Boolean(this.child || this.codexPid || this.codexIdentity ||
                this._versionChild || this._versionIdentity || (this.connection && this.connection !== connection));
            const failed = connectionCloseFailed || results.some(item => item.failed);
            if (failed || pendingTargets || orphanedOwnership) {
                throw new SidecarError(failed ? "CODEX_STOP_FAILED" : "CODEX_STOP_UNCONFIRMED",
                    "Codex stop did not converge",
                    { connectionCloseFailed, pendingTargets, orphanedOwnership, results });
            }
            if (this.connection === connection) this.connection = null;
            try {
                if (!this.closed) this._onClosed({ intentional: true, suppressed: Boolean(options.suppressClosed) });
            } catch {
                throw new SidecarError("CODEX_STOP_FAILED", "Codex closed notification failed",
                    { notificationFailed: true });
            }
            return { confirmed: true, terminated: results.some(item => item.terminated), results };
        }).finally(() => {
            for (const [child, ownership] of this._stopTargets) {
                if (ownership.confirmed) this._stopTargets.delete(child);
            }
            this.stopping = false;
            this._stopPromise = null;
        });
        return this._stopPromise;
    }

    _onClosed(info) {
        if (this.closed) return;
        this.closed = true;
        this.emit("closed", { ...info, intentional: this.stopping || Boolean(info?.intentional) });
    }
}

module.exports = {
    CodexAppServerProcess,
    PATCH_CODEX_VERSION,
    normalizeServiceTierOverride
};
