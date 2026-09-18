"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const {
    DEFAULT_FRAME_BYTES, MIN_FRAME_BYTES, MAX_FRAME_BYTES, FRAME_LIMIT_PROTOCOL_VERSION,
    resolveFrameLimit, frameLimitStatus, encodeJsonLine, BoundedLineReader
} = require("../appserver/frameTransport");
const { JsonLineRpcConnection } = require("../appserver/jsonLineRpcConnection");
const { CodexAppServerProcess } = require("../appserver/codexAppServerProcess");
const { SidecarServer } = require("../appserver/sidecarServer");
const { SidecarClient } = require("../appserver/sidecarClient");
const { SidecarError } = require("../appserver/protocol");

const tick = () => new Promise(resolve => setImmediate(resolve));
const mockChild = () => Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: { destroyed: false, writes: [], write(text) { this.writes.push(text); } }
});
function connection(limit) {
    const child = mockChild();
    const rpc = new JsonLineRpcConnection(child, { maxBufferBytes: limit });
    const errors = [], messages = [];
    rpc.on("protocolError", error => errors.push(error));
    rpc.on("notification", message => messages.push(message));
    return { child, rpc, errors, messages };
}
function notificationOfBytes(size) {
    const prefix = '{"method":"test/frame","params":{"text":"';
    const suffix = '"}}';
    return prefix + "x".repeat(size - Buffer.byteLength(prefix + suffix)) + suffix;
}
function client(options = {}) {
    return new SidecarClient({ pluginDir: __dirname, jobRoot: path.join(__dirname, "synthetic-unused-jobs"),
        processIdentity: null, ...options });
}
function server(options = {}) {
    return new SidecarServer({ pluginDir: __dirname, jobRoot: path.join(__dirname, "synthetic-unused-jobs"), ...options });
}

test("limits default separately; decimal strings and inclusive endpoints accepted", () => {
    for (const value of [undefined, "", "   "]) assert.equal(resolveFrameLimit(value), 16777216);
    for (const value of [1024, "1024", 67108864, "67108864", " 16777216 "]) {
        assert.equal(resolveFrameLimit(value), Number(value));
    }
    assert.equal(MIN_FRAME_BYTES, 1024);
    assert.equal(MAX_FRAME_BYTES, 67108864);
    assert.equal(FRAME_LIMIT_PROTOCOL_VERSION, 1);
    assert.equal(new CodexAppServerProcess().maxCodexFrameBytes, DEFAULT_FRAME_BYTES);
    assert.equal(client().maxIpcBufferBytes, DEFAULT_FRAME_BYTES);
    assert.equal(server().maxCodexFrameBytes, DEFAULT_FRAME_BYTES);
});
for (const [label, value] of [
    ["null", null], ["boolean", true], ["object", {}], ["array", []], ["NaN", NaN],
    ["Infinity", Infinity], ["negative", -1], ["zero", 0], ["too-small", 1023],
    ["fraction", 1024.1], ["too-large", 67108865], ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["scientific-string", "1e6"], ["hex", "0x1000"], ["unit", "16MiB"], ["garbage", "1024junk"]
]) {
    test("reject invalid frame capacity: " + label, () => {
        assert.throws(() => resolveFrameLimit(value, "synthetic-field"), e => {
            assert.equal(e.code, "INVALID_FRAME_LIMIT");
            assert.equal(e.details.field, "synthetic-field");
            return true;
        });
        assert.throws(() => new CodexAppServerProcess({ maxCodexFrameBytes: value }), { code: "INVALID_FRAME_LIMIT" });
        assert.throws(() => client({ maxIpcBufferBytes: value }), { code: "INVALID_FRAME_LIMIT" });
        assert.throws(() => server({ maxCodexFrameBytes: value }), { code: "INVALID_FRAME_LIMIT" });
    });
}
for (const size of [1024, 1024 * 1024 + 129, DEFAULT_FRAME_BYTES]) {
    for (const delimiter of ["\n", "\r\n"]) {
        test(`accept exact ${size}-byte JSON payload with ${JSON.stringify(delimiter)}`, () => {
            const { child, rpc, errors, messages } = connection(size);
            const frame = Buffer.from(notificationOfBytes(size) + delimiter);
            for (let at = 0; at < frame.length; at += 65537) child.stdout.emit("data", frame.subarray(at, at + 65537));
            assert.equal(errors.length, 0);
            assert.equal(messages.length, 1);
            assert.equal(rpc.buffer, "");
            rpc.close("test");
        });
    }
    for (const terminated of [false, true]) {
        test(`reject ${size}+1-byte frame, terminated=${terminated}`, () => {
            const { child, rpc, errors, messages } = connection(size);
            child.stdout.emit("data", Buffer.from(notificationOfBytes(size + 1) + (terminated ? "\n" : "")));
            assert.equal(errors[0].code, "PROTOCOL_BUFFER_OVERFLOW");
            assert.equal(errors[0].details.limitBytes, size);
            assert.equal(errors[0].details.measuredBytes, size + 1);
            assert.equal(messages.length, 0);
            assert.equal(rpc.closed, true);
            assert.equal(rpc.buffer, "");
        });
    }
}
test("default reader accepts legal frame above the old 1 MiB ceiling", () => {
    const { child, rpc, messages, errors } = connection();
    child.stdout.emit("data", Buffer.from(notificationOfBytes(2 * 1024 * 1024) + "\n"));
    assert.equal(messages.length, 1);
    assert.equal(errors.length, 0);
    rpc.close();
});
test("many valid frames in a single chunk are not a cumulative-limit failure", () => {
    const { child, rpc, messages, errors } = connection(1024);
    child.stdout.emit("data", Buffer.from((notificationOfBytes(1024) + "\n").repeat(80)));
    assert.equal(messages.length, 80);
    assert.equal(errors.length, 0);
    rpc.close();
});
test("UTF-8 is lossless at every split in a multibyte message", () => {
    const original = { method: "test/unicode", params: { text: "赞妮🙂𠮷é—容量" } };
    const encoded = Buffer.from(JSON.stringify(original) + "\r\n");
    for (let split = 1; split < encoded.length; split++) {
        const { child, rpc, messages, errors } = connection(1024);
        child.stdout.emit("data", encoded.subarray(0, split));
        child.stdout.emit("data", encoded.subarray(split));
        assert.deepEqual(messages[0], original);
        assert.equal(errors.length, 0);
        rpc.close();
    }
});
test("byte accounting is UTF-8 bytes, not JS characters", () => {
    const reader = new BoundedLineReader(1024);
    assert.throws(() => reader.push(Buffer.from("中".repeat(342)), () => {}), { code: "PROTOCOL_BUFFER_OVERFLOW" });
    assert.equal(reader.bufferedBytes, 0);
});
test("CR reserve is one byte only and cannot hide an oversized unterminated frame", () => {
    const reader = new BoundedLineReader(1024);
    reader.push(Buffer.from("x".repeat(1024) + "\r"), () => {});
    assert.equal(reader.bufferedBytes, 1025);
    assert.throws(() => reader.push(Buffer.from("y"), () => {}), { code: "PROTOCOL_BUFFER_OVERFLOW" });
    assert.equal(reader.bufferedBytes, 0);
});
test("split CRLF at exact boundary is accepted", () => {
    const reader = new BoundedLineReader(1024), lines = [];
    reader.push(Buffer.from("x".repeat(1024)), line => lines.push(line));
    reader.push(Buffer.from("\r"), line => lines.push(line));
    reader.push(Buffer.from("\n"), line => lines.push(line));
    assert.equal(lines[0].length, 1024);
});
test("partial data is retained in bounded storage, cleared on close; one-byte chunks work", () => {
    const { child, rpc, messages } = connection(2048);
    const frame = Buffer.from(notificationOfBytes(1500) + "\n");
    for (const byte of frame) child.stdout.emit("data", Buffer.from([byte]));
    assert.equal(messages.length, 1);
    child.stdout.emit("data", Buffer.from("remaining"));
    assert.ok(rpc.lineReader.storage.length <= 2049);
    rpc.close();
    assert.equal(rpc.buffer, "");
    assert.equal(rpc.lineReader.storage, null);
});
test("malformed JSON keeps existing protocolError behavior", () => {
    const { child, rpc, errors } = connection(1024);
    child.stdout.emit("data", Buffer.from("{not-json\n"));
    assert.equal(errors[0].code, "INVALID_JSON");
    rpc.close();
});
test("oversize input rejects pending requests and ignores subsequent frames", async () => {
    const { child, rpc, errors, messages } = connection(1024);
    const pending = rpc.request("ping", {});
    const check = assert.rejects(pending, { code: "CODEX_CONNECTION_CLOSED" });
    child.stdout.emit("data", Buffer.from("x".repeat(1025)));
    child.stdout.emit("data", Buffer.from('{"method":"too-late"}\n'));
    await check;
    assert.equal(rpc.pending.size, 0);
    assert.equal(errors.length, 1);
    assert.equal(messages.length, 0);
});
test("outbound JSONL is bounded before stdin write", () => {
    const { child, rpc, errors } = connection(1024);
    const result = rpc._write({ method: "oversized", params: "x".repeat(1024) });
    assert.equal(result, false);
    assert.equal(child.stdin.writes.length, 0);
    assert.equal(errors[0].code, "PROTOCOL_BUFFER_OVERFLOW");
    assert.equal(errors[0].details.direction, "outbound");
    assert.equal(rpc.closed, true);
});
test("encoder checks exact serialized UTF-8 payload bytes", () => {
    const value = JSON.parse(notificationOfBytes(1024));
    assert.equal(Buffer.byteLength(encodeJsonLine(value, 1024, "TEST_LIMIT", "synthetic")), 1025);
    assert.throws(() => encodeJsonLine({ text: "🙂".repeat(300) }, 1024, "TEST_LIMIT", "synthetic"), { code: "TEST_LIMIT" });
});

async function withIpc(options, run) {
    const sidecar = server(options);
    sidecar.state = { instanceId: "synthetic-instance", controlToken: "synthetic-local-only", status: "ready" };
    let dispatches = 0;
    sidecar._dispatch = async (method, params) => {
        dispatches++;
        if (method === "oversize-result") return { text: "x".repeat(sidecar.maxIpcBufferBytes) };
        if (method === "oversize-error") throw new SidecarError("SYNTHETIC", "x".repeat(sidecar.maxIpcBufferBytes * 2));
        if (method === "unicode") return { text: params.text };
        if (method === "status") return sidecar.status();
        return { accepted: true, length: params.text?.length || 0 };
    };
    const listener = net.createServer(socket => sidecar._acceptSocket(socket));
    await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
    const state = { ...sidecar.state, endpoint: { host: "127.0.0.1", port: listener.address().port } };
    try { await run({ sidecar, state, dispatches: () => dispatches }); }
    finally {
        for (const socket of sidecar.sockets) socket.destroy();
        await new Promise(resolve => listener.close(resolve));
    }
}
test("real local IPC roundtrip works above old ceiling with Unicode", { timeout: 10000 }, async () => {
    await withIpc({}, async ({ state }) => {
        const c = client();
        const text = "赞妮🙂".repeat(190000);
        const result = await c._callWithState(state, "unicode", { text });
        assert.equal(result.text, text);
    });
});
test("oversized request is deterministically rejected before connecting or dispatching", async () => {
    await withIpc({ maxIpcBufferBytes: 1024 }, async ({ state, dispatches }) => {
        const c = client({ maxIpcBufferBytes: 1024 });
        await assert.rejects(c._callWithState(state, "unicode", { text: "x".repeat(1024) }),
            { code: "SIDECAR_IPC_REQUEST_TOO_LARGE" });
        assert.equal(dispatches(), 0);
    });
});
test("oversize IPC result produces bounded error, never silently replays", async () => {
    await withIpc({ maxIpcBufferBytes: 1024 }, async ({ state, dispatches }) => {
        const c = client({ maxIpcBufferBytes: 1024 });
        await assert.rejects(c._callWithState(state, "oversize-result", {}), { code: "SIDECAR_IPC_BUFFER_OVERFLOW" });
        assert.equal(dispatches(), 1);
    });
});
test("oversize error message also fits IPC cap", async () => {
    await withIpc({ maxIpcBufferBytes: 1024 }, async ({ state, dispatches }) => {
        await assert.rejects(client({ maxIpcBufferBytes: 1024 })._callWithState(state, "oversize-error", {}),
            { code: "SIDECAR_IPC_BUFFER_OVERFLOW" });
        assert.equal(dispatches(), 1);
    });
});
test("oversize response requestId has bounded fallback without recursive sending", () => {
    const s = server({ maxIpcBufferBytes: 1024 });
    const socket = { destroyed: false, end(text) { this.text = text; } };
    s._sendError(socket, "x".repeat(3000), new SidecarError("ERR", "x".repeat(3000)));
    assert.ok(Buffer.byteLength(socket.text) - 1 <= 1024);
    const message = JSON.parse(socket.text);
    assert.equal(message.requestId, null);
    assert.equal(message.error.code, "SIDECAR_IPC_BUFFER_OVERFLOW");
});
test("IPC request bytes are bounded even if no newline arrives", async () => {
    await withIpc({ maxIpcBufferBytes: 1024 }, async ({ state, dispatches }) => {
        const reply = await new Promise((resolve, reject) => {
            const socket = net.createConnection(state.endpoint);
            let text = "";
            const timeout = setTimeout(() => { socket.destroy(); reject(Error("test timeout")); }, 3000);
            socket.on("data", data => { text += data.toString("utf8"); });
            socket.once("connect", () => socket.write(Buffer.alloc(1025, 120)));
            socket.once("error", error => { clearTimeout(timeout); reject(error); });
            socket.once("close", () => { clearTimeout(timeout); resolve(JSON.parse(text)); });
        });
        assert.equal(reply.error.code, "SIDECAR_IPC_BUFFER_OVERFLOW");
        assert.equal(dispatches(), 0);
    });
});
test("server accepts one request and ignores subsequent frames on the same socket", async () => {
    const s = server({ maxIpcBufferBytes: 1024 });
    const socket = Object.assign(new EventEmitter(), { destroyed: false, end() {}, destroy() { this.destroyed = true; } });
    let calls = 0;
    s._handleIpcLine = async () => { calls++; };
    s._acceptSocket(socket);
    socket.emit("data", Buffer.from('\n{"first":true}\n' + "x".repeat(2048)));
    await tick();
    assert.equal(calls, 1);
    socket.emit("close");
    assert.equal(s.sockets.size, 0);
});
for (const method of ["submitAnalyzeJob", "submitPatchJob", "submitWriteJob"]) {
    test(method + " refuses old or incompatible instances without submission", async () => {
        const c = client();
        let sends = 0;
        c._callWithState = async () => { sends++; return {}; };
        for (const limits of [undefined, frameLimitStatus(1024, DEFAULT_FRAME_BYTES),
            { protocolVersion: 99, codexMaxFrameBytes: DEFAULT_FRAME_BYTES, ipcMaxFrameBytes: DEFAULT_FRAME_BYTES }]) {
            c.ensure = async () => ({ frameLimits: limits });
            await assert.rejects(c[method]({ jobId: "job_frame_gate" }), { code: "SIDECAR_FRAME_LIMIT_MISMATCH" });
        }
        assert.equal(sends, 0);
    });
}
test("capacity gate accepts exact configured limits and status reports actual values", () => {
    const c = client({ maxCodexFrameBytes: 4096, maxIpcBufferBytes: 8192 });
    const s = server({ maxCodexFrameBytes: 4096, maxIpcBufferBytes: 8192 });
    assert.deepEqual(s.status().frameLimits, frameLimitStatus(4096, 8192));
    assert.doesNotThrow(() => c._assertFrameLimitsCompatible({ frameLimits: s.status().frameLimits }));
});
test("patch submission response overflow remains unknown; preflight overflow does not", async () => {
    const c = client();
    c.ensure = async () => ({ frameLimits: frameLimitStatus(DEFAULT_FRAME_BYTES, DEFAULT_FRAME_BYTES) });
    c._callWithState = async () => { throw new SidecarError("SIDECAR_IPC_BUFFER_OVERFLOW", "synthetic"); };
    await assert.rejects(c.submitPatchJob({ jobId: "job_frame_unknown" }),
        { code: "AICW_APP_SERVER_PATCH_SUBMISSION_UNKNOWN" });
    c._callWithState = async () => { throw new SidecarError("SIDECAR_IPC_REQUEST_TOO_LARGE", "synthetic"); };
    await assert.rejects(c.submitPatchJob({ jobId: "job_frame_preflight" }),
        { code: "SIDECAR_IPC_REQUEST_TOO_LARGE" });
});
test("sidecar entry strictly parses both capacity flags without starting a process", () => {
    const file = path.join(__dirname, "../appserver/sidecar-entry.js");
    let source = fs.readFileSync(file, "utf8");
    source = source.slice(0, source.indexOf("\nmain().catch(")) + "\nmodule.exports = { parseArgs };";
    const m = { exports: {} };
    vm.runInNewContext(source, { module: m, require: createRequire(file), process: { cwd: () => "/unused" } });
    const common = ["--job-root", "/unused", "--codex-global-args", "[]"];
    const options = m.exports.parseArgs([...common, "--max-codex-frame-bytes", "8192", "--max-ipc-frame-bytes", "4096"]);
    assert.equal(options.maxCodexFrameBytes, 8192);
    assert.equal(options.maxIpcBufferBytes, 4096);
    assert.throws(() => m.exports.parseArgs([...common, "--max-codex-frame-bytes", "Infinity"]), { code: "INVALID_FRAME_LIMIT" });
});
test("config parser and createSidecarClient pass both independent values", () => {
    const file = path.join(__dirname, "../AICodeWorker.js");
    const source = fs.readFileSync(file, "utf8");
    const begin = source.indexOf("function loadConfig() {");
    const end = source.indexOf("\nconst CFG = loadConfig();", begin);
    const factoryBegin = source.indexOf("function createSidecarClient(");
    const factoryEnd = source.indexOf("\nfunction isAppServerMeta(", factoryBegin);
    let received;
    const context = {
        __dirname: "/synthetic", process: { env: {} }, os: { homedir: () => "/synthetic" }, path,
        fs: { existsSync: () => true, readFileSync: () => "CODEX_APP_SERVER_MAX_FRAME_BYTES=8192\nCODEX_APP_SERVER_IPC_MAX_FRAME_BYTES=4096\n" },
        TRACE_MODES: new Set(["summary", "events", "raw"]), APP_SERVER_MAX_CONCURRENCY: 3,
        resolveFrameLimit, SidecarClient: class { constructor(options) { received = options; } }
    };
    vm.runInNewContext(source.slice(begin, end) + "\nconst CFG = loadConfig();\n" +
        source.slice(factoryBegin, factoryEnd) + "\ncreateSidecarClient();", context);
    assert.equal(received.maxCodexFrameBytes, 8192);
    assert.equal(received.maxIpcBufferBytes, 4096);
});
test("patch artifact contract stays 512 KiB; manifest advertises bounded defaults", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../plugin-manifest.json"), "utf8"));
    assert.equal(manifest.defaults.CODEX_APP_SERVER_MAX_FRAME_BYTES, DEFAULT_FRAME_BYTES);
    assert.equal(manifest.defaults.CODEX_APP_SERVER_IPC_MAX_FRAME_BYTES, DEFAULT_FRAME_BYTES);
    const { MAX_PATCH_BYTES } = require("../appserver/patchValidator");
    assert.equal(MAX_PATCH_BYTES, 524288);
});