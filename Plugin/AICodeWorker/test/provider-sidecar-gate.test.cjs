"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { SidecarServer } = require("../appserver/sidecarServer");
const {
    PROVIDER_ROUTING_PROTOCOL_VERSION,
    PROVIDER_EXECUTION_AVAILABLE,
    PROVIDER_ERROR_CODES
} = require("../appserver/providerRoutes");

const PROVIDER_REJECTION_MESSAGE = "Provider routing request was rejected.";
const CONTROL_VALUE = "synthetic-control-value";
const SECRET_CANARY = "synthetic-secret-canary";
const URL_CANARY = "https://secret.example.invalid/provider?value=synthetic";
const ALIASES = [
    "deepseek-4.1-flash",
    "deepseek-4.1-flash-commandcode"
];
const KNOWN_ROUTES = [
    { routeId: "deepseek-official", revision: "official-r1" },
    { routeId: "deepseek-commandcode", revision: "commandcode-r1" }
];
const MODES = ["analyze", "patch", "write"];
const RAW_PROVIDER_FIELDS = [
    "modelProvider",
    "providerRoutes",
    "providerRuntime",
    "routeCatalog",
    "providerRouteCatalog",
    "providerRouteDependencies",
    "providerDependencies",
    "dependencies",
    "providerPlan",
    "providerRoutePlan",
    "providerRoute",
    "routePlan",
    "providerRoutingProtocolVersion",
    "providerExecutionAvailable"
];

function removeTempRoot(tempRoot) {
    fs.rmSync(tempRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50
    });
}

function createEnvironment() {
    const tempRoot = fs.realpathSync.native(
        fs.mkdtempSync(path.join(os.tmpdir(), "vcp-aicw-provider-sidecar-"))
    );
    const pluginDir = path.join(tempRoot, "plugin");
    const jobRoot = path.join(tempRoot, "jobs");
    const projectRoot = path.join(tempRoot, "project");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "fixture.txt"), "synthetic fixture\n", "utf8");

    const server = new SidecarServer({ pluginDir, jobRoot });
    const counts = {
        startThread: 0,
        startTurn: 0,
        isPatchVersionAllowed: 0,
        openWriteSession: 0
    };
    const originalOpenWriteSession = server._openWriteSession;
    server._openWriteSession = async function observedOpenWriteSession(...args) {
        counts.openWriteSession += 1;
        return originalOpenWriteSession.apply(this, args);
    };
    server.codex = {
        startThread: async () => {
            counts.startThread += 1;
            return { id: "synthetic-thread" };
        },
        startTurn: async () => {
            counts.startTurn += 1;
            return { id: "synthetic-turn" };
        },
        isPatchVersionAllowed: () => {
            counts.isPatchVersionAllowed += 1;
            return true;
        }
    };
    server.state = {
        schemaVersion: 1,
        instanceId: "synthetic-instance",
        controlToken: CONTROL_VALUE,
        pid: 12345,
        codexPid: null,
        status: "ready",
        providerRoutingProtocolVersion: 999,
        providerExecutionAvailable: true
    };

    const environment = {
        tempRoot,
        pluginDir,
        jobRoot,
        projectRoot,
        server,
        counts,
        metaPaths: new Set(),
        sequence: 0,
        nextId(prefix) {
            this.sequence += 1;
            return `${prefix}-${this.sequence}`;
        },
        cleanup() {
            server._openWriteSession = originalOpenWriteSession;
            removeTempRoot(tempRoot);
        }
    };
    return environment;
}

function jobPaths(environment, jobId) {
    return {
        metaPath: path.join(environment.jobRoot, "meta", `${jobId}.json`),
        outputPath: path.join(environment.jobRoot, "output", `${jobId}.txt`),
        codexOutputPath: path.join(environment.jobRoot, "output", `${jobId}.codex-last.txt`),
        patchPath: path.join(environment.jobRoot, "patches", `${jobId}.patch`)
    };
}

function makeParams(environment, mode, jobId, overrides = {}) {
    const paths = jobPaths(environment, jobId);
    const params = {
        jobId,
        projectPath: environment.projectRoot,
        text: "synthetic provider sidecar task",
        model: "gpt-5.6-luna",
        metaPath: paths.metaPath,
        outputPath: paths.outputPath,
        codexOutputPath: paths.codexOutputPath
    };
    if (mode === "patch") params.patchPath = paths.patchPath;
    return Object.assign(params, overrides);
}

function withoutModel(params) {
    delete params.model;
    return params;
}

function writeSyntheticMeta(environment, jobId) {
    const paths = jobPaths(environment, jobId);
    fs.mkdirSync(path.dirname(paths.metaPath), { recursive: true });
    fs.writeFileSync(paths.metaPath, JSON.stringify({
        jobId,
        synthetic: true
    }), "utf8");
    environment.metaPaths.add(path.resolve(paths.metaPath));
    return paths.metaPath;
}

function preparedParams(environment, mode, overrides = {}, withMeta = true) {
    const jobId = environment.nextId(mode);
    const params = makeParams(environment, mode, jobId, overrides);
    if (withMeta) writeSyntheticMeta(environment, jobId);
    return params;
}

function pathIsWithin(root, value) {
    if (typeof value !== "string") return false;
    try {
        const resolvedRoot = path.resolve(root);
        const resolvedValue = path.resolve(value);
        const relative = path.relative(resolvedRoot, resolvedValue);
        return relative === "" || (
            relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        );
    } catch {
        return false;
    }
}

function snapshotFiles(root) {
    const snapshot = [];
    if (!fs.existsSync(root)) return snapshot;
    const visit = directory => {
        const entries = fs.readdirSync(directory, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const fullPath = path.join(directory, entry.name);
            const relative = path.relative(root, fullPath);
            if (entry.isDirectory()) {
                snapshot.push(["directory", relative]);
                visit(fullPath);
                continue;
            }
            const stat = fs.statSync(fullPath);
            snapshot.push([
                "file",
                relative,
                stat.size,
                stat.mtimeMs,
                fs.readFileSync(fullPath).toString("base64")
            ]);
        }
    };
    visit(root);
    return snapshot;
}

function snapshotState(environment) {
    return {
        activeJobs: [...environment.server.activeJobs.keys()],
        seenJobs: [...environment.server.seenJobs].sort(),
        counts: { ...environment.counts }
    };
}

async function monitoredInvocation(environment, invoke) {
    const beforeFiles = snapshotFiles(environment.tempRoot);
    const beforeState = snapshotState(environment);
    const counters = {
        timers: 0,
        fileWrites: 0,
        metaReads: 0
    };
    const originalSetTimeout = global.setTimeout;
    const mutationMethods = [
        "writeFileSync",
        "appendFileSync",
        "mkdirSync",
        "renameSync",
        "unlinkSync",
        "rmSync",
        "truncateSync"
    ];
    const originals = new Map();
    let result;
    let error;

    try {
        global.setTimeout = function monitoredSetTimeout(...args) {
            counters.timers += 1;
            return Reflect.apply(originalSetTimeout, this, args);
        };
        const originalReadFileSync = fs.readFileSync;
        originals.set("readFileSync", originalReadFileSync);
        fs.readFileSync = function monitoredReadFileSync(...args) {
            if (typeof args[0] === "string" && environment.metaPaths.has(path.resolve(args[0]))) {
                counters.metaReads += 1;
            }
            return Reflect.apply(originalReadFileSync, this, args);
        };
        for (const method of mutationMethods) {
            const original = fs[method];
            originals.set(method, original);
            fs[method] = function monitoredMutation(...args) {
                const watched = pathIsWithin(environment.tempRoot, args[0]) ||
                    (method === "renameSync" && pathIsWithin(environment.tempRoot, args[1]));
                if (watched) counters.fileWrites += 1;
                return Reflect.apply(original, this, args);
            };
        }
        try {
            result = await invoke();
        } catch (caught) {
            error = caught;
        }
    } finally {
        global.setTimeout = originalSetTimeout;
        for (const [method, original] of originals) fs[method] = original;
    }

    assert.deepEqual(snapshotFiles(environment.tempRoot), beforeFiles);
    assert.deepEqual(snapshotState(environment), beforeState);
    assert.equal(counters.timers, 0, "provider rejection scheduled a timer");
    assert.equal(counters.fileWrites, 0, "provider rejection changed a temporary file");
    assert.equal(counters.metaReads, 0, "provider rejection read job meta");
    return { result, error };
}

async function expectSidecarError(environment, expectedCode, invoke, provider = true) {
    const observed = await monitoredInvocation(environment, invoke);
    assert.ok(observed.error, `expected ${expectedCode}, got a successful result`);
    assert.equal(observed.error.code, expectedCode);
    if (provider) {
        assert.equal(observed.error.message, PROVIDER_REJECTION_MESSAGE);
        assert.equal(observed.error.details, undefined);
    }
    return observed.error;
}

function createMemorySocket() {
    return {
        destroyed: false,
        output: "",
        end(value) {
            this.output += String(value);
            this.destroyed = true;
        },
        destroy() {
            this.destroyed = true;
        }
    };
}

async function ipcRequest(environment, request) {
    let socket;
    const observed = await monitoredInvocation(environment, async () => {
        socket = createMemorySocket();
        await environment.server._handleIpcLine(socket, JSON.stringify(request));
        return JSON.parse(socket.output.trim());
    });
    assert.equal(observed.error, undefined);
    return observed.result;
}

async function expectIpcProviderError(environment, requestId, params, expectedCode) {
    const response = await ipcRequest(environment, {
        requestId,
        token: CONTROL_VALUE,
        method: "submitAnalyzeJob",
        params
    });
    assert.equal(response.requestId, requestId);
    assert.equal(response.ok, false);
    assert.deepEqual(response.error, {
        code: expectedCode,
        message: PROVIDER_REJECTION_MESSAGE
    });
    const serialized = JSON.stringify(response);
    assert.equal(serialized.includes(SECRET_CANARY), false);
    assert.equal(serialized.includes(URL_CANARY), false);
    return response;
}

test("direct Sidecar submit methods reject provider routing before execution", async () => {
    const environment = createEnvironment();
    try {
        for (const alias of ALIASES) {
            for (const model of [alias, `  ${alias}  `]) {
                for (const mode of MODES) {
                    const params = preparedParams(environment, mode, { model });
                    await expectSidecarError(
                        environment,
                        mode === "analyze"
                            ? PROVIDER_ERROR_CODES.ROUTE_REQUIRED
                            : PROVIDER_ERROR_CODES.MODE_UNSUPPORTED,
                        () => environment.server[`_submit${mode[0].toUpperCase()}${mode.slice(1)}Job`](params)
                    );
                }
            }
        }

        for (const route of KNOWN_ROUTES) {
            const params = withoutModel(preparedParams(environment, "analyze"));
            params.providerRouteId = route.routeId;
            params.providerRouteRevision = route.revision;
            await expectSidecarError(
                environment,
                PROVIDER_ERROR_CODES.ROUTE_NOT_CONFIGURED,
                () => environment.server._submitAnalyzeJob(params)
            );
        }

        const unknownRoute = withoutModel(preparedParams(environment, "analyze"));
        unknownRoute.providerRouteId = "synthetic-unknown-route";
        unknownRoute.providerRouteRevision = "synthetic-r1";
        await expectSidecarError(
            environment,
            PROVIDER_ERROR_CODES.ROUTE_UNKNOWN,
            () => environment.server._submitAnalyzeJob(unknownRoute)
        );

        const missingRevision = withoutModel(preparedParams(environment, "analyze"));
        missingRevision.providerRouteId = KNOWN_ROUTES[0].routeId;
        await expectSidecarError(
            environment,
            PROVIDER_ERROR_CODES.PROTOCOL_UNSUPPORTED,
            () => environment.server._submitAnalyzeJob(missingRevision)
        );

        const invalidRevision = withoutModel(preparedParams(environment, "analyze"));
        invalidRevision.providerRouteId = KNOWN_ROUTES[0].routeId;
        invalidRevision.providerRouteRevision = null;
        await expectSidecarError(
            environment,
            PROVIDER_ERROR_CODES.PROTOCOL_UNSUPPORTED,
            () => environment.server._submitAnalyzeJob(invalidRevision)
        );

        const routeModelConflict = preparedParams(environment, "analyze", {
            providerRouteId: KNOWN_ROUTES[0].routeId,
            providerRouteRevision: KNOWN_ROUTES[0].revision,
            model: "gpt-5.6-luna"
        });
        await expectSidecarError(
            environment,
            PROVIDER_ERROR_CODES.ROUTE_MODEL_CONFLICT,
            () => environment.server._submitAnalyzeJob(routeModelConflict)
        );

        const unknownTopLevel = withoutModel(preparedParams(environment, "analyze"));
        unknownTopLevel.providerRouteId = KNOWN_ROUTES[0].routeId;
        unknownTopLevel.providerRouteRevision = KNOWN_ROUTES[0].revision;
        unknownTopLevel.syntheticUnknownField = "rejected";
        await expectSidecarError(
            environment,
            PROVIDER_ERROR_CODES.REQUEST_INVALID,
            () => environment.server._submitAnalyzeJob(unknownTopLevel)
        );

        for (const mode of MODES) {
            for (const field of ["modelProvider", "providerRuntime", "providerPlan"]) {
                for (const value of [undefined, null]) {
                    const params = preparedParams(environment, mode, { [field]: value });
                    await expectSidecarError(
                        environment,
                        PROVIDER_ERROR_CODES.RESERVED_FIELD,
                        () => environment.server[`_submit${mode[0].toUpperCase()}${mode.slice(1)}Job`](params)
                    );
                }
            }
        }

        for (const field of RAW_PROVIDER_FIELDS) {
            const params = preparedParams(environment, "analyze", { [field]: SECRET_CANARY });
            await expectSidecarError(
                environment,
                PROVIDER_ERROR_CODES.RESERVED_FIELD,
                () => environment.server._submitAnalyzeJob(params)
            );
        }

        const textOnly = preparedParams(environment, "analyze", {
            text: `ordinary text mentions providerRouteId providerPlan dependencies ${SECRET_CANARY} ${URL_CANARY}`
        }, false);
        await expectSidecarError(
            environment,
            "META_NOT_FOUND",
            () => environment.server._submitAnalyzeJob(textOnly),
            false
        );

        const nonPlain = Object.assign(
            Object.create(null),
            preparedParams(environment, "analyze", { model: ALIASES[0] }, false)
        );
        await expectSidecarError(
            environment,
            "META_NOT_FOUND",
            () => environment.server._submitAnalyzeJob(nonPlain),
            false
        );
    } finally {
        environment.cleanup();
    }
});

test("ordinary models and approximate aliases retain the original Sidecar checks", async () => {
    const environment = createEnvironment();
    try {
        const originalStatus = environment.server.state.status;
        environment.server.state.status = "closed";
        try {
            for (const model of ["gpt-5.6-luna", "gpt-5.6-sol", "deepseek-4.1-flash-beta", "DeepSeek-4.1-flash"]) {
                const params = preparedParams(environment, "analyze", { model }, false);
                await expectSidecarError(
                    environment,
                    "SIDECAR_NOT_READY",
                    () => environment.server._submitAnalyzeJob(params),
                    false
                );
            }
        } finally {
            environment.server.state.status = originalStatus;
        }

        for (const model of ["gpt-5.6-luna", "gpt-5.6-sol", "deepseek-4.1-flash-beta"]) {
            const params = preparedParams(environment, "analyze", { model }, false);
            await expectSidecarError(
                environment,
                "META_NOT_FOUND",
                () => environment.server._submitAnalyzeJob(params),
                false
            );
        }

        const writeParams = preparedParams(environment, "write", { model: "gpt-5.6-luna" }, false);
        await expectSidecarError(
            environment,
            "AICW_WRITE_NOT_CONFIGURED",
            () => environment.server._submitWriteJob(writeParams),
            false
        );
    } finally {
        environment.cleanup();
    }
});

test("real dispatch reaches the same provider guard for all three modes", async () => {
    const environment = createEnvironment();
    try {
        const methods = {
            analyze: "submitAnalyzeJob",
            patch: "submitPatchJob",
            write: "submitWriteJob"
        };
        for (const mode of MODES) {
            const params = preparedParams(environment, mode, { model: `  ${ALIASES[0]}  ` });
            await expectSidecarError(
                environment,
                mode === "analyze"
                    ? PROVIDER_ERROR_CODES.ROUTE_REQUIRED
                    : PROVIDER_ERROR_CODES.MODE_UNSUPPORTED,
                () => environment.server._dispatch(methods[mode], params)
            );
        }

        const routeParams = withoutModel(preparedParams(environment, "analyze"));
        routeParams.providerRouteId = KNOWN_ROUTES[0].routeId;
        routeParams.providerRouteRevision = KNOWN_ROUTES[0].revision;
        await expectSidecarError(
            environment,
            PROVIDER_ERROR_CODES.ROUTE_NOT_CONFIGURED,
            () => environment.server._dispatch(methods.analyze, routeParams)
        );
    } finally {
        environment.cleanup();
    }
});

test("status and real JSON IPC expose fixed provider protocol state and safe errors", async () => {
    const environment = createEnvironment();
    try {
        const status = environment.server.status();
        assert.equal(status.providerRoutingProtocolVersion, PROVIDER_ROUTING_PROTOCOL_VERSION);
        assert.equal(status.providerExecutionAvailable, PROVIDER_EXECUTION_AVAILABLE);
        assert.equal(status.serviceTierOverrideProtocolVersion, 1);
        assert.deepEqual(status.activeJobs, []);
        assert.equal(status.maxConcurrency, 3);
        assert.deepEqual(status.frameLimits, {
            protocolVersion: 1,
            codexMaxFrameBytes: 16 * 1024 * 1024,
            ipcMaxFrameBytes: 16 * 1024 * 1024
        });
        assert.equal(status.patchProtocolSupported, true);
        assert.equal(status.patchContractVersion, 1);
        assert.equal(status.patchMaxBytes, 524288);
        assert.equal(status.patchRepositoryPolicy, "clean-git-root");
        assert.deepEqual(status.patchOperations, ["modify-existing-tracked-file"]);
        assert.equal(status.writeProtocolSupported, true);
        assert.equal(status.writeProtocolVersion, 2);
        assert.equal(status.writeConfigured, false);
        assert.equal(status.writeConfigurationErrorCode, null);
        assert.equal(status.writeMaxConcurrency, 2);
        assert.equal(status.writeWorkspacePolicy, "server-generated-locked-git-worktree");
        assert.equal(status.writeValidationPolicy, "builtin-diff-json-js-syntax");
        assert.equal(status.writeValidationProfile, null);

        const aliasParams = preparedParams(environment, "analyze", {
            model: `  ${ALIASES[1]}  `,
            text: `do not echo ${SECRET_CANARY} or ${URL_CANARY}`
        });
        await expectIpcProviderError(
            environment,
            "ipc-alias",
            aliasParams,
            PROVIDER_ERROR_CODES.ROUTE_REQUIRED
        );

        const routeParams = withoutModel(preparedParams(environment, "analyze"));
        routeParams.providerRouteId = KNOWN_ROUTES[1].routeId;
        routeParams.providerRouteRevision = KNOWN_ROUTES[1].revision;
        await expectIpcProviderError(
            environment,
            "ipc-route",
            routeParams,
            PROVIDER_ERROR_CODES.ROUTE_NOT_CONFIGURED
        );

        const invalidTokenParams = preparedParams(environment, "analyze", {
            model: ALIASES[0],
            text: `${SECRET_CANARY} ${URL_CANARY}`
        });
        const invalidTokenResponse = await ipcRequest(environment, {
            requestId: "ipc-invalid-token",
            token: "wrong-control-value",
            method: "submitAnalyzeJob",
            params: invalidTokenParams
        });
        assert.equal(invalidTokenResponse.ok, false);
        assert.equal(invalidTokenResponse.error.code, "INVALID_CONTROL_TOKEN");
        assert.equal(invalidTokenResponse.error.message, "Invalid Sidecar control token");
        assert.equal(JSON.stringify(invalidTokenResponse).includes(SECRET_CANARY), false);
        assert.equal(JSON.stringify(invalidTokenResponse).includes(URL_CANARY), false);

        const ping = await ipcRequest(environment, {
            requestId: "ipc-ping",
            token: CONTROL_VALUE,
            method: "ping",
            params: {}
        });
        assert.equal(ping.ok, true);
        assert.deepEqual(ping.result, {
            pong: true,
            instanceId: "synthetic-instance"
        });

        const statusResponse = await ipcRequest(environment, {
            requestId: "ipc-status",
            token: CONTROL_VALUE,
            method: "status",
            params: {}
        });
        assert.equal(statusResponse.ok, true);
        assert.equal(statusResponse.result.providerRoutingProtocolVersion, 1);
        assert.equal(statusResponse.result.providerExecutionAvailable, false);
    } finally {
        environment.cleanup();
    }
});
