"use strict";

// One UTF-8 JSON payload, excluding LF or CRLF. Not a total process-memory bound.
const DEFAULT_FRAME_BYTES = 16 * 1024 * 1024;
const MIN_FRAME_BYTES = 1024;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const FRAME_LIMIT_PROTOCOL_VERSION = 1;

class FrameTransportError extends Error {
    constructor(code, message, details) {
        super(message);
        this.name = "FrameTransportError";
        this.code = code;
        this.details = details;
    }
}

function resolveFrameLimit(value, field = "maxFrameBytes") {
    if (value === undefined || (typeof value === "string" && value.trim() === "")) {
        return DEFAULT_FRAME_BYTES;
    }
    const numeric = typeof value === "number" ? value
        : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
    if (!Number.isSafeInteger(numeric) || numeric < MIN_FRAME_BYTES || numeric > MAX_FRAME_BYTES) {
        throw new FrameTransportError("INVALID_FRAME_LIMIT",
            "Frame capacity must be an integer number of bytes within the supported range",
            { field, minimum: MIN_FRAME_BYTES, maximum: MAX_FRAME_BYTES });
    }
    return numeric;
}

function frameLimitStatus(codexMaxFrameBytes, ipcMaxFrameBytes) {
    return { protocolVersion: FRAME_LIMIT_PROTOCOL_VERSION, codexMaxFrameBytes, ipcMaxFrameBytes };
}

function encodeJsonLine(value, maxBytes, code, message) {
    const text = JSON.stringify(value);
    if (typeof text !== "string") throw new TypeError("JSON frame must be serializable");
    const measuredBytes = Buffer.byteLength(text, "utf8");
    if (measuredBytes > maxBytes) {
        throw new FrameTransportError(code, message, { measuredBytes, limitBytes: maxBytes, direction: "outbound" });
    }
    return `${text}\n`;
}

class BoundedLineReader {
    constructor(maxBytes, options = {}) {
        this.maxBytes = resolveFrameLimit(maxBytes);
        this.code = options.code || "PROTOCOL_BUFFER_OVERFLOW";
        this.message = options.message || "JSONL frame exceeded the byte limit";
        this.reset();
    }

    get bufferedBytes() { return this.length; }

    pendingText() {
        return this.length ? this.storage.toString("utf8", 0, this.length) : "";
    }

    reset() {
        this.storage = null;
        this.length = 0;
    }

    _append(segment) {
        if (!segment.length) return;
        const required = this.length + segment.length;
        // Keep at most one extra CR until LF establishes whether it is a delimiter.
        const trailingCR = segment[segment.length - 1] === 13;
        if (required > this.maxBytes + (trailingCR ? 1 : 0)) {
            const details = { measuredBytes: required - (trailingCR ? 1 : 0), limitBytes: this.maxBytes, direction: "inbound" };
            this.reset();
            throw new FrameTransportError(this.code, this.message, details);
        }
        if (!this.storage || this.storage.length < required) {
            const capacity = Math.min(this.maxBytes + 1,
                Math.max(required, this.storage ? this.storage.length * 2 : Math.min(4096, this.maxBytes + 1)));
            const next = Buffer.allocUnsafe(capacity);
            if (this.length) this.storage.copy(next, 0, 0, this.length);
            this.storage = next;
        }
        segment.copy(this.storage, this.length);
        this.length = required;
    }

    push(chunk, onLine) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
        let offset = 0;
        while (offset < bytes.length) {
            const newline = bytes.indexOf(10, offset);
            const end = newline === -1 ? bytes.length : newline;
            this._append(bytes.subarray(offset, end));
            if (newline === -1) return;
            const payloadLength = this.length && this.storage[this.length - 1] === 13 ? this.length - 1 : this.length;
            const line = payloadLength ? this.storage.toString("utf8", 0, payloadLength) : "";
            this.reset();
            // IPC carries only one nonblank request/response per socket.
            if (onLine(line) === false) return;
            offset = newline + 1;
        }
    }
}

module.exports = {
    DEFAULT_FRAME_BYTES, MIN_FRAME_BYTES, MAX_FRAME_BYTES, FRAME_LIMIT_PROTOCOL_VERSION,
    FrameTransportError, resolveFrameLimit, frameLimitStatus, encodeJsonLine, BoundedLineReader
};