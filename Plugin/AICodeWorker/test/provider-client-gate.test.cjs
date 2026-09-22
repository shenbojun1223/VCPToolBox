"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { SidecarClient } = require("../appserver/sidecarClient");

const PROVIDER_ERROR_MESSAGE = "Provider routing request was rejected.";
const CONTROL_TOKEN_CANARY = "control-token-client-gate-canary";
const TEST_PROCESS_IDENTITY = Object.freeze({
    pid: process.pid,
    startTime: "provider-client-gate-test"
});

function makeState(instanceId, overrides = {}) {
    return {
        schemaVersion: 1,
        instanceId,
        controlToken: `control-${instanceId}`,
        endpoint: `endpoint-${instanceId}`,
        status: "ready",
        pid: process.pid,
        processIdentity: TEST_PROCESS_IDENTITY,
        ...overrides
    };
}

function frameLimitsFor(client) {
    return {
        protocolVersion: 1,
        codexMaxFrameBytes: client.maxCodexFrameBytes,
        ipcMaxFrameBytes: client.maxIpcBufferBytes
    };
}

function compatibleState(client, instanceId, overrides = {}) {
    return makeState(instanceId, {
        frameLimits: frameLimitsFor(client),
        serviceTierOverrideProtocolVersion: 1,
        ...overrides
    });
}

function createFixture(options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-aicw-provider-client-gate-"));
    const pluginDir = path.join(root, "plugin");
    const jobRoot = path.join(root, "jobs");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(jobRoot, { recursive: true });

    let state = Object.prototype.hasOwnProperty.call(options, "state")
        ? options.state
        : makeState("fixture-instance");
    const client = new SidecarClient({
        pluginDir,
        jobRoot,
        maxConcurrency: 2,
        processIdentity: TEST_PROCESS_IDENTITY,
        identityProvider: () => { throw new Error("test identity provider must not be called"); },
        stateReader: () => state
    });
    client._inspectStateProcess = () => ({ alive: true, confirmed: true, mismatch: false, unknown: false });

    return {
        root,
        pluginDir,
        jobRoot,
        client,
        get state() { return state; },
        setState(next) { state = next; },
        close() {
            fs.rmSync(root, { recursive: true, force: true });
        }
    };
}

async function withFixture(callback, options = {}) {
    const fixture = createFixture(options);
    try {
        return await callback(fixture);
    } finally {
        fixture.close();
    }
}

async function expectProviderError(operation, code) {
    let observed;
    await assert.rejects(
        Promise.resolve().then(operation),
        error => {
            observed = error;
            return error?.code === code && error?.message === PROVIDER_ERROR_MESSAGE;
        }
    );
    assert.equal(observed.details, undefined);
    assert.equal(JSON.stringify(observed).includes(CONTROL_TOKEN_CANARY), false);
    assert.equal(String(observed.message).includes("endpoint"), false);
    return observed;
}

function installMemorySocket(responseFor, requests) {
    const originalCreateConnection = net.createConnection;
    net.createConnection = () => {
        const socket = new EventEmitter();
        socket.destroyed = false;
        socket.setTimeout = () => socket;
        socket.write = line => {
            const request = JSON.parse(String(line));
            requests.push(request);
            const response = responseFor(request);
            setImmediate(() => {
                if (response.kind === "connection-error") {
                    const error = new Error("synthetic connection failure");
                    error.code = response.code || "ECONNRESET";
                    socket.emit("error", error);
                    return;
                }
                socket.emit("data", Buffer.from(JSON.stringify({
                    requestId: request.requestId,
                    ...response
                }) + "\n", "utf8"));
            });
            return true;
        };
        socket.destroy = () => { socket.destroyed = true; };
        setImmediate(() => socket.emit("connect"));
        return socket;
    };
    return () => { net.createConnection = originalCreateConnection; };
}

test("live provider status is projected only from a matching realtime response", async () => {
    await withFixture(async fixture => {
        const state = makeState("projection-instance", {
            providerRoutingProtocolVersion: 1,
            providerExecutionAvailable: true
        });
        fixture.setState(state);
        const cases = [
            [{ providerRoutingProtocolVersion: 1, providerExecutionAvailable: false }, 1, false],
            [{ providerRoutingProtocolVersion: 1, providerExecutionAvailable: true }, 1, true],
            [{}, null, null],
            [{ providerRoutingProtocolVersion: 99, providerExecutionAvailable: true }, 99, true],
            [{ providerRoutingProtocolVersion: "1", providerExecutionAvailable: "false" }, null, null]
        ];

        for (const [liveFields, expectedVersion, expectedExecution] of cases) {
            const liveStatus = {
                instanceId: state.instanceId,
                maxConcurrency: 2,
                ...liveFields
            };
            fixture.client._callWithState = async (_state, method) => {
                assert.equal(method, "status");
                return liveStatus;
            };
            const projected = await fixture.client._assertCompatibleConcurrency(state);
            assert.equal(projected.providerRoutingProtocolVersion, expectedVersion);
            assert.equal(projected.providerExecutionAvailable, expectedExecution);

            const publicStatus = await fixture.client.status();
            assert.equal(publicStatus.providerRoutingProtocolVersion, expectedVersion);
            assert.equal(publicStatus.providerExecutionAvailable, expectedExecution);

            const inspection = fixture.client._safeInspection(state, "ready", liveStatus);
            assert.equal(inspection.providerRoutingProtocolVersion, expectedVersion);
            assert.equal(inspection.providerExecutionAvailable, expectedExecution);
        }

        fixture.client._callWithState = async () => ({
            instanceId: "different-instance",
            maxConcurrency: 2,
            providerRoutingProtocolVersion: 1,
            providerExecutionAvailable: true
        });
        const mismatchedStatus = await fixture.client.status();
        assert.equal(mismatchedStatus.providerRoutingProtocolVersion, null);
        assert.equal(mismatchedStatus.providerExecutionAvailable, null);
        const mismatchedInspection = fixture.client._safeInspection(
            state,
            "ready",
            mismatchedStatus
        );
        assert.equal(mismatchedInspection.providerRoutingProtocolVersion, null);
        assert.equal(mismatchedInspection.providerExecutionAvailable, null);

        const diskOnlyInspection = fixture.client._safeInspection(state, "ready");
        assert.equal(diskOnlyInspection.providerRoutingProtocolVersion, null);
        assert.equal(diskOnlyInspection.providerExecutionAvailable, null);
    });
});

test("absent, startup-lock, and no-ping inspection expose unknown provider status", async () => {
    await withFixture(async fixture => {
        const absent = await fixture.client.inspectNoStart();
        assert.deepEqual({
            providerRoutingProtocolVersion: absent.providerRoutingProtocolVersion,
            providerExecutionAvailable: absent.providerExecutionAvailable
        }, { providerRoutingProtocolVersion: null, providerExecutionAvailable: null });

        fs.mkdirSync(fixture.client.paths.runtime, { recursive: true });
        fs.writeFileSync(fixture.client.paths.lockPath, JSON.stringify({
            ownerToken: "stale-lock",
            pid: 2147483647,
            processIdentity: { pid: 2147483647, startTime: "stale" },
            createdAt: Date.now()
        }), "utf8");
        const startupLock = await fixture.client.inspectNoStart();
        assert.equal(startupLock.status, "stale-lock");
        assert.equal(startupLock.providerRoutingProtocolVersion, null);
        assert.equal(startupLock.providerExecutionAvailable, null);
    }, { state: null });

    await withFixture(async fixture => {
        fixture.setState(makeState("disk-only-instance", {
            providerRoutingProtocolVersion: 1,
            providerExecutionAvailable: true
        }));
        const inspection = await fixture.client.inspectNoStart({ ping: false });
        assert.equal(inspection.providerRoutingProtocolVersion, null);
        assert.equal(inspection.providerExecutionAvailable, null);
    });
});

test("explicit analyze routes require the current Sidecar proof and submit once when valid", async () => {
    await withFixture(async fixture => {
        let ensuredState = compatibleState(fixture.client, "proof-instance");
        let ensureCalls = 0;
        let submitCalls = 0;
        fixture.client.ensure = async () => {
            ensureCalls += 1;
            return ensuredState;
        };
        fixture.client._callWithState = async (_state, method, params) => {
            assert.equal(method, "submitAnalyzeJob");
            submitCalls += 1;
            return { accepted: true, params };
        };
        const routeRequest = {
            jobId: "provider-proof-job",
            projectPath: fixture.pluginDir,
            text: "provider proof",
            providerRouteId: "deepseek-official",
            providerRouteRevision: "official-r1",
            effort: "medium"
        };
        const invalidProofs = [
            [{}, "AICW_PROVIDER_PROTOCOL_UNSUPPORTED"],
            [{ providerRoutingProtocolVersion: 2, providerExecutionAvailable: true }, "AICW_PROVIDER_PROTOCOL_UNSUPPORTED"],
            [{ providerRoutingProtocolVersion: 1, providerExecutionAvailable: "false" }, "AICW_PROVIDER_PROTOCOL_UNSUPPORTED"],
            [{ providerRoutingProtocolVersion: 1, providerExecutionAvailable: false }, "AICW_PROVIDER_RUNTIME_UNAVAILABLE"]
        ];
        for (const [proof, code] of invalidProofs) {
            ensuredState = compatibleState(fixture.client, "proof-instance", proof);
            await expectProviderError(() => fixture.client.submitAnalyzeJob(routeRequest), code);
            assert.equal(submitCalls, 0);
        }

        ensuredState = compatibleState(fixture.client, "proof-instance", {
            providerRoutingProtocolVersion: 1,
            providerExecutionAvailable: true
        });
        const response = await fixture.client.submitAnalyzeJob(routeRequest);
        assert.deepEqual(response, { accepted: true, params: routeRequest });
        assert.equal(ensureCalls, invalidProofs.length + 1);
        assert.equal(submitCalls, 1);
    });
});

test("ordinary requests retain the old path and provider-looking text is not classified", async () => {
    await withFixture(async fixture => {
        const ensuredState = compatibleState(fixture.client, "ordinary-instance");
        let ensureCalls = 0;
        const submitted = [];
        fixture.client.ensure = async () => {
            ensureCalls += 1;
            return ensuredState;
        };
        fixture.client._callWithState = async (_state, method, params) => {
            submitted.push({ method, params });
            return { accepted: true };
        };

        for (const model of ["Luna", "Sol", "deepseek-4.1-flash-extra"]) {
            const params = {
                jobId: `ordinary-${model.replace(/[^A-Za-z0-9]/g, "-")}`,
                projectPath: fixture.pluginDir,
                text: "ordinary text",
                model
            };
            await fixture.client.submitAnalyzeJob(params);
            assert.deepEqual(submitted.at(-1), { method: "submitAnalyzeJob", params });
            assert.equal(Object.prototype.hasOwnProperty.call(params, "providerRouteId"), false);
            assert.equal(Object.prototype.hasOwnProperty.call(params, "modelProvider"), false);
        }

        const textOnly = {
            jobId: "text-provider-names",
            projectPath: fixture.pluginDir,
            text: "providerRouteId modelProvider providerPlan deepseek-4.1-flash",
            task: "providerRuntime"
        };
        await fixture.client.submitAnalyzeJob(textOnly);
        assert.deepEqual(submitted.at(-1), { method: "submitAnalyzeJob", params: textOnly });

        const nonPlain = [];
        await fixture.client.submitAnalyzeJob(nonPlain);
        assert.deepEqual(submitted.at(-1), { method: "submitAnalyzeJob", params: nonPlain });
        assert.equal(ensureCalls, 5);
    });
});

test("provider fields and aliases are rejected before ensure for the correct operation", async () => {
    await withFixture(async fixture => {
        const ensuredState = compatibleState(fixture.client, "gate-instance");
        let ensureCalls = 0;
        let rpcCalls = 0;
        fixture.client.ensure = async () => {
            ensureCalls += 1;
            return ensuredState;
        };
        fixture.client._callWithState = async () => {
            rpcCalls += 1;
            return { accepted: true };
        };

        const earlyCases = [
            ["analyze alias", "submitAnalyzeJob", {
                jobId: "analyze-alias",
                model: " deepseek-4.1-flash "
            }, "AICW_PROVIDER_ROUTE_REQUIRED"],
            ["analyze route and model", "submitAnalyzeJob", {
                jobId: "analyze-conflict",
                providerRouteId: "deepseek-official",
                model: "Luna"
            }, "AICW_PROVIDER_ROUTE_MODEL_CONFLICT"],
            ["patch alias", "submitPatchJob", {
                jobId: "patch-alias",
                model: "deepseek-4.1-flash"
            }, "AICW_PROVIDER_MODE_UNSUPPORTED"],
            ["write alias", "submitWriteJob", {
                jobId: "write-alias",
                model: "deepseek-4.1-flash-commandcode"
            }, "AICW_PROVIDER_MODE_UNSUPPORTED"],
            ["patch route", "submitPatchJob", {
                jobId: "patch-route",
                providerRouteId: "deepseek-official"
            }, "AICW_PROVIDER_MODE_UNSUPPORTED"],
            ["write route", "submitWriteJob", {
                jobId: "write-route",
                providerRouteRevision: null
            }, "AICW_PROVIDER_MODE_UNSUPPORTED"]
        ];
        for (const [, method, params, code] of earlyCases) {
            await expectProviderError(() => fixture.client[method](params), code);
        }

        for (const field of ["modelProvider", "providerRuntime", "routeCatalog", "providerPlan", "dependencies"]) {
            await expectProviderError(
                () => fixture.client.submitAnalyzeJob({ jobId: `raw-${field}`, [field]: undefined }),
                "AICW_PROVIDER_RESERVED_FIELD"
            );
        }
        assert.equal(ensureCalls, 0);
        assert.equal(rpcCalls, 0);
    });
});

test("new provider guards do not skip the original frame, Fast, or write checks", async () => {
    await withFixture(async fixture => {
        let ensuredState = compatibleState(fixture.client, "compatibility-instance");
        let rpcCalls = 0;
        fixture.client.ensure = async () => ensuredState;
        fixture.client._callWithState = async () => {
            rpcCalls += 1;
            return { accepted: true };
        };

        ensuredState = compatibleState(fixture.client, "compatibility-instance", {
            providerRoutingProtocolVersion: 1,
            providerExecutionAvailable: true,
            frameLimits: { protocolVersion: 99, codexMaxFrameBytes: 1, ipcMaxFrameBytes: 1 }
        });
        await assert.rejects(
            fixture.client.submitAnalyzeJob({
                jobId: "provider-frame-check",
                providerRouteId: "deepseek-official"
            }),
            error => error?.code === "SIDECAR_FRAME_LIMIT_MISMATCH"
        );
        assert.equal(rpcCalls, 0);

        ensuredState = compatibleState(fixture.client, "compatibility-instance", {
            serviceTierOverrideProtocolVersion: null
        });
        await assert.rejects(
            fixture.client.submitAnalyzeJob({ jobId: "fast-check", model: "Luna", serviceTier: "fast" }),
            error => error?.code === "AICW_SERVICE_TIER_SIDECAR_UNSUPPORTED"
        );
        assert.equal(rpcCalls, 0);

        await assert.rejects(
            fixture.client.submitWriteJob({ jobId: "write-protocol-check", text: "write" }),
            error => error?.code === "AICW_APP_SERVER_WRITE_SIDECAR_UNSUPPORTED"
        );
        assert.equal(rpcCalls, 0);
    });
});

test("a proof from instance A is not reused for instance B", async () => {
    await withFixture(async fixture => {
        let ensuredState = compatibleState(fixture.client, "instance-a", {
            providerRoutingProtocolVersion: 1,
            providerExecutionAvailable: true
        });
        let ensureCalls = 0;
        let submitCalls = 0;
        fixture.client.ensure = async () => {
            ensureCalls += 1;
            return ensuredState;
        };
        fixture.client._callWithState = async () => {
            submitCalls += 1;
            return { accepted: true };
        };
        const params = {
            jobId: "instance-proof-job",
            providerRouteId: "deepseek-official",
            providerRouteRevision: "official-r1"
        };
        await fixture.client.submitAnalyzeJob(params);
        assert.equal(submitCalls, 1);

        ensuredState = compatibleState(fixture.client, "instance-b");
        await expectProviderError(
            () => fixture.client.submitAnalyzeJob(params),
            "AICW_PROVIDER_PROTOCOL_UNSUPPORTED"
        );
        assert.equal(ensureCalls, 2);
        assert.equal(submitCalls, 1);
    });
});

test("an existing instance mismatch keeps the original normal-request error", async () => {
    await withFixture(async fixture => {
        const state = makeState("normal-instance");
        let submitCalls = 0;
        fixture.client._callWithState = async (_state, method) => {
            if (method === "status") return { instanceId: "other-instance", maxConcurrency: 2 };
            submitCalls += 1;
            return { accepted: true };
        };
        fixture.client.ensure = () => fixture.client._assertCompatibleConcurrency(state);
        await assert.rejects(
            fixture.client.submitAnalyzeJob({ jobId: "normal-mismatch", model: "Luna" }),
            error => error?.code === "SIDECAR_INSTANCE_MISMATCH"
        );
        assert.equal(submitCalls, 0);
    });
});

test("real ensure and _callWithState preserve route transport fields without retry", async () => {
    await withFixture(async fixture => {
        fixture.setState(makeState("socket-instance", { controlToken: CONTROL_TOKEN_CANARY }));
        const requests = [];
        const restoreSocket = installMemorySocket(request => {
            if (request.method === "ping") return { ok: true, result: { pong: true } };
            if (request.method === "status") return {
                ok: true,
                result: {
                    instanceId: "socket-instance",
                    maxConcurrency: 2,
                    frameLimits: frameLimitsFor(fixture.client),
                    serviceTierOverrideProtocolVersion: 1,
                    providerRoutingProtocolVersion: 1,
                    providerExecutionAvailable: true
                }
            };
            return { ok: true, result: { accepted: true } };
        }, requests);
        try {
            const params = {
                jobId: "socket-route-job",
                projectPath: fixture.pluginDir,
                text: "socket route",
                providerRouteId: "deepseek-official",
                providerRouteRevision: "official-r1",
                effort: "high",
                serviceTier: "fast",
                timeoutSec: 42
            };
            const result = await fixture.client.submitAnalyzeJob(params);
            assert.deepEqual(result, { accepted: true });
            assert.equal(requests.length, 3);
            const submit = requests.at(-1);
            assert.equal(submit.requestId, "3");
            assert.equal(submit.token, CONTROL_TOKEN_CANARY);
            assert.equal(submit.method, "submitAnalyzeJob");
            assert.deepEqual(submit.params, params);
            for (const field of ["model", "modelProvider", "providerRuntime", "providerPlan", "routeCatalog", "env"]) {
                assert.equal(Object.prototype.hasOwnProperty.call(submit.params, field), false, field);
            }
        } finally {
            restoreSocket();
        }
    });
});

test("_callWithState keeps one send on a fixed Sidecar rejection", async () => {
    await withFixture(async fixture => {
        const requests = [];
        const restoreSocket = installMemorySocket(() => ({
            ok: false,
            error: {
                code: "AICW_PROVIDER_RUNTIME_UNAVAILABLE",
                message: PROVIDER_ERROR_MESSAGE
            }
        }), requests);
        try {
            await assert.rejects(
                fixture.client._callWithState(
                    makeState("transport-instance", { controlToken: CONTROL_TOKEN_CANARY }),
                    "submitAnalyzeJob",
                    { providerRouteId: "deepseek-official" }
                ),
                error => error?.code === "AICW_PROVIDER_RUNTIME_UNAVAILABLE" &&
                    error?.message === PROVIDER_ERROR_MESSAGE
            );
        } finally {
            restoreSocket();
        }
        assert.equal(requests.length, 1);
    });
});
