"use strict";

const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const { JsonLineRpcConnection } = require("./jsonLineRpcConnection");
const { SidecarError, getProcessIdentity, terminateOwnedChild } = require("./protocol");

const PATCH_CODEX_VERSION = "codex-cli 0.144.5";

class CodexAppServerProcess extends EventEmitter {
    constructor(options = {}) {
        super();
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
        this.closed = false;
        this._versionChild = null;
        this._versionIdentity = null;
    }

    async _readVersion() {
        const args = [...this.codexGlobalArgs, "--version"];
        return new Promise((resolve, reject) => {
            let settled = false;
            let versionChild;
            let stdout = "";
            const finish = (error, value) => {
                if (settled) return;
                settled = true;
                if (this._versionChild === versionChild) this._versionChild = null;
                if (error) reject(error);
                else resolve(value);
            };
            try {
                versionChild = spawn(this.codexBin, args, {
                    cwd: this.cwd,
                    env: this.env,
                    shell: false,
                    stdio: ["ignore", "pipe", "ignore"],
                    windowsHide: true
                });
                this._versionChild = versionChild;
                this._versionIdentity = getProcessIdentity(versionChild.pid);
            } catch (error) {
                finish(new SidecarError("CODEX_VERSION_SPAWN_FAILED", "Could not start Codex version probe", { cause: error.code }));
                return;
            }
            const timer = setTimeout(() => {
                if (settled) return;
                terminateOwnedChild(versionChild, {
                    identity: this._versionIdentity,
                    gracefulTimeoutMs: 250
                }).finally(() => finish(new SidecarError("CODEX_VERSION_TIMEOUT", "Codex version probe timed out")));
            }, this.versionTimeoutMs);
            versionChild.stdout?.on("data", chunk => { stdout += String(chunk).slice(0, 512); });
            versionChild.once("error", error => {
                clearTimeout(timer);
                finish(new SidecarError("CODEX_VERSION_SPAWN_FAILED", "Codex version probe failed", { cause: error.code }));
            });
            versionChild.once("close", (code, signal) => {
                clearTimeout(timer);
                if (code !== 0) {
                    finish(new SidecarError("CODEX_VERSION_FAILED", "Codex version probe returned an error", { code, signal }));
                    return;
                }
                finish(null, stdout.trim().split(/\r?\n/, 1)[0].slice(0, 128) || "unknown");
            });
        });
    }

    async start() {
        if (this.started && !this.closed) return this;
        let child = null;
        try {
            this.version = await this._readVersion();
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
                throw new SidecarError("CODEX_APP_SERVER_SPAWN_FAILED", "Could not start Codex app-server", { cause: error.code });
            }
            this.child = child;
            this.codexPid = child.pid || null;
            this.codexIdentity = getProcessIdentity(child.pid);
            this.connection = new JsonLineRpcConnection(child, { defaultTimeoutMs: this.requestTimeoutMs });
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
            this.codexIdentity = this.codexIdentity || getProcessIdentity(child.pid);
            if (!this.connection._write({ jsonrpc: "2.0", method: "initialized" })) {
                throw new SidecarError("CODEX_INITIALIZE_FAILED", "Could not send initialized notification");
            }
            this.started = true;
            return this;
        } catch (error) {
            await this.stop({ suppressClosed: true, childOverride: child });
            if (error instanceof SidecarError) throw error;
            throw new SidecarError("CODEX_INITIALIZE_FAILED", "Codex app-server initialization failed", { cause: error.code });
        }
    }

    async startThread({ projectPath, model } = {}) {
        if (!this.connection || this.closed) throw new SidecarError("CODEX_NOT_READY", "Codex app-server is not ready");
        const params = {
            cwd: projectPath,
            ephemeral: true,
            sandbox: "read-only",
            approvalPolicy: "never"
        };
        if (model) params.model = model;
        const result = await this.connection.request("thread/start", params);
        const threadId = result?.thread?.id;
        if (!threadId) throw new SidecarError("CODEX_INVALID_RESPONSE", "thread/start did not return thread.id");
        return result.thread;
    }

    isPatchVersionAllowed() {
        return this.version === PATCH_CODEX_VERSION;
    }

    async startTurn({ threadId, text, effort, patchMode = false, projectPath, model } = {}) {
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
        if (effort) params.effort = effort;
        const result = await this.connection.request("turn/start", params);
        const turnId = result?.turn?.id;
        if (!turnId) throw new SidecarError("CODEX_INVALID_RESPONSE", "turn/start did not return turn.id");
        return result.turn;
    }

    async interruptTurn({ threadId, turnId } = {}) {
        if (!this.connection || this.closed) throw new SidecarError("CODEX_NOT_READY", "Codex app-server is not ready");
        return this.connection.request("turn/interrupt", { threadId, turnId });
    }

    async stop(options = {}) {
        if (this.stopping) return;
        this.stopping = true;
        const connection = this.connection;
        const child = options.childOverride || this.child;
        if (connection && !connection.closed) connection.close("intentional stop");
        if (child && child.pid) await terminateOwnedChild(child, {
            identity: child === this.child ? this.codexIdentity : getProcessIdentity(child.pid),
            gracefulTimeoutMs: 750
        });
        this.child = null;
        this.connection = null;
        this.codexPid = null;
        this.codexIdentity = null;
        this.started = false;
        if (!this.closed) this._onClosed({ intentional: true, suppressed: Boolean(options.suppressClosed) });
    }

    _onClosed(info) {
        if (this.closed) return;
        this.closed = true;
        this.emit("closed", { ...info, intentional: this.stopping || Boolean(info?.intentional) });
    }
}

module.exports = { CodexAppServerProcess, PATCH_CODEX_VERSION };
