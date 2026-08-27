"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");

const sourcePluginDir = path.resolve(__dirname, "..");
const sourceAppServerDir = path.join(sourcePluginDir, "appserver");
const sourceFixture = path.join(__dirname, "fixtures", "fake-codex-app-server.js");
const sourceMonitor = path.resolve(__dirname, "..", "..", "AICodeWorkerMonitor", "AICodeWorkerMonitor.js");

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await delay(25);
    }
    throw new Error("timed out waiting for isolated AICodeWorker condition");
}

function readJson(filePath) {
    try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
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

function writeLegacyScript(filePath, kind) {
    const script = kind === "exec"
        ? `const fs=require("fs");
const args=process.argv.slice(2);
const all=args.join(" ");
const match=all.match(/\\[\\[DELAY_MS=(\\d+)\\]\\]/);
const wait=match?Number(match[1]):20;
const outputIndex=args.indexOf("--output-last-message");
const output=outputIndex>=0?args[outputIndex+1]:null;
setTimeout(()=>{
  if(output) fs.writeFileSync(output,"legacy-final\\n【执行结果摘要】legacy complete\\n【读取文件清单】无\\n","utf8");
  process.stdout.write(JSON.stringify({type:"legacy-result"})+"\\n");
},wait);`
        : `const all=process.argv.slice(2).join(" ");
const match=all.match(/\\[\\[DELAY_MS=(\\d+)\\]\\]/);
setTimeout(()=>process.stdout.write(JSON.stringify({type:"opencode-result"})+"\\n"),match?Number(match[1]):20);`;
    fs.writeFileSync(filePath, script, "utf8");
}

async function createEnvironment(options = {}) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-aicodeworker-routing-"));
    const pluginDir = path.join(tempRoot, "plugin");
    const appserverDir = path.join(pluginDir, "appserver");
    const jobRoot = path.join(pluginDir, "jobs");
    const projectRoot = path.join(tempRoot, "project");
    const codexHome = path.join(tempRoot, "codex-home");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.cpSync(sourceAppServerDir, appserverDir, { recursive: true });
    fs.copyFileSync(path.join(sourcePluginDir, "runner.js"), path.join(pluginDir, "runner.js"));
    fs.copyFileSync(sourceFixture, path.join(pluginDir, "fake-codex-app-server.js"));
    fs.writeFileSync(
        path.join(pluginDir, "app-server"),
        options.badAppServer
            ? "if (process.argv.includes('--version')) process.exit(17); process.argv.splice(2, 0, 'app-server'); process.exit(17);"
            : "if (process.argv.includes('--version')) { process.stdout.write('fake-codex 1.0.0\\n'); process.exit(0); } process.argv.splice(2, 0, 'app-server'); require('./fake-codex-app-server.js');",
        "utf8"
    );
    const workerPath = path.join(pluginDir, "AICodeWorker.js");
    const workerSource = fs.readFileSync(path.join(sourcePluginDir, "AICodeWorker.js"), "utf8");
    const sidecarFixturePattern = /        codexBin: CFG\.codexBin,\r?\n        maxConcurrency/;
    if (!sidecarFixturePattern.test(workerSource)) {
        try {
            fs.rmSync(tempRoot, {
                recursive: true,
                force: true,
                maxRetries: 5,
                retryDelay: 100
            });
        } catch {}
        throw new Error("routing fixture could not locate Sidecar client construction");
    }
    fs.writeFileSync(
        workerPath,
        workerSource.replace(
            sidecarFixturePattern,
            "        codexBin: CFG.codexBin,\n        codexGlobalArgs: [path.join(__dirname, 'app-server')],\n        maxConcurrency"
        ),
        "utf8"
    );
    writeLegacyScript(path.join(projectRoot, "exec"), "exec");
    writeLegacyScript(path.join(projectRoot, "run"), "run");
    const flagLine = Object.prototype.hasOwnProperty.call(options, "flag")
        ? `ENABLE_CODEX_APP_SERVER_ANALYZE=${options.flag}\n`
        : "";
    fs.writeFileSync(path.join(pluginDir, "config.env"), [
        "ENABLE_OPENCODE=true",
        "ENABLE_MIMOCODE=false",
        `OPENCODE_BIN=${process.execPath}`,
        "OPENCODE_BASE_URL=",
        "OPENCODE_API_KEY=",
        "OPENCODE_MODEL=",
        "ENABLE_CODEX=true",
        flagLine.trimEnd(),
        `CODEX_BIN=${process.execPath}`,
        `CODEX_HOME=${codexHome}`,
        `ALLOWED_PROJECT_ROOTS=${projectRoot}`,
        `JOB_ROOT=${jobRoot}`,
        "DEFAULT_TIMEOUT_SEC=5",
        "MAX_TASK_CHARS=20000",
        "MAX_CONCURRENT_JOBS=1",
        "DEFAULT_TRACE_MODE=events",
        `TRACE_MAX_EVENTS=${Object.prototype.hasOwnProperty.call(options, "traceMaxEvents") ? options.traceMaxEvents : 60}`,
        "TRACE_EVENT_TEXT_CHARS=800",
        "TRACE_RAW_MAX_CHARS=16000",
        "REDACT_SECRETS=true",
        "ENABLE_ANTIGRAVITY=false",
        "AGY_BIN=",
        "AGY_MODEL=",
        "AGY_PROXY="
    ].filter(Boolean).join("\n") + "\n", "utf8");

    const children = new Set();
    async function invoke(input, timeoutMs = 15000) {
        return new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [workerPath], {
                cwd: pluginDir,
                env: { ...process.env },
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true
            });
            children.add(child);
            let stdout = "";
            let stderr = "";
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                child.kill();
                reject(new Error(`isolated AICodeWorker timed out: ${input.command}`));
            }, timeoutMs);
            child.stdout.on("data", chunk => { stdout += String(chunk); });
            child.stderr.on("data", chunk => { stderr += String(chunk); });
            child.once("error", error => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                children.delete(child);
                reject(error);
            });
            child.once("close", code => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                children.delete(child);
                try {
                    const parsed = JSON.parse(stdout.trim());
                    resolve({ ...parsed, __stderr: stderr, __exitCode: code });
                } catch (error) {
                    reject(new Error(`invalid isolated response (${code}): ${stdout} ${stderr}`));
                }
            });
            child.stdin.end(JSON.stringify(input));
        });
    }

    const protocol = require(path.join(appserverDir, "protocol.js"));
    async function cleanup() {
        for (const child of children) child.kill();
        const statePath = protocol.runtimePaths(pluginDir, jobRoot).statePath;
        const state = readJson(statePath);
        const pids = new Set([state?.pid, state?.codexPid].filter(Boolean));
        const identities = new Map([
            [state?.pid, state?.processIdentity],
            [state?.codexPid, state?.codexProcessIdentity]
        ]);
        if (state) {
            try {
                const client = new (require(path.join(appserverDir, "sidecarClient.js")).SidecarClient)({
                    pluginDir,
                    jobRoot,
                    codexBin: process.execPath,
                    requestTimeoutMs: 1000,
                    connectTimeoutMs: 500
                });
                await client.shutdown();
            } catch {}
            try { await waitFor(() => !fs.existsSync(statePath), 4000); } catch {}
        }
        for (const pid of pids) {
            if (!protocol.isPidAlive(pid)) continue;
            const identity = identities.get(pid);
            if (identity && protocol.sameProcessIdentity(identity, protocol.getProcessIdentity(pid))) {
                try { protocol.terminateExactPid(pid, true); } catch {}
            }
        }
        await delay(100);
        await removeTestRoot(tempRoot, "routing fixture");
    }
    return { tempRoot, pluginDir, jobRoot, projectRoot, workerPath, invoke, cleanup };
}

function metaPath(environment, jobId) {
    return path.join(environment.jobRoot, "meta", `${jobId}.json`);
}

async function waitForMeta(environment, jobId, terminal = false) {
    await waitFor(() => {
        const meta = readJson(metaPath(environment, jobId));
        return Boolean(meta && (!terminal || ["completed", "failed", "cancelled", "timeout"].includes(meta.state)));
    });
    return readJson(metaPath(environment, jobId));
}

function resultOf(response) {
    return response.status === "success" ? response.result : response;
}

test("generateJobId stays unique in one second and matches the structured format", async () => {
    const environment = await createEnvironment({ flag: "false" });
    try {
        const worker = require(environment.workerPath);
        const ids = Array.from({ length: 128 }, () => worker.generateJobId());
        assert.equal(new Set(ids).size, ids.length);
        for (const id of ids) {
            assert.match(id, /^job_\d{8}_\d{6}_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        }
    } finally {
        await environment.cleanup();
    }
});

test("TRACE_MAX_EVENTS=1 returns exactly one omitted event with the correct count", async () => {
    const environment = await createEnvironment({ flag: "false", traceMaxEvents: 1 });
    try {
        const worker = require(environment.workerPath);
        const capped = worker.capTraceEvents([
            { type: "first" },
            { type: "middle" },
            { type: "last" },
            { type: "extra" }
        ]);
        assert.equal(capped.length, 1);
        assert.deepEqual(capped[0], { type: "omitted", count: 3, text: "中间轨迹已省略" });
    } finally {
        await environment.cleanup();
    }
});

test("resolveRunAndWaitAfterWait returns terminal legacy meta after one cancel without reconcile", async () => {
    const environment = await createEnvironment({ flag: "false" });
    try {
        const worker = require(environment.workerPath);
        let reads = 0;
        let cancelCalls = 0;
        let reconcileCalls = 0;
        const result = await worker.resolveRunAndWaitAfterWait("job_legacy_cancel", {}, {
            readMeta: () => {
                reads++;
                return reads === 1
                    ? { jobId: "job_legacy_cancel", state: "running", executionBackend: "legacy-exec" }
                    : { jobId: "job_legacy_cancel", state: "cancelled", executionBackend: "legacy-exec" };
            },
            cancel: () => {
                cancelCalls++;
                return { status: "success", state: "cancelled" };
            },
            reconcile: () => {
                reconcileCalls++;
            },
            buildResult: (jobId, meta) => ({ status: "success", jobId, state: meta.state }),
            buildTracePayload: () => ({ executionTrace: [] })
        });
        assert.equal(result.state, "cancelled");
        assert.equal(cancelCalls, 1);
        assert.equal(reconcileCalls, 0);
    } finally {
        await environment.cleanup();
    }
});

test("resolveRunAndWaitAfterWait reconciles app-server cancellation once and never creates a second Job", async () => {
    const environment = await createEnvironment({ flag: "false" });
    try {
        const worker = require(environment.workerPath);
        let currentMeta = { jobId: "job_app_cancel", state: "running", executionBackend: "codex-app-server" };
        let cancelCalls = 0;
        let reconcileCalls = 0;
        let secondJobCalls = 0;
        const result = await worker.resolveRunAndWaitAfterWait("job_app_cancel", {}, {
            readMeta: () => currentMeta,
            cancel: () => {
                cancelCalls++;
                return { status: "success", state: "running" };
            },
            reconcile: () => {
                reconcileCalls++;
                currentMeta = { ...currentMeta, state: "cancelled" };
            },
            run: () => {
                secondJobCalls++;
            },
            buildResult: (jobId, meta) => ({ status: "success", jobId, state: meta.state }),
            buildTracePayload: () => ({ executionTrace: [] })
        });
        assert.equal(result.state, "cancelled");
        assert.equal(cancelCalls, 1);
        assert.equal(reconcileCalls, 1);
        assert.equal(secondJobCalls, 0);
    } finally {
        await environment.cleanup();
    }
});

test("resolveRunAndWaitAfterWait reports unconfirmed cancellation for running or unknown meta", async () => {
    const environment = await createEnvironment({ flag: "false" });
    try {
        const worker = require(environment.workerPath);
        for (const scenario of [
            {
                name: "running",
                initial: { jobId: "job_running", state: "running", executionBackend: "codex-app-server" },
                afterCancel: { jobId: "job_running", state: "running", executionBackend: "codex-app-server" },
                cancelResult: { status: "success", state: "running" },
                expectedReconcile: 1
            },
            {
                name: "unknown",
                initial: null,
                afterCancel: null,
                cancelResult: { status: "error", errorCode: "SIDECAR_IPC_TIMEOUT", requestedExecutionBackend: "codex-app-server" },
                expectedReconcile: 1
            }
        ]) {
            let cancelCalls = 0;
            let reconcileCalls = 0;
            const result = await worker.resolveRunAndWaitAfterWait(`job_${scenario.name}`, {}, {
                readMeta: () => cancelCalls === 0 ? scenario.initial : scenario.afterCancel,
                cancel: () => {
                    cancelCalls++;
                    return scenario.cancelResult;
                },
                reconcile: () => {
                    reconcileCalls++;
                },
                buildTracePayload: () => ({ executionTrace: [] })
            });
            assert.equal(result.errorCode, "AICW_RUN_AND_WAIT_CANCEL_UNCONFIRMED");
            assert.equal(result.jobId, `job_${scenario.name}`);
            assert.equal(cancelCalls, 1, scenario.name);
            assert.equal(reconcileCalls, scenario.expectedReconcile, scenario.name);
            assert.equal(result.hint.includes("未生成第二个 Job"), true, scenario.name);
        }
    } finally {
        await environment.cleanup();
    }
});

test("fallback requires pre-Job absence and private owned-child termination evidence", async () => {
    const environment = await createEnvironment({ flag: "false" });
    try {
        const worker = require(environment.workerPath);
        const protocol = require(path.join(environment.pluginDir, "appserver", "protocol.js"));
        const error = new protocol.SidecarError("SIDECAR_START_FAILED", "startup failed", {
            safeToFallback: true,
            fallbackEvidence: "owned-child-termination-confirmed"
        });
        const absent = { status: "absent", activeJobs: 0, warnings: [] };
        assert.equal(worker.shouldFallbackToLegacyBeforeJob(error, absent, absent, { jobCreated: false, hasAppServerMeta: false }), false);
        assert.equal(worker.shouldFallbackToLegacyBeforeJob(error, absent, absent, { jobCreated: true, hasAppServerMeta: false }), false);
        assert.equal(worker.shouldFallbackToLegacyBeforeJob(error, absent, absent, { jobCreated: false, hasAppServerMeta: true }), false);
        assert.equal(worker.shouldFallbackToLegacyBeforeJob(
            new protocol.SidecarError("SIDECAR_IPC_TIMEOUT", "submission uncertain"),
            absent,
            absent,
            { jobCreated: false, hasAppServerMeta: false }
        ), false);
        assert.equal(worker.shouldFallbackToLegacyBeforeJob(
            new protocol.SidecarError("SIDECAR_START_FAILED", "no owned child", { safeToFallback: true, fallbackEvidence: "spawn-not-created" }),
            absent,
            absent,
            { jobCreated: false, hasAppServerMeta: false }
        ), false);
        assert.equal(worker.shouldFallbackToLegacyBeforeJob(
            new protocol.SidecarError("SIDECAR_START_FAILED", "ambiguous", { safeToFallback: false, fallbackEvidence: "owned-child-termination-confirmed" }),
            absent,
            absent,
            { jobCreated: false, hasAppServerMeta: false }
        ), false);
    } finally {
        await environment.cleanup();
    }
});

test("legacy cmdCancel reports AICW_CANCEL_UNCONFIRMED when a recorded PID survives force", async () => {
    const environment = await createEnvironment({ flag: "false" });
    try {
        const worker = require(environment.workerPath);
        const jobId = "job_legacy_cancel_unconfirmed";
        const meta = {
            jobId,
            state: "running",
            executionBackend: "legacy-exec",
            workerPid: 101,
            opencodePid: 202,
            pid: 303
        };
        const kills = [];
        const saved = [];
        let appended = 0;
        const result = await worker.cmdCancel({ jobId }, {
            reconcile: () => {},
            readMeta: () => ({ ...meta }),
            saveMeta: (id, value) => saved.push({ id, value }),
            isProcessRunning: () => true,
            kill: (pid, force) => kills.push({ pid, force }),
            sleep: () => {},
            confirmationTimeoutMs: 0,
            appendOutput: () => { appended++; }
        });
        assert.equal(result.status, "error");
        assert.equal(result.errorCode, "AICW_CANCEL_UNCONFIRMED");
        assert.equal(result.state, "running");
        assert.deepEqual(kills, [
            { pid: 101, force: false },
            { pid: 202, force: false },
            { pid: 303, force: false },
            { pid: 101, force: true },
            { pid: 202, force: true },
            { pid: 303, force: true }
        ]);
        assert.equal(saved.length, 0);
        assert.equal(appended, 0);
    } finally {
        await environment.cleanup();
    }
});

test("legacy cmdCancel writes cancelled only after all recorded PIDs disappear", async () => {
    const environment = await createEnvironment({ flag: "false" });
    try {
        const worker = require(environment.workerPath);
        const jobId = "job_legacy_cancel_confirmed";
        const meta = {
            jobId,
            state: "running",
            executionBackend: "legacy-exec",
            workerPid: 111,
            opencodePid: 222,
            pid: 333
        };
        const alive = new Set([111, 222, 333]);
        const saved = [];
        let appended = 0;
        const result = await worker.cmdCancel({ jobId }, {
            reconcile: () => {},
            readMeta: () => ({ ...meta }),
            saveMeta: (id, value) => saved.push({ id, value: { ...value } }),
            isProcessRunning: pid => alive.has(pid),
            kill: (pid, force) => { if (force) alive.delete(pid); },
            sleep: () => {},
            appendOutput: () => { appended++; }
        });
        assert.equal(result.status, "success");
        assert.equal(result.state, "cancelled");
        assert.equal(saved.length, 1);
        assert.equal(saved[0].id, jobId);
        assert.equal(saved[0].value.state, "cancelled");
        assert.equal(appended, 1);
    } finally {
        await environment.cleanup();
    }
});

test("legacy cmdCancel preserves a natural terminal state observed during cancellation", async () => {
    const environment = await createEnvironment({ flag: "false" });
    try {
        const worker = require(environment.workerPath);
        const jobId = "job_legacy_cancel_race";
        let currentMeta = {
            jobId,
            state: "running",
            executionBackend: "legacy-exec",
            workerPid: 404,
            pid: 505
        };
        const alive = new Set([404, 505]);
        const saved = [];
        let appended = 0;
        const result = await worker.cmdCancel({ jobId }, {
            reconcile: () => {},
            readMeta: () => ({ ...currentMeta }),
            saveMeta: (id, value) => saved.push({ id, value }),
            isProcessRunning: pid => alive.has(pid),
            kill: (pid, force) => {
                if (!force) {
                    currentMeta = { ...currentMeta, state: "completed" };
                    alive.clear();
                }
            },
            sleep: () => {},
            appendOutput: () => { appended++; }
        });
        assert.equal(result.status, "success");
        assert.equal(result.state, "completed");
        assert.equal(saved.length, 0);
        assert.equal(appended, 0);
    } finally {
        await environment.cleanup();
    }
});

test("resolveRunAndWaitAfterWait keeps cancel unconfirmed after the real legacy cmdCancel path", async () => {
    const environment = await createEnvironment({ flag: "false" });
    try {
        const worker = require(environment.workerPath);
        const jobId = "job_legacy_run_wait_cancel";
        const currentMeta = {
            jobId,
            state: "running",
            executionBackend: "legacy-exec",
            workerPid: 606,
            pid: 707
        };
        let cancelCalls = 0;
        let saved = 0;
        const cancelDependencies = {
            reconcile: () => {},
            readMeta: () => ({ ...currentMeta }),
            saveMeta: () => { saved++; },
            isProcessRunning: () => true,
            kill: () => {},
            sleep: () => {},
            confirmationTimeoutMs: 0,
            appendOutput: () => { throw new Error("cancel output must not be appended"); }
        };
        const result = await worker.resolveRunAndWaitAfterWait(jobId, {}, {
            readMeta: () => ({ ...currentMeta }),
            cancel: id => {
                cancelCalls++;
                return worker.cmdCancel({ jobId: id }, cancelDependencies);
            },
            reconcile: () => { throw new Error("legacy cancellation must not reconcile app-server jobs"); },
            buildTracePayload: () => ({ executionTrace: [] })
        });
        assert.equal(result.status, "error");
        assert.equal(result.errorCode, "AICW_RUN_AND_WAIT_CANCEL_UNCONFIRMED");
        assert.equal(result.state, "running");
        assert.equal(result.jobId, jobId);
        assert.equal(cancelCalls, 1);
        assert.equal(saved, 0);
        assert.equal(result.hint.includes("未生成第二个 Job"), true);
    } finally {
        await environment.cleanup();
    }
});

test("strict feature flag routes Codex analyze only when trimmed lowercase true", async () => {
    for (const flag of [undefined, "false", "1", "yes", "on", " TRUE "]) {
        const environment = await createEnvironment({ ...(flag === undefined ? {} : { flag }) });
        try {
            const response = await environment.invoke({
                command: "run",
                worker: "codex",
                mode: "analyze",
                projectPath: environment.projectRoot,
                task: `[[FINAL=flag-${String(flag)}]]`
            });
            if (flag === " TRUE ") {
                assert.equal(response.status, "success", `flag=${String(flag)} response=${JSON.stringify(response)}`);
                const meta = await waitForMeta(environment, resultOf(response).jobId, true);
                assert.equal(meta.executionBackend, "codex-app-server");
            } else {
                assert.equal(response.status, "success", `flag=${String(flag)} response=${JSON.stringify(response)}`);
                const meta = await waitForMeta(environment, resultOf(response).jobId, true);
                assert.equal(meta.executionBackend, "legacy-exec");
                assert.equal(fs.existsSync(path.join(environment.jobRoot, "runtime", "sidecar-state.json")), false);
            }
        } finally {
            await environment.cleanup();
        }
    }
});

test("enabled Codex analyze uses app-server safe trace and does not create args", async () => {
    const environment = await createEnvironment({ flag: "true" });
    try {
        const response = await environment.invoke({
            command: "run",
            worker: "codex",
            mode: "analyze",
            projectPath: environment.projectRoot,
            task: "[[DELAY_MS=80]][[FINAL=app-final]]",
            traceMode: "events"
        });
        assert.equal(response.status, "success");
        const jobId = resultOf(response).jobId;
        const meta = await waitForMeta(environment, jobId, true);
        assert.equal(meta.executionBackend, "codex-app-server");
        assert.equal(meta.requestedExecutionBackend, "codex-app-server");
        assert.equal(meta.submissionState, "accepted");
        assert.equal(meta.pid, null);
        assert.equal(meta.workerPid, null);
        assert.equal(fs.existsSync(path.join(environment.jobRoot, "meta", `${jobId}.args.json`)), false);
        const trace = resultOf(await environment.invoke({ command: "trace", jobId, traceMode: "events" }));
        assert.ok(trace.executionTrace.some(event => event.type === "appserver_event"));
        assert.match(trace.traceText, /turn\/(started|completed)/);
        const raw = resultOf(await environment.invoke({ command: "trace", jobId, traceMode: "raw" }));
        assert.doesNotMatch(raw.rawTrace, /app-final|DELAY_MS/);
    } finally {
        await environment.cleanup();
    }
});

test("app-server attachments are rejected before Job and Sidecar creation", async () => {
    const environment = await createEnvironment({ flag: "true" });
    try {
        const response = await environment.invoke({
            command: "run",
            worker: "codex",
            mode: "analyze",
            projectPath: environment.projectRoot,
            task: "attachment gate",
            attachments: ["image.png"]
        });
        assert.equal(response.status, "error");
        assert.equal(response.errorCode, "AICW_APPSERVER_ATTACHMENTS_UNSUPPORTED");
        assert.equal(fs.existsSync(path.join(environment.jobRoot, "runtime", "sidecar-state.json")), false);
        assert.equal(fs.existsSync(path.join(environment.jobRoot, "meta")), false);
    } finally {
        await environment.cleanup();
    }
});

test("Codex patch/write and non-Codex remain legacy", async () => {
    const environment = await createEnvironment({ flag: "true" });
    try {
        for (const input of [
            { worker: "codex", mode: "patch", task: "patch legacy" },
            { worker: "codex", mode: "write", task: "write legacy" },
            { worker: "opencode", mode: "analyze", task: "other worker" }
        ]) {
            const response = await environment.invoke({ command: "run", projectPath: environment.projectRoot, ...input });
            assert.equal(response.status, "success");
            const meta = await waitForMeta(environment, resultOf(response).jobId, true);
            assert.equal(meta.executionBackend, "legacy-exec");
            assert.equal(meta.requestedExecutionBackend, undefined);
        }
    } finally {
        await environment.cleanup();
    }
});

test("app-server concurrency is two and the third submission is rejected without fallback", async () => {
    const environment = await createEnvironment({ flag: "true" });
    try {
        const responses = await Promise.all([
            environment.invoke({ command: "run", worker: "codex", mode: "analyze", projectPath: environment.projectRoot, task: "[[DELAY_MS=1800]][[FINAL=A]]" }),
            environment.invoke({ command: "run", worker: "codex", mode: "analyze", projectPath: environment.projectRoot, task: "[[DELAY_MS=1800]][[FINAL=B]]" }),
            environment.invoke({ command: "run", worker: "codex", mode: "analyze", projectPath: environment.projectRoot, task: "[[DELAY_MS=1800]][[FINAL=C]]" })
        ]);
        const errors = responses.filter(response => response.status === "error");
        assert.equal(errors.length, 1);
        assert.equal(
            errors[0].errorCode,
            "AICW_APP_SERVER_CONCURRENCY_LIMIT",
            `unexpected error response=${JSON.stringify(errors[0])}`
        );
        for (const response of responses) {
            const job = resultOf(response);
            const meta = await waitForMeta(environment, job.jobId, true);
            if (response.status === "error") {
                assert.equal(meta.submissionState, "rejected");
                assert.equal(meta.executionBackend, undefined);
            } else {
                assert.equal(meta.executionBackend, "codex-app-server");
            }
        }
    } finally {
        await environment.cleanup();
    }
});

test("legacy concurrency remains one and is independent of app-server quota", async () => {
    const environment = await createEnvironment({ flag: "false" });
    try {
        const responses = await Promise.all([
            environment.invoke({ command: "run", worker: "codex", mode: "analyze", projectPath: environment.projectRoot, task: "[[DELAY_MS=1200]][[FINAL=L1]]" }),
            environment.invoke({ command: "run", worker: "codex", mode: "analyze", projectPath: environment.projectRoot, task: "[[DELAY_MS=1200]][[FINAL=L2]]" })
        ]);
        assert.equal(responses.filter(response => response.status === "success").length, 1);
        assert.equal(responses.filter(response => response.status === "error").length, 1);
        const success = responses.find(response => response.status === "success");
        await waitForMeta(environment, resultOf(success).jobId, true);
    } finally {
        await environment.cleanup();
    }
});

test("pre-Job app-server startup failure falls back once to one legacy Job", async () => {
    const environment = await createEnvironment({ flag: "true", badAppServer: true });
    try {
        const response = await environment.invoke({
            command: "run",
            worker: "codex",
            mode: "analyze",
            projectPath: environment.projectRoot,
            task: "fallback once"
        });
        assert.equal(response.status, "success");
        const jobId = resultOf(response).jobId;
        const meta = await waitForMeta(environment, jobId, true);
        assert.equal(meta.executionBackend, "legacy-exec");
        assert.equal(meta.fallbackFrom, "codex-app-server");
        assert.ok(meta.fallbackReason);
        const files = fs.readdirSync(path.join(environment.jobRoot, "meta"))
            .filter(file => file.endsWith(".json") && !file.endsWith(".args.json"));
        assert.deepEqual(files, [`${jobId}.json`]);
    } finally {
        await environment.cleanup();
    }
});

test("Job-created app-server rejection is failed/rejected and never falls back", async () => {
    const environment = await createEnvironment({ flag: "true" });
    const failedProject = path.join(environment.projectRoot, "fake-thread-fail");
    fs.mkdirSync(failedProject, { recursive: true });
    try {
        const response = await environment.invoke({
            command: "run",
            worker: "codex",
            mode: "analyze",
            projectPath: failedProject,
            task: "reject after Job creation"
        });
        assert.equal(response.status, "error");
        assert.equal(response.errorCode, "AICW_APP_SERVER_SUBMISSION_REJECTED");
        const metaFiles = fs.readdirSync(path.join(environment.jobRoot, "meta"))
            .filter(file => file.endsWith(".json") && !file.endsWith(".args.json"));
        assert.equal(metaFiles.length, 1);
        const meta = readJson(path.join(environment.jobRoot, "meta", metaFiles[0]));
        assert.equal(meta.state, "failed");
        assert.equal(meta.submissionState, "rejected");
        assert.equal(meta.fallbackFrom, undefined);
    } finally {
        await environment.cleanup();
    }
});

test("app-server cancel interrupts one turn without killing shared Sidecar/Codex", async () => {
    const environment = await createEnvironment({ flag: "true" });
    try {
        const [a, b] = await Promise.all([
            environment.invoke({ command: "run", worker: "codex", mode: "analyze", projectPath: environment.projectRoot, task: "[[DELAY_MS=1800]][[FINAL=A]]" }),
            environment.invoke({ command: "run", worker: "codex", mode: "analyze", projectPath: environment.projectRoot, task: "[[DELAY_MS=350]][[FINAL=B]]" })
        ]);
        assert.equal(a.status, "success", `A response=${JSON.stringify(a)}`);
        assert.equal(b.status, "success", `B response=${JSON.stringify(b)}`);
        const aId = resultOf(a).jobId;
        const bId = resultOf(b).jobId;
        const statePath = path.join(environment.jobRoot, "runtime", "sidecar-state.json");
        const before = readJson(statePath);
        const cancel = await environment.invoke({ command: "cancel", jobId: aId });
        assert.equal(cancel.status, "success");
        const after = readJson(statePath);
        assert.equal(after.pid, before.pid);
        assert.equal(after.codexPid, before.codexPid);
        assert.equal((await waitForMeta(environment, aId, true)).state, "cancelled");
        assert.equal((await waitForMeta(environment, bId, true)).state, "completed");
    } finally {
        await environment.cleanup();
    }
});

test("run_and_wait waits for app-server terminal state", async () => {
    const environment = await createEnvironment({ flag: "true" });
    try {
        const response = await environment.invoke({
            command: "run_and_wait",
            worker: "codex",
            mode: "analyze",
            projectPath: environment.projectRoot,
            task: "[[DELAY_MS=50]][[FINAL=waited]]"
        }, 10000);
        assert.equal(response.status, "success");
        const result = resultOf(response);
        assert.equal(result.state, "completed");
        assert.equal(result.executionBackend, "codex-app-server");
    } finally {
        await environment.cleanup();
    }
});

test("capabilities observes without starting Sidecar and exposes both quotas", async () => {
    for (const flag of ["false", "true"]) {
        const environment = await createEnvironment({ flag });
        try {
            const response = await environment.invoke({ command: "capabilities" });
            assert.equal(response.status, "success");
            const result = resultOf(response);
            assert.equal(result.codexAppServerAnalyzeEnabled, flag === "true");
            assert.equal(result.legacyMaxConcurrentJobs, 1);
            assert.equal(result.appServerMaxConcurrentJobs, 2);
            assert.equal(result.codexAppServerStatus, flag === "true" ? "absent" : "disabled");
            assert.equal(fs.existsSync(path.join(environment.jobRoot, "runtime", "sidecar-state.json")), false);
        } finally {
            await environment.cleanup();
        }
    }
});

test("shutdown command remains unknown", async () => {
    const environment = await createEnvironment({ flag: "true" });
    try {
        const response = await environment.invoke({ command: "shutdown" });
        assert.equal(response.status, "error");
        assert.match(response.error, /未知命令/);
        assert.equal(fs.existsSync(path.join(environment.jobRoot, "runtime", "sidecar-state.json")), false);
    } finally {
        await environment.cleanup();
    }
});

test("dead historical app-server Job reconciles without starting a Sidecar", async () => {
    const environment = await createEnvironment({ flag: "false" });
    try {
        const id = "job_historical_dead";
        const paths = {
            meta: metaPath(environment, id),
            output: path.join(environment.jobRoot, "output", `${id}.txt`),
            codexOutput: path.join(environment.jobRoot, "output", `${id}.codex-last.txt`)
        };
        fs.mkdirSync(path.dirname(paths.meta), { recursive: true });
        fs.mkdirSync(path.dirname(paths.output), { recursive: true });
        fs.writeFileSync(paths.output, JSON.stringify({ source: "codex-app-server", method: "turn/started", params: { threadId: "t", turnId: "u" } }) + "\n", "utf8");
        fs.writeFileSync(paths.codexOutput, "historical", "utf8");
        fs.writeFileSync(paths.meta, JSON.stringify({
            jobId: id,
            state: "running",
            worker: "codex",
            mode: "analyze",
            projectPath: environment.projectRoot,
            requestedExecutionBackend: "codex-app-server",
            executionBackend: "codex-app-server",
            sidecarInstanceId: "dead-instance",
            sidecarPid: 2147483647,
            traceMode: "events"
        }), "utf8");
        const protocol = require(path.join(environment.pluginDir, "appserver", "protocol.js"));
        const runtime = protocol.runtimePaths(environment.pluginDir, environment.jobRoot);
        fs.mkdirSync(path.dirname(runtime.statePath), { recursive: true });
        protocol.writeJsonAtomic(runtime.statePath, {
            schemaVersion: 1,
            instanceId: "dead-instance",
            controlToken: "dead-token",
            pid: 2147483647,
            endpoint: runtime.endpoint,
            status: "ready"
        });
        const query = resultOf(await environment.invoke({ command: "query", jobId: id, wait: false }));
        assert.equal(query.state, "failed");
        const trace = resultOf(await environment.invoke({ command: "trace", jobId: id, traceMode: "events" }));
        assert.ok(Array.isArray(trace.executionTrace));
        const cancel = resultOf(await environment.invoke({ command: "cancel", jobId: id }));
        assert.equal(cancel.state, "failed");
        assert.equal(fs.existsSync(runtime.statePath), false);
    } finally {
        await environment.cleanup();
    }
});

test("buildResult and Monitor payload preserve old fields and expose safe backend fields", async () => {
    const environment = await createEnvironment({ flag: "false" });
    try {
        const id = "job_result_projection";
        const outputDir = path.join(environment.jobRoot, "output");
        const metaDir = path.join(environment.jobRoot, "meta");
        fs.mkdirSync(outputDir, { recursive: true });
        fs.mkdirSync(metaDir, { recursive: true });
        fs.writeFileSync(path.join(outputDir, `${id}.txt`), "safe event\n", "utf8");
        fs.writeFileSync(path.join(outputDir, `${id}.codex-last.txt`), "final report", "utf8");
        fs.writeFileSync(path.join(metaDir, `${id}.json`), JSON.stringify({ jobId: id, state: "completed", worker: "codex", mode: "analyze", projectPath: environment.projectRoot, traceMode: "summary", executionBackend: "codex-app-server", requestedExecutionBackend: "codex-app-server", submissionState: "accepted", sidecarInstanceId: "instance", sidecarPid: 42, threadId: "thread", turnId: "turn", metaRevision: 4, errorCode: null }), "utf8");
        const worker = require(environment.workerPath);
        const result = worker.buildResult(id, readJson(path.join(metaDir, `${id}.json`)));
        assert.equal(result.output, "final report");
        assert.equal(result.outputFile.endsWith(`${id}.txt`), true);
        assert.equal(result.executionBackend, "codex-app-server");
        assert.equal(result.threadId, "thread");
        assert.equal(result.metaRevision, 4);
        const monitor = require(sourceMonitor);
        const oldPayload = monitor.buildJobStatusPayload({ jobId: "old", state: "running", worker: "opencode", mode: "analyze", pid: 10 }, "old.json");
        assert.equal(oldPayload.data.executionBackend, "legacy-exec");
        const appPayload = monitor.buildJobStatusPayload({ jobId: id, state: "completed", worker: "codex", mode: "analyze", requestedExecutionBackend: "codex-app-server", sidecarPid: 20, threadId: "thread", turnId: "turn", task: "must not escape" }, `${id}.json`);
        assert.equal(appPayload.data.pid, 20);
        assert.equal(appPayload.data.requestedExecutionBackend, "codex-app-server");
        assert.equal(Object.prototype.hasOwnProperty.call(appPayload.data, "task"), false);
        assert.equal(Object.prototype.hasOwnProperty.call(appPayload.data, "controlToken"), false);
    } finally {
        await environment.cleanup();
    }
});

function appServerPrepared(worker, environment, task = "fixture task") {
    const normalized = worker.normalizeRunRequest({
        worker: "codex",
        mode: "analyze",
        projectPath: environment.projectRoot,
        task
    });
    assert.equal(normalized.status, "success");
    return normalized.prepared;
}

function fakeAppServerClient(submitState = {}) {
    return {
        inspectNoStart: async () => ({ status: "absent" }),
        ensure: async () => ({ status: "ready" }),
        submitAnalyzeJob: async () => {
            submitState.calls = (submitState.calls || 0) + 1;
            return { accepted: true };
        }
    };
}

function assertCompactQuery(result) {
    for (const field of [
        "output", "logSummary", "fileReadList", "executionTrace", "traceText", "rawTrace",
        "task", "controlToken", "endpoint", "processIdentity"
    ]) {
        assert.equal(Object.prototype.hasOwnProperty.call(result, field), false, `compact query leaked ${field}`);
    }
    assert.equal(typeof result.outputFile, "string");
    assert.equal(typeof result.logFile, "string");
}

test("app-server meta initialization failure finalizes failed/rejected without submitting", async () => {
    const environment = await createEnvironment({ flag: "true" });
    try {
        const worker = require(environment.workerPath);
        const submitState = {};
        const response = await worker.cmdRunAppServerAnalyze(
            appServerPrepared(worker, environment),
            {
                client: fakeAppServerClient(submitState),
                writeFileSync: () => { throw Object.assign(new Error("injected output failure"), { code: "EOUTPUT" }); }
            }
        );
        assert.equal(response.status, "error");
        assert.equal(response.errorCode, "AICW_APP_SERVER_META_INIT_FAILED");
        assert.equal(submitState.calls || 0, 0);
        const meta = readJson(metaPath(environment, response.jobId));
        assert.equal(meta.state, "failed");
        assert.equal(meta.submissionState, "rejected");
        assert.equal(meta.exitCode, 1);
        assert.equal(meta.errorCode, "AICW_APP_SERVER_META_INIT_FAILED");
        assert.equal(meta.metaRevision, 1);
        assert.match(meta.completedAt, /^\d{4}-\d{2}-\d{2}T/);
    } finally { await environment.cleanup(); }
});

test("app-server submitting persistence failure finalizes terminal meta without submitting", async () => {
    const environment = await createEnvironment({ flag: "true" });
    try {
        const worker = require(environment.workerPath);
        const protocol = require(path.join(environment.pluginDir, "appserver", "protocol.js"));
        const submitState = {};
        let metaWrites = 0;
        const response = await worker.cmdRunAppServerAnalyze(
            appServerPrepared(worker, environment),
            {
                client: fakeAppServerClient(submitState),
                writeJsonAtomic: (filePath, value) => {
                    metaWrites++;
                    if (metaWrites === 1) throw Object.assign(new Error("injected submitting failure"), { code: "ESUBMITMETA" });
                    protocol.writeJsonAtomic(filePath, value);
                }
            }
        );
        assert.equal(response.status, "error");
        assert.equal(response.errorCode, "AICW_APP_SERVER_META_INIT_FAILED");
        assert.equal(submitState.calls || 0, 0);
        const meta = readJson(metaPath(environment, response.jobId));
        assert.equal(meta.state, "failed");
        assert.equal(meta.submissionState, "rejected");
        assert.equal(meta.exitCode, 1);
        assert.equal(meta.errorCode, "AICW_APP_SERVER_META_INIT_FAILED");
        assert.equal(meta.metaRevision, 1);
        assert.ok(meta.completedAt);
    } finally { await environment.cleanup(); }
});

test("app-server init terminal persistence failure deletes unsubmitted meta, and delete failure is explicit", async () => {
    for (const deletionMode of ["succeeds", "fails"]) {
        const environment = await createEnvironment({ flag: "true" });
        try {
            const worker = require(environment.workerPath);
            const submitState = {};
            const response = await worker.cmdRunAppServerAnalyze(
                appServerPrepared(worker, environment, `terminal persistence ${deletionMode}`),
                {
                    client: fakeAppServerClient(submitState),
                    writeJsonAtomic: () => { throw Object.assign(new Error("injected meta persistence failure"), { code: "EMETA" }); },
                    ...(deletionMode === "fails"
                        ? { unlinkSync: filePath => {
                            if (filePath.endsWith(".json")) throw Object.assign(new Error("injected delete failure"), { code: "EDELETE" });
                            fs.unlinkSync(filePath);
                        } }
                        : {})
                }
            );
            assert.equal(response.status, "error");
            assert.equal(response.errorCode, "AICW_APP_SERVER_META_FINALIZATION_FAILED");
            assert.equal(response.state, "unknown");
            assert.equal(submitState.calls || 0, 0);
            assert.equal(fs.existsSync(metaPath(environment, response.jobId)), deletionMode === "fails");
            if (deletionMode === "succeeds") assert.equal(response.metaDeleted, true);
            else assert.equal(response.metaDeleted, false);
        } finally { await environment.cleanup(); }
    }
});

test("app-server exclusive meta creation finalization failure is explicit and never submits", async () => {
    const environment = await createEnvironment({ flag: "true" });
    try {
        const worker = require(environment.workerPath);
        const protocol = require(path.join(environment.pluginDir, "appserver", "protocol.js"));
        const submitState = {};
        const response = await worker.cmdRunAppServerAnalyze(
            appServerPrepared(worker, environment, "exclusive meta finalization failure"),
            {
                client: fakeAppServerClient(submitState),
                createJsonExclusive: () => {
                    throw new protocol.SidecarError(
                        "META_CREATE_FINALIZATION_FAILED",
                        "injected exclusive meta cleanup failure",
                        { cause: "EWRITE", cleanupCause: "EDELETE", stage: "write" }
                    );
                }
            }
        );
        assert.equal(response.status, "error");
        assert.equal(response.errorCode, "AICW_APP_SERVER_META_FINALIZATION_FAILED");
        assert.equal(response.state, "unknown");
        assert.equal(response.finalizationError, "META_CREATE_FINALIZATION_FAILED");
        assert.equal(response.metaDeleted, true);
        assert.equal(submitState.calls || 0, 0);
        assert.equal(fs.existsSync(metaPath(environment, response.jobId)), false);
    } finally { await environment.cleanup(); }
});

test("normal app-server initialization persists submitting once and submits exactly once", async () => {
    const environment = await createEnvironment({ flag: "true" });
    try {
        const worker = require(environment.workerPath);
        const submitState = {};
        const response = await worker.cmdRunAppServerAnalyze(
            appServerPrepared(worker, environment, "normal initialization"),
            { client: fakeAppServerClient(submitState) }
        );
        assert.equal(response.status, "success");
        assert.equal(submitState.calls, 1);
        const meta = readJson(metaPath(environment, response.jobId));
        assert.equal(meta.state, "running");
        assert.equal(meta.submissionState, "submitting");
        assert.equal(meta.metaRevision, 1);
        assert.equal(fs.existsSync(path.join(environment.jobRoot, "output", `${response.jobId}.txt`)), true);
        assert.equal(fs.existsSync(path.join(environment.jobRoot, "logs", `${response.jobId}.log`)), true);
        assert.equal(fs.existsSync(path.join(environment.jobRoot, "output", `${response.jobId}.codex-last.txt`)), true);
    } finally { await environment.cleanup(); }
});

test("terminal query wait=false defaults to compact while full remains available", async () => {
    const environment = await createEnvironment({ flag: "true" });
    try {
        const response = await environment.invoke({
            command: "run",
            worker: "codex",
            mode: "analyze",
            projectPath: environment.projectRoot,
            task: "[[DELAY_MS=40]][[FINAL=compact-terminal]]",
            traceMode: "events"
        });
        const jobId = resultOf(response).jobId;
        await waitForMeta(environment, jobId, true);
        const compact = resultOf(await environment.invoke({
            command: "query",
            jobId,
            wait: false,
            traceMode: "events"
        }));
        assertCompactQuery(compact);
        assert.equal(compact.state, "completed");
        assert.match(compact.summary, /执行结果摘要|compact-terminal/);
        assert.ok(compact.summary.length <= 240);
        const full = resultOf(await environment.invoke({ command: "query", jobId, wait: false, responseMode: "full" }));
        assert.equal(typeof full.output, "string");
        assert.equal(typeof full.logSummary, "string");
        assert.ok(Array.isArray(full.executionTrace));
    } finally { await environment.cleanup(); }
});

test("compact summary ignores machine JSONL and uses stable terminal state text", async () => {
    const environment = await createEnvironment({ flag: "false" });
    try {
        const cases = [
            ["job_compact_timeout_summary", "timeout", "AICW_TEST_TIMEOUT", /任务等待超时/],
            ["job_compact_failed_summary", "failed", "AICW_TEST_FAILED", /任务执行失败（AICW_TEST_FAILED）/],
            ["job_compact_cancelled_summary", "cancelled", null, /任务已取消/],
            ["job_compact_completed_json_summary", "completed", null, /任务已完成/]
        ];
        fs.mkdirSync(path.join(environment.jobRoot, "meta"), { recursive: true });
        fs.mkdirSync(path.join(environment.jobRoot, "output"), { recursive: true });
        for (const [jobId, state, errorCode, expected] of cases) {
            fs.writeFileSync(
                metaPath(environment, jobId),
                JSON.stringify({
                    jobId,
                    state,
                    worker: "codex",
                    mode: "write",
                    exitCode: state === "completed" ? 0 : 1,
                    ...(errorCode ? { errorCode } : {})
                }),
                "utf8"
            );
            fs.writeFileSync(
                path.join(environment.jobRoot, "output", `${jobId}.txt`),
                `${JSON.stringify({
                    type: "item.started",
                    item: {
                        type: "command_execution",
                        command: "node --test",
                        aggregated_output: "",
                        status: "in_progress"
                    }
                })}\n=== 任务超时 (1800s) 已终止 ===\n`,
                "utf8"
            );
            const compact = resultOf(await environment.invoke({
                command: "query",
                jobId,
                wait: false,
                responseMode: "compact"
            }));
            assert.match(compact.summary, expected);
            assert.equal(compact.summary.includes("aggregated_output"), false);
            assert.equal(compact.summary.includes("\\\\"), false);
            assert.ok(compact.summary.length <= 240);
        }
    } finally { await environment.cleanup(); }
});

test("compact summary preserves readable completed text without an anchor", async () => {
    const environment = await createEnvironment({ flag: "false" });
    try {
        const jobId = "job_compact_plain_summary";
        fs.mkdirSync(path.join(environment.jobRoot, "meta"), { recursive: true });
        fs.mkdirSync(path.join(environment.jobRoot, "output"), { recursive: true });
        fs.writeFileSync(metaPath(environment, jobId), JSON.stringify({
            jobId,
            state: "completed",
            worker: "opencode",
            mode: "analyze",
            exitCode: 0
        }), "utf8");
        fs.writeFileSync(
            path.join(environment.jobRoot, "output", `${jobId}.txt`),
            `${JSON.stringify({ type: "trace", status: "completed" })}\nHuman-readable final result.\n`,
            "utf8"
        );
        const compact = resultOf(await environment.invoke({
            command: "query",
            jobId,
            wait: false,
            responseMode: "compact"
        }));
        assert.equal(compact.summary, "Human-readable final result.");
    } finally { await environment.cleanup(); }
});

test("compact summary ignores a trivial result anchor", async () => {
    const environment = await createEnvironment({ flag: "false" });
    try {
        const jobId = "job_compact_trivial_anchor";
        fs.mkdirSync(path.join(environment.jobRoot, "meta"), { recursive: true });
        fs.mkdirSync(path.join(environment.jobRoot, "output"), { recursive: true });
        fs.writeFileSync(metaPath(environment, jobId), JSON.stringify({
            jobId,
            state: "completed",
            worker: "codex",
            mode: "analyze",
            exitCode: 0
        }), "utf8");
        fs.writeFileSync(
            path.join(environment.jobRoot, "output", `${jobId}.txt`),
            `${JSON.stringify({ type: "item.completed", status: "completed" })}\n【执行结果摘要】\`。\n`,
            "utf8"
        );
        const compact = resultOf(await environment.invoke({
            command: "query",
            jobId,
            wait: false,
            responseMode: "compact"
        }));
        assert.equal(compact.summary, "任务已完成，完整结果见 outputFile。");
    } finally { await environment.cleanup(); }
});

test("running query wait=false defaults to compact and points to trace command", async () => {
    const environment = await createEnvironment({ flag: "true" });
    try {
        const response = await environment.invoke({
            command: "run",
            worker: "codex",
            mode: "analyze",
            projectPath: environment.projectRoot,
            task: "[[DELAY_MS=1200]][[FINAL=compact-running]]",
            traceMode: "events"
        });
        const jobId = resultOf(response).jobId;
        const query = resultOf(await environment.invoke({ command: "query", jobId, wait: false }));
        assertCompactQuery(query);
        assert.equal(query.state, "running");
        assert.equal(query.traceAvailable, true);
        assert.match(query.hint, /trace/);
        await waitForMeta(environment, jobId, true);
    } finally { await environment.cleanup(); }
});

test("query wait=true defaults to full and compact projection excludes injected sensitive fields", async () => {
    const environment = await createEnvironment({ flag: "false" });
    try {
        const id = "job_compact_sensitive_projection";
        const outputPath = path.join(environment.jobRoot, "output", `${id}.txt`);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.mkdirSync(path.join(environment.jobRoot, "logs"), { recursive: true });
        fs.mkdirSync(path.join(environment.jobRoot, "meta"), { recursive: true });
        fs.writeFileSync(outputPath, "controlToken=do-not-return endpoint=do-not-return\n【执行结果摘要】safe compact summary\n", "utf8");
        fs.writeFileSync(path.join(environment.jobRoot, "logs", `${id}.log`), "log body", "utf8");
        fs.writeFileSync(metaPath(environment, id), JSON.stringify({
            jobId: id,
            state: "completed",
            worker: "opencode",
            mode: "analyze",
            projectPath: environment.projectRoot,
            task: "secret task body",
            controlToken: "secret token",
            endpoint: "secret endpoint",
            processIdentity: { pid: 1, startTime: "secret identity" },
            exitCode: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:00:01.000Z",
            warnings: []
        }), "utf8");
        const compact = resultOf(await environment.invoke({ command: "query", jobId: id, wait: false }));
        assertCompactQuery(compact);
        assert.match(compact.summary, /safe compact summary/);
        for (const secret of ["secret task body", "secret token", "secret endpoint", "secret identity", "do-not-return"]) {
            assert.equal(JSON.stringify(compact).includes(secret), false, `compact response leaked ${secret}`);
        }
        const full = resultOf(await environment.invoke({ command: "query", jobId: id, wait: true }));
        assert.equal(typeof full.output, "string");
    } finally { await environment.cleanup(); }
});

test("compact capabilities is a small routing-safe whitelist and full remains compatible", async () => {
    const environment = await createEnvironment({ flag: "true" });
    try {
        const full = resultOf(await environment.invoke({ command: "capabilities" }));
        const compact = resultOf(await environment.invoke({ command: "capabilities", responseMode: "compact" }));
        assert.ok(
            JSON.stringify(compact).length < JSON.stringify(full).length,
            `compact=${JSON.stringify(compact).length} full=${JSON.stringify(full).length}`
        );
        const codex = compact.workers.find(worker => worker.name === "codex");
        assert.deepEqual(Object.keys(codex).sort(), [
            "available", "configuredReasoningEffort", "model", "modelSource", "name",
            "reasoningEffortEffective", "reasoningEfforts", "version"
        ].sort());
        for (const worker of compact.workers.filter(item => item.name !== "codex")) {
            assert.deepEqual(Object.keys(worker).sort(), ["available", "name"]);
        }
        assert.equal(compact.legacyMaxConcurrentJobs, 1);
        assert.equal(compact.appServerMaxConcurrentJobs, 2);
        assert.equal(compact.codexAppServerAnalyzeEnabled, true);
        assert.equal(typeof compact.codexAppServerStatus, "string");
        assert.equal(typeof compact.codexAppServerActiveJobs, "number");
        assert.equal(Object.prototype.hasOwnProperty.call(compact, "reasoningEffortDetails"), false);
        assert.equal(Object.prototype.hasOwnProperty.call(compact, "note"), false);
        assert.equal(Object.prototype.hasOwnProperty.call(full.workers.find(worker => worker.name === "codex"), "reasoningEffortDetails"), true);
    } finally { await environment.cleanup(); }
});

test("query and capabilities reject an invalid responseMode", async () => {
    const environment = await createEnvironment({ flag: "false" });
    try {
        const query = await environment.invoke({ command: "query", jobId: "job_invalid_response_mode", wait: false, responseMode: "brief" });
        assert.equal(query.status, "error");
        assert.match(query.error, /responseMode/);
        const capabilities = await environment.invoke({ command: "capabilities", responseMode: "brief" });
        assert.equal(capabilities.status, "error");
        assert.match(capabilities.error, /responseMode/);
    } finally { await environment.cleanup(); }
});
