"use strict";
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const defer = () => {
let resolve, reject;
const promise = new Promise((a, b) => { resolve = a; reject = b; });
return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
async function runTests(source) {
let count = 0;
function fixture() {
const log = [], meta = new Map(), locks = new Map();
const h = { stop: async () => ({ confirmed: true }), diagnosticFailure: false };
class SidecarError extends Error {
constructor(code, message) { super(message); this.code = code; }
}
const write = (file, value) => {
if (file === "/state") {
if (h.diagnosticFailure) throw Error("mock disk failure");
log.push("state:" + value.status);
return;
}
if (h.diagnosticFailure && !["failed", "completed"].includes(value.state)) throw Error("mock disk failure");
meta.set(file, structuredClone(value));
log.push("meta:" + value.state);
};
const protocol = {
SidecarError, writeJsonAtomic: write,
runtimePaths: () => ({ statePath: "/state", runtime: "/runtime", endpoint: "/endpoint" }),
getLocalProcessIdentityConfirmed: async () => ({ pid: 31, startTime: "mock" }),
ensureDirectory() {}, removeEndpoint() { log.push("endpoint"); },
assertJobId: value => value, getPatchProtocolProof: () => ({}),
verifyPatchArtifactDirectory() {}, inspectPatchArtifactFile() {},
removePatchArtifactExact() { log.push("remove-artifact"); return true; },
updateJobMetaLocked(root, id, file, updater, options = {}) {
const task = (locks.get(id) || Promise.resolve()).then(async () => {
const next = await updater(structuredClone(meta.get(file)));
if (h.beforeWrite) await h.beforeWrite(next);
(options.hooks?.writeJsonAtomic || write)(file, next);
return { updated: true, meta: next };
});
locks.set(id, task.catch(() => {}));
return task;
}
};
class Codex extends EventEmitter {
async start() { if (h.startHook) await h.startHook(this); if (h.startError) throw h.startError; }
stop() { log.push("stop"); return h.stop(); }
async interruptTurn() { log.push("interrupt"); }
}
const patch = {
MAX_PATCH_BYTES: 10000, extractPatchPayload: () => "patch",
assertNoSecrets() {}, parseUnifiedDiff: () => ({ fileCount: 1 }),
createPrivateCandidate: () => ({ candidatePath: "/candidate", candidateIdentity: {} }),
validateTrackedPaths: async () => {},
applyCheck: async () => { if (h.apply) await h.apply.promise; },
publishCandidateNoOverwrite: () => { log.push("publish"); return { publicIdentity: {} }; },
sha256: () => "a".repeat(64)
};
const fakeFs = new Proxy({
mkdirSync() {}, appendFileSync() {},
unlinkSync() { if (h.unlinkError) throw Error("mock unlink failure"); log.push("unlink"); }
}, { get(target, key) { if (key in target) return target[key]; return () => { throw Error("Unexpected fs call"); }; } });
const module = { exports: {} };
const sandbox = {
module, Buffer, setTimeout, clearTimeout, setImmediate,
process: { platform: "win32", pid: 31, cwd: () => "/project" },
require(name) {
if (name === "fs") return fakeFs;
if (name === "events") return { EventEmitter };
if (name === "path") return require("node:path");
if (name === "crypto") return { randomUUID: () => "instance-1", randomBytes: () => ({ toString: () => "mock" }) };
if (name === "net") return { createServer() {
const server = new EventEmitter();
server.listen = () => setImmediate(() => server.emit("listening"));
return server;
} };
if (name === "./protocol") return protocol;
if (name === "./codexAppServerProcess") return { CodexAppServerProcess: Codex };
if (name === "./patchValidator") return patch;
if (name === "./writeRuntimeConfig") return { getWriteProtocolStatus: () => ({}) };
if (["./gitWorktreeAdapter", "./worktreeWriteSession", "./trustedValidationRunner"].includes(name)) return {};
throw Error("Unexpected import");
}
};
vm.runInNewContext(source, sandbox, { filename: "sidecarServer.js" });
const s = Object.create(module.exports.SidecarServer.prototype);
EventEmitter.call(s);
Object.assign(s, {
state: { schemaVersion: 1, instanceId: "instance-1", pid: 31, status: "ready" },
activeJobs: new Map(), seenJobs: new Set(), sockets: new Set(),
paths: protocol.runtimePaths(), jobRoot: "/jobs", pluginDir: "/plugin",
codex: new Codex(), started: true, draining: false, drainTimeoutMs: 15,
cancelTimeoutMs: 100, timeoutGraceMs: 5, patchMetaOptions: {}, patchArtifactHooks: {},
patchGitOptions: {}, _writeValidationProfile: "mock",
_writeValidationRunner: { run: async () => { if (h.validation) return h.validation.promise; return { passed: true }; } }
});
s._closeServer = async () => { log.push("close-server"); };
function add(kind = "analyze") {
const id = kind + (s.activeJobs.size + 1);
const terminal = defer();
const job = {
jobId: id, kind, paths: { metaPath: "/" + id, patchPath: "/public", outputPath: "/events", codexOutputPath: "/output" },
threadId: "thread-" + id, turnId: "turn-" + id, state: "running", terminal: false,
eventChain: Promise.resolve(), terminalPromise: terminal.promise,
turnBoundPromise: Promise.resolve(), setupDone: Promise.resolve(),
resolveTerminal(value) { log.push("terminal:" + id); terminal.resolve(value); },
gitChildren: new Set(), patchChunks: ["patch"], baseline: { baseHead: "mock", baseStatusSha256: "mock" },
baselineMonitor: { async assertStable() {}, async close() { return true; } },
patchArtifactDirectoryIdentity: {}, handle: { worktreePath: "/worktree" },
session: { async verify() {}, async commitCandidate() {
log.push("commit"); return { resultCommit: "mock", resultTree: "mock", changedFiles: [] };
} }
};
meta.set(job.paths.metaPath, { jobId: id, sidecarInstanceId: "instance-1", state: "running" });
s.activeJobs.set(id, job);
return job;
}
function completed(job, status = "completed") {
s._handleNotification({ method: "turn/completed", params: { threadId: job.threadId, turn: { id: job.turnId, status } } });
return job.eventChain;
}
return { s, h, log, meta, add, completed };
}
async function test(name, fn) { await fn(); console.log("ok " + (++count) + " " + name); }
await test("01", async () => {
const { s, h, add, meta, log } = fixture(), d = defer();
const a = add(), b = add(); h.stop = () => d.promise;
const p = s._handleProtocolError({ code: "PROTOCOL_BUFFER_OVERFLOW" });
await tick();
assert.equal(s.activeJobs.size, 2); assert.equal(a.terminal, false);
assert.equal(meta.get(b.paths.metaPath).state, "running");
assert.throws(() => s._codexRequest("startThread", {}), { code: "SIDECAR_NOT_READY" });
d.resolve({ confirmed: true }); await p;
assert.equal(s.activeJobs.size, 0); assert.equal(log.filter(x => x.startsWith("terminal:")).length, 2);
assert.equal(s.state.status, "degraded"); assert(!log.includes("unlink"));
});
await test("02", async () => {
const { s, h, add, meta, log } = fixture(), d = defer(), job = add();
h.stop = () => d.promise; h.diagnosticFailure = true;
const p = s._handleProtocolError({}); await tick();
d.reject({ code: "CODEX_STOP_UNCONFIRMED", message: "discard-me" });
await assert.rejects(p, { code: "CODEX_STOP_UNCONFIRMED" });
await tick();
assert.equal(s.activeJobs.get(job.jobId), job); assert.equal(job.terminal, false);
assert.equal(meta.get(job.paths.metaPath).state, "running"); assert(!log.includes("unlink"));
assert.equal(s.state.stopFault.code, "CODEX_STOP_UNCONFIRMED");
});
await test("03", async () => {
const { s, h, add, log } = fixture(); add();
let p; h.stop = () => {
assert.equal(s._handleCodexClosed({ intentional: true }), p);
assert.equal(s._handleProtocolError({}), p);
return { confirmed: true };
};
p = s._handleProtocolError({});
assert.equal(s._handleProtocolError({}), p); await p;
assert.equal(log.filter(x => x === "stop").length, 1);
});
await test("04", async () => {
const { s, h, add } = fixture(); add(); s.codex.closed = true;
h.stop = async () => ({ confirmed: false });
await assert.rejects(s._handleCodexClosed(), { code: "CODEX_STOP_UNCONFIRMED" });
assert.equal(s.activeJobs.size, 1);
});
await test("05", async () => {
const { s, h, add, log } = fixture(), d = defer(), job = add();
const cancel = s._cancel({ jobId: job.jobId });
await tick();
h.stop = () => d.promise; const p = s._handleProtocolError({});
const finish = s._finishJob(job, "timeout", null, "JOB_TIMEOUT", "JOB_TIMEOUT");
s._handleTimeout(job); await tick();
assert.equal(job.terminal, false); assert.equal(s.activeJobs.size, 1);
d.resolve({ confirmed: true }); await Promise.all([p, finish, cancel]);
assert.equal(log.filter(x => x.startsWith("terminal:")).length, 1);
});
await test("06", async () => {
const { s, h, add, log } = fixture(), d = defer(); add(); h.stop = () => d.promise;
const p = s.shutdown(); assert.equal(s.shutdown(), p); await tick();
d.reject({ code: "CODEX_STOP_FAILED" }); await assert.rejects(p, { code: "CODEX_STOP_FAILED" });
assert(!log.includes("unlink")); assert.equal(s.activeJobs.size, 1);
h.stop = async () => ({ confirmed: true });
const retry = s.shutdown(); await retry;
assert.equal(s.shutdown(), retry); assert.equal(s.state.status, "closed");
assert(log.indexOf("close-server") > log.findIndex(x => x.startsWith("terminal:")));
assert(log.indexOf("unlink") > log.indexOf("close-server"));
s._handleCodexClosed(); assert.equal(s.state.status, "closed");
assert.equal(log.filter(x => x === "stop").length, 2);
});
await test("07", async () => {
const { s, h, log } = fixture(); h.unlinkError = true;
await assert.rejects(s.shutdown(), { code: "SIDECAR_CLEANUP_FAILED" });
assert.equal(s.state.status, "degraded");
h.unlinkError = false; await s.shutdown();
assert.equal(log.filter(x => x === "stop").length, 1);
});
await test("08", async () => {
const { s, h, log } = fixture(); s.started = false; s.state = null;
h.startError = Error("mock initialization failure");
h.stop = async () => { throw { code: "CODEX_STOP_UNCONFIRMED" }; };
await assert.rejects(s.start(), { code: "CODEX_STOP_UNCONFIRMED" });
assert.equal(s.state.status, "degraded"); assert(!log.includes("unlink"));
h.stop = async () => ({ confirmed: true }); await s.shutdown();
});
await test("09", async () => {
const { s, add, log } = fixture(), job = add("write"), setup = defer();
job.setupDone = setup.promise;
await assert.rejects(s._handleProtocolError({}), { code: "SIDECAR_RESOURCES_UNCONFIRMED" });
assert.equal(job.terminal, false); assert(!log.includes("unlink"));
setup.resolve(); await tick(); await s.shutdown(); assert.equal(s.activeJobs.size, 0);
});
await test("10", async () => {
const { s, h, add, completed, log } = fixture(), job = add("write");
h.validation = defer(); completed(job); await tick();
await assert.rejects(s.shutdown(), { code: "SIDECAR_RESOURCES_UNCONFIRMED" });
assert.equal(job.finalizing, true); assert(!log.includes("commit")); assert(!log.includes("unlink"));
h.validation.resolve({ passed: true }); await job.eventChain; await s.shutdown();
assert(job.candidateResult); assert(job.session); assert(!log.includes("remove-artifact"));
assert.equal(log.filter(x => x === "stop").length, 1);
});
await test("11", async () => {
const { s, h, add, completed, meta } = fixture(), job = add("write");
h.validation = defer(); completed(job); await tick();
const stop = s._handleProtocolError({});
h.validation.resolve({ passed: false }); await assert.rejects(stop, { code: "SIDECAR_RESOURCES_UNCONFIRMED" });
assert.equal(s.activeJobs.get(job.jobId), job); assert(job.session);
assert.equal(meta.get(job.paths.metaPath).state, "running");
});
await test("12", async () => {
const { s, h, add, completed, log } = fixture(), job = add("patch");
h.apply = defer(); completed(job); await tick();
await assert.rejects(s.shutdown(), { code: "SIDECAR_RESOURCES_UNCONFIRMED" });
assert.equal(job.finalizing, true); assert(!log.includes("unlink"));
h.apply.resolve(); await job.eventChain; await s.shutdown();
assert(log.includes("publish")); assert.equal(job.state, "completed");
});

return count;
}
module.exports={runTests};
