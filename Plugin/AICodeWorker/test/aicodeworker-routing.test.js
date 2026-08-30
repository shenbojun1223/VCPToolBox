"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
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

function patchProtocolProof() {
    return {
        patchProtocolSupported: true,
        patchContractVersion: 1,
        patchMaxBytes: 524288,
        patchRepositoryPolicy: "clean-git-root",
        patchOperations: ["modify-existing-tracked-file"]
    };
}

function runFixtureGit(projectRoot, args) {
    const result = spawnSync("git", args, {
        cwd: projectRoot,
        encoding: "utf8",
        windowsHide: true
    });
    assert.equal(result.status, 0, `fixture git ${args[0]} failed`);
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
    const tempRoot = fs.realpathSync.native(
        fs.mkdtempSync(path.join(os.tmpdir(), "vcp-aicodeworker-routing-"))
    );
    const pluginDir = path.join(tempRoot, "plugin");
    const appserverDir = path.join(pluginDir, "appserver");
    const jobRoot = path.join(pluginDir, "jobs");
    const projectRoot = path.join(tempRoot, "project");
    const codexHome = path.join(tempRoot, "codex-home");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.cpSync(sourceAppServerDir, appserverDir, { recursive: true });
    if (options.legacyPatchProtocol) {
        const sidecarServerPath = path.join(appserverDir, "sidecarServer.js");
        const sidecarServerSource = fs.readFileSync(sidecarServerPath, "utf8");
        const legacySidecarServerSource = sidecarServerSource.replace(
            /^\s*\.\.\.getPatchProtocolProof\(\),?\r?\n/gm,
            ""
        );
        if (legacySidecarServerSource === sidecarServerSource) {
            throw new Error("routing fixture could not create legacy Sidecar protocol");
        }
        fs.writeFileSync(sidecarServerPath, legacySidecarServerSource, "utf8");
    }
    fs.copyFileSync(path.join(sourcePluginDir, "runner.js"), path.join(pluginDir, "runner.js"));
    fs.copyFileSync(sourceFixture, path.join(pluginDir, "fake-codex-app-server.js"));
    fs.writeFileSync(
        path.join(pluginDir, "app-server"),
        options.badAppServer
            ? "if (process.argv.includes('--version')) process.exit(17); process.argv.splice(2, 0, 'app-server'); process.exit(17);"
            : "if (process.argv.includes('--version')) { process.stdout.write('codex-cli 0.144.5\\n'); process.exit(0); } process.argv.splice(2, 0, 'app-server'); require('./fake-codex-app-server.js');",
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
    fs.writeFileSync(
        path.join(codexHome, "config.toml"),
        'model = "gpt-5-codex"\nmodel_reasoning_effort = "medium"\n',
        "utf8"
    );
    if (options.gitProject) {
        fs.writeFileSync(path.join(projectRoot, "tracked.txt"), "alpha\nbeta\n", "utf8");
        runFixtureGit(projectRoot, ["init"]);
        runFixtureGit(projectRoot, ["config", "user.email", "routing-fixture@example.invalid"]);
        runFixtureGit(projectRoot, ["config", "user.name", "Routing Fixture"]);
        runFixtureGit(projectRoot, ["add", "."]);
        runFixtureGit(projectRoot, ["commit", "-m", "fixture baseline"]);
    }
    const flagLine = Object.prototype.hasOwnProperty.call(options, "flag")
        ? `ENABLE_CODEX_APP_SERVER_ANALYZE=${options.flag}\n`
        : "";
    const patchFlagLine = Object.prototype.hasOwnProperty.call(options, "patchFlag")
        ? `ENABLE_CODEX_APP_SERVER_PATCH=${options.patchFlag}\n`
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
        patchFlagLine.trimEnd(),
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

function cleanupPaths(environment, jobId) {
    const protocolPaths = require(path.join(environment.pluginDir, "appserver", "protocol.js"))
        .jobPaths(environment.jobRoot, jobId);
    return {
        metaPath: protocolPaths.metaPath,
        argsPath: path.join(environment.jobRoot, "meta", `${jobId}.args.json`),
        outputPath: protocolPaths.outputPath,
        logPath: path.join(environment.jobRoot, "logs", `${jobId}.log`),
        patchPath: protocolPaths.patchPath,
        codexOutputPath: protocolPaths.codexOutputPath
    };
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

function installAuthorizedAppServerPatch(environment, jobId, patchText = "diff --git a/a b/a\n") {
    const protocol = require(path.join(environment.pluginDir, "appserver", "protocol.js"));
    fs.mkdirSync(environment.jobRoot, { recursive: true });
    const directoryIdentity = protocol.pinPatchArtifactDirectory(environment.jobRoot, { create: true });
    const paths = protocol.jobPaths(environment.jobRoot, jobId);
    fs.mkdirSync(path.dirname(paths.metaPath), { recursive: true });
    fs.mkdirSync(path.dirname(paths.outputPath), { recursive: true });
    fs.writeFileSync(paths.patchPath, patchText, { encoding: "utf8", mode: 0o600 });
    fs.writeFileSync(paths.outputPath, `${patchText}\nMODEL_PATCH_BODY_MUST_NOT_RETURN`, "utf8");
    fs.writeFileSync(paths.codexOutputPath, `${patchText}\nCODEX_PATCH_BODY_MUST_NOT_RETURN`, "utf8");
    const patchSha256 = crypto.createHash("sha256").update(Buffer.from(patchText, "utf8")).digest("hex");
    const patchBytes = Buffer.byteLength(patchText, "utf8");
    const publicArtifact = protocol.inspectPatchArtifactFile(paths.patchPath, directoryIdentity, {
        jobRoot: environment.jobRoot,
        expectedSha256: patchSha256,
        expectedBytes: patchBytes
    });
    const meta = {
        jobId,
        state: "completed",
        worker: "codex",
        mode: "patch",
        projectPath: environment.projectRoot,
        executionBackend: "codex-app-server",
        requestedExecutionBackend: "codex-app-server",
        sidecarInstanceId: "completed-patch-instance",
        jobKind: "patch",
        jobPhase: "completed",
        patchContractVersion: 1,
        baseHead: "a".repeat(40),
        patchValidated: true,
        applyCheckPassed: true,
        baselineStable: true,
        patchSha256,
        patchBytes,
        patchFileCount: 1,
        patchArtifactNonce: "bbbbbbbbbbbbbbbbbbbbbbbb",
        patchArtifactDirectoryIdentity: directoryIdentity,
        patchArtifactPublicIdentity: publicArtifact.identity,
        warnings: [{ level: "warn", message: "secret-target-warning.txt" }],
        exitCode: 0,
        completedAt: new Date().toISOString()
    };
    protocol.writeJsonAtomic(paths.metaPath, meta);
    return { protocol, paths, meta, patchText };
}

function markArtifactOld(artifact, extra = {}) {
    const meta = {
        ...artifact.meta,
        startedAt: "2000-01-01T00:00:00.000Z",
        ...extra
    };
    artifact.protocol.writeJsonAtomic(artifact.paths.metaPath, meta);
    artifact.meta = meta;
    return meta;
}

const ARTIFACT_ROUTING_SENTINELS = Object.freeze([
    "PATCH_BODY_SENTINEL diff --git a/secret-target.txt",
    "COMMAND_OUTPUT_SENTINEL",
    "secret-target.txt",
    "TOOL_RESULT_SENTINEL"
]);

function writeArtifactRoutingSentinelOutput(environment, jobId) {
    const paths = cleanupPaths(environment, jobId);
    const codexJsonl = [
        {
            type: "item.completed",
            item: {
                type: "agent_message",
                id: "agent-sentinel",
                status: "completed",
                text: "PATCH_BODY_SENTINEL diff --git a/secret-target.txt b/secret-target.txt"
            }
        },
        {
            type: "item.completed",
            item: {
                type: "command_execution",
                id: "command-sentinel",
                status: "completed",
                command: "cat secret-target.txt",
                exit_code: 0,
                aggregated_output: "COMMAND_OUTPUT_SENTINEL"
            }
        },
        {
            type: "item.completed",
            item: {
                type: "file_change",
                id: "file-change-sentinel",
                status: "completed",
                changes: [{ path: "secret-target.txt", kind: "update" }]
            }
        },
        {
            type: "item.completed",
            item: {
                type: "mcp_tool_call",
                id: "tool-sentinel",
                status: "completed",
                name: "sentinel-tool",
                result: "TOOL_RESULT_SENTINEL"
            }
        },
        {
            source: "codex-app-server",
            method: "COMMAND_OUTPUT_SENTINEL",
            params: {
                threadId: "secret-target.txt",
                turnId: "TOOL_RESULT_SENTINEL",
                status: "PATCH_BODY_SENTINEL"
            }
        }
    ].map(event => JSON.stringify(event)).join("\n") + "\n";

    for (const filePath of [paths.outputPath, paths.codexOutputPath, paths.logPath]) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, codexJsonl, "utf8");
    }
    return paths;
}

function assertNoArtifactRoutingSentinels(value, label) {
    const serialized = JSON.stringify(value);
    for (const sentinel of ARTIFACT_ROUTING_SENTINELS) {
        assert.equal(serialized.includes(sentinel), false, `${label} leaked ${sentinel}`);
    }
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

test("strict patch flag enables only trimmed case-insensitive true", async () => {
    for (const patchFlag of [undefined, "", "false", "0", "1", "yes", " TRUE "]) {
        const environment = await createEnvironment({
            ...(patchFlag === undefined ? {} : { patchFlag })
        });
        try {
            const worker = require(environment.workerPath);
            assert.equal(
                worker.isCodexAppServerPatchRoute("codex", "patch"),
                patchFlag === " TRUE ",
                `patchFlag=${String(patchFlag)}`
            );
            assert.equal(worker.isCodexAppServerPatchRoute("codex", "write"), false);
            assert.equal(worker.isCodexAppServerPatchRoute("opencode", "patch"), false);
        } finally { await environment.cleanup(); }
    }
});

test("analyze and patch app-server flags are independent", async () => {
    for (const flags of [
        { flag: "true", patchFlag: "false", analyze: true, patch: false },
        { flag: "false", patchFlag: "true", analyze: false, patch: true }
    ]) {
        const environment = await createEnvironment(flags);
        try {
            const worker = require(environment.workerPath);
            assert.equal(worker.isCodexAppServerAnalyzeRoute("codex", "analyze"), flags.analyze);
            assert.equal(worker.isCodexAppServerPatchRoute("codex", "patch"), flags.patch);
        } finally { await environment.cleanup(); }
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

test("patch flag false preserves legacy while write and non-Codex patch remain legacy", async () => {
    const environment = await createEnvironment({ flag: "true", patchFlag: "false" });
    try {
        for (const input of [
            { worker: "codex", mode: "patch", task: "patch legacy" },
            { worker: "codex", mode: "write", task: "write legacy" },
            { worker: "opencode", mode: "patch", task: "other worker patch" }
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

test("patch flag true routes only Codex patch through app-server and never mutates the project", async () => {
    const environment = await createEnvironment({ flag: "false", patchFlag: "true", gitProject: true });
    try {
        const patch = validPatch("routed-patch");
        const response = await environment.invoke({
            command: "run",
            worker: "codex",
            mode: "patch",
            projectPath: environment.projectRoot,
            task: `[[FINAL_BASE64=${Buffer.from(patch, "utf8").toString("base64")}]]`
        });
        assert.equal(response.status, "success", JSON.stringify(response));
        const jobId = resultOf(response).jobId;
        const meta = await waitForMeta(environment, jobId, true);
        assert.equal(meta.executionBackend, "codex-app-server");
        assert.equal(meta.jobKind, "patch");
        assert.equal(meta.patchContractVersion, 1);
        assert.equal(
            meta.patchValidated,
            true,
            `patch terminal=${JSON.stringify({ state: meta.state, errorCode: meta.errorCode, jobPhase: meta.jobPhase })}`
        );
        assert.equal(meta.applyCheckPassed, true);
        assert.equal(meta.baselineStable, true);
        assert.equal(fs.existsSync(path.join(environment.jobRoot, "meta", `${jobId}.args.json`)), false);
        assert.equal(fs.readFileSync(path.join(environment.projectRoot, "tracked.txt"), "utf8"), "alpha\nbeta\n");
    } finally { await environment.cleanup(); }
});

test("unknown or blank run mode is rejected before Job, lock, or Sidecar while other commands ignore mode", async () => {
    const environment = await createEnvironment({ flag: "true", patchFlag: "true" });
    try {
        for (const [index, mode] of ["unknown", "   ", null].entries()) {
            const response = await environment.invoke({
                command: index % 2 === 0 ? "run" : "run_and_wait",
                worker: "codex",
                mode,
                projectPath: environment.projectRoot,
                task: "invalid mode"
            });
            assert.equal(response.status, "error");
            assert.equal(response.errorCode, "AICW_INVALID_MODE");
        }
        assert.equal(fs.existsSync(path.join(environment.jobRoot, "meta")), false);
        assert.equal(fs.existsSync(path.join(environment.jobRoot, "runtime", "sidecar-state.json")), false);
        const worker = require(environment.workerPath);
        const presetTarget = path.join(environment.projectRoot, "exec");
        const rejectedPreset = worker.normalizeRunRequest({
            preset: "index",
            targetPath: presetTarget,
            projectPath: environment.projectRoot,
            mode: "   "
        });
        assert.equal(rejectedPreset.status, "error");
        assert.equal(rejectedPreset.errorCode, "AICW_INVALID_MODE");
        const legalPreset = worker.normalizeRunRequest({
            preset: "index",
            targetPath: presetTarget,
            projectPath: environment.projectRoot
        });
        assert.equal(legalPreset.status, "success");
        assert.equal(legalPreset.prepared.mode, "analyze");
        const capabilities = await environment.invoke({ command: "capabilities", mode: "unknown" });
        assert.equal(capabilities.status, "success");
        assert.equal(fs.existsSync(path.join(environment.jobRoot, "runtime", "sidecar-state.json")), false);
    } finally { await environment.cleanup(); }
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
    for (const fixture of [
        { flag: "false", patchFlag: "false", status: "disabled" },
        { flag: "true", patchFlag: "false", status: "absent" },
        { flag: "false", patchFlag: "true", status: "absent" }
    ]) {
        const environment = await createEnvironment(fixture);
        try {
            const response = await environment.invoke({ command: "capabilities" });
            assert.equal(response.status, "success");
            const result = resultOf(response);
            assert.equal(result.codexAppServerAnalyzeEnabled, fixture.flag === "true");
            assert.equal(result.codexAppServerPatchEnabled, fixture.patchFlag === "true");
            assert.equal(result.legacyMaxConcurrentJobs, 1);
            assert.equal(result.appServerMaxConcurrentJobs, 2);
            assert.equal(result.appServerConcurrencyScope, "shared-analyze-patch");
            assert.equal(result.patchContractVersion, 1);
            assert.equal(result.patchMaxBytes, 524288);
            assert.equal(result.patchRepositoryPolicy, "clean-git-root");
            assert.deepEqual(result.patchOperations, ["modify-existing-tracked-file"]);
            assert.equal(result.codexAppServerStatus, fixture.status);
            assert.equal(
                result.codexAppServerPatchProtocolSupport,
                fixture.patchFlag === "true" ? "unknown" : false
            );
            assert.equal(result.workers.find(worker => worker.name === "codex").supportsAppServerPatch, false);
            assert.equal(fs.existsSync(path.join(environment.jobRoot, "runtime", "sidecar-state.json")), false);
        } finally {
            await environment.cleanup();
        }
    }
});

test("live old Sidecar status without patch protocol proof is never reported as supported", async () => {
    const environment = await createEnvironment({ flag: "true", patchFlag: "true", legacyPatchProtocol: true });
    try {
        const run = await environment.invoke({
            command: "run",
            worker: "codex",
            mode: "analyze",
            projectPath: environment.projectRoot,
            task: "[[FINAL=protocol-observation]]"
        });
        assert.equal(run.status, "success");
        await waitForMeta(environment, resultOf(run).jobId, true);
        const capabilities = resultOf(await environment.invoke({ command: "capabilities" }));
        assert.equal(capabilities.codexAppServerStatus, "ready");
        assert.equal(capabilities.codexAppServerPatchEnabled, true);
        assert.equal(capabilities.codexAppServerPatchProtocolSupport, "unknown");
        assert.equal(
            capabilities.workers.find(worker => worker.name === "codex").supportsAppServerPatch,
            false
        );
    } finally { await environment.cleanup(); }
});

test("new Sidecar proof is visible while patch flag is false and patch stays legacy", async () => {
    const environment = await createEnvironment({ flag: "true", patchFlag: "false" });
    try {
        const analyze = await environment.invoke({
            command: "run",
            worker: "codex",
            mode: "analyze",
            projectPath: environment.projectRoot,
            task: "[[FINAL=proof-visible]]"
        });
        assert.equal(analyze.status, "success");
        await waitForMeta(environment, resultOf(analyze).jobId, true);

        const capabilities = resultOf(await environment.invoke({ command: "capabilities" }));
        assert.equal(capabilities.codexAppServerPatchProtocolSupport, true);
        assert.equal(capabilities.codexAppServerPatchEnabled, false);
        assert.equal(
            capabilities.workers.find(worker => worker.name === "codex").supportsAppServerPatch,
            false
        );

        const patch = await environment.invoke({
            command: "run",
            worker: "codex",
            mode: "patch",
            projectPath: environment.projectRoot,
            task: "legacy patch remains selected"
        });
        assert.equal(patch.status, "success");
        const meta = await waitForMeta(environment, resultOf(patch).jobId, true);
        assert.equal(meta.executionBackend, "legacy-exec");
        assert.equal(meta.requestedExecutionBackend, undefined);
    } finally { await environment.cleanup(); }
});

test("complete proof plus patch flag is required before capabilities report support", async () => {
    const environment = await createEnvironment({ flag: "true", patchFlag: "true" });
    try {
        const analyze = await environment.invoke({
            command: "run",
            worker: "codex",
            mode: "analyze",
            projectPath: environment.projectRoot,
            task: "[[FINAL=proof-enabled]]"
        });
        assert.equal(analyze.status, "success");
        await waitForMeta(environment, resultOf(analyze).jobId, true);

        const capabilities = resultOf(await environment.invoke({ command: "capabilities" }));
        assert.equal(capabilities.codexAppServerPatchProtocolSupport, true);
        assert.equal(capabilities.codexAppServerPatchEnabled, true);
        assert.equal(
            capabilities.workers.find(worker => worker.name === "codex").supportsAppServerPatch,
            true
        );
    } finally { await environment.cleanup(); }
});

test("old Sidecar proof rejects patch without creating a Job or falling back", async () => {
    const environment = await createEnvironment({ flag: "false", patchFlag: "true", legacyPatchProtocol: true });
    try {
        const response = await environment.invoke({
            command: "run",
            worker: "codex",
            mode: "patch",
            projectPath: environment.projectRoot,
            task: "old Sidecar must fail closed"
        });
        assert.equal(response.status, "error");
        assert.equal(response.errorCode, "AICW_APP_SERVER_PATCH_UNSUPPORTED");
        assert.equal(fs.existsSync(path.join(environment.jobRoot, "meta")), false);
        assert.equal(response.fallbackFrom, undefined);
    } finally { await environment.cleanup(); }
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

function appServerPatchPrepared(worker, environment, task = "fixture patch task", extra = {}) {
    const normalized = worker.normalizeRunRequest({
        worker: "codex",
        mode: "patch",
        projectPath: environment.projectRoot,
        task,
        ...extra
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

function fakePatchClient(submitState = {}, behavior = {}) {
    return {
        ensure: async () => {
            submitState.ensureCalls = (submitState.ensureCalls || 0) + 1;
            if (behavior.ensureError) throw behavior.ensureError;
            return { status: "ready", ...patchProtocolProof() };
        },
        submitPatchJob: async params => {
            submitState.calls = (submitState.calls || 0) + 1;
            submitState.params = params;
            if (behavior.submitError) throw behavior.submitError;
            if (Object.prototype.hasOwnProperty.call(behavior, "response")) return behavior.response;
            return { accepted: true };
        }
    };
}

function jobMetaFiles(environment) {
    const directory = path.join(environment.jobRoot, "meta");
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory).filter(file => file.endsWith(".json") && !file.endsWith(".args.json"));
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

test("patch rejects attachments and sessionId before Job or Sidecar creation", async () => {
    for (const extra of [{ attachments: ["image.png"] }, { sessionId: "forbidden-session" }]) {
        const environment = await createEnvironment({ patchFlag: "true" });
        try {
            const worker = require(environment.workerPath);
            const submitState = {};
            const response = await worker.cmdRunAppServerPatch(
                appServerPatchPrepared(worker, environment, "early rejection", extra),
                { client: fakePatchClient(submitState) }
            );
            assert.equal(response.status, "error");
            assert.match(response.errorCode, /PATCH_(?:ATTACHMENTS|SESSION)_UNSUPPORTED/);
            assert.equal(submitState.ensureCalls || 0, 0);
            assert.equal(submitState.calls || 0, 0);
            assert.deepEqual(jobMetaFiles(environment), []);
            assert.equal(fs.existsSync(path.join(environment.jobRoot, "runtime", "sidecar-state.json")), false);
        } finally { await environment.cleanup(); }
    }
});

test("patch pre-Job Sidecar failure is unavailable and never falls back", async () => {
    const environment = await createEnvironment({ patchFlag: "true" });
    try {
        const worker = require(environment.workerPath);
        const protocol = require(path.join(environment.pluginDir, "appserver", "protocol.js"));
        const submitState = {};
        const response = await worker.cmdRunAppServerPatch(
            appServerPatchPrepared(worker, environment),
            {
                client: fakePatchClient(submitState, {
                    ensureError: new protocol.SidecarError("SIDECAR_START_FAILED", "injected startup failure")
                })
            }
        );
        assert.equal(response.status, "error");
        assert.equal(response.errorCode, "AICW_APP_SERVER_PATCH_UNAVAILABLE");
        assert.equal(submitState.ensureCalls, 1);
        assert.equal(submitState.calls || 0, 0);
        assert.deepEqual(jobMetaFiles(environment), []);
        assert.equal(fs.existsSync(path.join(environment.jobRoot, ".job_lock")), false);
    } finally { await environment.cleanup(); }
});

test("patch UNKNOWN_METHOD, version mismatch, and concurrency reject without legacy fallback", async () => {
    const cases = [
        ["UNKNOWN_METHOD", "AICW_APP_SERVER_PATCH_UNSUPPORTED"],
        ["AICW_PATCH_CODEX_VERSION_UNVERIFIED", "AICW_APP_SERVER_PATCH_UNSUPPORTED"],
        ["CONCURRENCY_LIMIT", "AICW_APP_SERVER_PATCH_CONCURRENCY_LIMIT"],
        ["DUPLICATE_JOB_ID", "AICW_APP_SERVER_PATCH_META_FAILED"]
    ];
    for (const [code, expected] of cases) {
        const environment = await createEnvironment({ patchFlag: "true" });
        try {
            const worker = require(environment.workerPath);
            const protocol = require(path.join(environment.pluginDir, "appserver", "protocol.js"));
            const submitState = {};
            const response = await worker.cmdRunAppServerPatch(
                appServerPatchPrepared(worker, environment, `reject ${code}`),
                {
                    client: fakePatchClient(submitState, {
                        submitError: new protocol.SidecarError(code, "injected rejection")
                    })
                }
            );
            assert.equal(response.status, "error");
            assert.equal(response.errorCode, expected);
            assert.equal(submitState.calls, 1);
            const files = jobMetaFiles(environment);
            assert.equal(files.length, 1);
            const meta = readJson(path.join(environment.jobRoot, "meta", files[0]));
            assert.equal(meta.jobKind, "patch");
            assert.equal(meta.state, "failed");
            assert.equal(meta.submissionState, "rejected");
            assert.equal(meta.errorCode, expected);
            assert.equal(meta.fallbackFrom, undefined);
            assert.equal(fs.existsSync(path.join(environment.jobRoot, "meta", `${meta.jobId}.args.json`)), false);
        } finally { await environment.cleanup(); }
    }
});

test("accepted patch submits once with only fixed contract fields and no public patch precreation", async () => {
    const environment = await createEnvironment({ patchFlag: "true" });
    try {
        const worker = require(environment.workerPath);
        const submitState = {};
        const response = await worker.cmdRunAppServerPatch(
            appServerPatchPrepared(worker, environment, "accepted once", { timeoutSec: 7 }),
            { client: fakePatchClient(submitState) }
        );
        assert.equal(response.status, "success");
        assert.equal(submitState.ensureCalls, 1);
        assert.equal(submitState.calls, 1);
        assert.deepEqual(Object.keys(submitState.params).sort(), [
            "codexOutputPath", "effort", "jobId", "metaPath", "model", "outputPath",
            "patchContractVersion", "patchPath", "projectPath", "text", "timeoutSec"
        ].sort());
        const protocol = require(path.join(environment.pluginDir, "appserver", "protocol.js"));
        const fixed = protocol.jobPaths(environment.jobRoot, response.jobId);
        assert.equal(submitState.params.metaPath, fixed.metaPath);
        assert.equal(submitState.params.outputPath, fixed.outputPath);
        assert.equal(submitState.params.codexOutputPath, fixed.codexOutputPath);
        assert.equal(submitState.params.patchPath, fixed.patchPath);
        assert.equal(submitState.params.timeoutSec, 7);
        assert.equal(submitState.params.model, "gpt-5-codex");
        assert.equal(submitState.params.effort, "medium");
        assert.equal(submitState.params.patchContractVersion, 1);
        for (const forbidden of ["sandbox", "cwd", "approvalPolicy", "networkAccess", "artifactDirectory"]) {
            assert.equal(Object.prototype.hasOwnProperty.call(submitState.params, forbidden), false);
        }
        const meta = readJson(fixed.metaPath);
        assert.equal(meta.state, "running");
        assert.equal(meta.jobKind, "patch");
        assert.equal(meta.jobPhase, "prepared");
        assert.equal(meta.submissionState, "submitting");
        assert.equal(meta.requestedExecutionBackend, "codex-app-server");
        assert.equal(meta.patchValidated, false);
        assert.equal(meta.applyCheckPassed, false);
        assert.equal(meta.baselineStable, false);
        assert.equal(meta.patchAvailable, false);
        assert.equal(fs.existsSync(fixed.patchPath), false);
        assert.equal(fs.existsSync(fixed.outputPath), true);
        assert.equal(fs.existsSync(fixed.codexOutputPath), true);
    } finally { await environment.cleanup(); }
});

test("patch transport uncertainty and invalid responses preserve one original Job without replay", async () => {
    const cases = [
        { code: "SIDECAR_IPC_TIMEOUT" },
        { code: "SIDECAR_IPC_CLOSED" },
        { code: "SIDECAR_IPC_ERROR" },
        { code: "SIDECAR_RESPONSE_MISMATCH" },
        { code: "INVALID_SIDECAR_RESPONSE" },
        { response: {} }
    ];
    for (const fixture of cases) {
        const environment = await createEnvironment({ patchFlag: "true" });
        try {
            const worker = require(environment.workerPath);
            const protocol = require(path.join(environment.pluginDir, "appserver", "protocol.js"));
            const submitState = {};
            const behavior = Object.prototype.hasOwnProperty.call(fixture, "response")
                ? { response: fixture.response }
                : { submitError: new protocol.SidecarError(fixture.code, "injected transport uncertainty") };
            const response = await worker.cmdRunAppServerPatch(
                appServerPatchPrepared(worker, environment, `unknown ${fixture.code || "invalid"}`),
                { client: fakePatchClient(submitState, behavior) }
            );
            assert.equal(response.status, "error");
            assert.equal(response.errorCode, "AICW_APP_SERVER_PATCH_SUBMISSION_UNKNOWN");
            assert.equal(submitState.calls, 1);
            assert.ok(response.jobId);
            const meta = readJson(metaPath(environment, response.jobId));
            assert.equal(meta.state, "running");
            assert.equal(meta.submissionState, "unknown");
            assert.equal(meta.errorCode, "AICW_APP_SERVER_PATCH_SUBMISSION_UNKNOWN");
            assert.deepEqual(jobMetaFiles(environment), [`${response.jobId}.json`]);
            assert.equal(fs.existsSync(path.join(environment.jobRoot, "meta", `${response.jobId}.args.json`)), false);
        } finally { await environment.cleanup(); }
    }
});

test("patch meta collision, init failure, and finalization failure never submit", async () => {
    const cases = [
        {
            expected: "AICW_APP_SERVER_PATCH_META_FAILED",
            dependency(protocol) {
                return { createJsonExclusive: () => { throw new protocol.SidecarError("META_ALREADY_EXISTS", "collision"); } };
            }
        },
        {
            expected: "AICW_APP_SERVER_PATCH_META_FAILED",
            dependency() {
                return { writeFileSync: () => { throw Object.assign(new Error("init failure"), { code: "EINIT" }); } };
            }
        },
        {
            expected: "AICW_APP_SERVER_PATCH_META_FINALIZATION_FAILED",
            dependency(protocol) {
                return { createJsonExclusive: () => { throw new protocol.SidecarError("META_CREATE_FINALIZATION_FAILED", "finalization"); } };
            }
        }
    ];
    for (const fixture of cases) {
        const environment = await createEnvironment({ patchFlag: "true" });
        try {
            const worker = require(environment.workerPath);
            const protocol = require(path.join(environment.pluginDir, "appserver", "protocol.js"));
            const submitState = {};
            const response = await worker.cmdRunAppServerPatch(
                appServerPatchPrepared(worker, environment, fixture.expected),
                { client: fakePatchClient(submitState), ...fixture.dependency(protocol) }
            );
            assert.equal(response.status, "error");
            assert.equal(response.errorCode, fixture.expected);
            assert.equal(submitState.calls || 0, 0);
        } finally { await environment.cleanup(); }
    }
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
    const environment = await createEnvironment({ flag: "true", patchFlag: "true" });
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
            "reasoningEffortEffective", "reasoningEfforts", "supportsAppServerPatch", "version"
        ].sort());
        for (const worker of compact.workers.filter(item => item.name !== "codex")) {
            assert.deepEqual(Object.keys(worker).sort(), ["available", "name"]);
        }
        assert.equal(compact.legacyMaxConcurrentJobs, 1);
        assert.equal(compact.appServerMaxConcurrentJobs, 2);
        assert.equal(compact.codexAppServerAnalyzeEnabled, true);
        assert.equal(compact.codexAppServerPatchEnabled, true);
        assert.equal(compact.appServerConcurrencyScope, "shared-analyze-patch");
        assert.equal(compact.patchContractVersion, 1);
        assert.equal(compact.patchMaxBytes, 524288);
        assert.equal(compact.patchRepositoryPolicy, "clean-git-root");
        assert.deepEqual(compact.patchOperations, ["modify-existing-tracked-file"]);
        assert.equal(compact.codexAppServerPatchProtocolSupport, "unknown");
        assert.equal(codex.supportsAppServerPatch, false);
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

test("completed app-server patch full and compact query return only authorized artifact metadata", async () => {
    const environment = await createEnvironment({ flag: "false" });
    try {
        const artifact = installAuthorizedAppServerPatch(environment, "job_query_authorized_patch", "diff --git a/a b/a\n多字节🙂\n");
        const full = resultOf(await environment.invoke({ command: "query", jobId: artifact.meta.jobId, wait: true, responseMode: "full" }));
        const compact = resultOf(await environment.invoke({ command: "query", jobId: artifact.meta.jobId, wait: false, responseMode: "compact" }));
        for (const result of [full, compact]) {
            assert.equal(result.patchFile, artifact.paths.patchPath);
            assert.equal(result.patchAvailable, true);
            assert.equal(result.patchSha256, artifact.meta.patchSha256);
            assert.equal(result.patchBytes, Buffer.byteLength(artifact.patchText, "utf8"));
            assert.equal(result.patchFileCount, 1);
            assert.equal(result.patchContractVersion, 1);
            assert.equal(result.baseHead, artifact.meta.baseHead);
            assert.equal(result.baselineStable, true);
            assert.equal(result.applyCheckPassed, true);
            assert.equal(result.patchValidated, true);
            assert.equal(result.jobPhase, "completed");
            assert.equal(JSON.stringify(result).includes("MODEL_PATCH_BODY_MUST_NOT_RETURN"), false);
            assert.equal(JSON.stringify(result).includes("CODEX_PATCH_BODY_MUST_NOT_RETURN"), false);
            assert.equal(JSON.stringify(result).includes("secret-target-warning.txt"), false);
            assert.equal(JSON.stringify(result).includes("多字节🙂"), false);
            assert.equal(JSON.stringify(result).includes(artifact.meta.patchArtifactNonce), false);
            assert.equal(JSON.stringify(result).includes(JSON.stringify(artifact.meta.patchArtifactDirectoryIdentity)), false);
            assert.equal(JSON.stringify(result).includes(JSON.stringify(artifact.meta.patchArtifactPublicIdentity)), false);
        }
        assert.equal(full.output, "");
        assert.equal(Object.prototype.hasOwnProperty.call(compact, "output"), false);
    } finally { await environment.cleanup(); }
});

test("non-completed app-server patch states never expose a patch or diff body", async () => {
    for (const state of ["running", "failed", "cancelled", "timeout"]) {
        const environment = await createEnvironment({ patchFlag: "false" });
        try {
            const jobId = `job_patch_state_${state}`;
            const outputPath = path.join(environment.jobRoot, "output", `${jobId}.txt`);
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            fs.mkdirSync(path.join(environment.jobRoot, "meta"), { recursive: true });
            fs.writeFileSync(outputPath, `diff --git a/secret.txt b/secret.txt\nSTATE_${state}_DIFF`, "utf8");
            fs.writeFileSync(metaPath(environment, jobId), JSON.stringify({
                jobId,
                state,
                worker: "codex",
                mode: "patch",
                jobKind: "patch",
                jobPhase: state === "running" ? "running" : "failed",
                projectPath: environment.projectRoot,
                executionBackend: "codex-app-server",
                requestedExecutionBackend: "codex-app-server",
                patchValidated: true,
                applyCheckPassed: true,
                baselineStable: true,
                patchContractVersion: 1,
                errorCode: state === "failed" ? "AICW_TEST_PATCH_FAILED" : null
            }), "utf8");
            for (const responseMode of ["full", "compact"]) {
                const result = resultOf(await environment.invoke({
                    command: "query",
                    jobId,
                    wait: false,
                    responseMode
                }));
                assert.equal(result.patchFile, null);
                assert.equal(result.patchAvailable, false);
                assert.equal(JSON.stringify(result).includes(`STATE_${state}_DIFF`), false);
                assert.equal(JSON.stringify(result).includes("secret.txt"), false);
            }
        } finally { await environment.cleanup(); }
    }
});

test("patch trace, listJobs, and Monitor expose only safe patch status fields", async () => {
    const environment = await createEnvironment({ patchFlag: "false" });
    try {
        const artifact = installAuthorizedAppServerPatch(environment, "job_patch_safe_surfaces");
        const injected = {
            ...artifact.meta,
            patchAvailable: true,
            candidatePath: "C:\\secret\\candidate.patch",
            targetPaths: ["secret-target.txt"],
            gitStderr: "GIT_STDERR_MUST_NOT_RETURN",
            gitStatus: "GIT_STATUS_MUST_NOT_RETURN",
            task: "TASK_MUST_NOT_RETURN",
            controlToken: "CONTROL_MUST_NOT_RETURN",
            endpoint: "ENDPOINT_MUST_NOT_RETURN",
            processIdentity: { marker: "PROCESS_IDENTITY_MUST_NOT_RETURN" }
        };
        artifact.protocol.writeJsonAtomic(artifact.paths.metaPath, injected);

        for (const traceMode of ["events", "raw"]) {
            const trace = resultOf(await environment.invoke({
                command: "trace",
                jobId: artifact.meta.jobId,
                traceMode
            }));
            assert.equal(trace.jobKind, "patch");
            assert.equal(trace.jobPhase, "completed");
            const serialized = JSON.stringify(trace);
            for (const secret of [
                "diff --git", "secret-target.txt", "GIT_STDERR_MUST_NOT_RETURN",
                "GIT_STATUS_MUST_NOT_RETURN", "candidate.patch", artifact.meta.patchArtifactNonce,
                "CONTROL_MUST_NOT_RETURN", "ENDPOINT_MUST_NOT_RETURN", "PROCESS_IDENTITY_MUST_NOT_RETURN"
            ]) {
                assert.equal(serialized.includes(secret), false, `trace leaked ${secret}`);
            }
        }

        const listed = resultOf(await environment.invoke({ command: "listJobs", limit: 5 }));
        const listedPatch = listed.jobs.find(job => job.jobId === artifact.meta.jobId);
        assert.equal(listedPatch.jobKind, "patch");
        assert.equal(listedPatch.jobPhase, "completed");
        assert.equal(listedPatch.patchAvailable, true);
        assert.equal(listedPatch.patchValidated, true);
        assert.equal(listedPatch.applyCheckPassed, true);
        assert.equal(listedPatch.baselineStable, true);
        assert.equal(listedPatch.patchBytes, artifact.meta.patchBytes);
        assert.equal(listedPatch.patchFileCount, 1);
        for (const secret of ["diff --git", "candidate.patch", artifact.meta.patchArtifactNonce, "GIT_STDERR_MUST_NOT_RETURN"]) {
            assert.equal(JSON.stringify(listed).includes(secret), false, `listJobs leaked ${secret}`);
        }

        const monitor = require(sourceMonitor);
        const payload = monitor.buildJobStatusPayload({
            ...injected,
            patchFile: artifact.paths.patchPath,
            errorCode: "AICW_SAFE_ERROR"
        }, artifact.paths.metaPath);
        assert.equal(payload.data.jobKind, "patch");
        assert.equal(payload.data.jobPhase, "completed");
        assert.equal(payload.data.patchAvailable, true);
        assert.equal(payload.data.patchValidated, true);
        assert.equal(payload.data.applyCheckPassed, true);
        assert.equal(payload.data.baselineStable, true);
        assert.equal(payload.data.patchBytes, artifact.meta.patchBytes);
        assert.equal(payload.data.patchFileCount, 1);
        assert.equal(payload.data.errorCode, "AICW_SAFE_ERROR");
        for (const secret of [
            artifact.paths.patchPath, "diff --git", "secret-target.txt", "candidate.patch",
            artifact.meta.patchArtifactNonce, "GIT_STDERR_MUST_NOT_RETURN", "TASK_MUST_NOT_RETURN",
            "CONTROL_MUST_NOT_RETURN", "ENDPOINT_MUST_NOT_RETURN", "PROCESS_IDENTITY_MUST_NOT_RETURN"
        ]) {
            assert.equal(JSON.stringify(payload).includes(secret), false, `Monitor leaked ${secret}`);
        }
    } finally { await environment.cleanup(); }
});

test("Monitor fails closed when a completed public patch is tampered", async () => {
    const environment = await createEnvironment({ patchFlag: "false" });
    try {
        const artifact = installAuthorizedAppServerPatch(environment, "job_monitor_tampered");
        fs.writeFileSync(artifact.paths.patchPath, "tampered monitor artifact", "utf8");
        const monitor = require(sourceMonitor);
        const payload = monitor.buildJobStatusPayload({
            ...artifact.meta,
            patchAvailable: true,
            patchValidated: true,
            applyCheckPassed: true,
            baselineStable: true
        }, artifact.paths.metaPath);
        assert.equal(payload.data.patchAvailable, false);
        assert.equal(payload.data.patchValidated, false);
        assert.equal(payload.data.patchBytes, null);
        assert.equal(payload.data.patchFileCount, null);
        assert.equal(Object.prototype.hasOwnProperty.call(payload.data, "patchFile"), false);
        assert.equal(JSON.stringify(payload).includes("tampered monitor artifact"), false);
    } finally { await environment.cleanup(); }
});

test("Monitor verifier exceptions fail closed without affecting a legacy projection", async () => {
    const environment = await createEnvironment({ patchFlag: "false" });
    try {
        const monitorPath = require.resolve(sourceMonitor);
        const protocolPath = require.resolve(path.join(sourcePluginDir, "appserver", "protocol.js"));
        const protocol = require(protocolPath);
        const originalMonitorModule = require.cache[monitorPath];
        const originalVerifier = protocol.inspectAuthorizedPatchArtifact;
        try {
            const artifact = installAuthorizedAppServerPatch(environment, "job_monitor_verifier_error");
            delete require.cache[monitorPath];
            protocol.inspectAuthorizedPatchArtifact = () => {
                throw new Error("injected verifier failure");
            };
            const monitor = require(sourceMonitor);
            const patchPayload = monitor.buildJobStatusPayload(artifact.meta, artifact.paths.metaPath);
            assert.equal(patchPayload.data.patchAvailable, false);
            assert.equal(patchPayload.data.patchValidated, false);
            assert.equal(patchPayload.data.patchBytes, null);

            const legacyPayload = monitor.buildJobStatusPayload({
                jobId: "job_monitor_legacy",
                state: "completed",
                worker: "codex",
                mode: "patch",
                executionBackend: "legacy-exec",
                patchAvailable: true,
                patchValidated: true,
                applyCheckPassed: true,
                baselineStable: true,
                patchBytes: 12,
                patchFileCount: 1
            }, path.join(environment.jobRoot, "meta", "job_monitor_legacy.json"));
            assert.equal(legacyPayload.data.patchAvailable, true);
            assert.equal(legacyPayload.data.patchBytes, 12);
        } finally {
            protocol.inspectAuthorizedPatchArtifact = originalVerifier;
            delete require.cache[monitorPath];
            if (originalMonitorModule) require.cache[monitorPath] = originalMonitorModule;
        }
    } finally {
        await environment.cleanup();
    }
});

test("cleanupOldJobs precisely removes an authorized terminal app-server patch", async () => {
    const environment = await createEnvironment({ patchFlag: "false" });
    try {
        const artifact = installAuthorizedAppServerPatch(environment, "job_cleanup_authorized");
        markArtifactOld(artifact);
        const worker = require(environment.workerPath);
        worker.cleanupOldJobs(7, 10);
        assert.equal(fs.existsSync(artifact.paths.metaPath), false);
        assert.equal(fs.existsSync(artifact.paths.patchPath), false);
        assert.equal(fs.existsSync(artifact.paths.outputPath), false);
        assert.equal(fs.existsSync(artifact.paths.codexOutputPath), false);
    } finally { await environment.cleanup(); }
});

test("cleanupOldJobs keeps replaced, hash-mismatched, and drifted app-server artifacts", async () => {
    for (const scenario of ["replacement", "hash-mismatch", "directory-drift"]) {
        const environment = await createEnvironment({ patchFlag: "false" });
        try {
            const artifact = installAuthorizedAppServerPatch(environment, `job_cleanup_${scenario}`);
            markArtifactOld(artifact);
            if (scenario === "replacement") {
                fs.renameSync(artifact.paths.patchPath, `${artifact.paths.patchPath}.original`);
                fs.writeFileSync(artifact.paths.patchPath, "replacement artifact", "utf8");
            } else if (scenario === "hash-mismatch") {
                fs.writeFileSync(artifact.paths.patchPath, "hash-mismatch artifact", "utf8");
            } else {
                const patchDirectory = path.dirname(artifact.paths.patchPath);
                fs.renameSync(patchDirectory, `${patchDirectory}.original`);
                fs.mkdirSync(patchDirectory, { recursive: true });
            }

            const worker = require(environment.workerPath);
            worker.cleanupOldJobs(7, 10);
            assert.equal(fs.existsSync(artifact.paths.metaPath), true, `${scenario} must retain meta`);
            if (scenario === "directory-drift") {
                assert.equal(
                    fs.existsSync(path.join(`${path.dirname(artifact.paths.patchPath)}.original`, path.basename(artifact.paths.patchPath))),
                    true
                );
            } else {
                assert.equal(fs.existsSync(artifact.paths.patchPath), true, `${scenario} must retain public artifact`);
            }
        } finally { await environment.cleanup(); }
    }
});

test("cleanupOldJobs does not touch running or unknown app-server patch Jobs", async () => {
    for (const state of ["running", "unknown"]) {
        const environment = await createEnvironment({ patchFlag: "false" });
        try {
            const artifact = installAuthorizedAppServerPatch(environment, `job_cleanup_${state}`);
            markArtifactOld(artifact, { state });
            const worker = require(environment.workerPath);
            worker.cleanupOldJobs(7, 10);
            assert.equal(fs.existsSync(artifact.paths.metaPath), true);
            assert.equal(fs.existsSync(artifact.paths.patchPath), true);
            assert.equal(fs.existsSync(artifact.paths.outputPath), true);
        } finally { await environment.cleanup(); }
    }
});

test("completed app-server patch tamper or same-content replacement is unauthorized in full and compact", async () => {
    for (const mode of ["tamper", "replacement"]) {
        const environment = await createEnvironment({ flag: "false" });
        try {
            const artifact = installAuthorizedAppServerPatch(environment, `job_query_patch_${mode}`);
            if (mode === "tamper") {
                fs.writeFileSync(artifact.paths.patchPath, "tampered", "utf8");
            } else {
                fs.renameSync(artifact.paths.patchPath, `${artifact.paths.patchPath}.original`);
                fs.writeFileSync(artifact.paths.patchPath, artifact.patchText, "utf8");
            }
            for (const responseMode of ["full", "compact"]) {
                const result = resultOf(await environment.invoke({
                    command: "query", jobId: artifact.meta.jobId, wait: responseMode === "full", responseMode
                }));
                assert.equal(result.patchFile, null);
                assert.equal(result.patchAvailable, false);
                assert.equal(result.patchSha256, null);
                assert.equal(result.patchBytes, null);
                assert.equal(result.patchFileCount, null);
                assert.equal(result.patchContractVersion, null);
                assert.equal(result.baseHead, null);
                assert.equal(result.patchValidated, false);
                assert.equal(result.applyCheckPassed, false);
                assert.equal(result.baselineStable, false);
            }
            assert.equal(fs.existsSync(artifact.paths.patchPath), true, "query must not delete tampered public artifact");
        } finally { await environment.cleanup(); }
    }
});

test("completed app-server patch public symlink or junction is unauthorized", async t => {
    const environment = await createEnvironment({ flag: "false" });
    try {
        const artifact = installAuthorizedAppServerPatch(environment, "job_query_patch_link");
        const target = path.join(environment.jobRoot, "link-target.patch");
        fs.writeFileSync(target, artifact.patchText, "utf8");
        fs.unlinkSync(artifact.paths.patchPath);
        try {
            fs.symlinkSync(target, artifact.paths.patchPath, "file");
        } catch (error) {
            if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
                const originalDirectory = path.dirname(artifact.paths.patchPath);
                const displacedDirectory = `${originalDirectory}.original`;
                const junctionTarget = path.join(environment.jobRoot, "junction-target");
                fs.renameSync(originalDirectory, displacedDirectory);
                fs.mkdirSync(junctionTarget, { recursive: true });
                fs.writeFileSync(path.join(junctionTarget, path.basename(artifact.paths.patchPath)), artifact.patchText, "utf8");
                try {
                    fs.symlinkSync(junctionTarget, originalDirectory, "junction");
                } catch (junctionError) {
                    if (["EPERM", "EACCES", "UNKNOWN"].includes(junctionError?.code)) {
                        t.diagnostic(`symlink and junction creation unavailable: ${junctionError.code}`);
                        return;
                    }
                    throw junctionError;
                }
            }
            else throw error;
        }
        for (const responseMode of ["full", "compact"]) {
            const result = resultOf(await environment.invoke({ command: "query", jobId: artifact.meta.jobId, wait: false, responseMode }));
            assert.equal(result.patchFile, null);
            assert.equal(result.patchAvailable, false);
        }
    } finally { await environment.cleanup(); }
});

test("legacy patch query keeps fixed-path compatibility in full and compact", async () => {
    const environment = await createEnvironment({ flag: "false" });
    try {
        const jobId = "job_query_legacy_patch";
        const patchPath = path.join(environment.jobRoot, "patches", `${jobId}.patch`);
        fs.mkdirSync(path.dirname(patchPath), { recursive: true });
        fs.mkdirSync(path.join(environment.jobRoot, "meta"), { recursive: true });
        fs.writeFileSync(patchPath, "legacy patch", "utf8");
        fs.writeFileSync(metaPath(environment, jobId), JSON.stringify({
            jobId, state: "completed", worker: "codex", mode: "patch",
            projectPath: environment.projectRoot, executionBackend: "legacy-exec", exitCode: 0,
            startedAt: "2000-01-01T00:00:00.000Z"
        }), "utf8");
        for (const responseMode of ["full", "compact"]) {
            const result = resultOf(await environment.invoke({ command: "query", jobId, wait: false, responseMode }));
            assert.equal(result.patchFile, patchPath);
            assert.equal(result.patchAvailable, true);
        }
        const monitor = require(sourceMonitor);
        const monitorPayload = monitor.buildJobStatusPayload({
            jobId,
            state: "completed",
            worker: "codex",
            mode: "patch",
            executionBackend: "legacy-exec",
            patchAvailable: true,
            patchValidated: false,
            patchBytes: null,
            patchFileCount: null
        }, metaPath(environment, jobId));
        assert.equal(monitorPayload.data.patchAvailable, true);
        assert.equal(Object.prototype.hasOwnProperty.call(monitorPayload.data, "patchFile"), false);

        const worker = require(environment.workerPath);
        worker.cleanupOldJobs(7, 10);
        assert.equal(fs.existsSync(patchPath), false);
        assert.equal(fs.existsSync(metaPath(environment, jobId)), false);
    } finally { await environment.cleanup(); }
});

test("classifyAppServerArtifactMeta is pure, marker-first, and fail closed", () => {
    const protocol = require(path.join(sourceAppServerDir, "protocol.js"));
    const classify = protocol.classifyAppServerArtifactMeta;
    const markerFields = [
        "patchContractVersion", "patchArtifactDirectoryIdentity", "patchArtifactPublicIdentity",
        "patchArtifactNonce", "patchSha256", "patchBytes", "patchFileCount", "patchValidated",
        "applyCheckPassed", "baselineStable", "gitRepoRoot", "baseHead", "baseTree", "baseStatusSha256"
    ];

    for (const field of markerFields) {
        assert.equal(classify({ [field]: null }), "patch", field);
    }
    assert.equal(classify({ jobKind: "patch" }), "patch");
    assert.equal(classify({ executionBackend: "codex-app-server", mode: "patch" }), "patch");
    assert.equal(classify({
        executionBackend: "legacy-exec",
        requestedExecutionBackend: "codex-app-server",
        mode: "patch"
    }), "patch");
    assert.equal(classify({ patchArtifactNonce: "bbbbbbbbbbbbbbbbbbbbbbbb" }), "patch");
    assert.equal(classify({
        executionBackend: "codex-app-server",
        mode: "analyze",
        patchSha256: "not-a-real-hash"
    }), "patch");
    assert.equal(classify({ executionBackend: "codex-app-server", mode: "analyze" }), "analyze");
    assert.equal(classify({ executionBackend: "codex-app-server" }), "ambiguous");
    assert.equal(classify({ requestedExecutionBackend: "codex-app-server", mode: "unknown" }), "ambiguous");
    assert.equal(classify({
        executionBackend: "codex-app-server",
        mode: "analyze",
        jobKind: "write"
    }), "ambiguous");
    assert.equal(classify({ mode: "patch" }), "legacy");
    assert.equal(classify({ executionBackend: "legacy-exec", mode: "patch" }), "legacy");

    const untouched = { executionBackend: "codex-app-server", mode: "analyze" };
    const before = JSON.stringify(untouched);
    assert.equal(classify(untouched), "analyze");
    assert.equal(JSON.stringify(untouched), before);
});

test("query and listJobs keep missing-jobKind and rewritten-backend patches behind authorization", async () => {
    const environment = await createEnvironment({ patchFlag: "false" });
    try {
        const artifact = installAuthorizedAppServerPatch(environment, "job_routing_patch_classification");
        const missingJobKind = { ...artifact.meta };
        delete missingJobKind.jobKind;
        artifact.protocol.writeJsonAtomic(artifact.paths.metaPath, missingJobKind);

        for (const responseMode of ["full", "compact"]) {
            const result = resultOf(await environment.invoke({
                command: "query",
                jobId: artifact.meta.jobId,
                wait: false,
                responseMode
            }));
            assert.equal(result.patchFile, artifact.paths.patchPath);
            assert.equal(result.patchAvailable, true);
            assert.equal(JSON.stringify(result).includes("MODEL_PATCH_BODY_MUST_NOT_RETURN"), false);
        }

        const listed = resultOf(await environment.invoke({ command: "listJobs", limit: 10 }));
        const listedPatch = listed.jobs.find(job => job.jobId === artifact.meta.jobId);
        assert.equal(listedPatch.patchAvailable, true);
        assert.equal(listedPatch.patchValidated, true);

        const rewrittenBackend = { ...missingJobKind, executionBackend: "legacy-exec" };
        artifact.protocol.writeJsonAtomic(artifact.paths.metaPath, rewrittenBackend);
        for (const responseMode of ["full", "compact"]) {
            const result = resultOf(await environment.invoke({
                command: "query",
                jobId: artifact.meta.jobId,
                wait: false,
                responseMode
            }));
            assert.equal(result.patchFile, artifact.paths.patchPath);
            assert.equal(result.patchAvailable, true);
        }

        fs.writeFileSync(artifact.paths.patchPath, "QUERY_TAMPERED_BODY", "utf8");
        for (const responseMode of ["full", "compact"]) {
            const result = resultOf(await environment.invoke({
                command: "query",
                jobId: artifact.meta.jobId,
                wait: false,
                responseMode
            }));
            assert.equal(result.patchFile, null);
            assert.equal(result.patchAvailable, false);
            assert.equal(JSON.stringify(result).includes("QUERY_TAMPERED_BODY"), false);
        }
    } finally { await environment.cleanup(); }
});

test("ambiguous app-server meta never projects a fixed patch in full, compact, or listJobs", async () => {
    const environment = await createEnvironment({ patchFlag: "false" });
    try {
        const protocol = require(path.join(environment.pluginDir, "appserver", "protocol.js"));
        const jobId = "job_routing_ambiguous_projection";
        const paths = protocol.jobPaths(environment.jobRoot, jobId);
        fs.mkdirSync(path.dirname(paths.metaPath), { recursive: true });
        fs.mkdirSync(path.dirname(paths.patchPath), { recursive: true });
        fs.writeFileSync(paths.patchPath, "AMBIGUOUS_FIXED_PATH_BODY", "utf8");
        fs.writeFileSync(paths.metaPath, JSON.stringify({
            jobId,
            state: "completed",
            worker: "codex",
            mode: "future-mode",
            projectPath: environment.projectRoot,
            executionBackend: "codex-app-server",
            requestedExecutionBackend: "codex-app-server",
            patchAvailable: true,
            startedAt: "2000-01-01T00:00:00.000Z"
        }), "utf8");

        for (const responseMode of ["full", "compact"]) {
            const result = resultOf(await environment.invoke({ command: "query", jobId, wait: false, responseMode }));
            assert.equal(result.patchFile, null);
            assert.equal(result.patchAvailable, false);
            assert.equal(JSON.stringify(result).includes("AMBIGUOUS_FIXED_PATH_BODY"), false);
        }
        const listed = resultOf(await environment.invoke({ command: "listJobs", limit: 10 }));
        const listedJob = listed.jobs.find(job => job.jobId === jobId);
        assert.equal(listedJob.patchAvailable, false);
        assert.equal(listedJob.patchValidated, false);
        assert.equal(listedJob.patchBytes, null);
        assert.equal(fs.existsSync(paths.patchPath), true);
    } finally { await environment.cleanup(); }
});

test("Monitor sends missing-jobKind, rewritten-backend, and marker-only patches through the verifier", async () => {
    const environment = await createEnvironment({ patchFlag: "false" });
    const monitorPath = require.resolve(sourceMonitor);
    const protocolPath = require.resolve(path.join(sourcePluginDir, "appserver", "protocol.js"));
    const protocol = require(protocolPath);
    const originalMonitorModule = require.cache[monitorPath];
    const originalVerifier = protocol.inspectAuthorizedPatchArtifact;
    try {
        const artifact = installAuthorizedAppServerPatch(environment, "job_monitor_classification");
        delete require.cache[monitorPath];
        let verifierCalls = 0;
        protocol.inspectAuthorizedPatchArtifact = (...args) => {
            verifierCalls++;
            return originalVerifier(...args);
        };
        const monitor = require(sourceMonitor);
        const missingJobKind = { ...artifact.meta };
        delete missingJobKind.jobKind;
        const rewrittenBackend = { ...missingJobKind, executionBackend: "legacy-exec" };
        const markerOnly = { ...artifact.meta };
        delete markerOnly.executionBackend;
        delete markerOnly.requestedExecutionBackend;
        delete markerOnly.mode;
        delete markerOnly.jobKind;

        for (const variant of [missingJobKind, rewrittenBackend, markerOnly]) {
            const before = verifierCalls;
            const payload = monitor.buildJobStatusPayload(variant, artifact.paths.metaPath);
            assert.equal(payload.data.patchAvailable, true);
            assert.equal(payload.data.patchValidated, true);
            assert.ok(verifierCalls > before);
            assert.equal(JSON.stringify(payload).includes(artifact.paths.patchPath), false);
        }

        const ambiguous = {
            jobId: "job_monitor_ambiguous",
            state: "completed",
            worker: "codex",
            mode: "future-mode",
            executionBackend: "codex-app-server",
            requestedExecutionBackend: "codex-app-server",
            patchAvailable: true
        };
        const beforeAmbiguous = verifierCalls;
        const ambiguousPayload = monitor.buildJobStatusPayload(ambiguous, artifact.paths.metaPath);
        assert.equal(verifierCalls, beforeAmbiguous);
        assert.equal(ambiguousPayload.data.patchAvailable, false);
        assert.equal(ambiguousPayload.data.patchValidated, false);
        assert.equal(ambiguousPayload.data.patchBytes, null);
        assert.equal(ambiguousPayload.data.patchFileCount, null);
    } finally {
        protocol.inspectAuthorizedPatchArtifact = originalVerifier;
        delete require.cache[monitorPath];
        if (originalMonitorModule) require.cache[monitorPath] = originalMonitorModule;
        await environment.cleanup();
    }
});

test("cleanupOldJobs authorizes missing-jobKind patches and retains replacements or hash mismatches", async () => {
    {
        const environment = await createEnvironment({ patchFlag: "false" });
        try {
            const artifact = installAuthorizedAppServerPatch(environment, "job_cleanup_missing_jobKind");
            delete artifact.meta.jobKind;
            markArtifactOld(artifact);
            const worker = require(environment.workerPath);
            worker.cleanupOldJobs(7, 10);
            assert.equal(fs.existsSync(artifact.paths.metaPath), false);
            assert.equal(fs.existsSync(artifact.paths.patchPath), false);
            assert.equal(fs.existsSync(artifact.paths.outputPath), false);
            assert.equal(fs.existsSync(artifact.paths.codexOutputPath), false);
        } finally { await environment.cleanup(); }
    }

    for (const scenario of ["replacement", "hash-mismatch"]) {
        const environment = await createEnvironment({ patchFlag: "false" });
        try {
            const artifact = installAuthorizedAppServerPatch(environment, `job_cleanup_missing_jobKind_${scenario}`);
            delete artifact.meta.jobKind;
            markArtifactOld(artifact);
            if (scenario === "replacement") {
                fs.renameSync(artifact.paths.patchPath, `${artifact.paths.patchPath}.original`);
                fs.writeFileSync(artifact.paths.patchPath, "MISSING_JOBKIND_REPLACEMENT", "utf8");
            } else {
                fs.writeFileSync(artifact.paths.patchPath, "MISSING_JOBKIND_HASH_MISMATCH", "utf8");
            }
            const worker = require(environment.workerPath);
            worker.cleanupOldJobs(7, 10);
            assert.equal(fs.existsSync(artifact.paths.metaPath), true, `${scenario} must retain meta`);
            assert.equal(fs.existsSync(artifact.paths.patchPath), true, `${scenario} must retain public artifact`);
        } finally { await environment.cleanup(); }
    }
});

test("cleanupOldJobs skips ambiguous meta and never unlinks its fixed patch", async () => {
    const environment = await createEnvironment({ patchFlag: "false" });
    try {
        const jobId = "job_cleanup_ambiguous_projection";
        const paths = cleanupPaths(environment, jobId);
        for (const filePath of [paths.metaPath, paths.argsPath, paths.outputPath, paths.logPath, paths.patchPath, paths.codexOutputPath]) {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, `AMBIGUOUS_${path.basename(filePath)}`, "utf8");
        }
        fs.writeFileSync(paths.metaPath, JSON.stringify({
            jobId,
            state: "completed",
            worker: "codex",
            mode: "future-mode",
            executionBackend: "codex-app-server",
            requestedExecutionBackend: "codex-app-server",
            patchAvailable: true,
            startedAt: "2000-01-01T00:00:00.000Z"
        }), "utf8");
        const worker = require(environment.workerPath);
        worker.cleanupOldJobs(7, 10);
        for (const filePath of [paths.metaPath, paths.argsPath, paths.outputPath, paths.logPath, paths.patchPath, paths.codexOutputPath]) {
            assert.equal(fs.existsSync(filePath), true, `ambiguous cleanup retained ${path.basename(filePath)}`);
        }
    } finally { await environment.cleanup(); }
});

test("cleanupOldJobs analyzes without deleting an analyze Job fixed patch", async () => {
    const environment = await createEnvironment({ patchFlag: "false" });
    try {
        const jobId = "job_cleanup_analyze_projection";
        const paths = cleanupPaths(environment, jobId);
        for (const filePath of [paths.metaPath, paths.argsPath, paths.outputPath, paths.logPath, paths.patchPath, paths.codexOutputPath]) {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, `ANALYZE_${path.basename(filePath)}`, "utf8");
        }
        fs.writeFileSync(paths.metaPath, JSON.stringify({
            jobId,
            state: "completed",
            worker: "codex",
            mode: "analyze",
            executionBackend: "codex-app-server",
            requestedExecutionBackend: "codex-app-server",
            startedAt: "2000-01-01T00:00:00.000Z"
        }), "utf8");
        const worker = require(environment.workerPath);
        worker.cleanupOldJobs(7, 10);
        for (const filePath of [paths.metaPath, paths.argsPath, paths.outputPath, paths.logPath, paths.codexOutputPath]) {
            assert.equal(fs.existsSync(filePath), false, `analyze cleanup removed ${path.basename(filePath)}`);
        }
        assert.equal(fs.existsSync(paths.patchPath), true);
    } finally { await environment.cleanup(); }
});

test("cleanupOldJobs preserves all artifacts when meta filename and jobId disagree", async () => {
    const environment = await createEnvironment({ patchFlag: "false" });
    try {
        const localId = "job_cleanup_filename_binding";
        const otherId = "job_cleanup_other_job";
        const localPaths = cleanupPaths(environment, localId);
        const otherPaths = cleanupPaths(environment, otherId);
        for (const filePath of [localPaths.metaPath, localPaths.argsPath, localPaths.outputPath, localPaths.logPath, localPaths.patchPath, localPaths.codexOutputPath,
            otherPaths.metaPath, otherPaths.argsPath, otherPaths.outputPath, otherPaths.logPath, otherPaths.patchPath, otherPaths.codexOutputPath]) {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, `BINDING_${path.basename(filePath)}`, "utf8");
        }
        fs.writeFileSync(localPaths.metaPath, JSON.stringify({
            jobId: otherId,
            state: "completed",
            worker: "codex",
            mode: "future-mode",
            executionBackend: "codex-app-server",
            requestedExecutionBackend: "codex-app-server",
            patchAvailable: true,
            startedAt: "2000-01-01T00:00:00.000Z"
        }), "utf8");
        fs.writeFileSync(otherPaths.metaPath, JSON.stringify({
            jobId: otherId,
            state: "completed",
            worker: "codex",
            mode: "patch",
            executionBackend: "legacy-exec",
            startedAt: new Date().toISOString()
        }), "utf8");
        const worker = require(environment.workerPath);
        worker.cleanupOldJobs(7, 10);
        for (const filePath of [localPaths.metaPath, localPaths.argsPath, localPaths.outputPath, localPaths.logPath, localPaths.patchPath, localPaths.codexOutputPath,
            otherPaths.metaPath, otherPaths.argsPath, otherPaths.outputPath, otherPaths.logPath, otherPaths.patchPath, otherPaths.codexOutputPath]) {
            assert.equal(fs.existsSync(filePath), true, `filename binding retained ${path.basename(filePath)}`);
        }
    } finally { await environment.cleanup(); }
});

test("marker-only app-server patches never downgrade to legacy output or JSONL parsing", async () => {
    const environment = await createEnvironment({ patchFlag: "false" });
    try {
        const artifact = installAuthorizedAppServerPatch(environment, "job_routing_marker_only", "diff --git a/authorized.txt b/authorized.txt\n");
        const paths = writeArtifactRoutingSentinelOutput(environment, artifact.meta.jobId);
        const markerOnly = {
            ...artifact.meta,
            startedAt: "2026-08-30T00:00:00.000Z",
            completedAt: "2026-08-30T00:00:01.000Z"
        };
        for (const field of ["executionBackend", "requestedExecutionBackend", "mode", "jobKind"]) {
            delete markerOnly[field];
        }

        const variants = [
            ["both-backends-deleted", markerOnly],
            ["both-backends-rewritten", {
                ...markerOnly,
                executionBackend: "legacy-exec",
                requestedExecutionBackend: "legacy-exec"
            }]
        ];
        for (const [variantName, meta] of variants) {
            artifact.protocol.writeJsonAtomic(artifact.paths.metaPath, meta);
            for (const traceMode of ["events", "raw"]) {
                const trace = resultOf(await environment.invoke({
                    command: "trace",
                    jobId: artifact.meta.jobId,
                    traceMode
                }));
                assertNoArtifactRoutingSentinels(trace, `${variantName} trace ${traceMode}`);
                assert.equal(trace.jobPhase, "completed");
            }
            for (const responseMode of ["full", "compact"]) {
                const result = resultOf(await environment.invoke({
                    command: "query",
                    jobId: artifact.meta.jobId,
                    wait: false,
                    responseMode,
                    ...(responseMode === "full" ? { traceMode: "events" } : {})
                }));
                assertNoArtifactRoutingSentinels(result, `${variantName} query ${responseMode}`);
                assert.equal(result.patchFile, paths.patchPath);
                assert.equal(result.patchAvailable, true);
                if (responseMode === "full") {
                    assert.equal(result.output, "");
                    assert.equal(result.logSummary, "");
                }
            }
        }

        const running = { ...markerOnly, state: "running", completedAt: null };
        artifact.protocol.writeJsonAtomic(artifact.paths.metaPath, running);
        for (const traceMode of ["events", "raw"]) {
            const trace = resultOf(await environment.invoke({
                command: "trace",
                jobId: artifact.meta.jobId,
                traceMode
            }));
            assertNoArtifactRoutingSentinels(trace, `marker-only running trace ${traceMode}`);
        }
        for (const responseMode of ["full", "compact"]) {
            const result = resultOf(await environment.invoke({
                command: "query",
                jobId: artifact.meta.jobId,
                wait: false,
                responseMode,
                ...(responseMode === "full" ? { traceMode: "raw" } : {})
            }));
            assertNoArtifactRoutingSentinels(result, `marker-only running query ${responseMode}`);
            assert.equal(result.patchFile, null);
            assert.equal(result.patchAvailable, false);
            if (responseMode === "full") {
                assert.equal(Object.prototype.hasOwnProperty.call(result, "output"), false);
                assert.equal(Object.prototype.hasOwnProperty.call(result, "logSummary"), false);
            }
        }
    } finally { await environment.cleanup(); }
});

test("ambiguous app-server artifacts fail closed across full, compact, and trace surfaces", async () => {
    const environment = await createEnvironment({ patchFlag: "false" });
    try {
        const jobId = "job_routing_ambiguous_output";
        const paths = writeArtifactRoutingSentinelOutput(environment, jobId);
        fs.mkdirSync(path.dirname(paths.patchPath), { recursive: true });
        fs.writeFileSync(paths.patchPath, "AMBIGUOUS_FIXED_PATH_BODY", "utf8");
        const meta = {
            jobId,
            state: "completed",
            worker: "codex",
            mode: "future-mode",
            projectPath: environment.projectRoot,
            executionBackend: "codex-app-server",
            requestedExecutionBackend: "codex-app-server",
            patchAvailable: true,
            warnings: [{ message: "COMMAND_OUTPUT_SENTINEL" }],
            startedAt: "2026-08-30T00:00:00.000Z",
            completedAt: "2026-08-30T00:00:01.000Z"
        };
        const protocol = require(path.join(environment.pluginDir, "appserver", "protocol.js"));
        protocol.writeJsonAtomic(paths.metaPath, meta);

        for (const traceMode of ["events", "raw"]) {
            const trace = resultOf(await environment.invoke({
                command: "trace",
                jobId,
                traceMode
            }));
            assertNoArtifactRoutingSentinels(trace, `ambiguous trace ${traceMode}`);
            assert.equal(trace.patchFile, null);
            assert.equal(trace.patchAvailable, false);
            assert.equal(trace.jobPhase, null);
        }
        for (const traceMode of ["events", "raw"]) {
            const full = resultOf(await environment.invoke({
                command: "query",
                jobId,
                wait: false,
                responseMode: "full",
                traceMode
            }));
            assertNoArtifactRoutingSentinels(full, `ambiguous full ${traceMode}`);
            assert.equal(full.patchFile, null);
            assert.equal(full.patchAvailable, false);
            assert.equal(full.output, "");
            assert.equal(full.logSummary, "");
        }
        const compact = resultOf(await environment.invoke({
            command: "query",
            jobId,
            wait: false,
            responseMode: "compact"
        }));
        assertNoArtifactRoutingSentinels(compact, "ambiguous compact");
        assert.equal(compact.patchFile, null);
        assert.equal(compact.patchAvailable, false);
        assert.equal(fs.existsSync(paths.patchPath), true);
    } finally { await environment.cleanup(); }
});
