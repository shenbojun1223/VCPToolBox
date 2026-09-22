"use strict";

const PROVIDER_ROUTING_PROTOCOL_VERSION = 1;
const PROVIDER_EXECUTION_AVAILABLE = false;

const PROVIDER_ERROR_CODES = Object.freeze({
    RESERVED_FIELD: "AICW_PROVIDER_RESERVED_FIELD",
    REQUEST_INVALID: "AICW_PROVIDER_REQUEST_INVALID",
    ROUTE_CATALOG_INVALID: "AICW_PROVIDER_ROUTE_CATALOG_INVALID",
    ROUTE_NOT_CONFIGURED: "AICW_PROVIDER_ROUTE_NOT_CONFIGURED",
    ROUTE_UNKNOWN: "AICW_PROVIDER_ROUTE_UNKNOWN",
    ROUTE_REVISION_MISMATCH: "AICW_PROVIDER_ROUTE_REVISION_MISMATCH",
    ROUTE_MODEL_CONFLICT: "AICW_PROVIDER_ROUTE_MODEL_CONFLICT",
    ROUTE_REQUIRED: "AICW_PROVIDER_ROUTE_REQUIRED",
    MODE_UNSUPPORTED: "AICW_PROVIDER_MODE_UNSUPPORTED",
    EFFORT_UNSUPPORTED: "AICW_PROVIDER_EFFORT_UNSUPPORTED",
    SERVICE_TIER_UNSUPPORTED: "AICW_PROVIDER_SERVICE_TIER_UNSUPPORTED",
    PROTOCOL_UNSUPPORTED: "AICW_PROVIDER_PROTOCOL_UNSUPPORTED",
    INSTANCE_CHANGED: "AICW_PROVIDER_INSTANCE_CHANGED",
    RUNTIME_UNAVAILABLE: "AICW_PROVIDER_RUNTIME_UNAVAILABLE"
});
const PROVIDER_ERROR_CODE_SET = new Set(Object.values(PROVIDER_ERROR_CODES));

const ALIAS_MAP = Object.freeze({
    "deepseek-4.1-flash": Object.freeze({
        routeId: "deepseek-official",
        modelProvider: "aicw-deepseek-official"
    }),
    "deepseek-4.1-flash-commandcode": Object.freeze({
        routeId: "deepseek-commandcode",
        modelProvider: "aicw-deepseek-commandcode"
    })
});

const ROUTE_ID_MAP = Object.freeze({
    "deepseek-official": Object.freeze({
        alias: "deepseek-4.1-flash",
        modelProvider: "aicw-deepseek-official"
    }),
    "deepseek-commandcode": Object.freeze({
        alias: "deepseek-4.1-flash-commandcode",
        modelProvider: "aicw-deepseek-commandcode"
    })
});
const ROUTE_IDS = new Set(Object.keys(ROUTE_ID_MAP));
const PROVIDER_MODEL_PROVIDERS = new Set(
    Object.keys(ROUTE_ID_MAP).map(routeId => ROUTE_ID_MAP[routeId].modelProvider)
);
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/u;
const MAX_MODEL_LENGTH = 256;
const MAX_EFFORTS = 32;
const MAX_TIERS = 2;
const DESCRIPTOR_KEYS = Object.freeze([
    "routeId",
    "revision",
    "upstreamModel",
    "reasoningEfforts",
    "defaultReasoningEffort",
    "serviceTiers",
    "defaultServiceTier"
]);
const DESCRIPTOR_KEY_SET = new Set(DESCRIPTOR_KEYS);

const EXTERNAL_RESERVED_FIELDS = Object.freeze([
    "providerRouteId",
    "providerRouteRevision",
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
]);
const IPC_RAW_RESERVED_FIELDS = Object.freeze([
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
]);
const PROVIDER_ROUTE_IPC_FIELDS = Object.freeze([
    "jobId",
    "projectPath",
    "text",
    "effort",
    "serviceTier",
    "timeoutSec",
    "metaPath",
    "outputPath",
    "codexOutputPath",
    "providerRouteId",
    "providerRouteRevision"
]);
const PROVIDER_ROUTE_IPC_FIELD_SET = new Set(PROVIDER_ROUTE_IPC_FIELDS);
const PROVIDER_ROUTE_FIELD_SET = new Set(["providerRouteId", "providerRouteRevision"]);

function normalizeProviderErrorCode(value) {
    return typeof value === "string" && PROVIDER_ERROR_CODE_SET.has(value)
        ? value
        : PROVIDER_ERROR_CODES.REQUEST_INVALID;
}

class ProviderRouteError extends Error {
    constructor(code) {
        const normalizedCode = normalizeProviderErrorCode(code);
        super(normalizedCode);
        this.name = "ProviderRouteError";
        this.code = normalizedCode;
    }
}

function providerRouteError(code) {
    return new ProviderRouteError(code);
}

function hasOwn(value, key) {
    try {
        return Boolean(value && (typeof value === "object" || typeof value === "function") &&
            Object.prototype.hasOwnProperty.call(value, key));
    } catch {
        return false;
    }
}

function isPlainObject(value) {
    if (!value || typeof value !== "object") return false;
    try {
        return !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
    } catch {
        return false;
    }
}

function assertPlainObject(value, code = PROVIDER_ERROR_CODES.REQUEST_INVALID) {
    if (!isPlainObject(value)) throw providerRouteError(code);
    return value;
}

function ownKeysOrThrow(value, code) {
    try {
        return Reflect.ownKeys(value);
    } catch {
        throw providerRouteError(code);
    }
}

function ownPropertyDescriptorOrThrow(value, key, code) {
    try {
        return Object.getOwnPropertyDescriptor(value, key);
    } catch {
        throw providerRouteError(code);
    }
}

function isDataPropertyDescriptor(descriptor) {
    return Boolean(descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value"));
}

function readOwnDataProperty(value, key, code) {
    const descriptor = ownPropertyDescriptorOrThrow(value, key, code);
    if (!descriptor) return { present: false, value: undefined };
    if (!isDataPropertyDescriptor(descriptor)) throw providerRouteError(code);
    return { present: true, value: descriptor.value };
}

function snapshotExactDataObject(value, expectedKeys, code) {
    assertPlainObject(value, code);
    const keys = ownKeysOrThrow(value, code);
    const expectedKeySet = new Set(expectedKeys);
    if (keys.length !== expectedKeys.length || keys.some(key =>
        typeof key !== "string" || !expectedKeySet.has(key))) {
        throw providerRouteError(code);
    }
    const snapshot = Object.create(null);
    for (const key of expectedKeys) {
        const field = readOwnDataProperty(value, key, code);
        if (!field.present) throw providerRouteError(code);
        snapshot[key] = field.value;
    }
    return snapshot;
}

function isCanonicalArrayIndexKey(key, length) {
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)) return false;
    const index = Number(key);
    return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function snapshotDenseArray(value, code, maxLength, minLength = 0) {
    let isArray;
    try { isArray = Array.isArray(value); } catch { throw providerRouteError(code); }
    if (!isArray) throw providerRouteError(code);

    const lengthDescriptor = ownPropertyDescriptorOrThrow(value, "length", code);
    if (!isDataPropertyDescriptor(lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < minLength || lengthDescriptor.value > maxLength) {
        throw providerRouteError(code);
    }
    const length = lengthDescriptor.value;
    const keys = ownKeysOrThrow(value, code);
    if (keys.length !== length + 1) throw providerRouteError(code);

    const indexKeys = new Set();
    let hasLength = false;
    for (const key of keys) {
        if (key === "length") {
            if (hasLength) throw providerRouteError(code);
            hasLength = true;
            continue;
        }
        if (!isCanonicalArrayIndexKey(key, length) || indexKeys.has(key)) {
            throw providerRouteError(code);
        }
        indexKeys.add(key);
    }
    if (!hasLength || indexKeys.size !== length) throw providerRouteError(code);

    const snapshot = new Array(length);
    for (let index = 0; index < length; index += 1) {
        const key = String(index);
        if (!indexKeys.has(key)) throw providerRouteError(code);
        const descriptor = ownPropertyDescriptorOrThrow(value, key, code);
        if (!isDataPropertyDescriptor(descriptor)) throw providerRouteError(code);
        snapshot[index] = descriptor.value;
    }
    return snapshot;
}

function isProviderAlias(model) {
    return typeof model === "string" && hasOwn(ALIAS_MAP, model);
}

function getProviderAliasInfo(alias) {
    if (!isProviderAlias(alias)) return null;
    const value = ALIAS_MAP[alias];
    return Object.freeze({
        alias,
        routeId: value.routeId,
        modelProvider: value.modelProvider
    });
}

function assertNoExternalReservedFields(input) {
    assertPlainObject(input);
    for (const field of EXTERNAL_RESERVED_FIELDS) {
        if (hasOwnOrThrow(input, field, PROVIDER_ERROR_CODES.REQUEST_INVALID)) {
            throw providerRouteError(PROVIDER_ERROR_CODES.RESERVED_FIELD);
        }
    }
    return input;
}

function assertNoIpcRawProviderFields(input) {
    assertPlainObject(input);
    for (const field of IPC_RAW_RESERVED_FIELDS) {
        if (hasOwnOrThrow(input, field, PROVIDER_ERROR_CODES.REQUEST_INVALID)) {
            throw providerRouteError(PROVIDER_ERROR_CODES.RESERVED_FIELD);
        }
    }
    return input;
}

function hasOwnOrThrow(value, key, code) {
    try {
        return Object.prototype.hasOwnProperty.call(value, key);
    } catch {
        throw providerRouteError(code);
    }
}

function assertSafeIdentifier(value) {
    return typeof value === "string" && SAFE_IDENTIFIER.test(value);
}

function assertSafeModel(value) {
    return typeof value === "string" &&
        value.length > 0 && value.length <= MAX_MODEL_LENGTH &&
        value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function cloneAndValidateDescriptor(value) {
    const descriptor = snapshotExactDataObject(
        value,
        DESCRIPTOR_KEYS,
        PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID
    );
    if (!ROUTE_IDS.has(descriptor.routeId) || !assertSafeIdentifier(descriptor.routeId)) {
        throw providerRouteError(PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID);
    }
    if (!assertSafeIdentifier(descriptor.revision)) {
        throw providerRouteError(PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID);
    }
    if (!assertSafeModel(descriptor.upstreamModel)) {
        throw providerRouteError(PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID);
    }
    const reasoningEfforts = snapshotDenseArray(
        descriptor.reasoningEfforts,
        PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID,
        MAX_EFFORTS,
        1
    );
    for (const effort of reasoningEfforts) {
        if (!assertSafeIdentifier(effort)) throw providerRouteError(PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID);
    }
    if (new Set(reasoningEfforts).size !== reasoningEfforts.length ||
        !reasoningEfforts.includes(descriptor.defaultReasoningEffort) ||
        !assertSafeIdentifier(descriptor.defaultReasoningEffort)) {
        throw providerRouteError(PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID);
    }
    const serviceTiers = snapshotDenseArray(
        descriptor.serviceTiers,
        PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID,
        MAX_TIERS,
        1
    );
    for (const tier of serviceTiers) {
        if (tier !== "default" && tier !== "fast") {
            throw providerRouteError(PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID);
        }
    }
    if (new Set(serviceTiers).size !== serviceTiers.length ||
        !serviceTiers.includes(descriptor.defaultServiceTier)) {
        throw providerRouteError(PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID);
    }
    return Object.freeze({
        routeId: descriptor.routeId,
        revision: descriptor.revision,
        upstreamModel: descriptor.upstreamModel,
        reasoningEfforts: Object.freeze([...reasoningEfforts]),
        defaultReasoningEffort: descriptor.defaultReasoningEffort,
        serviceTiers: Object.freeze([...serviceTiers]),
        defaultServiceTier: descriptor.defaultServiceTier
    });
}

function createProviderRouteCatalog(routeCatalog = []) {
    const descriptors = snapshotDenseArray(
        routeCatalog,
        PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID,
        ROUTE_IDS.size,
        0
    );
    const routes = [];
    for (const descriptor of descriptors) routes.push(cloneAndValidateDescriptor(descriptor));
    const routeIds = new Set();
    for (const route of routes) {
        if (routeIds.has(route.routeId)) {
            throw providerRouteError(PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID);
        }
        routeIds.add(route.routeId);
    }
    return Object.freeze(routes);
}

const DEFAULT_PROVIDER_ROUTE_CATALOG = Object.freeze([]);

function trustedCatalogFrom(dependencies = {}) {
    if (dependencies === undefined) return DEFAULT_PROVIDER_ROUTE_CATALOG;
    assertPlainObject(dependencies, PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID);
    let selectedCatalog = DEFAULT_PROVIDER_ROUTE_CATALOG;
    let selected = false;
    for (const field of ["providerRouteCatalog", "routeCatalog", "providerRoutes"]) {
        const candidate = readOwnDataProperty(
            dependencies,
            field,
            PROVIDER_ERROR_CODES.ROUTE_CATALOG_INVALID
        );
        if (!candidate.present) continue;
        const catalog = createProviderRouteCatalog(candidate.value);
        if (!selected) {
            selectedCatalog = catalog;
            selected = true;
        }
    }
    return selectedCatalog;
}

function findRouteById(routeId, dependencies = {}) {
    if (!assertSafeIdentifier(routeId)) throw providerRouteError(PROVIDER_ERROR_CODES.ROUTE_UNKNOWN);
    const aliasInfo = hasOwn(ROUTE_ID_MAP, routeId) ? ROUTE_ID_MAP[routeId] : null;
    if (!aliasInfo) throw providerRouteError(PROVIDER_ERROR_CODES.ROUTE_UNKNOWN);
    const route = trustedCatalogFrom(dependencies).find(candidate => candidate.routeId === routeId);
    if (!route) throw providerRouteError(PROVIDER_ERROR_CODES.ROUTE_NOT_CONFIGURED);
    return { route, aliasInfo };
}

function normalizeEffort(value, route) {
    const effort = value === undefined || value === null ||
        (typeof value === "string" && value.trim() === "")
        ? route.defaultReasoningEffort
        : typeof value === "string" ? value.trim().toLowerCase() : null;
    if (!effort || !route.reasoningEfforts.some(candidate => candidate === effort)) {
        throw providerRouteError(PROVIDER_ERROR_CODES.EFFORT_UNSUPPORTED);
    }
    return effort;
}

function normalizeServiceTier(value, route) {
    const serviceTier = value === undefined || value === null ||
        (typeof value === "string" && value.trim() === "")
        ? route.defaultServiceTier
        : typeof value === "string" ? value.trim().toLowerCase() : null;
    if (!serviceTier || !route.serviceTiers.some(candidate => candidate === serviceTier)) {
        throw providerRouteError(PROVIDER_ERROR_CODES.SERVICE_TIER_UNSUPPORTED);
    }
    return serviceTier;
}

function resolveProviderRoutePlan(alias, options = {}, dependencies = {}) {
    if (!isProviderAlias(alias)) throw providerRouteError(PROVIDER_ERROR_CODES.ROUTE_UNKNOWN);
    assertPlainObject(options);
    const { route, aliasInfo } = findRouteById(ALIAS_MAP[alias].routeId, dependencies);
    const fastMode = readOwnDataProperty(options, "fastMode", PROVIDER_ERROR_CODES.REQUEST_INVALID).value;
    if (fastMode !== undefined && fastMode !== null && typeof fastMode !== "boolean") {
        throw providerRouteError(PROVIDER_ERROR_CODES.REQUEST_INVALID);
    }
    const requestedTier = fastMode === true
        ? "fast"
        : fastMode === false
            ? "default"
            : readOwnDataProperty(options, "serviceTier", PROVIDER_ERROR_CODES.REQUEST_INVALID).value;
    const plan = {
        alias,
        routeId: route.routeId,
        revision: route.revision,
        upstreamModel: route.upstreamModel,
        model: route.upstreamModel,
        modelProvider: aliasInfo.modelProvider,
        reasoningEffort: normalizeEffort(
            readOwnDataProperty(options, "reasoningEffort", PROVIDER_ERROR_CODES.REQUEST_INVALID).value,
            route
        ),
        serviceTier: normalizeServiceTier(requestedTier, route)
    };
    return Object.freeze(plan);
}

function resolveProviderRouteRequest(request, dependencies = {}) {
    assertNoIpcRawProviderFields(request);
    if (hasOwnOrThrow(request, "model", PROVIDER_ERROR_CODES.REQUEST_INVALID)) {
        throw providerRouteError(PROVIDER_ERROR_CODES.ROUTE_MODEL_CONFLICT);
    }
    const requestKeys = ownKeysOrThrow(request, PROVIDER_ERROR_CODES.REQUEST_INVALID);
    if (requestKeys.some(key => typeof key !== "string" || !PROVIDER_ROUTE_IPC_FIELD_SET.has(key))) {
        throw providerRouteError(PROVIDER_ERROR_CODES.REQUEST_INVALID);
    }
    const routeIdField = readOwnDataProperty(
        request,
        "providerRouteId",
        PROVIDER_ERROR_CODES.PROTOCOL_UNSUPPORTED
    );
    const revisionField = readOwnDataProperty(
        request,
        "providerRouteRevision",
        PROVIDER_ERROR_CODES.PROTOCOL_UNSUPPORTED
    );
    const hasRouteId = routeIdField.present;
    const hasRevision = revisionField.present;
    if (!hasRouteId || !hasRevision ||
        typeof routeIdField.value !== "string" || typeof revisionField.value !== "string") {
        throw providerRouteError(PROVIDER_ERROR_CODES.PROTOCOL_UNSUPPORTED);
    }
    const { route, aliasInfo } = findRouteById(routeIdField.value, dependencies);
    if (revisionField.value !== route.revision) {
        throw providerRouteError(PROVIDER_ERROR_CODES.ROUTE_REVISION_MISMATCH);
    }
    const effort = normalizeEffort(
        readOwnDataProperty(request, "effort", PROVIDER_ERROR_CODES.REQUEST_INVALID).value,
        route
    );
    const serviceTier = normalizeServiceTier(
        readOwnDataProperty(request, "serviceTier", PROVIDER_ERROR_CODES.REQUEST_INVALID).value,
        route
    );
    return Object.freeze({
        alias: aliasInfo.alias,
        routeId: route.routeId,
        revision: route.revision,
        upstreamModel: route.upstreamModel,
        model: route.upstreamModel,
        modelProvider: aliasInfo.modelProvider,
        reasoningEffort: effort,
        serviceTier
    });
}

function validatePlanForConversion(plan, requireUpstreamModel) {
    assertPlainObject(plan);
    const alias = readOwnDataProperty(plan, "alias", PROVIDER_ERROR_CODES.REQUEST_INVALID);
    const routeId = readOwnDataProperty(plan, "routeId", PROVIDER_ERROR_CODES.REQUEST_INVALID);
    const revision = readOwnDataProperty(plan, "revision", PROVIDER_ERROR_CODES.REQUEST_INVALID);
    const modelProvider = readOwnDataProperty(plan, "modelProvider", PROVIDER_ERROR_CODES.REQUEST_INVALID);
    const reasoningEffort = readOwnDataProperty(plan, "reasoningEffort", PROVIDER_ERROR_CODES.REQUEST_INVALID);
    const serviceTier = readOwnDataProperty(plan, "serviceTier", PROVIDER_ERROR_CODES.REQUEST_INVALID);
    const upstreamModel = readOwnDataProperty(plan, "upstreamModel", PROVIDER_ERROR_CODES.REQUEST_INVALID);
    const model = readOwnDataProperty(plan, "model", PROVIDER_ERROR_CODES.REQUEST_INVALID);
    if (!alias.present || !routeId.present || !revision.present || !modelProvider.present ||
        !reasoningEffort.present || !serviceTier.present || !isProviderAlias(alias.value)) {
        throw providerRouteError(PROVIDER_ERROR_CODES.REQUEST_INVALID);
    }
    const aliasInfo = ALIAS_MAP[alias.value];
    if (routeId.value !== aliasInfo.routeId || modelProvider.value !== aliasInfo.modelProvider ||
        !assertSafeIdentifier(revision.value) || !assertSafeIdentifier(reasoningEffort.value) ||
        (serviceTier.value !== "default" && serviceTier.value !== "fast")) {
        throw providerRouteError(PROVIDER_ERROR_CODES.REQUEST_INVALID);
    }
    if (upstreamModel.present && !assertSafeModel(upstreamModel.value)) {
        throw providerRouteError(PROVIDER_ERROR_CODES.REQUEST_INVALID);
    }
    if (model.present && !assertSafeModel(model.value)) {
        throw providerRouteError(PROVIDER_ERROR_CODES.REQUEST_INVALID);
    }
    if (upstreamModel.present && model.present && upstreamModel.value !== model.value) {
        throw providerRouteError(PROVIDER_ERROR_CODES.REQUEST_INVALID);
    }
    if (requireUpstreamModel && !upstreamModel.present) {
        throw providerRouteError(PROVIDER_ERROR_CODES.REQUEST_INVALID);
    }
    return {
        alias: alias.value,
        routeId: routeId.value,
        revision: revision.value,
        modelProvider: modelProvider.value,
        reasoningEffort: reasoningEffort.value,
        serviceTier: serviceTier.value,
        upstreamModel: upstreamModel.present ? upstreamModel.value : undefined
    };
}

function providerPlanToIpc(plan) {
    const verifiedPlan = validatePlanForConversion(plan, false);
    return Object.freeze({
        providerRouteId: verifiedPlan.routeId,
        providerRouteRevision: verifiedPlan.revision,
        effort: verifiedPlan.reasoningEffort,
        serviceTier: verifiedPlan.serviceTier
    });
}

function providerPlanToThreadParams(plan) {
    const verifiedPlan = validatePlanForConversion(plan, true);
    if (!PROVIDER_MODEL_PROVIDERS.has(verifiedPlan.modelProvider)) {
        throw providerRouteError(PROVIDER_ERROR_CODES.REQUEST_INVALID);
    }
    return Object.freeze({
        model: verifiedPlan.upstreamModel,
        modelProvider: verifiedPlan.modelProvider,
        allowProviderModelFallback: false,
        effort: verifiedPlan.reasoningEffort,
        serviceTier: verifiedPlan.serviceTier
    });
}

function providerRoutingStatus(source = null) {
    const value = isPlainObject(source) ? source : null;
    let protocolVersion = null;
    let executionAvailable = null;
    if (value) {
        try {
            const field = readOwnDataProperty(value, "providerRoutingProtocolVersion", PROVIDER_ERROR_CODES.REQUEST_INVALID);
            if (field.present && Number.isSafeInteger(field.value)) protocolVersion = field.value;
        } catch {}
        try {
            const field = readOwnDataProperty(value, "providerExecutionAvailable", PROVIDER_ERROR_CODES.REQUEST_INVALID);
            if (field.present && typeof field.value === "boolean") executionAvailable = field.value;
        } catch {}
    }
    return {
        providerRoutingProtocolVersion: protocolVersion,
        providerExecutionAvailable: executionAvailable
    };
}

function assertProviderRoutingProof(source) {
    if (!isPlainObject(source)) {
        throw providerRouteError(PROVIDER_ERROR_CODES.PROTOCOL_UNSUPPORTED);
    }
    let protocolVersion;
    let executionAvailable;
    try {
        protocolVersion = readOwnDataProperty(
            source,
            "providerRoutingProtocolVersion",
            PROVIDER_ERROR_CODES.PROTOCOL_UNSUPPORTED
        );
        executionAvailable = readOwnDataProperty(
            source,
            "providerExecutionAvailable",
            PROVIDER_ERROR_CODES.PROTOCOL_UNSUPPORTED
        );
    } catch {
        throw providerRouteError(PROVIDER_ERROR_CODES.PROTOCOL_UNSUPPORTED);
    }
    if (!protocolVersion.present || protocolVersion.value !== PROVIDER_ROUTING_PROTOCOL_VERSION ||
        !executionAvailable.present || typeof executionAvailable.value !== "boolean") {
        throw providerRouteError(PROVIDER_ERROR_CODES.PROTOCOL_UNSUPPORTED);
    }
    if (executionAvailable.value !== true) {
        throw providerRouteError(PROVIDER_ERROR_CODES.RUNTIME_UNAVAILABLE);
    }
    return Object.freeze({
        providerRoutingProtocolVersion: PROVIDER_ROUTING_PROTOCOL_VERSION,
        providerExecutionAvailable: true
    });
}

function isProviderRouteRequest(value) {
    if (!isPlainObject(value)) return false;
    try {
        const model = readOwnDataProperty(value, "model", PROVIDER_ERROR_CODES.REQUEST_INVALID);
        if (model.present && isProviderAlias(model.value)) return true;
        for (const field of [...PROVIDER_ROUTE_FIELD_SET, ...IPC_RAW_RESERVED_FIELDS]) {
            if (hasOwnOrThrow(value, field, PROVIDER_ERROR_CODES.REQUEST_INVALID)) return true;
        }
    } catch {
        return false;
    }
    return false;
}

function providerErrorCodeFrom(error, fallbackCode = PROVIDER_ERROR_CODES.REQUEST_INVALID) {
    const normalizedFallback = normalizeProviderErrorCode(fallbackCode);
    if (error === null || (typeof error !== "object" && typeof error !== "function")) {
        return normalizedFallback;
    }
    try {
        const descriptor = Object.getOwnPropertyDescriptor(error, "code");
        if (!descriptor || !isDataPropertyDescriptor(descriptor)) return normalizedFallback;
        return typeof descriptor.value === "string" && PROVIDER_ERROR_CODE_SET.has(descriptor.value)
            ? descriptor.value
            : normalizedFallback;
    } catch {
        return normalizedFallback;
    }
}

function providerErrorResult(error, fallbackCode = PROVIDER_ERROR_CODES.REQUEST_INVALID) {
    const code = providerErrorCodeFrom(error, fallbackCode);
    return {
        status: "error",
        errorCode: code,
        error: "Provider routing request was rejected."
    };
}

module.exports = {
    PROVIDER_ROUTING_PROTOCOL_VERSION,
    PROVIDER_EXECUTION_AVAILABLE,
    PROVIDER_ERROR_CODES,
    ALIAS_MAP,
    DEFAULT_PROVIDER_ROUTE_CATALOG,
    EXTERNAL_RESERVED_FIELDS,
    IPC_RAW_RESERVED_FIELDS,
    PROVIDER_ROUTE_IPC_FIELDS,
    ProviderRouteError,
    isPlainObject,
    isProviderAlias,
    getProviderAliasInfo,
    assertNoExternalReservedFields,
    assertNoIpcRawProviderFields,
    createProviderRouteCatalog,
    trustedCatalogFrom,
    findRouteById,
    resolveProviderRoutePlan,
    resolveProviderRouteRequest,
    providerPlanToIpc,
    providerPlanToThreadParams,
    providerRoutingStatus,
    assertProviderRoutingProof,
    isProviderRouteRequest,
    providerErrorCodeFrom,
    providerErrorResult
};
