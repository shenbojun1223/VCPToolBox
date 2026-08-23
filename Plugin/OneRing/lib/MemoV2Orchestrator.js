'use strict';

const { buildCandidateInput, validateAgentName } = require('../OneRingMemoV2.js');
const { createDefaultState } = require('./MemoV2Store.js');
const {
    DEFAULT_MAX_INPUT_CHARS,
    buildReductionPrompt
} = require('./MemoV2PromptBuilder.js');
const {
    DEFAULT_PROMPT_EVENT_TEXT_CHARS,
    normalizePromptEventTextCap
} = require('./MemoV2PromptProjector.js');
const { planMemoV2Batches } = require('./MemoV2BatchPlanner.js');
const { eventDate, validateReduction, validateReductionResponse } = require('./MemoV2Reducer.js');
const {
    WIRE_CONTRACT_VERSION,
    decodeReductionToolArguments
} = require('./MemoV2ToolContract.js');
const {
    NEW_THREAD_WIRE_TOKEN,
    NO_ASSIGNEE_WIRE_TOKEN
} = require('./MemoV2WireTokens.js');
const {
    reduceCandidateState,
    applyReductionToWorkingState,
    finalizeWorkingState,
    cloneJson,
    clockIso
} = require('./MemoV2StateReducer.js');
const { renderMemo, validateRenderedText } = require('./MemoV2Renderer.js');

const DEFAULT_FORMAT_RETRIES = 2;
const DEFAULT_MAX_TOKENS = 4096;
const FORMAT_RETRY_CODES = new Set([
    'MEMO_V2_INVALID_JSON',
    'MEMO_V2_INVALID_SCHEMA',
    'MEMO_V2_MODEL_DATE_FORBIDDEN',
    'MEMO_V2_INVALID_MODEL_RESPONSE',
    'MEMO_V2_TOOL_CALL_MISSING',
    'MEMO_V2_TOOL_CALL_MULTIPLE',
    'MEMO_V2_TOOL_CALL_WRONG_TYPE',
    'MEMO_V2_TOOL_CALL_WRONG_NAME',
    'MEMO_V2_TOOL_ARGUMENTS_MISSING',
    'MEMO_V2_LIMIT_EXCEEDED',
    'MEMO_V2_INVALID_SOURCES',
    'MEMO_V2_INVALID_SOURCE_ID'
]);

function orchestrationError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function normalizeFormatRetries(value) {
    const retries = Number(value ?? DEFAULT_FORMAT_RETRIES);
    if (!Number.isSafeInteger(retries) || retries < 0 || retries > 3) {
        throw orchestrationError('MEMO_V2_FORMAT_RETRIES_INVALID', 'formatRetries must be an integer from 0 to 3');
    }
    return retries;
}

function isFormatRetryable(error) {
    return FORMAT_RETRY_CODES.has(String(error?.code || ''));
}

function shortFailureCode(code) {
    return String(code || '').replace(/^MEMO_V2_/u, '').slice(0, 64);
}

function modelMeta(response) {
    return {
        attempts: Number.isSafeInteger(Number(response?.attempts)) ? Number(response.attempts) : 0,
        genericInvalidRequestRetryCount: Number.isSafeInteger(Number(response?.genericInvalidRequestRetryCount))
            ? Number(response.genericInvalidRequestRetryCount)
            : 0,
        finishReason: response?.finishReason == null
            ? null
            : String(response.finishReason).replace(/[^a-z0-9_.-]/giu, '_').slice(0, 40),
        usage: response?.usage && typeof response.usage === 'object' ? {
            prompt_tokens: Number(response.usage.prompt_tokens) || 0,
            completion_tokens: Number(response.usage.completion_tokens) || 0,
            total_tokens: Number(response.usage.total_tokens) || 0
        } : null
    };
}

function readPrevious(options) {
    if (options.previousState !== undefined) return options.previousState || createDefaultState(options.agentName);
    if (options.store && typeof options.store.readState === 'function') return options.store.readState(options.agentName);
    return createDefaultState(options.agentName);
}

function buildDelta(options) {
    if (options.delta) return options.delta;
    return buildCandidateInput({
        agentName: options.agentName,
        projectBasePath: options.projectBasePath,
        database: options.database,
        store: options.store,
        previousState: options.previousState,
        timelineDays: options.timelineDays,
        fallbackCount: options.fallbackCount,
        now: options.now,
        DatabaseImpl: options.DatabaseImpl
    });
}

function prepareReductionRequest(options = {}) {
    const agentName = validateAgentName(options.agentName || options.delta?.agentName);
    const delta = options.delta || buildDelta({ ...options, agentName });
    const previousState = options.previousState !== undefined
        ? options.previousState || createDefaultState(agentName)
        : delta.previousState || readPrevious({ ...options, agentName });
    const prompt = buildReductionPrompt({
        canonicalEvents: delta.canonicalEvents,
        previousState,
        maxInputChars: options.maxInputChars,
        eventTextCapChars: options.eventTextCapChars,
        formatAttempt: options.formatAttempt,
        previousValidationCode: options.previousValidationCode
    });
    return {
        agentName,
        delta,
        previousState,
        messages: prompt.messages,
        tools: prompt.tools,
        toolChoice: prompt.toolChoice,
        parallelToolCalls: prompt.parallelToolCalls,
        promptStats: prompt.stats
    };
}

function validateReductionResponseForDelta(options = {}) {
    const delta = options.delta;
    if (!delta || typeof delta !== 'object') throw orchestrationError('MEMO_V2_INVALID_DELTA', 'delta is required');
    const validationOptions = {
        delta,
        previousState: options.previousState || delta.previousState,
        allowedThreadIds: options.allowedThreadIds,
        allowedActorNames: options.allowedActorNames
    };
    if (options.wirePayload !== undefined) return validateReduction(options.wirePayload, validationOptions);
    return validateReductionResponse({ response: options.response, ...validationOptions });
}

function assertNoWireTokenLeak(value) {
    const visit = candidate => {
        if (typeof candidate === 'string') {
            return candidate.includes(NEW_THREAD_WIRE_TOKEN) || candidate.includes(NO_ASSIGNEE_WIRE_TOKEN);
        }
        if (Array.isArray(candidate)) return candidate.some(visit);
        if (candidate && typeof candidate === 'object') return Object.values(candidate).some(visit);
        return false;
    };
    if (visit(value)) throw orchestrationError('MEMO_V2_WIRE_TOKEN_LEAK', 'wire sentinel leaked into candidate output');
}

function buildCandidateState(options = {}) {
    const delta = options.delta;
    if (!delta || typeof delta !== 'object') throw orchestrationError('MEMO_V2_INVALID_DELTA', 'delta is required');
    const previousState = options.previousState || delta.previousState || createDefaultState(delta.agentName);
    const candidate = reduceCandidateState({
        delta,
        previousState,
        reduction: options.reduction || options.validatedReduction,
        clock: options.clock ?? options.now,
        retentionDays: options.retentionDays,
        maxTimelineFacts: options.maxTimelineFacts,
        maxThreadHistory: options.maxThreadHistory
    });
    assertNoWireTokenLeak(candidate);
    const rendered = renderMemo(candidate, { charBudget: options.renderCharBudget });
    const renderedMemo = validateRenderedText(rendered.text);
    assertNoWireTokenLeak(renderedMemo);
    const at = clockIso(options.clock ?? options.now);
    candidate.lastAttemptAt = at;
    candidate.lastSuccessAt = at;
    candidate.lastError = null;
    candidate.renderedMemo = renderedMemo;
    candidate.stats = {
        ...(candidate.stats && typeof candidate.stats === 'object' ? candidate.stats : {}),
        renderedChars: rendered.stats.chars,
        droppedFacts: rendered.stats.droppedFacts,
        droppedThreads: rendered.stats.droppedThreads
    };
    if (candidate.cursor?.lastMessageId !== delta.nextCursor?.lastMessageId
        || candidate.cursor?.snapshotDbMaxId !== delta.nextCursor?.snapshotDbMaxId) {
        throw orchestrationError('MEMO_V2_CURSOR_MISMATCH', 'candidate cursor does not match the complete delta');
    }
    return { state: candidate, rendered, stats: rendered.stats };
}

function safeFailure(error, batchIndex = null, batchCount = 0, formatMeta = {}) {
    return {
        code: String(error?.code || 'MEMO_V2_SHADOW_FAILED'),
        message: String(error?.code || 'MEMO_V2_SHADOW_FAILED'),
        batchIndex,
        batchNumber: batchIndex == null ? null : batchIndex + 1,
        batchCount,
        formatAttempt: Number.isSafeInteger(formatMeta.formatAttempt) ? formatMeta.formatAttempt : null,
        formatAttemptsAllowed: Number.isSafeInteger(formatMeta.formatAttemptsAllowed)
            ? formatMeta.formatAttemptsAllowed
            : null
    };
}

function emptyUsage() {
    return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

function createStats(
    delta,
    formatRetriesConfigured = DEFAULT_FORMAT_RETRIES,
    eventTextCapChars = DEFAULT_PROMPT_EVENT_TEXT_CHARS
) {
    const events = Array.isArray(delta?.canonicalEvents) ? delta.canonicalEvents : [];
    return {
        plannedBatchCount: 0,
        processedBatchCount: 0,
        totalCanonicalEventCount: events.length,
        coveredCanonicalEventCount: 0,
        droppedCanonicalEventCount: 0,
        duplicateCoverageCount: 0,
        batchEventCounts: [],
        dateBoundedBatching: true,
        contiguousDateSegmentCount: 0,
        dateBoundarySplitCount: 0,
        batchUniqueDateCounts: [],
        mixedDateBatchCount: 0,
        batchPromptChars: [],
        batchContractEventIdCounts: [],
        batchContractThreadIdCounts: [],
        batchContractActorNameCounts: [],
        batchFormatAttempts: [],
        batchToolCallAttempts: [],
        batchToolSchemaChars: [],
        eventTextCapChars,
        projectedEventCount: 0,
        projectionOriginalChars: 0,
        projectionOutputChars: 0,
        projectionRemovedChars: 0,
        projectionRequiredSegmentFailures: 0,
        promptSanitizedEventCount: 0,
        promptRedactionPlaceholderCount: 0,
        promptSanitizationRemovedChars: 0,
        batchProjectedEventCounts: [],
        batchProjectionRemovedChars: [],
        batchPromptSanitizedEventCounts: [],
        batchPromptRedactionPlaceholderCounts: [],
        batchPromptSanitizationRemovedChars: [],
        attemptsTotal: 0,
        genericInvalidRequestRetryCount: 0,
        modelCallCount: 0,
        wireContractVersion: WIRE_CONTRACT_VERSION,
        requestBudgetChars: DEFAULT_MAX_INPUT_CHARS,
        structuredChannel: 'forced_tool_call',
        toolCallRetryCount: 0,
        toolCallFailureCodes: [],
        normalContentIgnoredCount: 0,
        validToolCallCount: 0,
        formatRetriesConfigured,
        formatRetryCount: 0,
        formatFailureCodes: [],
        finishReasons: [],
        usage: emptyUsage(),
        outputChars: 0,
        sourceMessageCount: Number(delta?.stats?.sourceMessageCount) || 0,
        sourceIdsCount: Array.isArray(delta?.sourceMessageIds) ? delta.sourceMessageIds.length : 0,
        normalizedChars: Number(delta?.stats?.normalizedChars) || 0,
        skipped: Number(delta?.skipped?.total) || 0,
        duplicates: Number(delta?.duplicates?.total) || 0
    };
}

function addModelMeta(stats, response) {
    const meta = modelMeta(response);
    stats.attemptsTotal += meta.attempts;
    stats.genericInvalidRequestRetryCount += meta.genericInvalidRequestRetryCount;
    if (meta.finishReason) stats.finishReasons.push(meta.finishReason);
    if (meta.usage) {
        stats.usage.prompt_tokens += meta.usage.prompt_tokens;
        stats.usage.completion_tokens += meta.usage.completion_tokens;
        stats.usage.total_tokens += meta.usage.total_tokens;
    }
    return meta;
}

function addTransportErrorMeta(stats, error) {
    const attempts = Number(error?.attempts);
    if (Number.isSafeInteger(attempts) && attempts > 0) stats.attemptsTotal += attempts;
    const genericRetries = Number(error?.genericInvalidRequestRetryCount);
    if (Number.isSafeInteger(genericRetries) && genericRetries > 0) {
        stats.genericInvalidRequestRetryCount += genericRetries;
    }
}

function batchDelta(delta, batch, workingState) {
    const normalizedChars = batch.reduce((sum, event) => sum + String(event.text || '').length, 0);
    return {
        ...delta,
        previousState: cloneJson(workingState),
        canonicalEvents: batch,
        sourceMessageIds: batch.map(event => String(event.eventId)),
        nextCursor: cloneJson(workingState.cursor),
        stats: {
            ...(delta.stats && typeof delta.stats === 'object' ? delta.stats : {}),
            sourceMessageCount: batch.length,
            normalizedEventCount: batch.length,
            normalizedChars
        }
    };
}

function assertPlanCoverage(plan, events) {
    const expected = events.map(event => String(event.eventId));
    const covered = plan.batches.flatMap(batch => batch.map(event => String(event.eventId)));
    if (plan.totalEventCount !== expected.length
        || plan.coveredEventCount !== expected.length
        || plan.droppedEventCount !== 0
        || plan.duplicateCoverageCount !== 0
        || covered.some((id, index) => id !== expected[index])) {
        throw orchestrationError('MEMO_V2_BATCH_COVERAGE_MISMATCH', 'planned batches do not cover every canonical event exactly once');
    }
}

function assertPlanDateBoundaries(plan) {
    const batchUniqueDateCounts = plan.batches.map(batch => new Set(batch.map(eventDate)).size);
    const plannedUniqueDateCounts = Array.isArray(plan.batchUniqueDateCounts)
        ? plan.batchUniqueDateCounts
        : [];
    if (plan.dateBoundedBatching !== true
        || plan.mixedDateBatchCount !== 0
        || batchUniqueDateCounts.some(count => count !== 1)
        || batchUniqueDateCounts.length !== plannedUniqueDateCounts.length
        || batchUniqueDateCounts.some((count, index) => count !== plannedUniqueDateCounts[index])) {
        throw orchestrationError(
            'MEMO_V2_BATCH_DATE_BOUNDARY_MISMATCH',
            'planned batches must contain exactly one trusted outer date each'
        );
    }
}

function assertBatchPromptCoverage(prompt, batch) {
    const expected = batch.map(event => String(event.eventId));
    const actual = Array.isArray(prompt?.includedEventIds) ? prompt.includedEventIds.map(String) : [];
    if (prompt?.stats?.inputEventCount !== expected.length
        || prompt?.stats?.includedEventCount !== expected.length
        || prompt?.stats?.currentEventIdCount !== expected.length
        || prompt?.stats?.droppedEventCount !== 0
        || actual.length !== expected.length
        || actual.some((id, index) => id !== expected[index])) {
        throw orchestrationError('MEMO_V2_PROMPT_COVERAGE_MISMATCH', 'reduction prompt does not contain the complete planned batch');
    }
}

function assertReductionReferencesCurrent(reduction, batch) {
    const currentIds = new Set(batch.map(event => String(event.eventId)));
    const sources = [
        ...(Array.isArray(reduction?.facts) ? reduction.facts : []),
        ...(Array.isArray(reduction?.threadUpdates) ? reduction.threadUpdates : [])
    ].flatMap(item => Array.isArray(item?.sourceMessageIds) ? item.sourceMessageIds.map(String) : []);
    if (sources.length > 0 && !sources.some(id => currentIds.has(id))) {
        throw orchestrationError('MEMO_V2_REDUCTION_REQUIRES_CURRENT_SOURCE', 'reduction must reference a current batch event');
    }
}

function aggregatePromptStats(plan, events, executedStats = null) {
    const batchPromptChars = Array.isArray(executedStats?.batchPromptChars)
        && executedStats.batchPromptChars.length === plan.batches.length
        ? executedStats.batchPromptChars
        : plan.batchPromptChars;
    const batchContractEventIdCounts = Array.isArray(executedStats?.batchContractEventIdCounts)
        && executedStats.batchContractEventIdCounts.length === plan.batches.length
        ? executedStats.batchContractEventIdCounts
        : plan.batchContractEventIdCounts || [];
    const batchContractThreadIdCounts = Array.isArray(executedStats?.batchContractThreadIdCounts)
        && executedStats.batchContractThreadIdCounts.length === plan.batches.length
        ? executedStats.batchContractThreadIdCounts
        : plan.batchContractThreadIdCounts || [];
    const batchContractActorNameCounts = Array.isArray(executedStats?.batchContractActorNameCounts)
        && executedStats.batchContractActorNameCounts.length === plan.batches.length
        ? executedStats.batchContractActorNameCounts
        : plan.batchContractActorNameCounts || [];
    const batchToolSchemaChars = Array.isArray(executedStats?.batchToolSchemaChars)
        && executedStats.batchToolSchemaChars.length === plan.batches.length
        ? executedStats.batchToolSchemaChars
        : plan.batchToolSchemaChars || [];
    const batchProjectedEventCounts = Array.isArray(executedStats?.batchProjectedEventCounts)
        && executedStats.batchProjectedEventCounts.length === plan.batches.length
        ? executedStats.batchProjectedEventCounts
        : plan.batchProjectedEventCounts || [];
    const batchProjectionRemovedChars = Array.isArray(executedStats?.batchProjectionRemovedChars)
        && executedStats.batchProjectionRemovedChars.length === plan.batches.length
        ? executedStats.batchProjectionRemovedChars
        : plan.batchProjectionRemovedChars || [];
    const batchPromptSanitizedEventCounts = Array.isArray(executedStats?.batchPromptSanitizedEventCounts)
        && executedStats.batchPromptSanitizedEventCounts.length === plan.batches.length
        ? executedStats.batchPromptSanitizedEventCounts
        : plan.batchPromptSanitizedEventCounts || [];
    const batchPromptRedactionPlaceholderCounts = Array.isArray(executedStats?.batchPromptRedactionPlaceholderCounts)
        && executedStats.batchPromptRedactionPlaceholderCounts.length === plan.batches.length
        ? executedStats.batchPromptRedactionPlaceholderCounts
        : plan.batchPromptRedactionPlaceholderCounts || [];
    const batchPromptSanitizationRemovedChars = Array.isArray(executedStats?.batchPromptSanitizationRemovedChars)
        && executedStats.batchPromptSanitizationRemovedChars.length === plan.batches.length
        ? executedStats.batchPromptSanitizationRemovedChars
        : plan.batchPromptSanitizationRemovedChars || [];
    return {
        totalRequestChars: batchPromptChars.reduce((sum, chars) => sum + Number(chars || 0), 0),
        toolSchemaChars: batchToolSchemaChars.reduce((sum, chars) => sum + Number(chars || 0), 0),
        maxInputChars: plan.maxPromptChars,
        requestBudgetChars: plan.maxPromptChars,
        wireContractVersion: WIRE_CONTRACT_VERSION,
        inputEventCount: events.length,
        includedEventCount: plan.coveredEventCount,
        droppedEventCount: 0,
        dateBoundedBatching: plan.dateBoundedBatching === true,
        contiguousDateSegmentCount: Number(plan.contiguousDateSegmentCount) || 0,
        dateBoundarySplitCount: Number(plan.dateBoundarySplitCount) || 0,
        batchUniqueDateCounts: (plan.batchUniqueDateCounts || []).slice(),
        mixedDateBatchCount: Number(plan.mixedDateBatchCount) || 0,
        formatAttempt: 0,
        plannedBatchCount: plan.batches.length,
        batchPromptChars: batchPromptChars.slice(),
        batchToolSchemaChars: batchToolSchemaChars.slice(),
        batchContractEventIdCounts: batchContractEventIdCounts.slice(),
        batchContractThreadIdCounts: batchContractThreadIdCounts.slice(),
        batchContractActorNameCounts: batchContractActorNameCounts.slice(),
        eventTextCapChars: plan.eventTextCapChars ?? DEFAULT_PROMPT_EVENT_TEXT_CHARS,
        projectedEventCount: batchProjectedEventCounts.reduce((sum, count) => sum + Number(count || 0), 0),
        projectionRemovedChars: batchProjectionRemovedChars.reduce((sum, count) => sum + Number(count || 0), 0),
        batchProjectedEventCounts: batchProjectedEventCounts.slice(),
        batchProjectionRemovedChars: batchProjectionRemovedChars.slice(),
        promptSanitizedEventCount: batchPromptSanitizedEventCounts.reduce((sum, count) => sum + Number(count || 0), 0),
        promptRedactionPlaceholderCount: batchPromptRedactionPlaceholderCounts.reduce((sum, count) => sum + Number(count || 0), 0),
        promptSanitizationRemovedChars: batchPromptSanitizationRemovedChars.reduce((sum, count) => sum + Number(count || 0), 0),
        batchPromptSanitizedEventCounts: batchPromptSanitizedEventCounts.slice(),
        batchPromptRedactionPlaceholderCounts: batchPromptRedactionPlaceholderCounts.slice(),
        batchPromptSanitizationRemovedChars: batchPromptSanitizationRemovedChars.slice()
    };
}

async function generateShadowCandidate(options = {}) {
    const formatRetries = normalizeFormatRetries(options.formatRetries);
    const formatAttemptsAllowed = formatRetries + 1;
    const agentName = validateAgentName(options.agentName || options.delta?.agentName);
    let delta;
    let previousState;
    let activeBatchIndex = null;
    let activeFormatAttempt = null;
    let batchCount = 0;
    let eventTextCapChars = DEFAULT_PROMPT_EVENT_TEXT_CHARS;
    let stats = createStats(null, formatRetries, eventTextCapChars);
    stats.requestBudgetChars = Number(options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS);
    try {
        eventTextCapChars = normalizePromptEventTextCap(options.eventTextCapChars);
        delta = buildDelta({ ...options, agentName });
        previousState = options.previousState !== undefined
            ? options.previousState || createDefaultState(agentName)
            : delta.previousState || readPrevious({ ...options, agentName });
        stats = createStats(delta, formatRetries, eventTextCapChars);
        stats.requestBudgetChars = Number(options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS);
        const events = Array.isArray(delta.canonicalEvents) ? delta.canonicalEvents : [];
        if (events.length === 0) {
            return {
                ok: true,
                noOp: true,
                reason: 'MEMO_V2_NO_DELTA',
                agentName,
                stats,
                deltaStats: stats,
                state: cloneJson(previousState),
                candidateWritten: false,
                cursorAdvanced: false
            };
        }

        const plan = planMemoV2Batches({
            canonicalEvents: events,
            previousState,
            maxInputChars: options.maxInputChars,
            eventTextCapChars,
            formatAttempt: formatRetries > 0 ? 1 : 0
        });
        assertPlanCoverage(plan, events);
        assertPlanDateBoundaries(plan);
        batchCount = plan.batches.length;
        stats.plannedBatchCount = batchCount;
        stats.coveredCanonicalEventCount = plan.coveredEventCount;
        stats.droppedCanonicalEventCount = plan.droppedEventCount;
        stats.duplicateCoverageCount = plan.duplicateCoverageCount;
        stats.batchEventCounts = plan.batchEventCounts.slice();
        stats.dateBoundedBatching = plan.dateBoundedBatching === true;
        stats.contiguousDateSegmentCount = Number(plan.contiguousDateSegmentCount) || 0;
        stats.dateBoundarySplitCount = Number(plan.dateBoundarySplitCount) || 0;
        stats.batchUniqueDateCounts = (plan.batchUniqueDateCounts || []).slice();
        stats.mixedDateBatchCount = Number(plan.mixedDateBatchCount) || 0;
        stats.batchFormatAttempts = Array(batchCount).fill(0);
        stats.batchToolCallAttempts = Array(batchCount).fill(0);
        stats.batchToolSchemaChars = (plan.batchToolSchemaChars || []).slice();
        stats.batchContractEventIdCounts = (plan.batchContractEventIdCounts || []).slice();
        stats.batchContractThreadIdCounts = (plan.batchContractThreadIdCounts || []).slice();
        stats.batchContractActorNameCounts = (plan.batchContractActorNameCounts || []).slice();
        stats.eventTextCapChars = plan.eventTextCapChars ?? eventTextCapChars;
        stats.batchProjectedEventCounts = (plan.batchProjectedEventCounts || []).slice();
        stats.batchProjectionRemovedChars = (plan.batchProjectionRemovedChars || []).slice();
        stats.projectedEventCount = Number(plan.totalProjectedEventCount || 0);
        stats.projectionRemovedChars = Number(plan.totalProjectionRemovedChars || 0);
        stats.batchPromptSanitizedEventCounts = (plan.batchPromptSanitizedEventCounts || []).slice();
        stats.batchPromptRedactionPlaceholderCounts = (plan.batchPromptRedactionPlaceholderCounts || []).slice();
        stats.batchPromptSanitizationRemovedChars = (plan.batchPromptSanitizationRemovedChars || []).slice();
        stats.promptSanitizedEventCount = Number(plan.totalPromptSanitizedEventCount || 0);
        stats.promptRedactionPlaceholderCount = Number(plan.totalPromptRedactionPlaceholderCount || 0);
        stats.promptSanitizationRemovedChars = Number(plan.totalPromptSanitizationRemovedChars || 0);
        stats.estimatedPromptChars = plan.estimatedPromptChars;
        stats.maxPromptChars = plan.maxPromptChars;

        if (!options.modelClient || (typeof options.modelClient.complete !== 'function' && typeof options.modelClient.request !== 'function')) {
            throw orchestrationError('MEMO_V2_MODEL_CLIENT_REQUIRED', 'modelClient must be injected for shadow generation');
        }
        if (!String(options.model || '').trim()) throw orchestrationError('MEMO_V2_MODEL_REQUIRED', 'model is required for shadow generation');
        const complete = typeof options.modelClient.complete === 'function'
            ? options.modelClient.complete.bind(options.modelClient)
            : options.modelClient.request.bind(options.modelClient);
        let workingState = cloneJson(previousState);
        for (let index = 0; index < plan.batches.length; index++) {
            activeBatchIndex = index;
            const batch = plan.batches[index];
            const currentDelta = batchDelta(delta, batch, workingState);
            let reduction = null;
            let previousValidationCode = null;
            for (let formatAttempt = 0; formatAttempt < formatAttemptsAllowed; formatAttempt++) {
                activeFormatAttempt = formatAttempt;
                stats.batchFormatAttempts[index] = formatAttempt + 1;
                const prompt = buildReductionPrompt({
                    canonicalEvents: batch,
                    previousState: workingState,
                    maxInputChars: options.maxInputChars,
                    eventTextCapChars,
                    formatAttempt,
                    previousValidationCode
                });
                assertBatchPromptCoverage(prompt, batch);
                stats.batchPromptChars[index] = prompt.stats.totalRequestChars;
                stats.batchToolSchemaChars[index] = prompt.stats.toolSchemaChars;
                stats.batchContractEventIdCounts[index] = prompt.stats.currentEventIdCount;
                stats.batchContractThreadIdCounts[index] = prompt.stats.existingThreadIdCount;
                stats.batchContractActorNameCounts[index] = prompt.stats.currentActorNameCount;
                stats.batchPromptSanitizedEventCounts[index] = prompt.stats.promptSanitizedEventCount;
                stats.batchPromptRedactionPlaceholderCounts[index] = prompt.stats.promptRedactionPlaceholderCount;
                stats.batchPromptSanitizationRemovedChars[index] = prompt.stats.promptSanitizationRemovedChars;
                stats.modelCallCount += 1;
                stats.batchToolCallAttempts[index] += 1;
                let response;
                try {
                    response = await complete({
                        model: String(options.model || '').trim(),
                        messages: prompt.messages,
                        tools: prompt.tools,
                        toolChoice: prompt.toolChoice,
                        parallelToolCalls: prompt.parallelToolCalls,
                        retryGenericInvalidRequest: true,
                        maxTokens: options.maxTokens == null ? DEFAULT_MAX_TOKENS : options.maxTokens,
                        temperature: options.temperature == null ? 0 : options.temperature,
                        signal: options.signal
                    });
                } catch (error) {
                    addTransportErrorMeta(stats, error);
                    throw error;
                }
                const meta = addModelMeta(stats, response);
                try {
                    if (/^length$/iu.test(meta.finishReason || '')) {
                        throw orchestrationError('MEMO_V2_MODEL_TRUNCATED', 'model output was truncated');
                    }
                    if (/content_filter|safety|blocked/iu.test(meta.finishReason || '')) {
                        throw orchestrationError('MEMO_V2_MODEL_SAFETY_BLOCKED', 'model output was blocked by safety policy');
                    }
                    if (typeof response?.content === 'string' && response.content.trim()) {
                        stats.normalContentIgnoredCount += 1;
                    }
                    const wirePayload = decodeReductionToolArguments(response);
                    reduction = validateReductionResponseForDelta({
                        wirePayload,
                        delta: currentDelta,
                        previousState: workingState,
                        allowedThreadIds: prompt.validationContract?.existingThreadIds,
                        allowedActorNames: prompt.validationContract?.currentActorNames
                    });
                    assertReductionReferencesCurrent(reduction, batch);
                    stats.validToolCallCount += 1;
                } catch (error) {
                    if (!isFormatRetryable(error)) throw error;
                    const code = String(error.code);
                    stats.formatFailureCodes.push(code);
                    stats.toolCallFailureCodes.push(shortFailureCode(code));
                    stats.toolCallRetryCount += 1;
                    if (formatAttempt + 1 >= formatAttemptsAllowed) throw error;
                    stats.formatRetryCount += 1;
                    previousValidationCode = code;
                }
                if (reduction) break;
            }
            workingState = applyReductionToWorkingState({
                delta: currentDelta,
                previousState: workingState,
                reduction,
                clock: options.clock ?? options.now,
                retentionDays: options.retentionDays,
                maxTimelineFacts: options.maxTimelineFacts,
                maxThreadHistory: options.maxThreadHistory
            });
            stats.processedBatchCount += 1;
            activeFormatAttempt = null;
        }
        activeBatchIndex = null;
        if (stats.processedBatchCount !== stats.plannedBatchCount
            || stats.coveredCanonicalEventCount !== stats.totalCanonicalEventCount
            || stats.droppedCanonicalEventCount !== 0
            || stats.duplicateCoverageCount !== 0) {
            throw orchestrationError('MEMO_V2_BATCH_COVERAGE_MISMATCH', 'not all planned batches completed');
        }
        stats.estimatedPromptChars = stats.batchPromptChars.reduce((sum, chars) => sum + Number(chars || 0), 0);

        const state = finalizeWorkingState({
            delta,
            workingState,
            clock: options.clock ?? options.now
        });
        assertNoWireTokenLeak(state);
        const rendered = renderMemo(state, { charBudget: options.renderCharBudget });
        const renderedMemo = validateRenderedText(rendered.text);
        assertNoWireTokenLeak(renderedMemo);
        state.renderedMemo = renderedMemo;
        stats.outputChars = rendered.stats.chars;
        state.stats = { ...(state.stats || {}), shadow: cloneJson(stats) };
        if (state.cursor?.lastMessageId !== delta.nextCursor?.lastMessageId
            || state.cursor?.snapshotDbMaxId !== delta.nextCursor?.snapshotDbMaxId) {
            throw orchestrationError('MEMO_V2_CURSOR_MISMATCH', 'final candidate cursor does not match the complete delta');
        }
        let candidateWritten = false;
        if (options.writeCandidate === true) {
            if (!options.store || typeof options.store.writeCandidate !== 'function') {
                throw orchestrationError('MEMO_V2_STORE_REQUIRED', 'store is required to write a candidate');
            }
            options.store.writeCandidate(agentName, state);
            candidateWritten = true;
        }
        return {
            ok: true,
            noOp: false,
            agentName,
            state,
            rendered,
            candidateWritten,
            cursorAdvanced: true,
            stats,
            promptStats: aggregatePromptStats(plan, events, stats)
        };
    } catch (error) {
        if (String(error?.code || '') === 'MEMO_V2_PROMPT_PROJECTION_REQUIRED_SEGMENT_LOST') {
            stats.projectionRequiredSegmentFailures = 1;
        }
        return {
            ok: false,
            noOp: false,
            agentName,
            error: safeFailure(error, activeBatchIndex, batchCount, {
                formatAttempt: activeFormatAttempt,
                formatAttemptsAllowed
            }),
            stats,
            previousState: cloneJson(previousState || options.previousState || null),
            cursorAdvanced: false,
            candidateWritten: false
        };
    }
}

module.exports = {
    prepareReductionRequest,
    validateReductionResponse: validateReductionResponseForDelta,
    buildCandidateState,
    generateShadowCandidate,
    orchestrationError,
    normalizeFormatRetries,
    DEFAULT_FORMAT_RETRIES,
    DEFAULT_MAX_TOKENS
};
