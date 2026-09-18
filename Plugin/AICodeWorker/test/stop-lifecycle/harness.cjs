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
function createHarness(source) {
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
if (name === "./frameTransport") return require("../../appserver/frameTransport");
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

return {fixture,defer,tick};
}
module.exports={createHarness};
