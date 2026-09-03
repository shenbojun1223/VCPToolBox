"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const { SidecarClient } = require("../appserver/sidecarClient");
const {
    SidecarError,
    runtimePaths,
    jobPaths,
    writeJsonAtomic,
    readJsonOrNull,
    isPidAlive,
    getProcessIdentity,
    sameProcessIdentity,
    terminateOwnedChild,
    reconcileDeadSidecarJobs,
    updateJobMetaLocked,
    metaLockPath,
    withJobMetaLock,
    terminateExactPid,
    getLocalProcessIdentityConfirmed,
    createJsonExclusive,
    pinPatchArtifactDirectory,
    createPatchArtifactNonce,
    patchCandidatePath,
    inspectAuthorizedPatchArtifact,
    getPatchProtocolProof
} = require("../appserver/protocol");
const { captureGitBaseline, startGitBaselineMonitor, sha256 } = require("../appserver/patchValidator");
const { CodexAppServerProcess } = require("../appserver/codexAppServerProcess");
const { JsonLineRpcConnection } = require("../appserver/jsonLineRpcConnection");
const { SidecarServer } = require("../appserver/sidecarServer");

const fixturePath = path.join(__dirname, "fixtures", "fake-codex-app-server.js");
const entryPath = path.join(__dirname, "..", "appserver", "sidecar-entry.js");
const nodeExecutable = process.execPath;

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function deterministicLocalIdentity() {
    return { pid: process.pid, startTime: "test-local-process" };
}

async function waitFor(predicate, timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await delay(25);
    }
    throw new Error("timed out waiting for test condition");
}

async function removeTestRoot(tempRoot, label) {
    let lastError = null;
    for (let attempt = 0; attempt < 10; attempt++) {
        try {
            fs.rmSync(tempRoot, {
                recursive: true,
                force: true,
                maxRetries: 5,
                retryDelay: 100
            });
        } catch (error) {
            lastError = error;
        }
        if (!fs.existsSync(tempRoot)) return;
        await delay(100);
    }
    throw new Error(`${label} cleanup left its tempRoot: ${tempRoot}${lastError ? ` (${lastError.code || lastError.message})` : ""}`);
}

async function listenIpcFixture(endpoint, responseFactory) {
    const server = net.createServer(socket => {
        let buffer = "";
        socket.setEncoding("utf8");
        socket.on("data", chunk => {
            buffer += chunk;
            const newline = buffer.indexOf("\n");
            if (newline === -1) return;
            const line = buffer.slice(0, newline);
            let request;
            try { request = JSON.parse(line); } catch { socket.end("not-json\n"); return; }
            const response = responseFactory(request);
            socket.end(`${typeof response === "string" ? response : JSON.stringify(response)}\n`);
        });
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint, resolve);
    });
    return server;
}

async function listenRawIpcFixture(endpoint, responseFactory) {
    const server = net.createServer(socket => {
        let request = "";
        let responded = false;
        socket.setEncoding("utf8");
        socket.on("data", chunk => {
            if (responded) return;
            request += chunk;
            if (!request.includes("\n")) return;
            responded = true;
            socket.end(responseFactory(request));
        });
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint, resolve);
    });
    return server;
}

function requestRawIpc(endpoint, payload) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(endpoint);
        let output = "";
        let settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            if (error) reject(error); else resolve(value);
        };
        socket.setEncoding("utf8");
        socket.setTimeout(3000, () => {
            socket.destroy();
            finish(new Error("raw IPC fixture timed out"));
        });
        socket.on("data", chunk => { output += chunk; });
        socket.once("error", error => finish(error));
        socket.once("close", () => finish(null, { output }));
        socket.once("connect", () => socket.end(payload));
    });
}

async function closeIpcFixture(server) {
    if (!server || !server.listening) return;
    await new Promise((resolve, reject) => {
        server.close(error => {
            if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
            else resolve();
        });
    });
}

function createMeta(jobRoot, jobId, extra = {}) {
    const paths = jobPaths(jobRoot, jobId);
    fs.mkdirSync(path.join(jobRoot, "meta"), { recursive: true });
    fs.mkdirSync(path.join(jobRoot, "output"), { recursive: true });
    writeJsonAtomic(paths.metaPath, { jobId, state: "queued", userField: "preserve-me", ...extra });
    return paths;
}

function gitFixture(cwd, args) {
    const result = spawnSync("git", args, {
        cwd,
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }
    });
    assert.equal(result.status, 0, `fixture git ${args[0]} failed without exposing stderr`);
    return String(result.stdout || "").trim();
}

function initializeGitProject(projectRoot, files = { "tracked.txt": "alpha\nbeta\n" }) {
    gitFixture(projectRoot, ["init", "--quiet"]);
    for (const [relative, content] of Object.entries(files)) {
        const target = path.join(projectRoot, ...relative.split("/"));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, "utf8");
    }
    gitFixture(projectRoot, ["add", "--", "."]);
    gitFixture(projectRoot, ["-c", "user.name=AICW Test", "-c", "user.email=aicw@example.invalid", "commit", "--quiet", "-m", "baseline"]);
}

function validPatch(replacement = "gamma", relative = "tracked.txt") {
    return [
        `diff --git a/${relative} b/${relative}`,
        "index fbbee86..0000000 100644",
        `--- a/${relative}`,
        `+++ b/${relative}`,
        "@@ -1,2 +1,2 @@",
        " alpha",
        "-beta",
        `+${replacement}`,
        ""
    ].join("\n");
}

function stateFixture(environment, extra = {}) {
    return {
        schemaVersion: 1,
        instanceId: "fixture-instance",
        controlToken: "fixture-token",
        pid: 2147483647,
        endpoint: environment.paths?.endpoint || runtimePaths(environment.pluginDir, environment.jobRoot).endpoint,
        status: "ready",
        ...extra
    };
}

async function createDirectPatchFinalizeFixture(options = {}) {
    const environment = await createEnvironment({ gitProject: true });
    const jobId = options.jobId || `job_direct_patch_${crypto.randomBytes(4).toString("hex")}`;
    fs.mkdirSync(environment.jobRoot, { recursive: true });
    const patchArtifactDirectoryIdentity = pinPatchArtifactDirectory(environment.jobRoot, { create: true });
    const patchArtifactNonce = createPatchArtifactNonce();
    const instanceId = "direct-patch-instance";
    const paths = createMeta(environment.jobRoot, jobId, {
        state: "running",
        executionBackend: "codex-app-server",
        sidecarInstanceId: instanceId,
        jobKind: "patch",
        jobPhase: "running",
        patchValidated: false,
        applyCheckPassed: false,
        baselineStable: false,
        patchArtifactNonce,
        patchArtifactDirectoryIdentity
    });
    const baseline = await captureGitBaseline(environment.projectRoot);
    const baselineMonitor = options.realBaselineMonitor
        ? startGitBaselineMonitor(environment.projectRoot, baseline, {
            intervalMs: 60000,
            watch() {
                const watcher = new EventEmitter();
                watcher.close = () => {};
                return watcher;
            }
        })
        : {
            async assertStable() { return true; },
            async close() {
                if (options.closeFailure) return false;
                return true;
            }
        };
    const server = new SidecarServer({
        pluginDir: environment.pluginDir,
        jobRoot: environment.jobRoot,
        patchArtifactHooks: options.patchArtifactHooks || {},
        patchMetaOptions: options.patchMetaOptions || {}
    });
    server.state = { status: "ready", instanceId, pid: process.pid };
    const terminalPromise = new Promise(resolve => { server._directResolveTerminal = resolve; });
    const job = {
        jobId,
        kind: "patch",
        projectPath: environment.projectRoot,
        paths,
        patchChunks: [options.patchText || validPatch("direct-finalize")],
        patchCollectionError: null,
        patchInputBytes: 0,
        outputBytes: 0,
        baseline,
        baselineMonitor,
        candidatePath: null,
        candidateIdentity: null,
        publicPublished: false,
        publicIdentity: null,
        publishedSha256: null,
        patchArtifactNonce,
        patchArtifactDirectoryIdentity,
        gitChildren: new Set(),
        timeoutTimer: null,
        timeoutFinalizeTimer: null,
        cancelTimeoutTimer: null,
        terminalClaim: "validation",
        finalizing: true,
        terminal: false,
        state: "running",
        terminalPromise,
        resolveTerminal: server._directResolveTerminal
    };
    server.activeJobs.set(jobId, job);
    return {
        environment,
        server,
        job,
        paths,
        patchArtifactDirectoryIdentity,
        patchArtifactNonce,
        async finalize() {
            try { await server._finalizePatch(job); } catch {}
            return readJsonOrNull(paths.metaPath);
        }
    };
}

async function createEnvironment(options = {}) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-aicodeworker-sidecar-"));
    const pluginDir = path.join(tempRoot, "plugin");
    const jobRoot = path.join(pluginDir, "jobs");
    let projectRoot = path.join(tempRoot, "project");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    projectRoot = fs.realpathSync.native(projectRoot);
    if (options.gitProject) initializeGitProject(projectRoot, options.gitFiles);
    const fakeRecordPath = path.join(tempRoot, "fake-codex-record.jsonl");
    const codexGlobalArgs = [
        fixturePath,
        `--fake-record-base64=${Buffer.from(fakeRecordPath, "utf8").toString("base64")}`,
        ...(options.fakeVersion ? [`--fake-version=${options.fakeVersion}`] : [])
    ];
    const clientOptions = {
        pluginDir,
        jobRoot,
        entryPath,
        codexBin: nodeExecutable,
        codexGlobalArgs,
        maxConcurrency: options.maxConcurrency || 2,
        startupTimeoutMs: 10000,
        requestTimeoutMs: 5000,
        connectTimeoutMs: 750,
        cancelTimeoutMs: 2500,
        startingTimeoutMs: options.startingTimeoutMs,
        testStartupDelayMs: options.testStartupDelayMs
    };
    const client = new SidecarClient(clientOptions);
    const environment = {
        tempRoot,
        pluginDir,
        jobRoot,
        projectRoot,
        fakeRecordPath,
        codexGlobalArgs,
        client,
        paths: runtimePaths(pluginDir, jobRoot),
        async submit(jobId, text, projectPath = projectRoot, submitOptions = {}) {
            const paths = createMeta(jobRoot, jobId, submitOptions.meta || {});
            return client.submitAnalyzeJob({
                jobId,
                projectPath,
                text,
                metaPath: paths.metaPath,
                outputPath: paths.outputPath,
                codexOutputPath: paths.codexOutputPath,
                ...(Object.prototype.hasOwnProperty.call(submitOptions, "timeoutSec") ? { timeoutSec: submitOptions.timeoutSec } : {})
            });
        },
        async waitJob(jobId) {
            const metaPath = jobPaths(jobRoot, jobId).metaPath;
            await waitFor(() => {
                const meta = readJsonOrNull(metaPath);
                return Boolean(meta && ["completed", "cancelled", "failed", "timeout"].includes(meta.state));
            });
            return JSON.parse(fs.readFileSync(metaPath, "utf8"));
        },
        async submitPatch(jobId, patchText, controls = "", submitOptions = {}) {
            const paths = createMeta(jobRoot, jobId, submitOptions.meta || {});
            return client.submitPatchJob({
                jobId,
                projectPath: submitOptions.projectPath || projectRoot,
                text: `[[FINAL_BASE64=${Buffer.from(patchText, "utf8").toString("base64")}]]${controls}`,
                model: submitOptions.model || "gpt-5-codex",
                effort: submitOptions.effort || "high",
                ...(Object.prototype.hasOwnProperty.call(submitOptions, "timeoutSec") ? { timeoutSec: submitOptions.timeoutSec } : {}),
                ...paths
            });
        },
        readFakeRecords() {
            if (!fs.existsSync(fakeRecordPath)) return [];
            return fs.readFileSync(fakeRecordPath, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
        },
        async close() {
            let state = readJsonOrNull(this.paths.statePath);
            const pids = new Set([state?.pid, state?.codexPid].filter(Boolean));
            const identities = new Map([
                [state?.pid, state?.processIdentity],
                [state?.codexPid, state?.codexProcessIdentity]
            ]);
            if (state && isPidAlive(state.pid)) {
                try { await this.client.shutdown(); } catch {}
            }
            try { await waitFor(() => !fs.existsSync(this.paths.statePath), 4000); } catch {}
            for (const pid of pids) {
                const identity = identities.get(pid);
                if (isPidAlive(pid) && identity && sameProcessIdentity(identity, getProcessIdentity(pid))) {
                    terminateExactPid(pid, true);
                }
            }
            await delay(100);
            await removeTestRoot(this.tempRoot, "sidecar fixture");
        }
    };
    return environment;
}

function clientFor(environment, options = {}) {
    return new SidecarClient({
        pluginDir: environment.pluginDir,
        jobRoot: environment.jobRoot,
        entryPath,
        codexBin: nodeExecutable,
        codexGlobalArgs: environment.codexGlobalArgs || [fixturePath],
        startupTimeoutMs: 10000,
        requestTimeoutMs: 5000,
        connectTimeoutMs: 750,
        ...options
    });
}

async function spawnDetachedStarting(environment, delayMs) {
    const starter = clientFor(environment, { testStartupDelayMs: delayMs });
    fs.mkdirSync(environment.paths.runtime, { recursive: true });
    const lock = starter._tryAcquireLock();
    assert.ok(lock);
    const child = starter._spawnSidecar();
    starter._releaseLock(lock);
    await waitFor(() => readJsonOrNull(environment.paths.statePath)?.status === "starting", 5000);
    return { starter, child };
}

function assertSafeInspection(result) {
    for (const field of ["controlToken", "endpoint", "processIdentity", "codexBin"]) {
        assert.equal(Object.prototype.hasOwnProperty.call(result, field), false, `inspection exposed ${field}`);
    }
}

test("inspectNoStart absent does not spawn", async () => {
    const environment = await createEnvironment();
    try {
        const result = await environment.client.inspectNoStart();
        assert.equal(result.status, "absent");
        assert.equal(environment.client.sidecarChild, null);
        assertSafeInspection(result);
    } finally { await environment.close(); }
});

test("inspectNoStart observes ready without exposing secrets", async () => {
    const environment = await createEnvironment();
    try {
        const state = await environment.client.ensure();
        const result = await environment.client.inspectNoStart();
        assert.equal(result.status, "ready");
        assert.equal(result.instanceId, state.instanceId);
        assert.equal(result.pid, state.pid);
        assert.equal(result.activeJobs, 0);
        assert.equal(result.maxConcurrency, 2);
        assertSafeInspection(result);
    } finally { await environment.close(); }
});

test("inspectNoStart live state wins over stale parent lock", async () => {
    const environment = await createEnvironment();
    try {
        const state = await environment.client.ensure();
        writeJsonAtomic(environment.paths.lockPath, {
            ownerToken: "dead-parent", pid: 2147483647,
            processIdentity: { pid: 2147483647, startTime: "dead" }, createdAt: Date.now() - 10000
        });
        const result = await environment.client.inspectNoStart();
        assert.equal(result.status, "ready");
        assert.equal(result.pid, state.pid);
        assert.deepEqual(result.warnings, ["SIDECAR_STARTUP_LOCK_STALE"]);
        assert.equal(fs.existsSync(environment.paths.lockPath), true);
        assertSafeInspection(result);
    } finally { await environment.close(); }
});

test("inspectNoStart malformed state fails closed", async () => {
    const environment = await createEnvironment();
    try {
        fs.mkdirSync(environment.paths.runtime, { recursive: true });
        fs.writeFileSync(environment.paths.statePath, "{malformed", "utf8");
        const result = await environment.client.inspectNoStart();
        assert.equal(result.status, "error");
        assert.equal(result.errorCode, "SIDECAR_STATE_INVALID");
        assert.equal(environment.client.sidecarChild, null);
        assertSafeInspection(result);
    } finally { await environment.close(); }
});

test("reconcileDeadInstance never starts a replacement", async () => {
    const environment = await createEnvironment();
    try {
        const state = await environment.client.ensure();
        const result = await environment.client.reconcileDeadInstance();
        assert.equal(result.status, "ready");
        assert.equal(result.pid, state.pid);
        assert.equal(environment.client.sidecarChild.pid, state.pid);
        assert.equal(isPidAlive(state.pid), true);
        assertSafeInspection(result);
    } finally { await environment.close(); }
});

test("reconcileDeadInstance reconciles confirmed dead state", async () => {
    const environment = await createEnvironment();
    try {
        const oldState = stateFixture(environment, { instanceId: "dead-instance", controlToken: "dead-token" });
        writeJsonAtomic(environment.paths.statePath, oldState);
        const result = await environment.client.reconcileDeadInstance();
        assert.equal(result.status, "absent");
        assert.equal(result.reconciled, true);
        assert.equal(fs.existsSync(environment.paths.statePath), false);
        assert.equal(environment.client.sidecarChild, null);
    } finally { await environment.close(); }
});

test("getLocalProcessIdentityConfirmed retries null and caches only success", async () => {
    const identity = deterministicLocalIdentity();
    let calls = 0;
    const identityProvider = () => {
        calls++;
        return calls < 3 ? null : identity;
    };
    assert.deepEqual(await getLocalProcessIdentityConfirmed({ identityProvider, delay: 25, timeoutMs: 200 }), identity);
    assert.equal(calls, 3);
    assert.deepEqual(await getLocalProcessIdentityConfirmed({ identityProvider, delay: 25, timeoutMs: 50 }), identity);
    assert.equal(calls, 3);
});

test("confirmed local identity timeout fails closed", async () => {
    let calls = 0;
    const identityProvider = () => { calls++; return null; };
    await assert.rejects(
        getLocalProcessIdentityConfirmed({ identityProvider, delay: 25, timeoutMs: 55 }),
        error => error.code === "LOCAL_PROCESS_IDENTITY_UNAVAILABLE"
    );
    assert.ok(calls >= 2);
});

test("startup lock creation uses one confirmed identity", async () => {
    const environment = await createEnvironment();
    try {
        const identity = deterministicLocalIdentity();
        let calls = 0;
        const identityProvider = () => { calls++; return identity; };
        const client = clientFor(environment, { processIdentity: null, identityProvider, identityDelay: 25 });
        fs.mkdirSync(environment.paths.runtime, { recursive: true });
        await client._ensureLocalProcessIdentity();
        const lock = client._tryAcquireLock();
        assert.ok(lock);
        assert.deepEqual(lock.record.processIdentity, identity);
        assert.equal(calls, 1);
        client._releaseLock(lock);
    } finally { await environment.close(); }
});

test("meta lock creation uses confirmed identity without second provider call", async () => {
    const environment = await createEnvironment();
    try {
        const identity = deterministicLocalIdentity();
        let calls = 0;
        const identityProvider = () => { calls++; return identity; };
        assert.deepEqual(await getLocalProcessIdentityConfirmed({ identityProvider, delay: 25 }), identity);
        await withJobMetaLock(environment.jobRoot, "job_meta_confirmed_identity", async ({ lockPath }) => {
            assert.deepEqual(readJsonOrNull(lockPath).processIdentity, identity);
        }, { identityProvider, delay: 25 });
        assert.equal(calls, 1);
    } finally { await environment.close(); }
});

test("Sidecar start writes non-null local identity", async () => {
    const environment = await createEnvironment();
    const identity = deterministicLocalIdentity();
    const identityProvider = () => identity;
    const server = new SidecarServer({
        pluginDir: environment.pluginDir,
        jobRoot: environment.jobRoot,
        codexBin: nodeExecutable,
        codexGlobalArgs: [fixturePath],
        identityProvider,
        identityDelay: 25
    });
    try {
        await server.start();
        const state = readJsonOrNull(environment.paths.statePath);
        assert.deepEqual(state.processIdentity, identity);
        assert.ok(state.processIdentity);
    } finally {
        try {
            await server.shutdown();
        } finally {
            await environment.close();
        }
    }
});

test("Sidecar status returns the exact patch protocol proof", async () => {
    const environment = await createEnvironment();
    const server = new SidecarServer({
        pluginDir: environment.pluginDir,
        jobRoot: environment.jobRoot,
        maxConcurrency: 2
    });
    server.state = { status: "ready", instanceId: "proof-instance", pid: process.pid, codexPid: null };
    try {
        const status = server.status();
        assert.deepEqual({
            patchProtocolSupported: status.patchProtocolSupported,
            patchContractVersion: status.patchContractVersion,
            patchMaxBytes: status.patchMaxBytes,
            patchRepositoryPolicy: status.patchRepositoryPolicy,
            patchOperations: status.patchOperations
        }, getPatchProtocolProof());
        assert.equal(status.status, "ready");
        assert.equal(status.maxConcurrency, 2);
        assert.equal(status.instanceId, "proof-instance");
        assert.equal(status.pid, process.pid);
        assert.equal(status.codexPid, null);
        assert.ok(Array.isArray(status.activeJobs));
    } finally { await environment.close(); }
});

test("SidecarClient inspection and status preserve the exact patch protocol proof", async () => {
    const environment = await createEnvironment();
    try {
        const state = await environment.client.ensure();
        const inspection = await environment.client.inspectNoStart();
        const status = await environment.client.status();
        for (const projected of [state, inspection, status]) {
            assert.deepEqual({
                patchProtocolSupported: projected.patchProtocolSupported,
                patchContractVersion: projected.patchContractVersion,
                patchMaxBytes: projected.patchMaxBytes,
                patchRepositoryPolicy: projected.patchRepositoryPolicy,
                patchOperations: projected.patchOperations
            }, getPatchProtocolProof());
        }
        assert.equal(inspection.status, "ready");
        assert.equal(status.status, "ready");
        assert.equal(status.maxConcurrency, 2);
        assert.equal(status.instanceId, state.instanceId);
        assert.equal(status.pid, state.pid);
        assert.ok(Array.isArray(status.activeJobs));
    } finally { await environment.close(); }
});

test("old Sidecar status without patch proof remains unknown and cannot be upgraded", async () => {
    const environment = await createEnvironment();
    const oldEndpoint = process.platform === "win32"
        ? `\\\\.\\pipe\\vcp-aicodeworker-old-${process.pid}-${Date.now()}`
        : path.join(environment.tempRoot, "old-sidecar.sock");
    const client = clientFor(environment);
    client._inspectStateProcess = () => ({ alive: true, confirmed: true, mismatch: false, unknown: false });
    const oldState = stateFixture(environment, {
        pid: 2147483647,
        endpoint: oldEndpoint,
        status: "ready"
    });
    writeJsonAtomic(environment.paths.statePath, oldState);
    const fixture = await listenIpcFixture(oldEndpoint, request => ({
        requestId: request.requestId,
        ok: true,
        result: {
            instanceId: oldState.instanceId,
            status: "ready",
            pid: oldState.pid,
            codexPid: null,
            activeJobs: [],
            maxConcurrency: 2
        }
    }));
    try {
        const status = await client.status();
        const inspection = await client.inspectNoStart();
        for (const projected of [status, inspection]) {
            assert.equal(projected.patchProtocolSupported, "unknown");
            assert.equal(projected.patchContractVersion, null);
            assert.equal(projected.patchMaxBytes, null);
            assert.equal(projected.patchRepositoryPolicy, null);
            assert.equal(projected.patchOperations, null);
        }
        assert.equal(status.status, "ready");
        assert.equal(status.maxConcurrency, 2);
        assert.equal(inspection.activeJobs, 0);
        assertSafeInspection(inspection);
    } finally {
        await closeIpcFixture(fixture);
        await environment.close();
    }
});

test("existing live starting Sidecar can be observed before caller local identity is acquired", async () => {
    const environment = await createEnvironment();
    try {
        const { child } = await spawnDetachedStarting(environment, 650);
        let calls = 0;
        const observer = clientFor(environment, {
            processIdentity: null,
            identityProvider: () => { calls++; throw new Error("local identity must not be requested"); },
            startingTimeoutMs: 4000
        });
        const state = await observer.ensure();
        assert.equal(state.pid, child.pid);
        assert.equal(state.status, "ready");
        assert.equal(calls, 0);
    } finally { await environment.close(); }
});

test("initialization includes required fields and tolerates unknown notifications/server requests", async () => {
    const environment = await createEnvironment();
    try {
        const state = await environment.client.ensure();
        assert.equal(state.codexVersion, "codex-cli 0.144.5");
        const accepted = await environment.submit("job_protocol", "[[SERVER_REQUEST]][[FINAL=protocol-ok]]");
        assert.equal(accepted.accepted, true);
        const meta = await environment.waitJob("job_protocol");
        assert.equal(meta.state, "completed");
        const output = fs.readFileSync(jobPaths(environment.jobRoot, "job_protocol").outputPath, "utf8");
        assert.match(output, /"source":"codex-app-server"/);
        assert.match(fs.readFileSync(jobPaths(environment.jobRoot, "job_protocol").codexOutputPath, "utf8"), /protocol-ok/);
        assert.equal((await environment.client.status()).status, "ready");
    } finally { await environment.close(); }
});

test("submitPatchJob publishes only a validated patch with exact read-only fields and preserves analyze", async () => {
    const environment = await createEnvironment({ gitProject: true });
    const patch = validPatch("patch-smoke-value");
    try {
        const accepted = await environment.submitPatch("job_patch_smoke", patch);
        assert.equal(accepted.accepted, true);
        assert.equal(JSON.stringify(accepted).includes("diff --git"), false);
        const meta = await environment.waitJob("job_patch_smoke");
        const paths = jobPaths(environment.jobRoot, "job_patch_smoke");
        assert.equal(meta.state, "completed", `patch smoke terminal meta: ${JSON.stringify({ state: meta.state, errorCode: meta.errorCode, jobPhase: meta.jobPhase })}`);
        assert.equal(meta.jobKind, "patch");
        assert.equal(meta.jobPhase, "completed");
        assert.equal(meta.patchValidated, true);
        assert.equal(meta.applyCheckPassed, true);
        assert.equal(meta.baselineStable, true);
        assert.equal(meta.patchContractVersion, 1);
        assert.equal(meta.sandboxMode, "read-only");
        assert.equal(meta.approvalPolicy, "never");
        assert.equal(meta.patchBytes, Buffer.byteLength(patch));
        assert.equal(meta.patchFileCount, 1);
        assert.equal(fs.readFileSync(paths.patchPath, "utf8"), patch);
        assert.equal(fs.readFileSync(path.join(environment.projectRoot, "tracked.txt"), "utf8"), "alpha\nbeta\n");
        assert.equal(fs.existsSync(paths.codexOutputPath), false);
        assert.equal(fs.readFileSync(paths.outputPath, "utf8").includes("diff --git"), false);
        assert.equal(JSON.stringify(meta).includes("diff --git"), false);
        assert.equal(JSON.stringify(meta).includes("candidate"), false);

        const records = environment.readFakeRecords();
        const thread = records.find(record => record.method === "thread/start");
        const turn = records.find(record => record.method === "turn/start");
        assert.deepEqual(thread.params, {
            cwd: environment.projectRoot,
            ephemeral: true,
            sandbox: "read-only",
            approvalPolicy: "never",
            model: "gpt-5-codex"
        });
        assert.deepEqual(turn.params, {
            threadId: accepted.threadId,
            cwd: environment.projectRoot,
            sandboxPolicy: { type: "readOnly", networkAccess: false },
            approvalPolicy: "never",
            model: "gpt-5-codex",
            effort: "high",
            inputTypes: ["text"]
        });

        await environment.submit("job_analyze_after_patch", "[[FINAL=analyze-ok]]");
        assert.equal((await environment.waitJob("job_analyze_after_patch")).state, "completed");
        assert.equal(fs.readFileSync(jobPaths(environment.jobRoot, "job_analyze_after_patch").codexOutputPath, "utf8"), "analyze-ok");
        const analyzeTurn = environment.readFakeRecords().filter(record => record.method === "turn/start").at(-1);
        assert.deepEqual(analyzeTurn.params, {
            threadId: analyzeTurn.params.threadId,
            inputTypes: ["text"]
        });
        for (const field of ["cwd", "sandboxPolicy", "approvalPolicy", "model", "effort"]) {
            assert.equal(Object.prototype.hasOwnProperty.call(analyzeTurn.params, field), false);
        }
    } finally { await environment.close(); }
});

test("Codex transport workspace-write sends fixed thread and turn sandbox fields", async () => {
    const environment = await createEnvironment();
    const codex = new CodexAppServerProcess({
        codexBin: nodeExecutable,
        codexGlobalArgs: environment.codexGlobalArgs,
        cwd: environment.projectRoot,
        requestTimeoutMs: 5000
    });
    try {
        await codex.start();
        const writeThread = await codex.startThread({
            projectPath: environment.projectRoot,
            model: "gpt-5-codex-write",
            writeMode: true
        });
        await codex.startTurn({
            threadId: writeThread.id,
            text: "workspace-write",
            effort: "medium",
            projectPath: environment.projectRoot,
            model: "gpt-5-codex-write",
            writeMode: true
        });

        const records = environment.readFakeRecords();
        assert.deepEqual(records.find(record => record.method === "thread/start")?.params, {
            cwd: environment.projectRoot,
            ephemeral: true,
            sandbox: "workspace-write",
            approvalPolicy: "never",
            model: "gpt-5-codex-write"
        });
        assert.deepEqual(records.find(record => record.method === "turn/start")?.params, {
            threadId: writeThread.id,
            cwd: environment.projectRoot,
            sandboxPolicy: {
                type: "workspaceWrite",
                writableRoots: [environment.projectRoot],
                networkAccess: false
            },
            approvalPolicy: "never",
            model: "gpt-5-codex-write",
            effort: "medium",
            inputTypes: ["text"]
        });

        const analyzeThread = await codex.startThread({
            projectPath: environment.projectRoot,
            model: "gpt-5-codex-analyze"
        });
        await codex.startTurn({
            threadId: analyzeThread.id,
            text: "default-analyze",
            projectPath: environment.projectRoot,
            model: "gpt-5-codex-analyze"
        });
        const analyzeRecords = environment.readFakeRecords();
        assert.deepEqual(analyzeRecords.filter(record => record.method === "thread/start").at(-1)?.params, {
            cwd: environment.projectRoot,
            ephemeral: true,
            sandbox: "read-only",
            approvalPolicy: "never",
            model: "gpt-5-codex-analyze"
        });
        assert.deepEqual(analyzeRecords.filter(record => record.method === "turn/start").at(-1)?.params, {
            threadId: analyzeThread.id,
            inputTypes: ["text"]
        });
    } finally {
        await codex.stop();
        await environment.close();
    }
});

test("Codex transport workspace-write rejects conflicts and invalid project paths before RPC", async () => {
    const environment = await createEnvironment();
    const codex = new CodexAppServerProcess({
        codexBin: nodeExecutable,
        codexGlobalArgs: environment.codexGlobalArgs,
        cwd: environment.projectRoot,
        requestTimeoutMs: 5000
    });
    try {
        await codex.start();
        const rpcCount = () => environment.readFakeRecords().length;
        const before = rpcCount();

        await assert.rejects(codex.startTurn({
            threadId: "thread-not-sent",
            text: "not-sent",
            patchMode: true,
            writeMode: true,
            projectPath: environment.projectRoot
        }), error => error instanceof SidecarError && error.code === "CODEX_MODE_CONFLICT");
        await assert.rejects(codex.startThread({ writeMode: true }),
            error => error instanceof SidecarError && error.code === "CODEX_WRITE_PROJECT_PATH_INVALID");
        await assert.rejects(codex.startThread({ projectPath: "relative-project", writeMode: true }),
            error => error instanceof SidecarError && error.code === "CODEX_WRITE_PROJECT_PATH_INVALID");
        await assert.rejects(codex.startTurn({ threadId: "thread-not-sent", writeMode: true }),
            error => error instanceof SidecarError && error.code === "CODEX_WRITE_PROJECT_PATH_INVALID");
        await assert.rejects(codex.startTurn({
            threadId: "thread-not-sent",
            projectPath: "relative-project",
            writeMode: true
        }), error => error instanceof SidecarError && error.code === "CODEX_WRITE_PROJECT_PATH_INVALID");

        assert.equal(rpcCount(), before);
    } finally {
        await codex.stop();
        await environment.close();
    }
});

test("two patch Jobs overlap and share the maxConcurrency=2 budget", async () => {
    const environment = await createEnvironment({ gitProject: true, maxConcurrency: 2 });
    try {
        const [first, second] = await Promise.all([
            environment.submitPatch("job_patch_overlap_a", validPatch("overlap-a"), "[[DELAY_MS=500]]"),
            environment.submitPatch("job_patch_overlap_b", validPatch("overlap-b"), "[[DELAY_MS=500]]")
        ]);
        assert.notEqual(first.threadId, second.threadId);
        assert.equal((await environment.client.status()).activeJobs.length, 2);
        const [a, b] = await Promise.all([
            environment.waitJob("job_patch_overlap_a"),
            environment.waitJob("job_patch_overlap_b")
        ]);
        assert.equal(a.patchValidated, true);
        assert.equal(b.patchValidated, true);
    } finally { await environment.close(); }
});

test("analyze and patch share capacity and reject a third Job without touching its meta", async () => {
    const environment = await createEnvironment({ gitProject: true, maxConcurrency: 2 });
    try {
        await Promise.all([
            environment.submit("job_mixed_analyze", "[[DELAY_MS=600]][[FINAL=analyze]]"),
            environment.submitPatch("job_mixed_patch", validPatch("mixed"), "[[DELAY_MS=600]]")
        ]);
        const third = createMeta(environment.jobRoot, "job_mixed_third");
        const before = fs.readFileSync(third.metaPath, "utf8");
        await assert.rejects(environment.client.submitPatchJob({
            jobId: "job_mixed_third",
            projectPath: environment.projectRoot,
            text: `[[FINAL_BASE64=${Buffer.from(validPatch("third")).toString("base64")}]]`,
            model: "gpt-5-codex",
            effort: "high",
            ...third
        }), error => error.code === "CONCURRENCY_LIMIT");
        assert.equal(fs.readFileSync(third.metaPath, "utf8"), before);
        assert.equal((await environment.waitJob("job_mixed_analyze")).state, "completed");
        assert.equal((await environment.waitJob("job_mixed_patch")).state, "completed");
    } finally { await environment.close(); }
});

test("patch cancel is targeted and cancel-first wins without publishing", async () => {
    const environment = await createEnvironment({ gitProject: true });
    try {
        await Promise.all([
            environment.submitPatch("job_patch_cancel_a", validPatch("cancel-a"), "[[DELAY_MS=1000]]"),
            environment.submitPatch("job_patch_cancel_b", validPatch("cancel-b"), "[[DELAY_MS=150]]")
        ]);
        const cancelled = await environment.client.cancel({ jobId: "job_patch_cancel_a" });
        assert.deepEqual(cancelled, { cancelled: true, jobId: "job_patch_cancel_a", state: "cancelled" });
        assert.equal((await environment.waitJob("job_patch_cancel_a")).state, "cancelled");
        assert.equal(fs.existsSync(jobPaths(environment.jobRoot, "job_patch_cancel_a").patchPath), false);
        assert.equal((await environment.waitJob("job_patch_cancel_b")).patchValidated, true);
    } finally { await environment.close(); }
});

test("timeout-first wins while a validation lease rejects late cancel", async () => {
    const environment = await createEnvironment({ gitProject: true });
    try {
        await environment.submitPatch("job_patch_timeout", validPatch("timeout"), "[[DELAY_MS=1000]]", { timeoutSec: 0.05 });
        const timeoutMeta = await environment.waitJob("job_patch_timeout");
        assert.equal(timeoutMeta.state, "timeout");
        assert.equal(timeoutMeta.jobPhase, "timeout");
        assert.equal(fs.existsSync(jobPaths(environment.jobRoot, "job_patch_timeout").patchPath), false);

        const server = new SidecarServer({ pluginDir: environment.pluginDir, jobRoot: environment.jobRoot });
        const leasePaths = createMeta(environment.jobRoot, "job_patch_validation_lease", {
            state: "running", jobKind: "patch", executionBackend: "codex-app-server", sidecarInstanceId: "lease-instance"
        });
        const leaseJob = {
            jobId: "job_patch_validation_lease",
            kind: "patch",
            paths: leasePaths,
            state: "running",
            finalizing: true,
            terminalClaim: "validation",
            terminal: false
        };
        server.state = { status: "ready", instanceId: "lease-instance" };
        server.activeJobs.set(leaseJob.jobId, leaseJob);
        assert.deepEqual(await server._cancel({ jobId: leaseJob.jobId }), {
            cancelled: false,
            alreadyFinalizing: true,
            state: "running"
        });
        assert.equal(leaseJob.terminalClaim, "validation");
        server.activeJobs.clear();
    } finally { await environment.close(); }
});

test("submitPatchJob classifies unknown transport once and fixes every artifact path", async () => {
    const environment = await createEnvironment();
    let calls = 0;
    let sent = null;
    try {
        environment.client.ensure = async () => ({ endpoint: "fixture", controlToken: "fixture" });
        environment.client._callWithState = async (_state, method, params) => {
            calls++;
            sent = { method, params };
            throw new SidecarError("SIDECAR_IPC_TIMEOUT", "injected timeout");
        };
        await assert.rejects(environment.client.submitPatchJob({
            jobId: "job_patch_unknown",
            projectPath: environment.projectRoot,
            metaPath: path.join(environment.tempRoot, "attacker-meta"),
            patchPath: path.join(environment.tempRoot, "attacker-patch")
        }), error => error.code === "AICW_APP_SERVER_PATCH_SUBMISSION_UNKNOWN" && error.details.transportCode === "SIDECAR_IPC_TIMEOUT");
        assert.equal(calls, 1);
        assert.equal(sent.method, "submitPatchJob");
        assert.deepEqual({
            metaPath: sent.params.metaPath,
            outputPath: sent.params.outputPath,
            codexOutputPath: sent.params.codexOutputPath,
            patchPath: sent.params.patchPath
        }, jobPaths(environment.jobRoot, "job_patch_unknown"));
    } finally { await environment.close(); }
});

test("watcher activity or Git fingerprint drift fails patch validation closed", async () => {
    const environment = await createEnvironment({ gitProject: true });
    try {
        await environment.submitPatch("job_patch_drift", validPatch("drift"), "[[DELAY_MS=700]]");
        fs.appendFileSync(path.join(environment.projectRoot, "tracked.txt"), "drift\n", "utf8");
        const meta = await environment.waitJob("job_patch_drift");
        assert.equal(meta.state, "failed");
        assert.equal(meta.errorCode, "AICW_PATCH_BASELINE_DRIFT");
        assert.equal(meta.patchValidated, false);
        assert.equal(fs.existsSync(jobPaths(environment.jobRoot, "job_patch_drift").patchPath), false);
    } finally { await environment.close(); }
});

test("dead Sidecar reconciliation distinguishes turn/finalize and removes authorized-hash artifacts", async () => {
    const environment = await createEnvironment();
    try {
        const oldState = { instanceId: "dead-patch-instance" };
        fs.mkdirSync(environment.jobRoot, { recursive: true });
        const directoryIdentity = pinPatchArtifactDirectory(environment.jobRoot, { create: true });
        const turnPaths = createMeta(environment.jobRoot, "job_patch_dead_turn", {
            state: "running", jobKind: "patch", jobPhase: "running",
            executionBackend: "codex-app-server", sidecarInstanceId: oldState.instanceId,
            patchArtifactNonce: "111111111111111111111111",
            patchArtifactDirectoryIdentity: directoryIdentity
        });
        const finalizePatch = validPatch("reconcile");
        const finalizeHash = crypto.createHash("sha256").update(finalizePatch).digest("hex");
        const finalizePaths = createMeta(environment.jobRoot, "job_patch_dead_finalize", {
            state: "running", jobKind: "patch", jobPhase: "validating", patchSha256: finalizeHash,
            patchBytes: Buffer.byteLength(finalizePatch),
            executionBackend: "codex-app-server", sidecarInstanceId: oldState.instanceId,
            patchArtifactNonce: "222222222222222222222222",
            patchArtifactDirectoryIdentity: directoryIdentity
        });
        const candidate = patchCandidatePath(environment.jobRoot, "job_patch_dead_finalize", oldState.instanceId, "222222222222222222222222");
        fs.writeFileSync(candidate, finalizePatch, { mode: 0o600 });
        fs.writeFileSync(finalizePaths.patchPath, finalizePatch, { mode: 0o600 });
        const result = await reconcileDeadSidecarJobs(environment.jobRoot, oldState);
        assert.deepEqual(result, { reconciled: 2, complete: true, failures: [] });
        assert.equal(readJsonOrNull(turnPaths.metaPath).errorCode, "SIDECAR_PROCESS_EXITED");
        assert.equal(readJsonOrNull(finalizePaths.metaPath).errorCode, "SIDECAR_PROCESS_EXITED_DURING_PATCH_FINALIZE");
        assert.equal(fs.existsSync(candidate), false);
        assert.equal(fs.existsSync(finalizePaths.patchPath), false);
    } finally { await environment.close(); }
});

test("dead Sidecar reconciliation is incomplete when public patch hash cannot be confirmed", async () => {
    const environment = await createEnvironment();
    try {
        const oldState = { instanceId: "dead-patch-unverified" };
        fs.mkdirSync(environment.jobRoot, { recursive: true });
        const directoryIdentity = pinPatchArtifactDirectory(environment.jobRoot, { create: true });
        const paths = createMeta(environment.jobRoot, "job_patch_unverified_public", {
            state: "running", jobKind: "patch", jobPhase: "publishing",
            executionBackend: "codex-app-server", sidecarInstanceId: oldState.instanceId,
            patchSha256: "0".repeat(64), patchBytes: Buffer.byteLength(validPatch("unverified")),
            patchArtifactNonce: "333333333333333333333333",
            patchArtifactDirectoryIdentity: directoryIdentity
        });
        fs.mkdirSync(path.dirname(paths.patchPath), { recursive: true });
        fs.writeFileSync(paths.patchPath, validPatch("unverified"), "utf8");
        const result = await reconcileDeadSidecarJobs(environment.jobRoot, oldState);
        assert.equal(result.complete, false);
        assert.deepEqual(result.failures, [{ jobId: "job_patch_unverified_public", code: "AICW_PATCH_ARTIFACT_CLEANUP_FAILED" }]);
        assert.equal(readJsonOrNull(paths.metaPath).state, "running");
        assert.equal(fs.existsSync(paths.patchPath), true);
    } finally { await environment.close(); }
});

test("public collision, candidate write failure, and meta failure all fail closed", async () => {
    const collision = await createEnvironment({ gitProject: true });
    try {
        const paths = createMeta(collision.jobRoot, "job_patch_public_collision");
        fs.mkdirSync(path.dirname(paths.patchPath), { recursive: true });
        fs.writeFileSync(paths.patchPath, "sentinel", "utf8");
        await assert.rejects(collision.client.submitPatchJob({
            jobId: "job_patch_public_collision", projectPath: collision.projectRoot,
            text: `[[FINAL_BASE64=${Buffer.from(validPatch("collision")).toString("base64")}]]`,
            model: "gpt-5-codex", effort: "high", ...paths
        }), error => error.code === "AICW_PATCH_FILE_WRITE_FAILED");
        assert.equal(fs.readFileSync(paths.patchPath, "utf8"), "sentinel");
        assert.equal(readJsonOrNull(paths.metaPath).state, "queued");
    } finally { await collision.close(); }

    const candidateFailure = await createEnvironment({ gitProject: true });
    try {
        fs.mkdirSync(candidateFailure.jobRoot, { recursive: true });
        fs.writeFileSync(path.join(candidateFailure.jobRoot, "patches"), "not-a-directory", "utf8");
        await assert.rejects(
            candidateFailure.submitPatch("job_patch_candidate_failure", validPatch("candidate-failure")),
            error => error.code === "AICW_PATCH_ARTIFACT_DIR_UNSAFE"
        );
        const meta = readJsonOrNull(jobPaths(candidateFailure.jobRoot, "job_patch_candidate_failure").metaPath);
        assert.equal(meta.state, "queued");
        assert.equal(meta.errorCode, undefined);
    } finally { await candidateFailure.close(); }

    const metaFailure = await createEnvironment();
    try {
        const server = new SidecarServer({ pluginDir: metaFailure.pluginDir, jobRoot: metaFailure.jobRoot });
        const paths = createMeta(metaFailure.jobRoot, "job_patch_meta_failure");
        server.state = { status: "ready", instanceId: "meta-failure-instance" };
        fs.unlinkSync(paths.metaPath);
        await assert.rejects(server._updatePatchMeta({ jobId: "job_patch_meta_failure", paths }, () => {}, "AICW_PATCH_META_FINALIZE_FAILED"), error => error.code === "AICW_PATCH_META_FINALIZE_FAILED");
        assert.equal(server.state.status, "degraded");
    } finally { await metaFailure.close(); }
});

test("patch version gate and approval requests fail closed before publication", async () => {
    const badVersion = await createEnvironment({ gitProject: true, fakeVersion: "codex-cli-unsupported" });
    try {
        const paths = createMeta(badVersion.jobRoot, "job_patch_bad_version");
        await assert.rejects(badVersion.client.submitPatchJob({
            jobId: "job_patch_bad_version", projectPath: badVersion.projectRoot,
            text: "not-run", model: "gpt-5-codex", effort: "high", ...paths
        }), error => error.code === "AICW_PATCH_CODEX_VERSION_UNVERIFIED");
        assert.equal(readJsonOrNull(paths.metaPath).state, "queued");
        assert.equal(badVersion.readFakeRecords().some(record => record.method === "thread/start"), false);
    } finally { await badVersion.close(); }

    const approval = await createEnvironment({ gitProject: true });
    try {
        await approval.submitPatch("job_patch_approval", validPatch("approval"), "[[SERVER_REQUEST]][[DELAY_MS=500]]");
        const meta = await approval.waitJob("job_patch_approval");
        assert.equal(meta.state, "failed");
        assert.equal(meta.errorCode, "AICW_PATCH_APPROVAL_REQUESTED");
        assert.equal(meta.patchValidated, false);
        assert.equal(fs.existsSync(jobPaths(approval.jobRoot, "job_patch_approval").patchPath), false);
    } finally { await approval.close(); }
});

test("public replacement before completed meta is never completed or authorized", async () => {
    let replacedPath = null;
    const fixture = await createDirectPatchFinalizeFixture({
        jobId: "job_patch_public_replace_before_completed",
        patchArtifactHooks: {
            beforeCompletedMeta: ({ patchPath }) => {
                replacedPath = patchPath;
                fs.renameSync(patchPath, `${patchPath}.published`);
                fs.writeFileSync(patchPath, "replacement", "utf8");
            }
        }
    });
    try {
        const meta = await fixture.finalize();
        assert.notEqual(meta.state, "completed");
        assert.equal(meta.patchValidated, false);
        assert.equal(fs.readFileSync(replacedPath, "utf8"), "replacement");
        assert.equal(inspectAuthorizedPatchArtifact(fixture.environment.jobRoot, fixture.job.jobId, meta).authorized, false);
        assert.equal(fixture.server.status().status, "degraded");
    } finally { await fixture.environment.close(); }
});

test("completed meta write failure rolls back exact public and rollback failure degrades", async () => {
    for (const rollbackFails of [false, true]) {
        let protocolWrites = 0;
        const artifactHooks = rollbackFails ? {
            unlinkSync(filePath) {
                if (filePath.endsWith(".patch")) throw Object.assign(new Error("injected unlink failure"), { code: "EACCES" });
                return fs.unlinkSync(filePath);
            }
        } : {};
        const fixture = await createDirectPatchFinalizeFixture({
            jobId: `job_patch_completed_write_${rollbackFails ? "rollback_fail" : "rollback_ok"}`,
            patchArtifactHooks: artifactHooks,
            patchMetaOptions: {
                hooks: {
                    writeJsonAtomic(filePath, value) {
                        protocolWrites++;
                        if (value.state === "completed") throw Object.assign(new Error("injected completed meta failure"), { code: "EMETA" });
                        writeJsonAtomic(filePath, value);
                    }
                }
            }
        });
        try {
            const meta = await fixture.finalize();
            assert.ok(protocolWrites >= 3);
            assert.equal(meta.state === "completed" && meta.patchValidated === true, false);
            assert.equal(inspectAuthorizedPatchArtifact(fixture.environment.jobRoot, fixture.job.jobId, meta).authorized, false);
            assert.equal(fs.existsSync(fixture.paths.patchPath), rollbackFails);
            if (rollbackFails) assert.equal(fixture.server.status().status, "degraded");
            else assert.equal(meta.state, "failed");
        } finally { await fixture.environment.close(); }
    }
});

test("completed meta lock release failure removes authorization and stays degraded", async () => {
    let releases = 0;
    const fixture = await createDirectPatchFinalizeFixture({
        jobId: "job_patch_completed_lock_release",
        patchMetaOptions: {
            waitMs: 0,
            hooks: {
                releaseMetaLock(lockPath, lock, releaseDefault) {
                    releases++;
                    if (releases === 3) return false;
                    return releaseDefault(lockPath, lock);
                }
            }
        }
    });
    try {
        const meta = await fixture.finalize();
        assert.equal(releases, 4);
        assert.equal(meta.state, "failed");
        assert.equal(meta.patchValidated, false);
        assert.equal(meta.applyCheckPassed, false);
        assert.equal(meta.baselineStable, false);
        assert.equal(fs.existsSync(fixture.paths.patchPath), false);
        assert.equal(inspectAuthorizedPatchArtifact(fixture.environment.jobRoot, fixture.job.jobId, meta).authorized, false);
        assert.equal(fixture.server.status().status, "degraded");
        assert.equal(fixture.server.activeJobs.has(fixture.job.jobId), false);
    } finally { await fixture.environment.close(); }
});

test("baseline drift after final assertion and before resource close is never authorized", async () => {
    let fixture;
    fixture = await createDirectPatchFinalizeFixture({
        jobId: "job_patch_final_close_drift",
        realBaselineMonitor: true,
        patchArtifactHooks: {
            beforeCompletedMeta: () => {
                fs.writeFileSync(
                    path.join(fixture.environment.projectRoot, "tracked.txt"),
                    "alpha\ndrifted\n",
                    "utf8"
                );
            }
        }
    });
    try {
        const meta = await fixture.finalize();
        assert.notEqual(meta.state, "completed");
        assert.equal(meta.patchValidated, false);
        assert.equal(meta.applyCheckPassed, false);
        assert.equal(meta.baselineStable, false);
        assert.equal(fs.existsSync(fixture.paths.patchPath), false);
        assert.equal(
            inspectAuthorizedPatchArtifact(
                fixture.environment.jobRoot,
                fixture.job.jobId,
                meta
            ).authorized,
            false
        );
    } finally { await fixture.environment.close(); }
});

test("patch resource close failure fails closed before authorization", async () => {
    const fixture = await createDirectPatchFinalizeFixture({
        jobId: "job_patch_close_failure",
        closeFailure: true
    });
    try {
        const meta = await fixture.finalize();
        assert.notEqual(meta.state, "completed");
        assert.equal(meta.patchValidated, false);
        assert.equal(fs.existsSync(fixture.paths.patchPath), false);
        assert.equal(inspectAuthorizedPatchArtifact(fixture.environment.jobRoot, fixture.job.jobId, meta).authorized, false);
    } finally { await fixture.environment.close(); }
});

test("dead patch reconcile handles validating publishing and published-not-completed crash points", async () => {
    const environment = await createEnvironment();
    try {
        fs.mkdirSync(environment.jobRoot, { recursive: true });
        const identity = pinPatchArtifactDirectory(environment.jobRoot, { create: true });
        const instanceId = "dead-crash-instance";
        const patch = validPatch("crash-point");
        for (const [index, scenario] of ["validating", "publishing", "published"].entries()) {
            const jobId = `job_patch_crash_${scenario}`;
            const nonce = `${index + 4}`.repeat(24);
            const paths = createMeta(environment.jobRoot, jobId, {
                state: "running", jobKind: "patch", jobPhase: scenario === "validating" ? "validating" : "publishing",
                executionBackend: "codex-app-server", sidecarInstanceId: instanceId,
                patchArtifactNonce: nonce, patchArtifactDirectoryIdentity: identity,
                patchSha256: sha256(Buffer.from(patch)), patchBytes: Buffer.byteLength(patch)
            });
            fs.writeFileSync(patchCandidatePath(environment.jobRoot, jobId, instanceId, nonce), patch, { mode: 0o600 });
            if (scenario === "published") fs.writeFileSync(paths.patchPath, patch, { mode: 0o600 });
        }
        const result = await reconcileDeadSidecarJobs(environment.jobRoot, { instanceId });
        assert.deepEqual(result, { reconciled: 3, complete: true, failures: [] });
        for (const scenario of ["validating", "publishing", "published"]) {
            const meta = readJsonOrNull(jobPaths(environment.jobRoot, `job_patch_crash_${scenario}`).metaPath);
            assert.equal(meta.errorCode, "SIDECAR_PROCESS_EXITED_DURING_PATCH_FINALIZE");
            assert.equal(meta.patchValidated, false);
            assert.equal(meta.applyCheckPassed, false);
        }
    } finally { await environment.close(); }
});

test("dead reconcile removes only exact dead instance nonce candidate", async () => {
    const environment = await createEnvironment();
    try {
        fs.mkdirSync(environment.jobRoot, { recursive: true });
        const identity = pinPatchArtifactDirectory(environment.jobRoot, { create: true });
        const patch = validPatch("ownership");
        const jobId = "job_patch_dead_exact";
        const deadInstance = "dead-exact-instance";
        const ownedNonce = "777777777777777777777777";
        createMeta(environment.jobRoot, jobId, {
            state: "running", jobKind: "patch", jobPhase: "validating",
            executionBackend: "codex-app-server", sidecarInstanceId: deadInstance,
            patchArtifactNonce: ownedNonce, patchArtifactDirectoryIdentity: identity
        });
        const owned = patchCandidatePath(environment.jobRoot, jobId, deadInstance, ownedNonce);
        const otherInstance = patchCandidatePath(environment.jobRoot, jobId, "live-instance", "888888888888888888888888");
        const otherNonce = patchCandidatePath(environment.jobRoot, jobId, deadInstance, "999999999999999999999999");
        fs.writeFileSync(owned, patch, { mode: 0o600 });
        fs.writeFileSync(otherInstance, patch, { mode: 0o600 });
        fs.writeFileSync(otherNonce, patch, { mode: 0o600 });
        const result = await reconcileDeadSidecarJobs(environment.jobRoot, { instanceId: deadInstance });
        assert.equal(result.complete, true);
        assert.equal(fs.existsSync(owned), false);
        assert.equal(fs.existsSync(otherInstance), true);
        assert.equal(fs.existsSync(otherNonce), true);
    } finally { await environment.close(); }
});

test("dead reconcile directory drift hash mismatch and replacement race remain incomplete", async () => {
    for (const scenario of ["directory-drift", "hash-mismatch", "replacement-race"]) {
        const environment = await createEnvironment();
        try {
            fs.mkdirSync(environment.jobRoot, { recursive: true });
            const identity = pinPatchArtifactDirectory(environment.jobRoot, { create: true });
            const patch = validPatch(scenario);
            const jobId = `job_patch_cleanup_${scenario.replace("-", "_")}`;
            const nonce = "aaaaaaaaaaaaaaaaaaaaaaaa";
            const paths = createMeta(environment.jobRoot, jobId, {
                state: "running", jobKind: "patch", jobPhase: "publishing",
                executionBackend: "codex-app-server", sidecarInstanceId: "dead-cleanup-instance",
                patchArtifactNonce: nonce, patchArtifactDirectoryIdentity: identity,
                patchSha256: scenario === "hash-mismatch" ? "0".repeat(64) : sha256(Buffer.from(patch)),
                patchBytes: Buffer.byteLength(patch)
            });
            fs.writeFileSync(paths.patchPath, patch, { mode: 0o600 });
            if (scenario === "directory-drift") {
                fs.renameSync(identity.realpath, `${identity.realpath}.old`);
                fs.mkdirSync(identity.realpath);
            }
            let replaced = false;
            const result = await reconcileDeadSidecarJobs(environment.jobRoot, { instanceId: "dead-cleanup-instance" }, {
                artifactHooks: scenario === "replacement-race" ? {
                    afterArtifactHashCheck({ filePath }) {
                        if (replaced || !filePath.endsWith(".patch")) return;
                        replaced = true;
                        fs.renameSync(filePath, `${filePath}.verified`);
                        fs.writeFileSync(filePath, "replacement", "utf8");
                    }
                } : {}
            });
            assert.equal(result.complete, false);
            assert.equal(readJsonOrNull(paths.metaPath).state, "running");
            if (scenario === "directory-drift") {
                assert.equal(fs.existsSync(path.join(`${identity.realpath}.old`, path.basename(paths.patchPath))), true);
            } else {
                assert.equal(fs.existsSync(paths.patchPath), true);
            }
            if (scenario === "replacement-race") assert.equal(fs.readFileSync(paths.patchPath, "utf8"), "replacement");
        } finally { await environment.close(); }
    }
});

function terminateVerifiedPid(pid, identity) {
    assert.ok(pid && identity, "test PID must have a recorded identity");
    assert.equal(isPidAlive(pid), true);
    assert.equal(sameProcessIdentity(identity, getProcessIdentity(pid)), true);
    return terminateExactPid(pid, true);
}

function mockChild({ pid = process.pid, exited = false } = {}) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { destroyed: false, write: () => true };
    child.pid = pid;
    child.exitCode = exited ? 0 : null;
    child.signalCode = null;
    child.killCalls = [];
    child.kill = signal => { child.killCalls.push(signal); };
    return child;
}

test("two concurrent ensure calls create one Sidecar PID and instance", async () => {
    const environment = await createEnvironment();
    try {
        const clients = [new SidecarClient({ ...environment.client, ...{} }), new SidecarClient({ ...environment.client, ...{} })];
        const [first, second] = await Promise.all([clients[0].ensure(), clients[1].ensure()]);
        assert.equal(first.pid, second.pid);
        assert.equal(first.instanceId, second.instanceId);
    } finally { await environment.close(); }
});

test("two Jobs overlap with distinct thread and turn IDs and both complete", async () => {
    const environment = await createEnvironment();
    try {
        const [a, b] = await Promise.all([
            environment.submit("job_overlap_a", "[[DELAY_MS=350]][[FINAL=A]]"),
            environment.submit("job_overlap_b", "[[DELAY_MS=250]][[FINAL=B]]")
        ]);
        assert.notEqual(a.threadId, b.threadId);
        assert.notEqual(a.turnId, b.turnId);
        const status = await environment.client.status();
        assert.equal(status.activeJobs.length, 2);
        assert.equal((await environment.waitJob("job_overlap_a")).state, "completed");
        assert.equal((await environment.waitJob("job_overlap_b")).state, "completed");
    } finally { await environment.close(); }
});

test("cancel waits for interrupted completion while another Job completes", async () => {
    const environment = await createEnvironment();
    try {
        await Promise.all([
            environment.submit("job_cancel_a", "[[DELAY_MS=1000]][[FINAL=A]]"),
            environment.submit("job_cancel_b", "[[DELAY_MS=120]][[FINAL=B]]")
        ]);
        const result = await environment.client.cancel({ jobId: "job_cancel_a" });
        assert.deepEqual(result, { cancelled: true, jobId: "job_cancel_a", state: "cancelled" });
        assert.equal((await environment.waitJob("job_cancel_a")).state, "cancelled");
        const b = await environment.waitJob("job_cancel_b");
        assert.equal(b.state, "completed");
        assert.equal(fs.readFileSync(jobPaths(environment.jobRoot, "job_cancel_b").codexOutputPath, "utf8"), "B");
    } finally { await environment.close(); }
});

test("third concurrent Job is rejected without changing its meta", async () => {
    const environment = await createEnvironment({ maxConcurrency: 2 });
    try {
        await Promise.all([
            environment.submit("job_limit_a", "[[DELAY_MS=500]][[FINAL=A]]"),
            environment.submit("job_limit_b", "[[DELAY_MS=500]][[FINAL=B]]")
        ]);
        const paths = createMeta(environment.jobRoot, "job_limit_c");
        const before = fs.readFileSync(paths.metaPath, "utf8");
        await assert.rejects(
            environment.client.submitAnalyzeJob({ jobId: "job_limit_c", projectPath: environment.projectRoot, text: "C", ...paths }),
            error => error.code === "CONCURRENCY_LIMIT"
        );
        assert.equal(fs.readFileSync(paths.metaPath, "utf8"), before);
    } finally { await environment.close(); }
});

test("fake Codex crash fails all active Jobs and degrades Sidecar", async () => {
    const environment = await createEnvironment();
    try {
        await Promise.all([
            environment.submit("job_crash_a", "[[DELAY_MS=500]][[CRASH_AFTER_MS=500]][[FINAL=A]]"),
            environment.submit("job_crash_b", "[[DELAY_MS=500]][[CRASH_AFTER_MS=500]][[FINAL=B]]")
        ]);
        const [a, b] = await Promise.all([environment.waitJob("job_crash_a"), environment.waitJob("job_crash_b")]);
        assert.equal(a.state, "failed");
        assert.equal(b.state, "failed");
        assert.equal(a.exitReason, "CODEX_APP_SERVER_EXITED");
        assert.equal(b.exitReason, "CODEX_APP_SERVER_EXITED");
        assert.equal((await environment.client.status()).status, "degraded");
    } finally { await environment.close(); }
});

test("thread start failure terminates the Job meta", async () => {
    const environment = await createEnvironment();
    const failingProject = path.join(environment.tempRoot, "fake-thread-fail");
    fs.mkdirSync(failingProject);
    try {
        await assert.rejects(environment.submit("job_start_failure", "ignored", failingProject), error => error.code === "CODEX_RPC_ERROR");
        const meta = await environment.waitJob("job_start_failure");
        assert.equal(meta.state, "failed");
        assert.equal(meta.exitCode, 1);
    } finally { await environment.close(); }
});

test("stale state with a nonexistent PID is cleaned and recovered", async () => {
    const environment = await createEnvironment();
    try {
        writeJsonAtomic(environment.paths.statePath, {
            schemaVersion: 1, instanceId: "stale", controlToken: "stale", pid: 2147483647,
            endpoint: environment.paths.endpoint, status: "ready"
        });
        const state = await environment.client.ensure();
        assert.notEqual(state.instanceId, "stale");
    } finally { await environment.close(); }
});

test("live but unresponsive state is not killed and returns SIDECAR_UNRESPONSIVE", async () => {
    const environment = await createEnvironment();
    try {
        const liveState = await environment.client.ensure();
        const original = { ...liveState };
        writeJsonAtomic(environment.paths.statePath, { ...liveState, endpoint: `${liveState.endpoint}-wrong` });
        await assert.rejects(environment.client.ping(), error => error.code === "SIDECAR_UNRESPONSIVE");
        assert.equal(isPidAlive(liveState.pid), true);
        writeJsonAtomic(environment.paths.statePath, original);
    } finally { await environment.close(); }
});

test("dead stale startup lock is rejected without spawn or deletion", async () => {
    const environment = await createEnvironment();
    try {
        fs.mkdirSync(environment.paths.runtime, { recursive: true });
        writeJsonAtomic(environment.paths.lockPath, {
            ownerToken: "dead", pid: 2147483647,
            processIdentity: { pid: 2147483647, startTime: "dead" }, createdAt: Date.now() - 10000
        });
        await assert.rejects(environment.client.ensure(), error => error.code === "SIDECAR_STARTUP_LOCK_STALE");
        assert.equal(fs.existsSync(environment.paths.lockPath), true);
        assert.equal(fs.existsSync(environment.paths.statePath), false);
    } finally { await environment.close(); }

    const waitingEnvironment = await createEnvironment();
    try {
        fs.mkdirSync(waitingEnvironment.paths.runtime, { recursive: true });
        const holder = new SidecarClient({
            pluginDir: waitingEnvironment.pluginDir,
            jobRoot: waitingEnvironment.jobRoot,
            entryPath,
            codexBin: nodeExecutable,
            codexGlobalArgs: [fixturePath]
        });
        const lock = holder._tryAcquireLock();
        assert.ok(lock);
        const waiter = new SidecarClient({
            pluginDir: waitingEnvironment.pluginDir,
            jobRoot: waitingEnvironment.jobRoot,
            entryPath,
            codexBin: nodeExecutable,
            codexGlobalArgs: [fixturePath],
            lockWaitMs: 150
        });
        await assert.rejects(waiter.ensure(), error => error.code === "SIDECAR_START_TIMEOUT");
        assert.ok(fs.existsSync(waitingEnvironment.paths.lockPath));
        holder._releaseLock(lock);
    } finally { await waitingEnvironment.close(); }
});

test("malformed startup lock is rejected without takeover", async () => {
    const environment = await createEnvironment();
    try {
        fs.mkdirSync(environment.paths.runtime, { recursive: true });
        fs.writeFileSync(environment.paths.lockPath, "{malformed", "utf8");
        await assert.rejects(environment.client.ensure(), error => error.code === "SIDECAR_LOCK_INVALID");
        assert.equal(fs.readFileSync(environment.paths.lockPath, "utf8"), "{malformed");
        assert.equal(fs.existsSync(environment.paths.statePath), false);
    } finally { await environment.close(); }
});

test("malformed state fails closed and does not spawn", async () => {
    const environment = await createEnvironment();
    try {
        fs.mkdirSync(environment.paths.runtime, { recursive: true });
        fs.writeFileSync(environment.paths.statePath, "{malformed", "utf8");
        await assert.rejects(environment.client.ensure(), error => error.code === "SIDECAR_STATE_INVALID");
        assert.equal(environment.client.sidecarChild, null);
        assert.equal(fs.readFileSync(environment.paths.statePath, "utf8"), "{malformed");
    } finally { await environment.close(); }
});

test("injected state EACCES fails closed and does not spawn", async () => {
    const environment = await createEnvironment();
    try {
        const client = clientFor(environment, {
            stateReader() { throw Object.assign(new Error("injected EACCES"), { code: "EACCES" }); }
        });
        await assert.rejects(client.ensure(), error => error.code === "SIDECAR_STATE_READ_FAILED");
        assert.equal(client.sidecarChild, null);
        assert.equal(fs.existsSync(environment.paths.statePath), false);
    } finally { await environment.close(); }
});

test("non-object state fails closed", async () => {
    const environment = await createEnvironment();
    try {
        fs.mkdirSync(environment.paths.runtime, { recursive: true });
        writeJsonAtomic(environment.paths.statePath, []);
        await assert.rejects(environment.client.ensure(), error => error.code === "SIDECAR_STATE_INVALID");
        assert.equal(environment.client.sidecarChild, null);
    } finally { await environment.close(); }
});

test("state missing a required field fails closed", async () => {
    const environment = await createEnvironment();
    try {
        fs.mkdirSync(environment.paths.runtime, { recursive: true });
        writeJsonAtomic(environment.paths.statePath, { schemaVersion: 1, instanceId: "x", controlToken: "y", pid: 2147483647, endpoint: environment.paths.endpoint });
        await assert.rejects(environment.client.ensure(), error => error.code === "SIDECAR_STATE_INVALID");
        assert.equal(environment.client.sidecarChild, null);
    } finally { await environment.close(); }
});

test("ENOENT state starts exactly one Sidecar normally", async () => {
    const environment = await createEnvironment();
    try {
        const state = await environment.client.ensure();
        assert.equal(state.status, "ready");
        assert.equal(environment.client.sidecarChild.pid, state.pid);
    } finally { await environment.close(); }
});

test("live starting Sidecar is reused despite a dead parent lock", async () => {
    const environment = await createEnvironment();
    try {
        const { child } = await spawnDetachedStarting(environment, 650);
        writeJsonAtomic(environment.paths.lockPath, {
            ownerToken: "dead-parent", pid: 2147483647,
            processIdentity: { pid: 2147483647, startTime: "dead" }, createdAt: Date.now() - 10000
        });
        const observer = clientFor(environment, { startingTimeoutMs: 4000 });
        const state = await observer.ensure();
        assert.equal(state.pid, child.pid);
        assert.equal(state.status, "ready");
        assert.equal(fs.existsSync(environment.paths.lockPath), true);
    } finally { await environment.close(); }
});

test("live starting Sidecar timeout never spawns a replacement", async () => {
    const environment = await createEnvironment();
    try {
        const { child } = await spawnDetachedStarting(environment, 1600);
        const observer = clientFor(environment, { startingTimeoutMs: 250 });
        await assert.rejects(observer.ensure(), error => error.code === "SIDECAR_STARTING_TIMEOUT");
        assert.equal(observer.sidecarChild, null);
        assert.equal(readJsonOrNull(environment.paths.statePath).pid, child.pid);
    } finally { await environment.close(); }
});

test("starting PID alive without identity fails closed and is not killed", async () => {
    const environment = await createEnvironment();
    try {
        writeJsonAtomic(environment.paths.statePath, stateFixture(environment, { pid: process.pid, status: "starting" }));
        await assert.rejects(environment.client.ensure(), error => error.code === "SIDECAR_STARTING_UNVERIFIED");
        assert.equal(isPidAlive(process.pid), true);
        assert.equal(environment.client.sidecarChild, null);
    } finally { await environment.close(); }
});

test("dead starting Sidecar is reconciled before a replacement starts", async () => {
    const environment = await createEnvironment();
    try {
        const { child } = await spawnDetachedStarting(environment, 5000);
        const state = readJsonOrNull(environment.paths.statePath);
        const terminated = await terminateOwnedChild(child, {
            identity: state.processIdentity,
            gracefulTimeoutMs: 100,
            forceConfirmationTimeoutMs: 1000
        });
        assert.equal(terminated.confirmed, true);
        await waitFor(() => !isPidAlive(child.pid), 3000);
        const replacement = await clientFor(environment).ensure();
        assert.notEqual(replacement.pid, child.pid);
        assert.equal(replacement.status, "ready");
    } finally { await environment.close(); }
});

test("two clients waiting on live starting state receive one instance", async () => {
    const environment = await createEnvironment();
    try {
        await spawnDetachedStarting(environment, 650);
        const clients = [clientFor(environment, { startingTimeoutMs: 4000 }), clientFor(environment, { startingTimeoutMs: 4000 })];
        const [first, second] = await Promise.all(clients.map(client => client.ensure()));
        assert.equal(first.pid, second.pid);
        assert.equal(first.instanceId, second.instanceId);
    } finally { await environment.close(); }
});

test("shutdown responds before exit, removes state, and ping does not restart", async () => {
    const environment = await createEnvironment();
    try {
        await environment.submit("job_shutdown", "[[DELAY_MS=2000]][[FINAL=late]]");
        const state = readJsonOrNull(environment.paths.statePath);
        const pids = [state.pid, state.codexPid];
        const response = await environment.client.shutdown();
        assert.deepEqual(response, { accepted: true });
        await waitFor(() => !fs.existsSync(environment.paths.statePath));
        await waitFor(() => pids.every(pid => !isPidAlive(pid)), 4000);
        assert.equal(pids.some(pid => isPidAlive(pid)), false);
        await assert.rejects(environment.client.ping(), error => error.code === "SIDECAR_NOT_RUNNING");
    } finally { await environment.close(); }
});

test("path traversal, fixed-path mismatch, relative projectPath, and wrong token are rejected", async () => {
    const environment = await createEnvironment();
    try {
        const state = await environment.client.ensure();
        await assert.rejects(environment.client.submitAnalyzeJob({ jobId: "../escape", projectPath: environment.projectRoot }), error => error.code === "INVALID_JOB_ID");
        const paths = createMeta(environment.jobRoot, "job_path_check");
        await assert.rejects(environment.client.submitAnalyzeJob({ jobId: "job_path_check", projectPath: "relative", ...paths }), error => error.code === "INVALID_PATH");
        await assert.rejects(environment.client.submitAnalyzeJob({ jobId: "job_path_check", projectPath: environment.projectRoot, ...paths, outputPath: path.join(environment.jobRoot, "outside.txt") }), error => error.code === "INVALID_JOB_PATH");
        await assert.rejects(environment.client._callWithState({ ...state, controlToken: "wrong" }, "ping", {}), error => error.code === "INVALID_CONTROL_TOKEN");
        assert.equal(readJsonOrNull(paths.metaPath).state, "queued");
    } finally { await environment.close(); }
});

test("SidecarClient accepts only strict IPC envelopes and fails closed on malformed responses", async () => {
    const environment = await createEnvironment();
    let currentCase;
    let server;
    try {
        const state = { endpoint: environment.paths.endpoint, controlToken: "fixture-token" };
        const cases = [
            {
                name: "valid result object",
                response: request => ({ requestId: request.requestId, ok: true, result: { accepted: true } }),
                expected: { accepted: true }
            },
            {
                name: "array result",
                response: request => ({ requestId: request.requestId, ok: true, result: [] }),
                code: "INVALID_SIDECAR_RESPONSE"
            },
            {
                name: "missing ok",
                response: request => ({ requestId: request.requestId, result: {} }),
                code: "INVALID_SIDECAR_RESPONSE"
            },
            {
                name: "malformed error",
                response: request => ({ requestId: request.requestId, ok: false, error: { code: "BROKEN" } }),
                code: "INVALID_SIDECAR_RESPONSE"
            },
            {
                name: "requestId mismatch",
                response: () => ({ requestId: "not-the-request", ok: true, result: {} }),
                code: "SIDECAR_RESPONSE_MISMATCH"
            },
            {
                name: "numeric requestId masquerade",
                response: request => ({ requestId: Number(request.requestId), ok: true, result: {} }),
                code: "SIDECAR_RESPONSE_MISMATCH"
            }
        ];
        server = await listenIpcFixture(environment.paths.endpoint, request => currentCase.response(request));
        for (const testCase of cases) {
            currentCase = testCase;
            if (testCase.expected) {
                assert.deepEqual(await environment.client._callWithState(state, "ping", {}), testCase.expected, testCase.name);
            } else {
                await assert.rejects(
                    environment.client._callWithState(state, "ping", {}),
                    error => error.code === testCase.code,
                    testCase.name
                );
            }
        }
    } finally {
        try {
            await closeIpcFixture(server);
        } finally {
            await environment.close();
        }
    }
});

test("SidecarClient bounds UTF-8 response buffers and consumes only the first response line", async () => {
    const environment = await createEnvironment();
    let server;
    try {
        const client = clientFor(environment, { maxIpcBufferBytes: 1024 });
        const state = { endpoint: environment.paths.endpoint, controlToken: "fixture-token" };
        for (const testCase of [
            { name: "response without newline", payload: "界".repeat(342) },
            { name: "oversized complete response line", payload: `${"界".repeat(342)}\n` }
        ]) {
            server = await listenRawIpcFixture(environment.paths.endpoint, () => testCase.payload);
            await assert.rejects(
                client._callWithState(state, "ping", {}),
                error => error.code === "SIDECAR_IPC_BUFFER_OVERFLOW",
                testCase.name
            );
            await closeIpcFixture(server);
            server = null;
        }

        server = await listenRawIpcFixture(environment.paths.endpoint, request => {
            const requestId = JSON.parse(request.trim()).requestId;
            return `${JSON.stringify({ requestId, ok: true, result: { first: true } })}\n${"x".repeat(2048)}\n`;
        });
        assert.deepEqual(await client._callWithState(state, "ping", {}), { first: true });
    } finally {
        try {
            await closeIpcFixture(server);
        } finally {
            await environment.close();
        }
    }
});

test("SidecarServer rejects oversized request buffers and closes each IPC socket", async () => {
    const environment = await createEnvironment();
    const sidecar = new SidecarServer({
        pluginDir: environment.pluginDir,
        jobRoot: environment.jobRoot,
        maxIpcBufferBytes: 1024
    });
    sidecar.state = { controlToken: "fixture-token", instanceId: "fixture-instance" };
    const server = net.createServer(socket => sidecar._acceptSocket(socket));
    sidecar.server = server;
    try {
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(environment.paths.endpoint, resolve);
        });
        for (const payload of [
            "界".repeat(342),
            `${JSON.stringify({ requestId: "oversized", token: "fixture-token", method: "ping", params: { text: "x".repeat(1100) } })}\n${JSON.stringify({ requestId: "ignored", token: "fixture-token", method: "ping" })}\n`
        ]) {
            const response = await requestRawIpc(environment.paths.endpoint, payload);
            const lines = response.output.trim().split(/\r?\n/).filter(Boolean);
            assert.equal(lines.length, 1);
            const envelope = JSON.parse(lines[0]);
            assert.equal(envelope.requestId, null);
            assert.equal(envelope.ok, false);
            assert.equal(envelope.error.code, "SIDECAR_IPC_BUFFER_OVERFLOW");
        }
        await waitFor(() => sidecar.sockets.size === 0, 1000);
    } finally {
        await sidecar.shutdown();
        await environment.close();
    }
});

test("createJsonExclusive preserves an existing meta file on collision", async () => {
    const environment = await createEnvironment();
    try {
        const target = path.join(environment.jobRoot, "meta", "job_collision.json");
        const original = { jobId: "job_collision", state: "queued", owner: "original" };
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `${JSON.stringify(original)}\n`, "utf8");
        assert.throws(
            () => createJsonExclusive(target, { ...original, owner: "replacement" }),
            error => error.code === "META_ALREADY_EXISTS"
        );
        assert.deepEqual(readJsonOrNull(target), original);
    } finally { await environment.close(); }
});

test("createJsonExclusive reports finalization failure when write and cleanup both fail", () => {
    let closeCalls = 0;
    assert.throws(
        () => createJsonExclusive(
            path.join(os.tmpdir(), "virtual-meta-finalization-failure.json"),
            { jobId: "job_virtual_meta_failure" },
            {
                openSync: () => 123,
                writeFileSync: () => {
                    throw Object.assign(new Error("injected write failure"), { code: "EWRITE" });
                },
                fsyncSync: () => {},
                closeSync: () => { closeCalls++; },
                linkSync: () => {
                    throw new Error("link must not run after write failure");
                },
                unlinkSync: () => {
                    throw Object.assign(new Error("injected cleanup failure"), { code: "EDELETE" });
                }
            }
        ),
        error => error.code === "META_CREATE_FINALIZATION_FAILED" &&
            error.details?.cause === "EWRITE" &&
            error.details?.cleanupCause === "EDELETE" &&
            error.details?.stage === "write"
    );
    assert.equal(closeCalls, 1);
});

test("duplicate jobId cannot be submitted a second time", async () => {
    const environment = await createEnvironment();
    try {
        await environment.submit("job_duplicate", "[[FINAL=once]]");
        const meta = await environment.waitJob("job_duplicate");
        const paths = jobPaths(environment.jobRoot, "job_duplicate");
        const before = fs.readFileSync(paths.metaPath, "utf8");
        await assert.rejects(environment.client.submitAnalyzeJob({
            jobId: "job_duplicate", projectPath: environment.projectRoot, text: "second", ...paths
        }), error => error.code === "DUPLICATE_JOB_ID");
        assert.equal(meta.state, "completed");
        assert.equal(fs.readFileSync(paths.metaPath, "utf8"), before);
    } finally { await environment.close(); }
});

test("turn/started before turn/start response binds the strict thread and is not dropped", async () => {
    const environment = await createEnvironment();
    try {
        const accepted = await environment.submit("job_started_first", "[[EVENTS_BEFORE_RESPONSE]][[FINAL=started-first]]");
        assert.equal(accepted.accepted, true);
        assert.equal((await environment.waitJob("job_started_first")).state, "completed");
        assert.equal(fs.readFileSync(jobPaths(environment.jobRoot, "job_started_first").codexOutputPath, "utf8"), "started-first");
    } finally { await environment.close(); }
});

test("delta before response is appended once and final output is correct", async () => {
    const environment = await createEnvironment();
    try {
        await environment.submit("job_delta_first", "[[DELTA_BEFORE_RESPONSE]][[FINAL=delta-once]]");
        const meta = await environment.waitJob("job_delta_first");
        const paths = jobPaths(environment.jobRoot, "job_delta_first");
        assert.equal(meta.state, "completed");
        assert.equal(fs.readFileSync(paths.codexOutputPath, "utf8"), "delta-once");
        assert.equal((fs.readFileSync(paths.outputPath, "utf8").match(/item\/agentMessage\/delta/g) || []).length, 1);
    } finally { await environment.close(); }
});

test("completed before response converges exactly once to completed", async () => {
    const environment = await createEnvironment();
    try {
        const accepted = await environment.submit("job_completed_first", "[[COMPLETED_BEFORE_RESPONSE]][[FINAL=complete-first]]");
        assert.equal(accepted.terminalState, "completed");
        const meta = await environment.waitJob("job_completed_first");
        assert.equal(meta.state, "completed");
        assert.equal(meta.userField, "preserve-me");
    } finally { await environment.close(); }
});

test("failed before response converges to failed without a second execution", async () => {
    const environment = await createEnvironment();
    try {
        const accepted = await environment.submit("job_failed_first", "[[FAILED_BEFORE_RESPONSE]][[FINAL=never-written]]");
        assert.equal(accepted.terminalState, "failed");
        const meta = await environment.waitJob("job_failed_first");
        assert.equal(meta.state, "failed");
        assert.equal(meta.exitReason, "CODEX_TURN_FAILED");
        assert.equal(fs.existsSync(jobPaths(environment.jobRoot, "job_failed_first").codexOutputPath), false);
    } finally { await environment.close(); }
});

test("response error after trusted events is accepted with the terminal state", async () => {
    const environment = await createEnvironment();
    try {
        const accepted = await environment.submit("job_response_error", "[[TURN_RESPONSE_ERROR_AFTER_EVENTS]][[FINAL=trusted-before-error]]");
        assert.equal(accepted.accepted, true);
        assert.equal(accepted.submissionConfirmedBy, "notification");
        assert.equal((await environment.waitJob("job_response_error")).state, "completed");
    } finally { await environment.close(); }
});

test("turn ID conflict is rejected and cannot cross-link another Job", async () => {
    const environment = await createEnvironment();
    try {
        await assert.rejects(environment.submit("job_turn_conflict", "[[EVENTS_BEFORE_RESPONSE]][[CONFLICT_TURN_ID]]"), error => error.code === "TURN_ID_CONFLICT");
        assert.equal((await environment.waitJob("job_turn_conflict")).state, "completed");
        assert.equal((await environment.submit("job_after_conflict", "[[FINAL=isolated]]")).accepted, true);
        assert.equal((await environment.waitJob("job_after_conflict")).state, "completed");
    } finally { await environment.close(); }
});

test("active turn notification conflict fails the bound Job with TURN_ID_CONFLICT", async () => {
    const environment = await createEnvironment();
    try {
        await environment.submit("job_active_turn_conflict", "[[CONFLICT_NOTIFICATION_WHILE_ACTIVE]][[DELAY_MS=250]][[FINAL=never-completes]]");
        const meta = await environment.waitJob("job_active_turn_conflict");
        assert.equal(meta.state, "failed");
        assert.equal(meta.exitCode, 1);
        assert.equal(meta.errorCode, "TURN_ID_CONFLICT");
        assert.equal(meta.exitReason, "Turn ID conflict");
    } finally { await environment.close(); }
});

test("active turn notification conflict cannot affect another Job", async () => {
    const environment = await createEnvironment();
    try {
        const [conflict, other] = await Promise.all([
            environment.submit("job_conflict_isolated", "[[CONFLICT_NOTIFICATION_WHILE_ACTIVE]][[DELAY_MS=200]][[FINAL=bad]]"),
            environment.submit("job_conflict_other", "[[DELAY_MS=80]][[FINAL=good]]")
        ]);
        assert.equal(conflict.accepted, true);
        assert.equal(other.accepted, true);
        assert.equal((await environment.waitJob("job_conflict_isolated")).errorCode, "TURN_ID_CONFLICT");
        assert.equal((await environment.waitJob("job_conflict_other")).state, "completed");
        assert.equal(fs.readFileSync(jobPaths(environment.jobRoot, "job_conflict_other").codexOutputPath, "utf8"), "good");
    } finally { await environment.close(); }
});

test("delta sent after completed does not change Codex output or trace", async () => {
    const environment = await createEnvironment();
    try {
        await environment.submit("job_delta_after_completed", "[[DELTA_AFTER_COMPLETED]][[DELAY_MS=25]][[FINAL=once]]");
        await environment.waitJob("job_delta_after_completed");
        const paths = jobPaths(environment.jobRoot, "job_delta_after_completed");
        assert.equal(fs.readFileSync(paths.codexOutputPath, "utf8"), "once");
        assert.equal(fs.readFileSync(paths.outputPath, "utf8").includes("late-delta"), false);
    } finally { await environment.close(); }
});

test("cancel before turn ID binds later and interrupts only that turn", async () => {
    const environment = await createEnvironment();
    try {
        await environment.client.ensure();
        const submission = environment.submit("job_cancel_before_turn", "[[TURN_RESPONSE_DELAY_MS=500]][[DELAY_MS=50]][[FINAL=cancel-me]]");
        await delay(50);
        const cancelled = await environment.client.cancel({ jobId: "job_cancel_before_turn" });
        assert.deepEqual(cancelled, { cancelled: true, jobId: "job_cancel_before_turn", state: "cancelled" });
        assert.equal((await environment.waitJob("job_cancel_before_turn")).state, "cancelled");
        assert.equal((await submission).accepted, true);
    } finally { await environment.close(); }
});

test("completed wins the cancel race and cancel is idempotent", async () => {
    const environment = await createEnvironment();
    try {
        await environment.client.ensure();
        const submission = environment.submit("job_cancel_race", "[[DELAY_MS=400]][[INTERRUPT_RACE_COMPLETE]][[FINAL=completed-wins]]");
        await delay(100);
        const result = await environment.client.cancel({ jobId: "job_cancel_race" });
        assert.equal(result.state, "completed");
        assert.equal(result.cancelled, false);
        assert.equal((await submission).accepted, true);
        assert.deepEqual(await environment.client.cancel({ jobId: "job_cancel_race" }), { cancelled: false, alreadyTerminal: true, state: "completed" });
    } finally { await environment.close(); }
});

test("submissionState becomes accepted on trusted turn binding", async () => {
    const environment = await createEnvironment();
    try {
        const submission = await environment.submit(
            "job_submission_accepted",
            "[[DELAY_MS=300]][[FINAL=accepted]]",
            environment.projectRoot,
            { meta: { submissionState: "submitting" } }
        );
        const paths = jobPaths(environment.jobRoot, "job_submission_accepted");
        const running = readJsonOrNull(paths.metaPath);
        assert.equal(submission.accepted, true);
        assert.equal(running.state, "running");
        assert.equal(running.submissionState, "accepted");
        assert.ok(running.threadId);
        assert.ok(running.turnId);
        assert.equal(running.executionBackend, "codex-app-server");
        assert.equal(running.metaRevision, 2);
        const completed = await environment.waitJob("job_submission_accepted");
        assert.equal(completed.state, "completed");
        assert.equal(completed.submissionState, "accepted");
        assert.equal(completed.metaRevision, 3);
    } finally { await environment.close(); }
});

test("explicit start failure marks submission rejected", async () => {
    const environment = await createEnvironment();
    const failingProject = path.join(environment.tempRoot, "fake-thread-fail");
    fs.mkdirSync(failingProject);
    try {
        await assert.rejects(
            environment.submit("job_submission_rejected", "ignored", failingProject, { meta: { submissionState: "submitting" } }),
            error => error.code === "CODEX_RPC_ERROR"
        );
        const meta = await environment.waitJob("job_submission_rejected");
        assert.equal(meta.state, "failed");
        assert.equal(meta.submissionState, "rejected");
        assert.equal(meta.errorCode, "CODEX_TURN_START_FAILED");
        assert.equal(meta.metaRevision, 1);
    } finally { await environment.close(); }
});

test("Sidecar-owned timeout finalizes an active turn", async () => {
    const environment = await createEnvironment();
    try {
        await environment.submit("job_timeout_active", "[[DELAY_MS=5000]][[FINAL=late]]", environment.projectRoot, { timeoutSec: 0.05 });
        const state = readJsonOrNull(environment.paths.statePath);
        const meta = await environment.waitJob("job_timeout_active");
        assert.equal(meta.state, "timeout");
        assert.equal(meta.exitCode, null);
        assert.equal(meta.errorCode, "JOB_TIMEOUT");
        assert.ok(meta.completedAt);
        assert.equal(meta.metaRevision, 3);
        assert.equal(isPidAlive(state.pid), true);
        assert.equal(isPidAlive(state.codexPid), true);
        await environment.submit("job_timeout_other", "[[FINAL=other]]", environment.projectRoot, { timeoutSec: 1 });
        assert.equal((await environment.waitJob("job_timeout_other")).state, "completed");
        assert.equal(readJsonOrNull(environment.paths.statePath).pid, state.pid);
    } finally { await environment.close(); }
});

test("timeout before turn binding still finalizes", async () => {
    const environment = await createEnvironment();
    let submission;
    try {
        submission = environment.submit(
            "job_timeout_unbound",
            "[[NO_TURN_RESPONSE]][[FINAL=never-bound]]",
            environment.projectRoot,
            { meta: { submissionState: "submitting" }, timeoutSec: 0.5 }
        );
        await waitFor(() => readJsonOrNull(jobPaths(environment.jobRoot, "job_timeout_unbound").metaPath)?.state === "running", 1500);
        const state = readJsonOrNull(environment.paths.statePath);
        const meta = await environment.waitJob("job_timeout_unbound");
        assert.equal(meta.state, "timeout");
        assert.equal(meta.submissionState, "submitting");
        assert.equal(meta.turnId, undefined);
        assert.equal(meta.exitCode, null);
        assert.equal(meta.errorCode, "JOB_TIMEOUT");
        assert.equal(meta.metaRevision, 2);
        assert.equal(isPidAlive(state.pid), true);
        assert.equal(isPidAlive(state.codexPid), true);
        await environment.submit("job_after_unbound_timeout", "[[FINAL=after]]", environment.projectRoot, { timeoutSec: 1 });
        assert.equal((await environment.waitJob("job_after_unbound_timeout")).state, "completed");
    } finally {
        await environment.close();
        if (submission) await Promise.allSettled([submission]);
    }
});

test("completed wins before timeout", async () => {
    const environment = await createEnvironment();
    try {
        await environment.submit("job_completed_before_timeout", "[[DELAY_MS=40]][[FINAL=fast]]", environment.projectRoot, { timeoutSec: 0.4 });
        const meta = await environment.waitJob("job_completed_before_timeout");
        assert.equal(meta.state, "completed");
        assert.equal(meta.exitCode, 0);
        assert.equal(meta.errorCode, undefined);
        assert.equal(meta.metaRevision, 3);
        await delay(500);
        assert.equal(readJsonOrNull(jobPaths(environment.jobRoot, "job_completed_before_timeout").metaPath).state, "completed");
    } finally { await environment.close(); }
});

test("timeout wins over late completed", async () => {
    const environment = await createEnvironment();
    try {
        await environment.submit("job_timeout_late_completed", "[[IGNORE_INTERRUPT]][[DELAY_MS=250]][[FINAL=late]]", environment.projectRoot, { timeoutSec: 0.05 });
        const meta = await environment.waitJob("job_timeout_late_completed");
        assert.equal(meta.state, "timeout");
        assert.equal(meta.exitCode, null);
        assert.equal(meta.errorCode, "JOB_TIMEOUT");
    } finally { await environment.close(); }
});

test("cancel and timeout obey terminal first wins", async () => {
    const environment = await createEnvironment();
    try {
        // Timeout starts before submit returns; keep a wide margin so this branch
        // deterministically proves cancel-first rather than host scheduling speed.
        await environment.submit("job_cancel_wins", "[[DELAY_MS=1000]][[FINAL=cancelled]]", environment.projectRoot, { timeoutSec: 3 });
        assert.deepEqual(await environment.client.cancel({ jobId: "job_cancel_wins" }), { cancelled: true, jobId: "job_cancel_wins", state: "cancelled" });
        assert.equal((await environment.waitJob("job_cancel_wins")).state, "cancelled");

        await environment.submit("job_timeout_wins", "[[IGNORE_INTERRUPT]][[DELAY_MS=1000]][[FINAL=timeout]]", environment.projectRoot, { timeoutSec: 0.05 });
        await delay(100);
        const lateCancel = await environment.client.cancel({ jobId: "job_timeout_wins" });
        assert.deepEqual(lateCancel, { cancelled: false, alreadyTerminal: true, state: "timeout" });
        assert.equal((await environment.waitJob("job_timeout_wins")).state, "timeout");
    } finally { await environment.close(); }
});

test("terminal cleanup clears timeout timers", async () => {
    const environment = await createEnvironment();
    const server = new SidecarServer({ pluginDir: environment.pluginDir, jobRoot: environment.jobRoot });
    const paths = createMeta(environment.jobRoot, "job_timer_cleanup");
    const job = {
        jobId: "job_timer_cleanup",
        paths,
        state: "running",
        terminal: false,
        timeoutTimer: setTimeout(() => {}, 10000),
        timeoutFinalizeTimer: setTimeout(() => {}, 10000),
        cancelTimeoutTimer: setTimeout(() => {}, 10000),
        terminalPromise: Promise.resolve(),
        resolveTerminal() {}
    };
    server.state = { status: "ready", instanceId: "timer-instance" };
    server._updateMeta = async () => {};
    server.activeJobs.set(job.jobId, job);
    try {
        await server._finishJob(job, "completed", 0, null);
        assert.equal(job.timeoutTimer, null);
        assert.equal(job.timeoutFinalizeTimer, null);
        assert.equal(job.cancelTimeoutTimer, null);
        assert.equal(server.activeJobs.has(job.jobId), false);
    } finally {
        server.activeJobs.clear();
        await environment.close();
    }
});

test("dead Sidecar reconciliation fails every old-instance running Job", async () => {
    const environment = await createEnvironment();
    try {
        const submissions = [
            environment.submit("job_dead_sidecar_a", "[[DELAY_MS=5000]][[FINAL=A]]"),
            environment.submit("job_dead_sidecar_b", "[[DELAY_MS=5000]][[FINAL=B]]")
        ];
        await waitFor(() => ["job_dead_sidecar_a", "job_dead_sidecar_b"].every(id => readJsonOrNull(jobPaths(environment.jobRoot, id).metaPath)?.state === "running"));
        const oldState = readJsonOrNull(environment.paths.statePath);
        const oldChild = environment.client.sidecarChild;
        assert.ok(oldChild);
        assert.equal(sameProcessIdentity(oldState.processIdentity, oldChild.processIdentity), true);
        const stopped = await terminateOwnedChild(oldChild, { identity: oldState.processIdentity, gracefulTimeoutMs: 250 });
        assert.equal(stopped.confirmed, true);
        await waitFor(() => oldChild.exitCode !== null || oldChild.signalCode !== null || !isPidAlive(oldState.pid));
        await Promise.allSettled(submissions);
        const recovered = await environment.client.ensure();
        assert.notEqual(recovered.instanceId, oldState.instanceId);
        for (const id of ["job_dead_sidecar_a", "job_dead_sidecar_b"]) {
            const meta = readJsonOrNull(jobPaths(environment.jobRoot, id).metaPath);
            assert.equal(meta.state, "failed");
            assert.equal(meta.errorCode, "SIDECAR_PROCESS_EXITED");
            assert.equal(meta.exitReason, "Sidecar process exited before Job completion");
        }
    } finally { await environment.close(); }
});

test("reconciliation ignores other instances, legacy exec, args files, and terminal Jobs", async () => {
    const environment = await createEnvironment();
    try {
        const oldState = { instanceId: "old-instance" };
        for (const [id, extra] of [
            ["job_reconcile_old", { state: "running", executionBackend: "codex-app-server", sidecarInstanceId: "old-instance" }],
            ["job_reconcile_other", { state: "running", executionBackend: "codex-app-server", sidecarInstanceId: "other-instance" }],
            ["job_reconcile_legacy", { state: "running", executionBackend: "legacy-exec", sidecarInstanceId: "old-instance" }],
            ["job_reconcile_terminal", { state: "completed", executionBackend: "codex-app-server", sidecarInstanceId: "old-instance" }]
        ]) createMeta(environment.jobRoot, id, extra);
        writeJsonAtomic(path.join(environment.jobRoot, "meta", "job_reconcile_args.args.json"), { state: "running", executionBackend: "codex-app-server", sidecarInstanceId: "old-instance" });
        assert.deepEqual(await reconcileDeadSidecarJobs(environment.jobRoot, oldState), { reconciled: 1, complete: true, failures: [] });
        assert.equal(readJsonOrNull(jobPaths(environment.jobRoot, "job_reconcile_old").metaPath).errorCode, "SIDECAR_PROCESS_EXITED");
        assert.equal(readJsonOrNull(jobPaths(environment.jobRoot, "job_reconcile_other").metaPath).state, "running");
        assert.equal(readJsonOrNull(jobPaths(environment.jobRoot, "job_reconcile_legacy").metaPath).state, "running");
        assert.equal(readJsonOrNull(jobPaths(environment.jobRoot, "job_reconcile_terminal").metaPath).state, "completed");
        assert.equal(readJsonOrNull(path.join(environment.jobRoot, "meta", "job_reconcile_args.args.json")).state, "running");
    } finally { await environment.close(); }
});

test("meta finalize failure keeps Job ownership and degrades Sidecar", async () => {
    const environment = await createEnvironment();
    const server = new SidecarServer({ pluginDir: environment.pluginDir, jobRoot: environment.jobRoot });
    const paths = createMeta(environment.jobRoot, "job_meta_finalize", { state: "running" });
    const terminalPromise = new Promise(resolve => { server._testResolveTerminal = resolve; });
    const job = {
        jobId: "job_meta_finalize",
        paths,
        state: "running",
        terminal: false,
        finalizationFailed: false,
        finalizationError: null,
        terminalPromise,
        resolveTerminal: server._testResolveTerminal
    };
    server.state = { status: "ready", instanceId: "test-instance" };
    server.activeJobs.set(job.jobId, job);
    server._updateMeta = async () => { throw new SidecarError("META_WRITE_FAILED", "injected meta failure"); };
    try {
        await assert.rejects(server._finishJob(job, "completed", 0, null), error => error.code === "META_FINALIZE_FAILED");
        assert.equal(server.activeJobs.get(job.jobId), job);
        assert.equal(job.finalizationFailed, true);
        assert.equal(job.state, "finalizationFailed");
        assert.equal(server.status().status, "degraded");
        assert.equal(readJsonOrNull(paths.metaPath).state, "running");
    } finally {
        server.activeJobs.clear();
        await environment.close();
    }
});

test("compare-and-delete does not remove a replacement Sidecar state", async () => {
    const environment = await createEnvironment();
    try {
        const oldState = stateFixture(environment, { instanceId: "old", controlToken: "old-token" });
        const newState = stateFixture(environment, { instanceId: "new", controlToken: "new-token", pid: 2147483646 });
        writeJsonAtomic(environment.paths.statePath, newState);
        assert.equal(await environment.client._cleanDeadState(oldState), false);
        assert.deepEqual(readJsonOrNull(environment.paths.statePath), newState);
    } finally { await environment.close(); }
});

test("reconciliation reports partial meta update failure and ensure preserves state", async () => {
    const environment = await createEnvironment();
    try {
        const oldState = stateFixture(environment, { instanceId: "old-update", controlToken: "old-token" });
        const failedPaths = createMeta(environment.jobRoot, "job_update_failure", { state: "running", executionBackend: "codex-app-server", sidecarInstanceId: oldState.instanceId });
        const goodPaths = createMeta(environment.jobRoot, "job_update_success", { state: "running", executionBackend: "codex-app-server", sidecarInstanceId: oldState.instanceId });
        writeJsonAtomic(environment.paths.statePath, oldState);
        environment.client.reconcileOptions = {
            updateJobMetaLocked(jobRoot, jobId, metaPath, updater) {
                if (metaPath === failedPaths.metaPath) throw new Error("injected update failure");
                return updateJobMetaLocked(jobRoot, jobId, metaPath, updater);
            }
        };
        await assert.rejects(environment.client.ensure(), error => error.code === "SIDECAR_RECONCILIATION_FAILED");
        assert.deepEqual(readJsonOrNull(environment.paths.statePath), oldState);
        assert.equal(readJsonOrNull(failedPaths.metaPath).state, "running");
        assert.equal(readJsonOrNull(goodPaths.metaPath).errorCode, "SIDECAR_PROCESS_EXITED");
    } finally { await environment.close(); }
});

test("concurrent locked meta updates preserve fields and increment revision", async () => {
    const environment = await createEnvironment();
    try {
        const paths = createMeta(environment.jobRoot, "job_meta_concurrent");
        await Promise.all([
            updateJobMetaLocked(environment.jobRoot, "job_meta_concurrent", paths.metaPath, async meta => {
                await delay(60);
                meta.firstWriter = true;
                return meta;
            }),
            updateJobMetaLocked(environment.jobRoot, "job_meta_concurrent", paths.metaPath, async meta => {
                meta.secondWriter = true;
                return meta;
            })
        ]);
        const meta = readJsonOrNull(paths.metaPath);
        assert.equal(meta.firstWriter, true);
        assert.equal(meta.secondWriter, true);
        assert.equal(meta.userField, "preserve-me");
        assert.equal(meta.metaRevision, 2);
    } finally { await environment.close(); }
});

test("held meta lock fails closed without overwriting", async () => {
    const environment = await createEnvironment();
    try {
        const paths = createMeta(environment.jobRoot, "job_meta_busy");
        await withJobMetaLock(environment.jobRoot, "job_meta_busy", async () => {
            await assert.rejects(
                updateJobMetaLocked(environment.jobRoot, "job_meta_busy", paths.metaPath, meta => { meta.overwritten = true; return meta; }, { waitMs: 0 }),
                error => error.code === "SIDECAR_META_LOCK_BUSY"
            );
        });
        assert.equal(readJsonOrNull(paths.metaPath).overwritten, undefined);
    } finally { await environment.close(); }
});

test("malformed and stale meta locks are never auto-taken over", async () => {
    const environment = await createEnvironment();
    try {
        const paths = createMeta(environment.jobRoot, "job_meta_stale_lock");
        const lockPath = metaLockPath(environment.jobRoot, "job_meta_stale_lock");
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(lockPath, "{malformed", "utf8");
        await assert.rejects(updateJobMetaLocked(environment.jobRoot, "job_meta_stale_lock", paths.metaPath, meta => meta), error => error.code === "SIDECAR_META_LOCK_INVALID");
        assert.equal(fs.readFileSync(lockPath, "utf8"), "{malformed");
        writeJsonAtomic(lockPath, {
            ownerToken: "dead-meta", pid: 2147483647,
            processIdentity: { pid: 2147483647, startTime: "dead" }, createdAt: Date.now() - 10000
        });
        await assert.rejects(updateJobMetaLocked(environment.jobRoot, "job_meta_stale_lock", paths.metaPath, meta => meta), error => error.code === "SIDECAR_META_LOCK_STALE");
        assert.equal(readJsonOrNull(paths.metaPath).metaRevision, undefined);
    } finally { await environment.close(); }
});

test("meta lock owner token mismatch refuses to release another owner", async () => {
    const environment = await createEnvironment();
    try {
        await assert.rejects(
            withJobMetaLock(environment.jobRoot, "job_meta_owner_mismatch", async ({ lockPath }) => {
                const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
                writeJsonAtomic(lockPath, { ...current, ownerToken: "different-owner" });
            }),
            error => error.code === "SIDECAR_META_LOCK_RELEASE_FAILED"
        );
        assert.equal(JSON.parse(fs.readFileSync(metaLockPath(environment.jobRoot, "job_meta_owner_mismatch"), "utf8")).ownerToken, "different-owner");
    } finally { await environment.close(); }
});

test("reconciliation skips a terminal replacement inside the meta lock", async () => {
    const environment = await createEnvironment();
    try {
        const paths = createMeta(environment.jobRoot, "job_meta_terminal_race", {
            state: "running", executionBackend: "codex-app-server", sidecarInstanceId: "old-race", unknownField: "keep"
        });
        const result = await reconcileDeadSidecarJobs(environment.jobRoot, { instanceId: "old-race" }, {
            updateJobMetaLocked: async (jobRoot, jobId, metaPath, updater) => {
                await updateJobMetaLocked(jobRoot, jobId, metaPath, meta => {
                    meta.state = "completed";
                    meta.completedAt = "terminal-wins";
                    return meta;
                });
                return updateJobMetaLocked(jobRoot, jobId, metaPath, updater);
            }
        });
        const meta = readJsonOrNull(paths.metaPath);
        assert.deepEqual(result, { reconciled: 0, complete: true, failures: [] });
        assert.equal(meta.state, "completed");
        assert.equal(meta.completedAt, "terminal-wins");
        assert.equal(meta.unknownField, "keep");
        assert.equal(meta.metaRevision, 1);
    } finally { await environment.close(); }
});

test("reconciliation skips an instance replacement inside the meta lock", async () => {
    const environment = await createEnvironment();
    try {
        const paths = createMeta(environment.jobRoot, "job_meta_instance_race", {
            state: "running", executionBackend: "codex-app-server", sidecarInstanceId: "old-instance"
        });
        const result = await reconcileDeadSidecarJobs(environment.jobRoot, { instanceId: "old-instance" }, {
            updateJobMetaLocked: async (jobRoot, jobId, metaPath, updater) => {
                await updateJobMetaLocked(jobRoot, jobId, metaPath, meta => { meta.sidecarInstanceId = "new-instance"; return meta; });
                return updateJobMetaLocked(jobRoot, jobId, metaPath, updater);
            }
        });
        assert.deepEqual(result, { reconciled: 0, complete: true, failures: [] });
        assert.equal(readJsonOrNull(paths.metaPath).sidecarInstanceId, "new-instance");
        assert.equal(readJsonOrNull(paths.metaPath).state, "running");
    } finally { await environment.close(); }
});

test("one reconciliation meta lock failure is partial while other Jobs continue", async () => {
    const environment = await createEnvironment();
    try {
        const failed = createMeta(environment.jobRoot, "job_meta_lock_failure", {
            state: "running", executionBackend: "codex-app-server", sidecarInstanceId: "old-lock"
        });
        const good = createMeta(environment.jobRoot, "job_meta_lock_success", {
            state: "running", executionBackend: "codex-app-server", sidecarInstanceId: "old-lock"
        });
        const lockPath = metaLockPath(environment.jobRoot, "job_meta_lock_failure");
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        writeJsonAtomic(lockPath, {
            ownerToken: "dead-meta", pid: 2147483647,
            processIdentity: { pid: 2147483647, startTime: "dead" }, createdAt: Date.now() - 10000
        });
        const result = await reconcileDeadSidecarJobs(environment.jobRoot, { instanceId: "old-lock" });
        assert.equal(result.complete, false);
        assert.deepEqual(result.failures, [{ jobId: "job_meta_lock_failure", code: "META_UPDATE_FAILED" }]);
        assert.equal(readJsonOrNull(failed.metaPath).state, "running");
        assert.equal(readJsonOrNull(good.metaPath).state, "failed");
        assert.equal(readJsonOrNull(good.metaPath).errorCode, "SIDECAR_PROCESS_EXITED");
    } finally { await environment.close(); }
});

test("meta directory read failure makes reconciliation incomplete and preserves state", async () => {
    const environment = await createEnvironment();
    try {
        const oldState = stateFixture(environment, { instanceId: "old-readdir", controlToken: "old-token" });
        writeJsonAtomic(environment.paths.statePath, oldState);
        environment.client.reconcileOptions = { hooks: { readdirSync() { throw Object.assign(new Error("injected readdir failure"), { code: "EACCES" }); } } };
        await assert.rejects(environment.client.ensure(), error => error.code === "SIDECAR_RECONCILIATION_FAILED");
        assert.deepEqual(readJsonOrNull(environment.paths.statePath), oldState);
    } finally { await environment.close(); }
});

test("cleanup waits for startup lock and does not delete while another owner holds it", async () => {
    const environment = await createEnvironment();
    try {
        environment.client.lockWaitMs = 1000;
        const oldState = stateFixture(environment, { instanceId: "old-lock-wait", controlToken: "old-token" });
        writeJsonAtomic(environment.paths.statePath, oldState);
        const holder = environment.client._tryAcquireLock();
        assert.ok(holder);
        const result = await environment.client._cleanDeadState(oldState);
        assert.equal(result, false);
        assert.deepEqual(readJsonOrNull(environment.paths.statePath), oldState);
        assert.equal(fs.existsSync(environment.paths.lockPath), true);
        environment.client._releaseLock(holder);
    } finally { await environment.close(); }
});

test("held startup lock is reused by cleanup without self-deadlock", async () => {
    const environment = await createEnvironment();
    try {
        const oldState = stateFixture(environment, { instanceId: "old-held", controlToken: "old-token" });
        writeJsonAtomic(environment.paths.statePath, oldState);
        const lock = environment.client._tryAcquireLock();
        assert.ok(lock);
        assert.equal(await environment.client._cleanDeadState(oldState, lock), true);
        assert.equal(fs.existsSync(environment.paths.statePath), false);
        assert.equal(fs.existsSync(environment.paths.lockPath), true);
        environment.client._releaseLock(lock);
    } finally { await environment.close(); }
});

test("cleanup rejects replacement injected after final confirmation and preserves new state", async () => {
    const environment = await createEnvironment();
    try {
        const oldState = stateFixture(environment, { instanceId: "old-final-check", controlToken: "old-token" });
        const newState = stateFixture(environment, { instanceId: "new-final-check", controlToken: "new-token", pid: 2147483646 });
        writeJsonAtomic(environment.paths.statePath, oldState);
        environment.client.cleanupHooks.afterFinalStateCheck = () => writeJsonAtomic(environment.paths.statePath, newState);
        assert.equal(await environment.client._cleanDeadState(oldState), false);
        assert.deepEqual(readJsonOrNull(environment.paths.statePath), newState);
    } finally { await environment.close(); }
});

test("cleanup refuses a held lock with a mismatched owner token", async () => {
    const environment = await createEnvironment();
    try {
        const oldState = stateFixture(environment, { instanceId: "old-owner", controlToken: "old-token" });
        writeJsonAtomic(environment.paths.statePath, oldState);
        const lock = environment.client._tryAcquireLock();
        assert.ok(lock);
        assert.equal(await environment.client._cleanDeadState(oldState, { ownerToken: "wrong-owner" }), false);
        assert.deepEqual(readJsonOrNull(environment.paths.statePath), oldState);
        environment.client._releaseLock(lock);
    } finally { await environment.close(); }
});

test("two clients reconcile one dead state and start one replacement instance", async () => {
    const environment = await createEnvironment();
    try {
        const oldState = stateFixture(environment, { instanceId: "old-concurrent", controlToken: "old-token" });
        writeJsonAtomic(environment.paths.statePath, oldState);
        const options = {
            pluginDir: environment.pluginDir,
            jobRoot: environment.jobRoot,
            entryPath,
            codexBin: nodeExecutable,
            codexGlobalArgs: [fixturePath],
            startupTimeoutMs: 10000,
            lockWaitMs: 3000
        };
        const clients = [new (require("../appserver/sidecarClient").SidecarClient)(options), new (require("../appserver/sidecarClient").SidecarClient)(options)];
        const [first, second] = await Promise.all([clients[0].ensure(), clients[1].ensure()]);
        assert.equal(first.instanceId, second.instanceId);
        assert.notEqual(first.instanceId, oldState.instanceId);
    } finally { await environment.close(); }
});

test("degraded Sidecar is observable but never treated as ready", async () => {
    const environment = await createEnvironment();
    try {
        await environment.submit("job_degraded", "[[DELAY_MS=1000]][[CRASH_AFTER_MS=100]][[FINAL=crashed]]");
        await environment.waitJob("job_degraded");
        assert.equal((await environment.client.status()).status, "degraded");
        await assert.rejects(environment.client.submitAnalyzeJob({ jobId: "job_after_degraded", projectPath: environment.projectRoot }), error => error.code === "SIDECAR_DEGRADED");
    } finally { await environment.close(); }
});

test("owned child already exited never runs the force timer", async () => {
    const child = mockChild({ exited: true });
    const result = await terminateOwnedChild(child, { gracefulTimeoutMs: 5 });
    assert.equal(result.alreadyExited, true);
    assert.deepEqual(child.killCalls, []);
});

test("identity mismatch and unavailable identity never force-kill", async () => {
    const mismatch = mockChild();
    const current = getProcessIdentity(process.pid);
    const oldIdentity = { pid: process.pid, ...(current?.startTimeTicks ? { startTimeTicks: "mismatch" } : { startTime: "mismatch" }) };
    const mismatchResult = await terminateOwnedChild(mismatch, { identity: oldIdentity, gracefulTimeoutMs: 1 });
    assert.equal(mismatchResult.identityMismatch, true);
    assert.deepEqual(mismatch.killCalls, []);

    const unknown = mockChild({ pid: 2147483647 });
    const unknownResult = await terminateOwnedChild(unknown, { identity: null, gracefulTimeoutMs: 1 });
    assert.equal(unknownResult.identityMismatch, true);
    assert.deepEqual(unknown.killCalls, ["SIGTERM"]);
});

function ownedTerminationFixture() {
    const child = mockChild();
    const identity = getProcessIdentity(process.pid);
    assert.ok(identity);
    return {
        child,
        identity,
        options: {
            identity,
            identityProvider: pid => getProcessIdentity(pid),
            gracefulTimeoutMs: 1,
            forceConfirmationTimeoutMs: 35,
            confirmationPollMs: 10
        }
    };
}

test("terminateOwnedChild strict process tree", {
    skip: process.platform !== "win32" && "requires Windows strict process-tree semantics"
}, async t => {
    await t.test("confirms tree termination only after the owned PID disappears", async () => {
        const fixture = ownedTerminationFixture();
        const treeKillCalls = [];
        let alive = true;
        const result = await terminateOwnedChild(fixture.child, {
            ...fixture.options,
            requireProcessTree: true,
            isPidAlive: () => alive,
            treeKill: (...args) => {
                treeKillCalls.push(args);
                alive = false;
                return true;
            }
        });

        assert.deepEqual(treeKillCalls, [[fixture.child.pid]]);
        assert.deepEqual(fixture.child.killCalls, []);
        assert.equal(alive, false);
        assert.equal(result.confirmed, true);
        assert.equal(result.processTreeRequired, true);
        assert.equal(result.treeTermination, "confirmed");
    });

    await t.test("does not report confirmation while the PID remains alive", async () => {
        const fixture = ownedTerminationFixture();
        let treeKillCalls = 0;
        const result = await terminateOwnedChild(fixture.child, {
            ...fixture.options,
            requireProcessTree: true,
            isPidAlive: () => true,
            treeKill: () => {
                treeKillCalls++;
                return true;
            }
        });

        assert.equal(treeKillCalls, 1);
        assert.deepEqual(fixture.child.killCalls, []);
        assert.equal(result.confirmed, false);
        assert.equal(result.processTreeRequired, true);
        assert.equal(result.treeTermination, "unconfirmed");
    });

    await t.test("does not tree-kill without an identity", async () => {
        const fixture = ownedTerminationFixture();
        let treeKillCalls = 0;
        const result = await terminateOwnedChild(fixture.child, {
            ...fixture.options,
            identity: null,
            requireProcessTree: true,
            isPidAlive: () => true,
            treeKill: () => {
                treeKillCalls++;
                return true;
            }
        });

        assert.equal(treeKillCalls, 0);
        assert.deepEqual(fixture.child.killCalls, []);
        assert.equal(result.confirmed, false);
        assert.equal(result.identityMissing, true);
        assert.equal(result.processTreeRequired, true);
    });

    await t.test("does not tree-kill after an identity mismatch", async () => {
        const fixture = ownedTerminationFixture();
        const mismatchedIdentity = {
            pid: fixture.child.pid,
            ...(fixture.identity.startTimeTicks
                ? { startTimeTicks: "mismatch" }
                : { startTime: "mismatch" })
        };
        let treeKillCalls = 0;
        const result = await terminateOwnedChild(fixture.child, {
            ...fixture.options,
            identity: mismatchedIdentity,
            requireProcessTree: true,
            isPidAlive: () => true,
            treeKill: () => {
                treeKillCalls++;
                return true;
            }
        });

        assert.equal(treeKillCalls, 0);
        assert.deepEqual(fixture.child.killCalls, []);
        assert.equal(result.confirmed, false);
        assert.equal(result.identityMismatch, true);
        assert.equal(result.processTreeRequired, true);
    });
});

test("force signal sent while child and PID remain alive is not confirmed", async () => {
    const fixture = ownedTerminationFixture();
    const result = await terminateOwnedChild(fixture.child, {
        ...fixture.options,
        isPidAlive: () => true,
        forceKill: () => true
    });
    assert.equal(result.forceSent, true);
    assert.equal(result.confirmed, false);
    assert.equal(result.stillAlive, true);
});

test("force signal followed by child exit/close is confirmed", async () => {
    const fixture = ownedTerminationFixture();
    const result = await terminateOwnedChild(fixture.child, {
        ...fixture.options,
        isPidAlive: () => true,
        forceKill: () => {
            setTimeout(() => {
                fixture.child.signalCode = "SIGKILL";
                fixture.child.emit("exit", null, "SIGKILL");
                fixture.child.emit("close", null, "SIGKILL");
            }, 5);
            return true;
        }
    });
    assert.equal(result.forceSent, true);
    assert.equal(result.confirmed, true);
    assert.equal(result.stillAlive, undefined);
});

test("force signal followed by PID disappearance is confirmed by bounded polling", async () => {
    const fixture = ownedTerminationFixture();
    let alive = true;
    const result = await terminateOwnedChild(fixture.child, {
        ...fixture.options,
        isPidAlive: () => alive,
        forceKill: () => {
            alive = false;
            return true;
        }
    });
    assert.equal(result.forceSent, true);
    assert.equal(result.confirmed, true);
    assert.equal(result.stillAlive, undefined);
});

test("legal no-jsonrpc notification is processed", async () => {
    const environment = await createEnvironment();
    try {
        await environment.submit("job_no_jsonrpc", "[[NO_JSONRPC]][[FINAL=no-jsonrpc]]");
        assert.equal((await environment.waitJob("job_no_jsonrpc")).state, "completed");
        assert.equal(fs.readFileSync(jobPaths(environment.jobRoot, "job_no_jsonrpc").codexOutputPath, "utf8"), "no-jsonrpc");
    } finally { await environment.close(); }
});

test("invalid JSON emits protocolError without crashing the JSONL connection", async () => {
    const child = mockChild();
    const connection = new JsonLineRpcConnection(child, { defaultTimeoutMs: 500 });
    let protocolErrors = 0;
    connection.on("protocolError", () => { protocolErrors++; });
    child.stdout.emit("data", "{invalid-json\n");
    await delay(10);
    assert.equal(protocolErrors, 1);
    assert.equal(connection.closed, false);
    connection.close("test");
});

test("JSONL buffer overflow emits protocolError and closes the connection", async () => {
    const child = mockChild();
    const connection = new JsonLineRpcConnection(child, { maxBufferBytes: 1024 });
    let overflow;
    connection.on("protocolError", error => { if (error.code === "PROTOCOL_BUFFER_OVERFLOW") overflow = error; });
    child.stdout.emit("data", "x".repeat(1025));
    await delay(10);
    assert.equal(overflow.code, "PROTOCOL_BUFFER_OVERFLOW");
    assert.equal(connection.closed, true);
    assert.equal(connection.buffer, "");
});

test("large delta volume does not duplicate delta payloads in the trace", async () => {
    const environment = await createEnvironment();
    try {
        await environment.submit("job_many_deltas", "[[DELTA_COUNT=2500]][[FINAL=x]]");
        assert.equal((await environment.waitJob("job_many_deltas")).state, "completed");
        const paths = jobPaths(environment.jobRoot, "job_many_deltas");
        assert.equal(fs.readFileSync(paths.codexOutputPath, "utf8").length, 2500);
        const trace = fs.readFileSync(paths.outputPath, "utf8");
        assert.equal(trace.includes('"delta"'), false);
        assert.ok(trace.length < 600000);
    } finally { await environment.close(); }
});
