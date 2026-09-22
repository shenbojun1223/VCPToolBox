"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const {
    ALIAS_MAP,
    DEFAULT_PROVIDER_ROUTE_CATALOG,
    PROVIDER_ERROR_CODES,
    PROVIDER_EXECUTION_AVAILABLE,
    PROVIDER_ROUTING_PROTOCOL_VERSION,
    ProviderRouteError,
    assertNoExternalReservedFields,
    assertNoIpcRawProviderFields,
    assertProviderRoutingProof,
    createProviderRouteCatalog,
    findRouteById,
    getProviderAliasInfo,
    isPlainObject,
    isProviderRouteRequest,
    providerErrorCodeFrom,
    providerErrorResult,
    providerPlanToIpc,
    providerPlanToThreadParams,
    providerRoutingStatus,
    resolveProviderRoutePlan,
    resolveProviderRouteRequest,
    trustedCatalogFrom
} = require("../appserver/providerRoutes");
const { CodexAppServerProcess } = require("../appserver/codexAppServerProcess");

const PROJECT_PATH = path.resolve(__dirname);
const CANARY = "synthetic-canary-must-not-leak";

const DESCRIPTORS = [
    {
        routeId: "deepseek-official",
        revision: "official-r1",
        upstreamModel: "aicw-synthetic-chat",
        reasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "low",
        serviceTiers: ["default", "fast"],
        defaultServiceTier: "default"
    },
    {
        routeId: "deepseek-commandcode",
        revision: "commandcode-r2",
        upstreamModel: "aicw-synthetic-reasoner",
        reasoningEfforts: ["medium", "high"],
        defaultReasoningEffort: "medium",
        serviceTiers: ["default", "fast"],
        defaultServiceTier: "fast"
    }
];

const CATALOG = createProviderRouteCatalog(DESCRIPTORS);
const DEPENDENCIES = Object.freeze({ providerRouteCatalog: CATALOG });

function expectProviderError(callback, code, forbidden = null) {
    assert.throws(callback, error => {
        assert.equal(error instanceof ProviderRouteError, true);
        assert.equal(error.code, code);
        if (forbidden) {
            assert.equal(error.message.includes(forbidden), false);
            assert.equal(error.stack.includes(forbidden), false);
        }
        return true;
    });
}

function cloneDescriptor(routeId = "deepseek-official") {
    const source = DESCRIPTORS.find(descriptor => descriptor.routeId === routeId);
    return {
        routeId: source.routeId,
        revision: source.revision,
        upstreamModel: source.upstreamModel,
        reasoningEfforts: [...source.reasoningEfforts],
        defaultReasoningEffort: source.defaultReasoningEffort,
        serviceTiers: [...source.serviceTiers],
        defaultServiceTier: source.defaultServiceTier
    };
}

function defineAccessor(target, key, getter) {
    Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        get: getter
    });
}

test("two aliases map exactly and production default catalog stays empty", () => {
    assert.deepEqual(getProviderAliasInfo("deepseek-4.1-flash"), {
        alias: "deepseek-4.1-flash",
        routeId: "deepseek-official",
        modelProvider: "aicw-deepseek-official"
    });
    assert.deepEqual(getProviderAliasInfo("deepseek-4.1-flash-commandcode"), {
        alias: "deepseek-4.1-flash-commandcode",
        routeId: "deepseek-commandcode",
        modelProvider: "aicw-deepseek-commandcode"
    });
    assert.equal(getProviderAliasInfo("deepseek-4.1"), null);
    assert.deepEqual(DEFAULT_PROVIDER_ROUTE_CATALOG, []);
    assert.equal(Object.isFrozen(DEFAULT_PROVIDER_ROUTE_CATALOG), true);
    expectProviderError(
        () => resolveProviderRoutePlan("deepseek-4.1-flash"),
        PROVIDER_ERROR_CODES.ROUTE_NOT_CONFIGURED
    );
    expectProviderError(
        () => findRouteById("not-a-route", DEPENDENCIES),
        PROVIDER_ERROR_CODES.ROUTE_UNKNOWN
    );

    const roundTrips = [
        {
            alias: "deepseek-4.1-flash",
            routeId: "deepseek-official",
            revision: "official-r1",
            model: "aicw-synthetic-chat",
            modelProvider: "aicw-deepseek-official",
            defaults: { effort: "low", serviceTier: "default" },
            explicit: { effort: "high", serviceTier: "fast" }
        },
        {
            alias: "deepseek-4.1-flash-commandcode",
            routeId: "deepseek-commandcode",
            revision: "commandcode-r2",
            model: "aicw-synthetic-reasoner",
            modelProvider: "aicw-deepseek-commandcode",
            defaults: { effort: "medium", serviceTier: "fast" },
            explicit: { effort: "high", serviceTier: "default" }
        }
    ];
    for (const route of roundTrips) {
        const expectedDefaultPlan = {
            alias: route.alias,
            routeId: route.routeId,
            revision: route.revision,
            upstreamModel: route.model,
            model: route.model,
            modelProvider: route.modelProvider,
            reasoningEffort: route.defaults.effort,
            serviceTier: route.defaults.serviceTier
        };
        const expectedExplicitPlan = {
            alias: route.alias,
            routeId: route.routeId,
            revision: route.revision,
            upstreamModel: route.model,
            model: route.model,
            modelProvider: route.modelProvider,
            reasoningEffort: route.explicit.effort,
            serviceTier: route.explicit.serviceTier
        };
        for (const [options, expectedPlan] of [
            [{}, expectedDefaultPlan],
            [{ reasoningEffort: route.explicit.effort, serviceTier: route.explicit.serviceTier }, expectedExplicitPlan]
        ]) {
            const plan = resolveProviderRoutePlan(route.alias, options, DEPENDENCIES);
            assert.deepEqual(plan, expectedPlan);
            const expectedIpc = {
                providerRouteId: route.routeId,
                providerRouteRevision: route.revision,
                effort: expectedPlan.reasoningEffort,
                serviceTier: expectedPlan.serviceTier
            };
            assert.deepEqual(providerPlanToIpc(plan), expectedIpc);
            assert.deepEqual(Object.keys(expectedIpc), [
                "providerRouteId", "providerRouteRevision", "effort", "serviceTier"
            ]);
            const resolved = resolveProviderRouteRequest({ ...expectedIpc }, DEPENDENCIES);
            assert.deepEqual(resolved, expectedPlan);
            assert.deepEqual(providerPlanToIpc(resolved), expectedIpc);
            assert.deepEqual(providerPlanToThreadParams(resolved), {
                model: route.model,
                modelProvider: route.modelProvider,
                allowProviderModelFallback: false,
                effort: expectedPlan.reasoningEffort,
                serviceTier: expectedPlan.serviceTier
            });
        }
    }
});

test("catalog descriptors require exact safe fields and unique controlled routes", () => {
    const unknownField = { ...cloneDescriptor(), unexpected: "reject" };
    expectProviderError(
        () => createProviderRouteCatalog([unknownField]),
        PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID
    );
    const symbolField = cloneDescriptor();
    symbolField[Symbol("unexpected")] = true;
    expectProviderError(
        () => createProviderRouteCatalog([symbolField]),
        PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID
    );
    expectProviderError(
        () => createProviderRouteCatalog([cloneDescriptor(), cloneDescriptor()]),
        PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID
    );
    for (const invalid of [
        { ...cloneDescriptor(), revision: "" },
        { ...cloneDescriptor(), revision: "bad\nrevision" },
        { ...cloneDescriptor(), upstreamModel: "" },
        { ...cloneDescriptor(), reasoningEfforts: [] },
        { ...cloneDescriptor(), reasoningEfforts: ["low", "low"] },
        { ...cloneDescriptor(), defaultReasoningEffort: "medium" },
        { ...cloneDescriptor(), serviceTiers: ["default", "other"] },
        { ...cloneDescriptor(), serviceTiers: ["default", "default"] },
        { ...cloneDescriptor(), defaultServiceTier: "other" }
    ]) {
        expectProviderError(
            () => createProviderRouteCatalog([invalid]),
            PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID
        );
    }
    expectProviderError(
        () => createProviderRouteCatalog([cloneDescriptor(), {
            ...cloneDescriptor("deepseek-commandcode"),
            routeId: "uncontrolled-route"
        }]),
        PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID
    );
    expectProviderError(
        () => createProviderRouteCatalog([cloneDescriptor(), cloneDescriptor("deepseek-commandcode"), cloneDescriptor()]),
        PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID
    );
    expectProviderError(
        () => trustedCatalogFrom({ providerRouteCatalog: { secret: "not-an-array" } }),
        PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID
    );
    let dependencyGetterCount = 0;
    const dependencyWithAccessor = { providerRouteCatalog: CATALOG };
    defineAccessor(dependencyWithAccessor, "routeCatalog", () => {
        dependencyGetterCount += 1;
        return CANARY;
    });
    expectProviderError(
        () => trustedCatalogFrom(dependencyWithAccessor),
        PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID,
        CANARY
    );
    assert.equal(dependencyGetterCount, 0);

    const sparseCatalog = new Array(1);
    expectProviderError(
        () => createProviderRouteCatalog(sparseCatalog),
        PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID
    );
    let catalogGetterCount = 0;
    const accessorCatalog = new Array(1);
    defineAccessor(accessorCatalog, "0", () => { catalogGetterCount += 1; return cloneDescriptor(); });
    expectProviderError(
        () => createProviderRouteCatalog(accessorCatalog),
        PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID
    );
    assert.equal(catalogGetterCount, 0);
    const extraCatalog = [cloneDescriptor()];
    extraCatalog.extra = "reject";
    expectProviderError(
        () => createProviderRouteCatalog(extraCatalog),
        PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID
    );
    const symbolCatalog = [cloneDescriptor()];
    symbolCatalog[Symbol("catalog-extra")] = true;
    expectProviderError(
        () => createProviderRouteCatalog(symbolCatalog),
        PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID
    );

    for (const field of ["reasoningEfforts", "serviceTiers"]) {
        const sparse = cloneDescriptor();
        sparse[field] = field === "reasoningEfforts" ? new Array(2) : new Array(1);
        if (field === "reasoningEfforts") sparse[field][0] = "low";
        expectProviderError(
            () => createProviderRouteCatalog([sparse]),
            PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID
        );

        const accessor = cloneDescriptor();
        let elementGetterCount = 0;
        accessor[field] = field === "reasoningEfforts" ? ["low", "high"] : ["default"];
        defineAccessor(accessor[field], field === "reasoningEfforts" ? "1" : "0", () => {
            elementGetterCount += 1;
            return field === "reasoningEfforts" ? "high" : "default";
        });
        expectProviderError(
            () => createProviderRouteCatalog([accessor]),
            PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID
        );
        assert.equal(elementGetterCount, 0);

        const extra = cloneDescriptor();
        extra[field] = field === "reasoningEfforts" ? ["low", "high"] : ["default"];
        extra[field].extra = "reject";
        expectProviderError(
            () => createProviderRouteCatalog([extra]),
            PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID
        );
        const symbol = cloneDescriptor();
        symbol[field] = field === "reasoningEfforts" ? ["low", "high"] : ["default"];
        symbol[field][Symbol("array-extra")] = true;
        expectProviderError(
            () => createProviderRouteCatalog([symbol]),
            PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID
        );
    }

    let descriptorGetterCount = 0;
    const accessorDescriptor = cloneDescriptor();
    defineAccessor(accessorDescriptor, "upstreamModel", () => {
        descriptorGetterCount += 1;
        return CANARY;
    });
    expectProviderError(
        () => createProviderRouteCatalog([accessorDescriptor]),
        PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID,
        CANARY
    );
    assert.equal(descriptorGetterCount, 0);

    const revokedDescriptor = Proxy.revocable(cloneDescriptor(), {});
    revokedDescriptor.revoke();
    expectProviderError(
        () => createProviderRouteCatalog([revokedDescriptor.proxy]),
        PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID,
        CANARY
    );
    const throwingArray = new Proxy([cloneDescriptor()], {
        ownKeys() { throw new Error(CANARY); }
    });
    expectProviderError(
        () => createProviderRouteCatalog(throwingArray),
        PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID,
        CANARY
    );

    const frozenDescriptor = Object.freeze({
        ...cloneDescriptor(),
        reasoningEfforts: Object.freeze(["low", "high"]),
        serviceTiers: Object.freeze(["default", "fast"])
    });
    const frozenCatalog = createProviderRouteCatalog(Object.freeze([frozenDescriptor]));
    assert.equal(Object.isFrozen(frozenCatalog), true);
    assert.equal(Object.isFrozen(frozenCatalog[0].reasoningEfforts), true);
    assert.deepEqual(frozenCatalog[0].upstreamModel, "aicw-synthetic-chat");
});

test("plans use route-owned defaults, explicit Fast semantics, and remain immutable", () => {
    const official = resolveProviderRoutePlan("deepseek-4.1-flash", {}, DEPENDENCIES);
    const commandcode = resolveProviderRoutePlan("deepseek-4.1-flash-commandcode", {}, DEPENDENCIES);
    assert.equal(official.reasoningEffort, "low");
    assert.equal(official.serviceTier, "default");
    assert.equal(commandcode.reasoningEffort, "medium");
    assert.equal(commandcode.serviceTier, "fast");

    const standard = resolveProviderRoutePlan("deepseek-4.1-flash", { fastMode: false }, DEPENDENCIES);
    const fast = resolveProviderRoutePlan("deepseek-4.1-flash", { fastMode: true }, DEPENDENCIES);
    assert.equal(standard.serviceTier, "default");
    assert.equal(fast.serviceTier, "fast");
    expectProviderError(
        () => resolveProviderRoutePlan("deepseek-4.1-flash", { fastMode: "true" }, DEPENDENCIES),
        PROVIDER_ERROR_CODES.REQUEST_INVALID
    );
    const defaultOnly = createProviderRouteCatalog([{
        ...cloneDescriptor(),
        serviceTiers: ["default"],
        defaultServiceTier: "default"
    }]);
    expectProviderError(
        () => resolveProviderRoutePlan("deepseek-4.1-flash", { fastMode: true }, { providerRouteCatalog: defaultOnly }),
        PROVIDER_ERROR_CODES.SERVICE_TIER_UNSUPPORTED
    );

    const sourceEfforts = ["low", "high"];
    const sourceTiers = ["default", "fast"];
    const sourceDescriptor = {
        ...cloneDescriptor(),
        upstreamModel: "aicw-synthetic-original",
        reasoningEfforts: sourceEfforts,
        serviceTiers: sourceTiers
    };
    const isolatedCatalog = createProviderRouteCatalog([sourceDescriptor]);
    sourceEfforts[0] = CANARY;
    sourceTiers[0] = CANARY;
    sourceDescriptor.upstreamModel = CANARY;
    assert.deepEqual(isolatedCatalog[0], {
        routeId: "deepseek-official",
        revision: "official-r1",
        upstreamModel: "aicw-synthetic-original",
        reasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "low",
        serviceTiers: ["default", "fast"],
        defaultServiceTier: "default"
    });
    assert.equal(Object.isFrozen(official), true);
    assert.equal(Object.isFrozen(CATALOG[0].reasoningEfforts), true);
    assert.equal(Object.isFrozen(CATALOG[0].serviceTiers), true);
    assert.throws(() => { official.reasoningEffort = "high"; }, TypeError);
    assert.throws(() => { CATALOG[0].reasoningEfforts.push("secret"); }, TypeError);
    assert.equal(official.reasoningEffort, "low");
    assert.equal(CATALOG[0].reasoningEfforts.includes("secret"), false);
});

test("IPC and thread plans expose only verified identity and reject mismatches", () => {
    const ipcRequest = {
        providerRouteId: "deepseek-official",
        providerRouteRevision: "official-r1",
        effort: "high",
        serviceTier: "fast"
    };
    assert.deepEqual(resolveProviderRouteRequest(ipcRequest, DEPENDENCIES), {
        alias: "deepseek-4.1-flash",
        routeId: "deepseek-official",
        revision: "official-r1",
        upstreamModel: "aicw-synthetic-chat",
        model: "aicw-synthetic-chat",
        modelProvider: "aicw-deepseek-official",
        reasoningEffort: "high",
        serviceTier: "fast"
    });
    const allowedExecutionFields = {
        ...ipcRequest,
        jobId: "synthetic-job",
        projectPath: PROJECT_PATH,
        text: "synthetic text",
        timeoutSec: 1,
        metaPath: "synthetic-meta",
        outputPath: "synthetic-output",
        codexOutputPath: "synthetic-codex-output"
    };
    assert.equal(resolveProviderRouteRequest(allowedExecutionFields, DEPENDENCIES).alias, "deepseek-4.1-flash");

    const invalidRequests = [
        [() => resolveProviderRouteRequest(ipcRequest), PROVIDER_ERROR_CODES.ROUTE_NOT_CONFIGURED],
        [() => resolveProviderRouteRequest({ ...ipcRequest, providerRouteId: "not-a-route" }, DEPENDENCIES), PROVIDER_ERROR_CODES.ROUTE_UNKNOWN],
        [() => resolveProviderRouteRequest({ ...ipcRequest, providerRouteRevision: "official-r9" }, DEPENDENCIES), PROVIDER_ERROR_CODES.ROUTE_REVISION_MISMATCH],
        [() => resolveProviderRouteRequest({ ...ipcRequest, model: "aicw-synthetic-chat" }, DEPENDENCIES), PROVIDER_ERROR_CODES.ROUTE_MODEL_CONFLICT],
        [() => resolveProviderRouteRequest({ ...ipcRequest, modelProvider: "aicw-deepseek-official" }, DEPENDENCIES), PROVIDER_ERROR_CODES.RESERVED_FIELD],
        [() => resolveProviderRouteRequest({ ...ipcRequest, alias: "deepseek-4.1-flash" }, DEPENDENCIES), PROVIDER_ERROR_CODES.REQUEST_INVALID],
        [() => resolveProviderRouteRequest({ ...ipcRequest, url: CANARY }, DEPENDENCIES), PROVIDER_ERROR_CODES.REQUEST_INVALID]
    ];
    for (const [callback, code] of invalidRequests) expectProviderError(callback, code, CANARY);
    const nonEnumerableUnknown = { ...ipcRequest };
    Object.defineProperty(nonEnumerableUnknown, "env", { value: {}, enumerable: false });
    expectProviderError(
        () => resolveProviderRouteRequest(nonEnumerableUnknown, DEPENDENCIES),
        PROVIDER_ERROR_CODES.REQUEST_INVALID
    );

    const plan = resolveProviderRoutePlan("deepseek-4.1-flash", {
        reasoningEffort: "high",
        serviceTier: "fast"
    }, DEPENDENCIES);
    const safeRevisionReplacement = { ...plan, revision: "synthetic-safe-revision" };
    assert.deepEqual(providerPlanToIpc(safeRevisionReplacement), {
        providerRouteId: "deepseek-official",
        providerRouteRevision: "synthetic-safe-revision",
        effort: "high",
        serviceTier: "fast"
    });
    for (const tampered of [
        { ...plan, routeId: "deepseek-commandcode" },
        { ...plan, modelProvider: "aicw-deepseek-commandcode" },
        { ...plan, alias: "deepseek-4.1-flash-commandcode" },
        { ...plan, model: "aicw-synthetic-other" },
        { ...plan, upstreamModel: "aicw-synthetic-other" },
        { ...plan, model: CANARY, upstreamModel: "aicw-synthetic-other" }
    ]) {
        expectProviderError(() => providerPlanToIpc(tampered), PROVIDER_ERROR_CODES.REQUEST_INVALID, CANARY);
        expectProviderError(() => providerPlanToThreadParams(tampered), PROVIDER_ERROR_CODES.REQUEST_INVALID, CANARY);
    }

    for (const value of [undefined, null]) {
        const external = { providerRouteId: value };
        expectProviderError(
            () => assertNoExternalReservedFields(external),
            PROVIDER_ERROR_CODES.RESERVED_FIELD
        );
        const raw = { modelProvider: value };
        expectProviderError(
            () => assertNoIpcRawProviderFields(raw),
            PROVIDER_ERROR_CODES.RESERVED_FIELD
        );
    }
    const nonEnumerableReserved = {};
    Object.defineProperty(nonEnumerableReserved, "providerRouteId", { value: "hidden", enumerable: false });
    expectProviderError(
        () => assertNoExternalReservedFields(nonEnumerableReserved),
        PROVIDER_ERROR_CODES.RESERVED_FIELD
    );
    let reservedGetterCount = 0;
    const accessorReserved = {};
    defineAccessor(accessorReserved, "providerRouteId", () => {
        reservedGetterCount += 1;
        return CANARY;
    });
    expectProviderError(
        () => assertNoExternalReservedFields(accessorReserved),
        PROVIDER_ERROR_CODES.RESERVED_FIELD,
        CANARY
    );
    assert.equal(reservedGetterCount, 0);
    expectProviderError(
        () => assertNoExternalReservedFields([]),
        PROVIDER_ERROR_CODES.REQUEST_INVALID
    );
    const ordinaryShape = { jobId: "synthetic-job" };
    assert.equal(assertNoExternalReservedFields(ordinaryShape), ordinaryShape);
    assert.equal(assertNoIpcRawProviderFields(ordinaryShape), ordinaryShape);
    assert.equal(isProviderRouteRequest({ model: "deepseek-4.1-flash" }), true);
    assert.equal(isProviderRouteRequest({ providerRouteId: "deepseek-official" }), true);
    assert.equal(isProviderRouteRequest({ jobId: "synthetic-job" }), false);

    const proofCases = [
        [{}, PROVIDER_ERROR_CODES.PROTOCOL_UNSUPPORTED],
        [{ providerRoutingProtocolVersion: 2, providerExecutionAvailable: true }, PROVIDER_ERROR_CODES.PROTOCOL_UNSUPPORTED],
        [{ providerRoutingProtocolVersion: 1, providerExecutionAvailable: "true" }, PROVIDER_ERROR_CODES.PROTOCOL_UNSUPPORTED],
        [{ providerRoutingProtocolVersion: 1, providerExecutionAvailable: false }, PROVIDER_ERROR_CODES.RUNTIME_UNAVAILABLE]
    ];
    for (const [proof, code] of proofCases) expectProviderError(() => assertProviderRoutingProof(proof), code);
    assert.deepEqual(assertProviderRoutingProof({
        providerRoutingProtocolVersion: PROVIDER_ROUTING_PROTOCOL_VERSION,
        providerExecutionAvailable: true
    }), {
        providerRoutingProtocolVersion: 1,
        providerExecutionAvailable: true
    });
    assert.equal(PROVIDER_EXECUTION_AVAILABLE, false);
    assert.deepEqual(providerRoutingStatus({
        providerRoutingProtocolVersion: 1,
        providerExecutionAvailable: false
    }), { providerRoutingProtocolVersion: 1, providerExecutionAvailable: false });
    let proofGetterCount = 0;
    const accessorProof = {};
    defineAccessor(accessorProof, "providerExecutionAvailable", () => {
        proofGetterCount += 1;
        return true;
    });
    accessorProof.providerRoutingProtocolVersion = 1;
    expectProviderError(
        () => assertProviderRoutingProof(accessorProof),
        PROVIDER_ERROR_CODES.PROTOCOL_UNSUPPORTED
    );
    assert.equal(proofGetterCount, 0);

    let errorCodeGetterCount = 0;
    const externalError = {};
    defineAccessor(externalError, "code", () => {
        errorCodeGetterCount += 1;
        return CANARY;
    });
    defineAccessor(externalError, "message", () => {
        errorCodeGetterCount += 1;
        return CANARY;
    });
    assert.equal(providerErrorCodeFrom(externalError, PROVIDER_ERROR_CODES.ROUTE_UNKNOWN), PROVIDER_ERROR_CODES.ROUTE_UNKNOWN);
    assert.deepEqual(providerErrorResult(externalError, PROVIDER_ERROR_CODES.ROUTE_UNKNOWN), {
        status: "error",
        errorCode: PROVIDER_ERROR_CODES.ROUTE_UNKNOWN,
        error: "Provider routing request was rejected."
    });
    assert.equal(errorCodeGetterCount, 0);
    const maliciousFallback = { toString() { throw new Error(CANARY); } };
    assert.equal(providerErrorCodeFrom(null, maliciousFallback), PROVIDER_ERROR_CODES.REQUEST_INVALID);
    const publicError = new ProviderRouteError(maliciousFallback);
    assert.equal(publicError.code, PROVIDER_ERROR_CODES.REQUEST_INVALID);
    assert.equal(publicError.message.includes(CANARY), false);
    assert.equal(providerErrorCodeFrom({ code: CANARY }, maliciousFallback), PROVIDER_ERROR_CODES.REQUEST_INVALID);
});

test("verified plans reach only an in-memory Codex connection with exact thread and turn fields", async () => {
    const routes = [
        {
            alias: "deepseek-4.1-flash",
            routeId: "deepseek-official",
            model: "aicw-synthetic-chat",
            provider: "aicw-deepseek-official",
            effort: "high",
            serviceTier: "fast"
        },
        {
            alias: "deepseek-4.1-flash-commandcode",
            routeId: "deepseek-commandcode",
            model: "aicw-synthetic-reasoner",
            provider: "aicw-deepseek-commandcode",
            effort: "high",
            serviceTier: "default"
        }
    ];
    for (const route of routes) {
        const plan = resolveProviderRoutePlan(route.alias, {
            reasoningEffort: route.effort,
            serviceTier: route.serviceTier
        }, DEPENDENCIES);
        const threadParams = providerPlanToThreadParams(plan);
        assert.deepEqual(threadParams, {
            model: route.model,
            modelProvider: route.provider,
            allowProviderModelFallback: false,
            effort: route.effort,
            serviceTier: route.serviceTier
        });
        const calls = [];
        const codex = new CodexAppServerProcess({ env: {} });
        codex.closed = false;
        codex.connection = {
            request: async (method, params) => {
                calls.push({ method, params });
                if (method === "thread/start") {
                    return {
                        model: route.model,
                        modelProvider: route.provider,
                        thread: { id: `thread-${route.routeId}`, modelProvider: route.provider }
                    };
                }
                if (method === "turn/start") return { turn: { id: `turn-${route.routeId}` } };
                throw new Error("unexpected in-memory method");
            }
        };
        assert.deepEqual(codex.env, {});
        assert.equal(codex.version, null);
        assert.equal(codex.child, null);
        assert.equal(codex.started, false);

        const thread = await codex.startThread({
            projectPath: PROJECT_PATH,
            ...threadParams
        });
        const turn = await codex.startTurn({
            threadId: thread.id,
            text: "synthetic provider route turn",
            effort: route.effort,
            serviceTier: route.serviceTier
        });
        assert.equal(thread.id, `thread-${route.routeId}`);
        assert.deepEqual(thread, {
            id: `thread-${route.routeId}`,
            modelProvider: route.provider
        });
        assert.equal(turn.id, `turn-${route.routeId}`);
        assert.deepEqual(calls[0], {
            method: "thread/start",
            params: {
                cwd: PROJECT_PATH,
                ephemeral: true,
                sandbox: "read-only",
                approvalPolicy: "never",
                model: route.model,
                modelProvider: route.provider,
                allowProviderModelFallback: false,
                serviceTier: route.serviceTier
            }
        });
        assert.deepEqual(calls[1], {
            method: "turn/start",
            params: {
                threadId: thread.id,
                input: [{ type: "text", text: "synthetic provider route turn", text_elements: [] }],
                effort: route.effort,
                serviceTier: route.serviceTier
            }
        });

        for (const mismatch of ["model", "modelProvider", "thread.modelProvider"]) {
            const mismatchCalls = [];
            const rejectingCodex = new CodexAppServerProcess({ env: {} });
            rejectingCodex.closed = false;
            rejectingCodex.connection = {
                request: async (method, params) => {
                    mismatchCalls.push({ method, params });
                    if (method !== "thread/start") throw new Error("unexpected mismatch method");
                    const response = {
                        model: route.model,
                        modelProvider: route.provider,
                        thread: { id: "synthetic-mismatch-thread", modelProvider: route.provider }
                    };
                    if (mismatch === "model") response.model = CANARY;
                    if (mismatch === "modelProvider") response.modelProvider = CANARY;
                    if (mismatch === "thread.modelProvider") response.thread.modelProvider = CANARY;
                    return response;
                }
            };
            await assert.rejects(
                () => rejectingCodex.startThread({ projectPath: PROJECT_PATH, ...threadParams }),
                error => error?.code === "CODEX_PROVIDER_ROUTE_UNCONFIRMED",
                mismatch
            );
            assert.deepEqual(mismatchCalls, [{
                method: "thread/start",
                params: {
                    cwd: PROJECT_PATH,
                    ephemeral: true,
                    sandbox: "read-only",
                    approvalPolicy: "never",
                    model: route.model,
                    modelProvider: route.provider,
                    allowProviderModelFallback: false,
                    serviceTier: route.serviceTier
                }
            }], mismatch);
            assert.equal(rejectingCodex.closed, false, mismatch);
            assert.equal(rejectingCodex.started, false, mismatch);
            assert.equal(rejectingCodex.child, null, mismatch);
        }
    }
});
