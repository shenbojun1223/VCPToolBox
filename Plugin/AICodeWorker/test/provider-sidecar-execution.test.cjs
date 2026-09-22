"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");

const { SidecarServer } = require("../appserver/sidecarServer");
const {
    createProviderRouteCatalog,
    DEFAULT_PROVIDER_ROUTE_CATALOG,
    PROVIDER_ERROR_CODES
} = require("../appserver/providerRoutes");
const { CodexAppServerProcess } = require("../appserver/codexAppServerProcess");

function createMockExecution(options = {}) {
    const execution = Object.create(CodexAppServerProcess.prototype);
    EventEmitter.call(execution);
    Object.assign(execution, EventEmitter.prototype);
    
    execution.started = false;
    execution.closed = false;
    execution.stopping = false;
    execution.connection = null;
    execution.child = null;
    execution.codexPid = null;
    execution.codexIdentity = null;
    execution._versionChild = null;
    execution._versionIdentity = null;
    execution._stopPromise = null;
    execution._starting = null;
    execution._stopTargets = new Map();

    execution.startCalls = 0;
    execution.startThreadCalls = 0;
    execution.startTurnCalls = 0;
    execution.stopCalls = 0;

    execution.start = async () => {
        execution.startCalls++;
        execution.started = true;
        return execution;
    };
    execution.startThread = async (params) => {
        execution.startThreadCalls++;
        execution.lastThreadParams = params;
        return {
            id: options.threadId || "test-provider-thread-1",
            modelProvider: params.modelProvider,
            model: params.model
        };
    };
    execution.startTurn = async (params) => {
        execution.startTurnCalls++;
        execution.lastTurnParams = params;
        return { id: options.turnId || "test-provider-turn-1" };
    };
    execution.interruptTurn = async () => {
        execution.interrupted = true;
        return { ok: true };
    };
    execution.stop = async (stopOpts) => {
        execution.stopCalls++;
        execution.lastStopOptions = stopOpts;
        execution.closed = true;
        return { confirmed: true };
    };

    return execution;
}

test("SidecarServer correctly dispatches analyze job to exclusive provider execution", async () => {
    const tempRoot = fs.realpathSync.native(
        fs.mkdtempSync(path.join(os.tmpdir(), "vcp-aicw-test-exec-"))
    );
    const pluginDir = path.join(tempRoot, "plugin");
    const jobRoot = path.join(tempRoot, "jobs");
    const projectRoot = path.join(tempRoot, "project");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(path.join(jobRoot, "meta"), { recursive: true });

    let createdExecution = null;
    const DESCRIPTORS = [
        {
            routeId: "deepseek-official",
            revision: "official-r1",
            upstreamModel: "deepseek-flash",
            reasoningEfforts: ["low", "high", "max"],
            defaultReasoningEffort: "high",
            serviceTiers: ["default", "fast"],
            defaultServiceTier: "default"
        },
        {
            routeId: "deepseek-commandcode",
            revision: "commandcode-r2",
            upstreamModel: "deepseek-v4.1-flash",
            reasoningEfforts: ["low", "high", "max"],
            defaultReasoningEffort: "high",
            serviceTiers: ["default", "fast"],
            defaultServiceTier: "fast"
        }
    ];
    const testCatalog = createProviderRouteCatalog(DESCRIPTORS);
    
    const server = new SidecarServer({
        pluginDir,
        jobRoot,
        providerRouteCatalog: testCatalog,
        providerCodexFactory: (details) => {
            createdExecution = createMockExecution();
            createdExecution.details = details;
            return createdExecution;
        }
    });

    server.state = {
        schemaVersion: 1,
        instanceId: "test-sidecar-instance",
        controlToken: "test-token",
        pid: 99999,
        codexPid: null,
        status: "ready"
    };

    const status = server.status();
    assert.equal(status.providerExecutionAvailable, true);

    const jobId = "test-prov-job-1";
    const metaPath = path.join(jobRoot, "meta", `${jobId}.json`);
    fs.writeFileSync(metaPath, JSON.stringify({ jobId }), "utf8");

    const { jobPaths } = require("../appserver/protocol");
    const expectedPaths = jobPaths(jobRoot, jobId);
    try {
        const result = await server._submitAnalyzeJob({
            jobId,
            projectPath: projectRoot,
            providerRouteId: "deepseek-official",
            providerRouteRevision: testCatalog[0].revision,
            text: "test analysis prompt",
            effort: "high",
            serviceTier: "default",
            metaPath: expectedPaths.metaPath,
            outputPath: expectedPaths.outputPath,
            codexOutputPath: expectedPaths.codexOutputPath
        });

        assert.equal(result.accepted, true);
        assert.equal(result.jobId, jobId);
        assert.equal(result.threadId, "test-provider-thread-1");
        assert.equal(result.turnId, "test-provider-turn-1");

        assert.ok(createdExecution, "exclusive execution should be created");
        assert.equal(createdExecution.startCalls, 1, "exclusive execution should be started");
        assert.equal(createdExecution.startThreadCalls, 1, "startThread should be called on exclusive execution");
        assert.equal(createdExecution.startTurnCalls, 1, "startTurn should be called on exclusive execution");
        assert.equal(createdExecution.lastThreadParams.modelProvider, "aicw-deepseek-official");
        assert.equal(createdExecution.lastThreadParams.model, "deepseek-flash");

        const metaAfterSubmit = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        assert.equal(metaAfterSubmit.providerRouteId, "deepseek-official");
        assert.equal(metaAfterSubmit.providerRouteRevision, testCatalog[0].revision);
        assert.equal(metaAfterSubmit.threadId, "test-provider-thread-1");

        // 模拟 turn 完成
        createdExecution.emit("notification", {
            method: "turn/completed",
            params: {
                threadId: "test-provider-thread-1",
                turnId: "test-provider-turn-1",
                turn: {
                    id: "test-provider-turn-1",
                    status: "completed"
                }
            }
        });

        const activeJob = server.activeJobs.get(jobId);
        if (activeJob) {
            await activeJob.terminalPromise;
        }

        assert.equal(createdExecution.stopCalls, 1, "exclusive execution should be stopped after completion");
        assert.deepEqual(createdExecution.lastStopOptions, { suppressClosed: true });

        const metaAfterComplete = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        assert.equal(metaAfterComplete.state, "completed");
        assert.equal(metaAfterComplete.exitCode, 0);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});



