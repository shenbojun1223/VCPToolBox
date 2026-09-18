"use strict";

const { EventEmitter } = require("events");
const { resolveFrameLimit, frameLimitStatus, encodeJsonLine, BoundedLineReader, FRAME_LIMIT_PROTOCOL_VERSION } = require("./frameTransport");
const { SidecarError } = require("./protocol");

class JsonLineRpcConnection extends EventEmitter {
    constructor(child, options = {}) {
        super();
        this.child = child;
        this.defaultTimeoutMs = Math.max(100, Number(options.defaultTimeoutMs || 10000));
        this.stderrLimit = Math.max(256, Number(options.stderrLimit || 8192));
        this.maxBufferBytes = resolveFrameLimit(options.maxBufferBytes, "maxBufferBytes");
        this.lineReader = new BoundedLineReader(this.maxBufferBytes, {
            code: "PROTOCOL_BUFFER_OVERFLOW", message: "Codex JSONL message exceeded the buffer limit"
        });
        this.pending = new Map();
        this.nextRequestId = 1;
        this.stderrSample = "";
        this.lineReader.reset();
        this.closed = false;
        this.closeInfo = null;
        this._bindChild();
    }

    _bindChild() {
        this.child.stdout?.on("data", chunk => this._onStdout(chunk));
        this.child.stderr?.on("data", chunk => this._onStderr(chunk));
        this.child.once("error", error => this._onChildFailure("error", error));
        this.child.once("close", (code, signal) => this._onChildFailure("close", { code, signal }));
    }

    get buffer() { return this.lineReader.pendingText(); }

    _onStdout(chunk) {
        if (this.closed) return;
        try {
            this.lineReader.push(chunk, line => {
                if (line.trim()) this._onLine(line);
                return !this.closed;
            });
        } catch (error) {
            if (error.code !== "PROTOCOL_BUFFER_OVERFLOW") throw error;
            this._failProtocol(new SidecarError(error.code, error.message, error.details));
        }
    }

    _onStderr(chunk) {
        const text = String(chunk);
        this.stderrSample = `${this.stderrSample}${text}`.slice(-this.stderrLimit);
    }

    _onLine(line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            this.emit("protocolError", new SidecarError("INVALID_JSON", "Codex emitted invalid JSON"));
            return;
        }
        if (!message || typeof message !== "object") {
            this.emit("protocolError", new SidecarError("INVALID_MESSAGE", "Codex emitted a non-object message"));
            return;
        }

        const hasId = Object.prototype.hasOwnProperty.call(message, "id");
        const hasMethod = typeof message.method === "string";
        if (hasMethod && hasId) {
            this.emit("serverRequest", {
                id: message.id,
                method: message.method,
                params: message.params
            });
            this._write({
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32601, message: "Server-initiated requests are not supported" }
            });
            return;
        }
        if (hasMethod) {
            this.emit("notification", { method: message.method, params: message.params });
            return;
        }
        if (hasId) {
            const pending = this.pending.get(String(message.id));
            if (!pending) {
                this.emit("protocolError", new SidecarError("UNKNOWN_RESPONSE_ID", "Codex returned an unknown request id"));
                return;
            }
            this.pending.delete(String(message.id));
            clearTimeout(pending.timer);
            if (message.error) {
                pending.reject(new SidecarError(
                    "CODEX_RPC_ERROR",
                    typeof message.error.message === "string" ? message.error.message : "Codex RPC request failed",
                    { rpcCode: message.error.code }
                ));
            } else {
                pending.resolve(message.result);
            }
            return;
        }
        this.emit("protocolError", new SidecarError("INVALID_MESSAGE", "Codex emitted an unclassified JSON message"));
    }

    _write(message) {
        if (this.closed || !this.child.stdin || this.child.stdin.destroyed) return false;
        try {
            this.child.stdin.write(encodeJsonLine(message, this.maxBufferBytes,
                "PROTOCOL_BUFFER_OVERFLOW", "Codex JSONL message exceeded the buffer limit"));
            return true;
        } catch (error) {
            if (error.code === "PROTOCOL_BUFFER_OVERFLOW") {
                this._failProtocol(new SidecarError(error.code, error.message, error.details));
                return false;
            }
            this.emit("protocolError", new SidecarError("WRITE_FAILED", "Could not write Codex JSONL message", { cause: error.code }));
            return false;
        }
    }

    request(method, params, timeoutMs = this.defaultTimeoutMs) {
        if (this.closed) return Promise.reject(new SidecarError("CODEX_CONNECTION_CLOSED", "Codex connection is closed"));
        const id = String(this.nextRequestId++);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (!this.pending.has(id)) return;
                this.pending.delete(id);
                reject(new SidecarError("CODEX_RPC_TIMEOUT", `Codex request timed out: ${method}`));
            }, Math.max(100, Number(timeoutMs || this.defaultTimeoutMs)));
            this.pending.set(id, { resolve, reject, timer, method });
            if (!this._write({ jsonrpc: "2.0", id, method, params })) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new SidecarError("CODEX_CONNECTION_CLOSED", "Codex connection is not writable"));
            }
        });
    }

    close(reason = "closed") {
        if (this.closed) return;
        this._onChildFailure("close", { reason });
    }

    _failProtocol(error) {
        this.lineReader.reset();
        this.emit("protocolError", error);
        this._onChildFailure("protocol", { code: error.code });
    }

    _onChildFailure(kind, detail) {
        if (this.closed) return;
        this.closed = true;
        this.lineReader.reset();
        this.closeInfo = { kind, detail, stderrSample: this.stderrSample };
        const error = new SidecarError(
            "CODEX_CONNECTION_CLOSED",
            kind === "error" ? "Codex process failed" : "Codex process closed",
            { kind, code: detail?.code, signal: detail?.signal }
        );
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
        this.emit("closed", this.closeInfo);
    }
}

module.exports = { JsonLineRpcConnection };
