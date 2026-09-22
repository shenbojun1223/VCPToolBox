"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const sourcePluginDir = path.resolve(__dirname, "..");
const sourceWorkerPath = path.join(sourcePluginDir, "AICodeWorker.js");
const sourceAppServerDir = path.join(sourcePluginDir, "appserver");

const ALIASES = [
    { alias: "deepseek-4.1-flash", routeId: "deepseek-official" },
    { alias: "deepseek-4.1-flash-commandcode", routeId: "deepseek-commandcode" }
];
const PROVIDER_ERROR_CODES = Object.freeze({
    RESERVED_FIELD: "AICW_PROVIDER_RESERVED_FIELD",
    ROUTE_NOT_CONFIGURED: "AICW_PROVIDER_ROUTE_NOT_CONFIGURED",
    MODE_UNSUPPORTED: "AICW_PROVIDER_MODE_UNSUPPORTED"
});
const CANARY = "synthetic-secret-canary";

function removeTempRoot(tempRoot) {
    fs.rmSync(tempRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50
    });
}

function cacheModels() {
    return [
        {
            slug: "gpt-5.6-luna",
            supported_reasoning_levels: [{ effort: "max", description: "synthetic luna" }],
            default_reasoning_level: "max"
        },
        {
            slug: "gpt-5.6-sol",
            supported_reasoning_levels: ["medium", "high"],
            default_reasoning_level: "medium"
        },
        {
            slug: "deepseek-4.1-flash-beta",
            supported_reasoning_levels: ["low", "high"],
            default_reasoning_level: "low"
        }
    ];
}

function createEnvironment(options = {}) {
    const tempRoot = fs.realpathSync.native(
        fs.mkdtempSync(path.join(os.tmpdir(), "vcp-aicw-provider-entry-"))
    );
    const pluginDir = path.join(tempRoot, "plugin");
    const projectRoot = path.join(tempRoot, "project");
    const codexHome = path.join(tempRoot, "codex-home");
    const jobRoot = path.join(tempRoot, "jobs");
    const workerPath = path.join(pluginDir, "AICodeWorker.js");
    const cachePath = path.join(codexHome, "models_cache.json");

    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.cpSync(sourceAppServerDir, path.join(pluginDir, "appserver"), { recursive: true });
    fs.copyFileSync(sourceWorkerPath, workerPath);
    assert.deepEqual(fs.readFileSync(workerPath), fs.readFileSync(sourceWorkerPath));
    fs.writeFileSync(path.join(projectRoot, "fixture.txt"), "synthetic fixture\n", "utf8");
    fs.writeFileSync(
        path.join(codexHome, "config.toml"),
        'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "medium"\n',
        "utf8"
    );
    fs.writeFileSync(
        cachePath,
        JSON.stringify({
            fetched_at: "synthetic-cache-time",
            client_version: "synthetic-codex-version",
            models: cacheModels()
        }),
        "utf8"
    );

    const config = [
        `ENABLE_OPENCODE=${options.enableOpencode === true ? "true" : "false"}`,
        "ENABLE_MIMOCODE=false",
        "OPENCODE_BIN=synthetic-opencode",
        "OPENCODE_BASE_URL=",
        "OPENCODE_API_KEY=",
        "OPENCODE_MODEL=",
        `ENABLE_CODEX=${options.enableCodex === false ? "false" : "true"}`,
        `ENABLE_CODEX_APP_SERVER_ANALYZE=${options.analyze === true ? "true" : "false"}`,
        "ENABLE_CODEX_APP_SERVER_PATCH=false",
        "ENABLE_CODEX_APP_SERVER_WRITE=false",
        "CODEX_BIN=synthetic-codex",
        `CODEX_HOME=${codexHome}`,
        `CODEX_MODELS_CACHE=${cachePath}`,
        `CODEX_MODEL=${options.codexModel || ""}`,
        `ALLOWED_PROJECT_ROOTS=${projectRoot}`,
        `JOB_ROOT=${jobRoot}`,
        "DEFAULT_TIMEOUT_SEC=5",
        "MAX_TASK_CHARS=20000",
        "MAX_CONCURRENT_JOBS=1",
        "DEFAULT_TRACE_MODE=summary",
        "REDACT_SECRETS=true",
        "ENABLE_ANTIGRAVITY=false",
        "AGY_BIN=synthetic-agy",
        "AGY_MODEL=",
        "AGY_PROXY="
    ].join("\n") + "\n";
    fs.writeFileSync(path.join(pluginDir, "config.env"), config, "utf8");

    return { tempRoot, pluginDir, projectRoot, codexHome, jobRoot, workerPath, cachePath };
}

function loadIsolatedWorker(environment) {
    const counters = {
        spawn: 0,
        spawnSync: 0,
        cacheReads: 0,
        sidecar: Object.create(null)
    };
    const originalSpawn = childProcess.spawn;
    const originalSpawnSync = childProcess.spawnSync;
    const originalReadFileSync = fs.readFileSync;
    const sidecarPath = path.join(environment.pluginDir, "appserver", "sidecarClient.js");
    const sidecarModule = require(sidecarPath);
    const prototype = sidecarModule.SidecarClient.prototype;
    const originalSidecarMethods = new Map();
    const sidecarMethods = [
        "ensure",
        "submitAnalyzeJob",
        "submitPatchJob",
        "submitWriteJob",
        "inspectNoStart",
        "reconcileDeadInstance",
        "cancel",
        "shutdown"
    ];

    childProcess.spawn = (...args) => {
        counters.spawn += 1;
        throw new Error("spawn trap");
    };
    childProcess.spawnSync = (...args) => {
        counters.spawnSync += 1;
        throw new Error("spawnSync trap");
    };
    fs.readFileSync = function trackedReadFile(filePath, ...args) {
        if (path.resolve(String(filePath)) === path.resolve(environment.cachePath)) {
            counters.cacheReads += 1;
        }
        return originalReadFileSync.call(this, filePath, ...args);
    };
    for (const method of sidecarMethods) {
        if (typeof prototype[method] !== "function") continue;
        originalSidecarMethods.set(method, prototype[method]);
        prototype[method] = async function sidecarTrap() {
            counters.sidecar[method] = (counters.sidecar[method] || 0) + 1;
            throw new Error(`${method} trap`);
        };
    }

    let worker;
    try {
        worker = require(environment.workerPath);
    } catch (error) {
        for (const [method, original] of originalSidecarMethods) prototype[method] = original;
        fs.readFileSync = originalReadFileSync;
        childProcess.spawn = originalSpawn;
        childProcess.spawnSync = originalSpawnSync;
        throw error;
    }

    return {
        worker,
        counters,
        restore() {
            for (const [method, original] of originalSidecarMethods) prototype[method] = original;
            fs.readFileSync = originalReadFileSync;
            childProcess.spawn = originalSpawn;
            childProcess.spawnSync = originalSpawnSync;
        }
    };
}

function request(environment, overrides = {}) {
    return {
        worker: "codex",
        projectPath: environment.projectRoot,
        task: "inspect providerRouteId and providerPlan as ordinary task text",
        mode: "analyze",
        ...overrides
    };
}

function assertProviderError(result, errorCode) {
    assert.equal(result.status, "error");
    assert.equal(result.errorCode, errorCode);
    assert.equal(result.error, "Provider routing request was rejected.");
    assert.equal(JSON.stringify(result).includes(CANARY), false);
}

function assertNoExecutionSideEffects(environment, isolated) {
    assert.equal(isolated.counters.spawn, 0);
    assert.equal(isolated.counters.spawnSync, 0);
    assert.equal(isolated.counters.cacheReads, 0);
    assert.deepEqual(isolated.counters.sidecar, Object.create(null));
    assert.equal(fs.existsSync(environment.jobRoot), false);
}

test("both provider aliases are rejected at normalize, run, and run_and_wait entry gates", async () => {
    // In production main repo, config.env may legitimately exist; the isolated test uses its own mock env

    for (const enableCodex of [false, true]) {
        for (const analyze of [false, true]) {
            const environment = createEnvironment({ enableCodex, analyze });
            let isolated;
            try {
                isolated = loadIsolatedWorker(environment);
                for (const { alias } of ALIASES) {
                    for (const mode of ["analyze", "write", "patch"]) {
                        for (const worker of ["codex", "opencode"]) {
                            for (const options of [
                                {},
                                { reasoningEffort: "max", fastMode: true },
                                { reasoningEffort: "high", fastMode: false }
                            ]) {
                                const input = request(environment, { model: alias, mode, worker, ...options });
                                const expected = enableCodex && analyze && worker === "codex" && mode === "analyze"
                                    ? PROVIDER_ERROR_CODES.ROUTE_NOT_CONFIGURED
                                    : PROVIDER_ERROR_CODES.MODE_UNSUPPORTED;
                                assertProviderError(isolated.worker.normalizeRunRequest(input), expected);
                                assertProviderError(await isolated.worker.cmdRun(input), expected);
                                const started = Date.now();
                                assertProviderError(await isolated.worker.cmdRunAndWait(input), expected);
                                assert.ok(Date.now() - started < 1000, "run_and_wait entered a wait loop");
                            }
                        }
                    }
                }
                assertNoExecutionSideEffects(environment, isolated);
            } finally {
                isolated?.restore();
                removeTempRoot(environment.tempRoot);
            }
        }
    }
});

test("provider capabilities are static for compact and full aliases, including CODEX_MODEL defaults", async () => {
    for (const { alias, routeId } of ALIASES) {
        const environment = createEnvironment({ analyze: true });
        let isolated;
        try {
            isolated = loadIsolatedWorker(environment);
            for (const responseMode of ["compact", "full"]) {
                const result = await isolated.worker.cmdCapabilities({
                    responseMode,
                    model: `  ${alias}  `
                });
                assert.equal(result.status, "success");
                assert.deepEqual(result.workers, [{
                    name: "codex",
                    available: false,
                    model: alias,
                    reasoningEfforts: []
                }]);
                assert.deepEqual(result.providerRouting, {
                    alias,
                    routeId,
                    configured: false,
                    executionAvailable: false,
                    blockedReason: PROVIDER_ERROR_CODES.ROUTE_NOT_CONFIGURED
                });
                assert.equal(Object.prototype.hasOwnProperty.call(result.workers[0], "version"), false);
                assert.equal(Object.prototype.hasOwnProperty.call(result, "codexAppServerStatus"), false);
            }

            const defaultEnvironment = createEnvironment({ analyze: true, codexModel: alias });
            let defaultIsolated;
            try {
                defaultIsolated = loadIsolatedWorker(defaultEnvironment);
                const result = await defaultIsolated.worker.cmdCapabilities({ responseMode: "full" });
                assert.equal(result.status, "success");
                assert.equal(result.workers[0].model, alias);
                assert.equal(result.providerRouting.routeId, routeId);
                assert.equal(defaultIsolated.counters.cacheReads, 0);
                assert.equal(defaultIsolated.counters.spawn, 0);
                assert.deepEqual(defaultIsolated.counters.sidecar, Object.create(null));
            } finally {
                defaultIsolated?.restore();
                removeTempRoot(defaultEnvironment.tempRoot);
            }

            assertNoExecutionSideEffects(environment, isolated);
        } finally {
            isolated?.restore();
            removeTempRoot(environment.tempRoot);
        }
    }
});

test("external provider fields are rejected by run and capabilities without scanning task text", async () => {
    const environment = createEnvironment({ analyze: true });
    let isolated;
    try {
        isolated = loadIsolatedWorker(environment);
        for (const value of [undefined, null]) {
            const input = request(environment, { model: ALIASES[0].alias, providerRouteId: value });
            assertProviderError(isolated.worker.normalizeRunRequest(input), PROVIDER_ERROR_CODES.RESERVED_FIELD);
            assertProviderError(await isolated.worker.cmdRun(input), PROVIDER_ERROR_CODES.RESERVED_FIELD);
            assertProviderError(
                await isolated.worker.cmdCapabilities({ model: ALIASES[0].alias, providerRouteId: value }),
                PROVIDER_ERROR_CODES.RESERVED_FIELD
            );
        }

        const nonEnumerable = request(environment, { model: ALIASES[1].alias });
        Object.defineProperty(nonEnumerable, "providerPlan", {
            value: CANARY,
            enumerable: false,
            configurable: false,
            writable: false
        });
        assertProviderError(isolated.worker.normalizeRunRequest(nonEnumerable), PROVIDER_ERROR_CODES.RESERVED_FIELD);
        assertProviderError(
            await isolated.worker.cmdCapabilities({
                model: ALIASES[1].alias,
                providerRouteRevision: CANARY
            }),
            PROVIDER_ERROR_CODES.RESERVED_FIELD
        );

        const presetReserved = request(environment, {
            model: ALIASES[0].alias,
            preset: "index",
            targetPath: path.join(environment.projectRoot, "fixture.txt"),
            providerRouteId: undefined
        });
        assertProviderError(
            isolated.worker.normalizeRunRequest(presetReserved),
            PROVIDER_ERROR_CODES.RESERVED_FIELD
        );

        const taskTextOnly = request(environment, {
            model: ALIASES[0].alias,
            task: "the words providerRouteId, providerPlan, dependencies, and routePlan are only task text"
        });
        assertProviderError(
            isolated.worker.normalizeRunRequest(taskTextOnly),
            PROVIDER_ERROR_CODES.ROUTE_NOT_CONFIGURED
        );
        assert.equal(JSON.stringify(taskTextOnly).includes(CANARY), false);
        assertNoExecutionSideEffects(environment, isolated);
    } finally {
        isolated?.restore();
        removeTempRoot(environment.tempRoot);
    }
});

test("ordinary Luna, Sol, approximate aliases, defaults, and compact projection keep existing behavior", async () => {
    const environment = createEnvironment({ analyze: false, enableCodex: false });
    let isolated;
    try {
        isolated = loadIsolatedWorker(environment);
        const ordinaryCases = [
            { model: "gpt-5.6-luna", effort: "MAX", fastMode: true, tier: "fast", expected: "max" },
            { model: "gpt-5.6-sol", effort: "medium", fastMode: false, tier: "default", expected: "medium" },
            { model: "gpt-5.6-sol", effort: undefined, fastMode: undefined, tier: null, expected: "medium" }
        ];
        for (const item of ordinaryCases) {
            const result = isolated.worker.normalizeRunRequest(request(environment, {
                model: item.model,
                reasoningEffort: item.effort,
                fastMode: item.fastMode
            }));
            assert.equal(result.status, "success");
            assert.equal(result.prepared.model, item.model);
            assert.equal(result.prepared.codexCapabilities.model, item.model);
            assert.equal(result.prepared.normalizedReasoningEffort, item.effort ? item.expected : null);
            assert.equal(result.prepared.normalizedFastMode, item.fastMode === undefined ? null : item.fastMode);
            assert.equal(result.prepared.serviceTierOverride, item.tier);
        }

        const approximate = isolated.worker.normalizeRunRequest(request(environment, {
            model: "deepseek-4.1-flash-beta",
            reasoningEffort: "low",
            fastMode: false
        }));
        assert.equal(approximate.status, "success");
        assert.equal(approximate.prepared.codexCapabilities.model, "deepseek-4.1-flash-beta");
        assert.equal(approximate.prepared.codexCapabilities.modelSource, "task_override");

        const defaultEnvironment = createEnvironment({
            analyze: false,
            codexModel: ALIASES[0].alias
        });
        let defaultIsolated;
        try {
            defaultIsolated = loadIsolatedWorker(defaultEnvironment);
            assertProviderError(
                defaultIsolated.worker.normalizeRunRequest(request(defaultEnvironment)),
                PROVIDER_ERROR_CODES.MODE_UNSUPPORTED
            );
            const explicitOrdinary = defaultIsolated.worker.normalizeRunRequest(request(defaultEnvironment, {
                model: "gpt-5.6-sol",
                reasoningEffort: "high",
                fastMode: false
            }));
            assert.equal(explicitOrdinary.status, "success");
            assert.equal(explicitOrdinary.prepared.codexCapabilities.model, "gpt-5.6-sol");
            assert.equal(defaultIsolated.counters.cacheReads > 0, true);
        } finally {
            defaultIsolated?.restore();
            removeTempRoot(defaultEnvironment.tempRoot);
        }

        const capabilities = await isolated.worker.cmdCapabilities({
            responseMode: "compact",
            model: "gpt-5.6-luna"
        });
        assert.equal(capabilities.status, "success");
        assert.deepEqual(capabilities.workers, [
            { name: "opencode", available: false },
            {
                name: "codex",
                available: false,
                version: "unknown",
                model: "gpt-5.6-luna",
                modelSource: "task_override",
                reasoningEfforts: ["max"],
                configuredReasoningEffort: "medium",
                reasoningEffortEffective: "medium",
                supportsPerTaskFastMode: true,
                fastModeOmittedBehavior: "inherit_codex_config",
                supportsAppServerPatch: false,
                supportsAppServerWrite: false
            },
            { name: "antigravity", available: false },
            { name: "mimocode", available: false }
        ]);
        assert.equal(capabilities.codexAppServerStatus, "disabled");
        assert.equal(capabilities.codexAppServerActiveJobs, 0);
        assert.equal(capabilities.codexAppServerPatchProtocolSupport, false);
        assert.equal(capabilities.codexAppServerWriteProtocolSupport, false);
        assert.equal(capabilities.patchContractVersion, 1);
        assert.deepEqual(capabilities.patchOperations, ["modify-existing-tracked-file"]);
        assert.equal(isolated.counters.spawn, 0);
        assert.equal(isolated.counters.spawnSync, 0);
        assert.equal(isolated.counters.sidecar.inspectNoStart || 0, 0);
    } finally {
        isolated?.restore();
        removeTempRoot(environment.tempRoot);
    }
});
