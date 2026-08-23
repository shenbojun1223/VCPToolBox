'use strict';

const path = require('path');
const { buildCandidateInput, validateAgentName } = require('../OneRingMemoV2.js');
const { MemoV2Store, safeAgentFileName } = require('../lib/MemoV2Store.js');
const { InternalModelClient } = require('../lib/InternalModelClient.js');
const { planMemoV2Batches } = require('../lib/MemoV2BatchPlanner.js');
const { DEFAULT_MAX_INPUT_CHARS } = require('../lib/MemoV2PromptBuilder.js');
const {
    DEFAULT_PROMPT_EVENT_TEXT_CHARS,
    normalizePromptEventTextCap
} = require('../lib/MemoV2PromptProjector.js');
const { WIRE_CONTRACT_VERSION } = require('../lib/MemoV2ToolContract.js');
const {
    generateShadowCandidate,
    DEFAULT_FORMAT_RETRIES
} = require('../lib/MemoV2Orchestrator.js');

function projectRoot() {
    return path.resolve(__dirname, '..', '..', '..');
}

function usage() {
    return [
        'Usage: node Plugin/OneRing/scripts/memo-v2-shadow-candidate.js --agent <name> [--timeline-days <n>] [--fallback-count <n>] [--max-input-chars <n>] [--event-text-cap-chars <n>] [--format-retries 0..3] [--request-metrics]',
        `Default event text cap: ${DEFAULT_PROMPT_EVENT_TEXT_CHARS} characters; --event-text-cap-chars is an explicit override.`,
        'Model calls require --call-model --write-candidate --model <name>; credentials come only from process environment.'
    ].join('\n');
}

function parsePositive(value, name) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`);
    return number;
}

function parseFormatRetries(value, name = '--format-retries') {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0 || number > 3) {
        throw new Error(`${name} must be an integer from 0 to 3`);
    }
    return number;
}

function parseArgs(argv) {
    const options = {
        requestMetrics: false,
        callModel: false,
        writeCandidate: false,
        formatRetries: DEFAULT_FORMAT_RETRIES,
        eventTextCapChars: DEFAULT_PROMPT_EVENT_TEXT_CHARS
    };
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--help' || argument === '-h') return { help: true };
        const equalsIndex = argument.indexOf('=');
        const name = equalsIndex >= 0 ? argument.slice(0, equalsIndex) : argument;
        const inlineValue = equalsIndex >= 0 ? argument.slice(equalsIndex + 1) : null;
        if (name === '--request-metrics') {
            if (inlineValue != null) throw new Error('--request-metrics does not take a value');
            options.requestMetrics = true;
            continue;
        }
        if (name === '--call-model') {
            if (inlineValue != null) throw new Error('--call-model does not take a value');
            options.callModel = true;
            continue;
        }
        if (name === '--write-candidate') {
            if (inlineValue != null) throw new Error('--write-candidate does not take a value');
            options.writeCandidate = true;
            continue;
        }
        if (!['--agent', '--timeline-days', '--fallback-count', '--max-input-chars', '--event-text-cap-chars', '--format-retries', '--model'].includes(name)) {
            throw new Error(`Unknown argument: ${name}`);
        }
        const value = inlineValue == null ? argv[++index] : inlineValue;
        if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
        if (name === '--agent') options.agentName = validateAgentName(value);
        if (name === '--timeline-days') options.timelineDays = parsePositive(value, name);
        if (name === '--fallback-count') options.fallbackCount = parsePositive(value, name);
        if (name === '--max-input-chars') options.maxInputChars = parsePositive(value, name);
        if (name === '--event-text-cap-chars') options.eventTextCapChars = normalizePromptEventTextCap(value);
        if (name === '--format-retries') options.formatRetries = parseFormatRetries(value, name);
        if (name === '--model') options.model = String(value).trim();
    }
    if (!options.agentName) throw new Error('--agent is required');
    const explicitFlags = options.callModel || options.writeCandidate || options.model;
    if (explicitFlags && !(options.callModel && options.writeCandidate && options.model)) {
        throw new Error('--call-model, --write-candidate and --model are required together');
    }
    return options;
}

function metricsFromDelta(delta, requestStats, candidate) {
    const candidateStats = candidate?.stats || {};
    const plannedBatchCount = candidateStats.plannedBatchCount ?? requestStats?.plannedBatchCount ?? 0;
    const totalCanonicalEventCount = candidateStats.totalCanonicalEventCount
        ?? requestStats?.totalEventCount
        ?? (Array.isArray(delta.canonicalEvents) ? delta.canonicalEvents.length : 0);
    const coveredCanonicalEventCount = candidateStats.coveredCanonicalEventCount
        ?? requestStats?.coveredEventCount
        ?? 0;
    const droppedCanonicalEventCount = candidateStats.droppedCanonicalEventCount
        ?? requestStats?.droppedEventCount
        ?? 0;
    const duplicateCoverageCount = candidateStats.duplicateCoverageCount
        ?? requestStats?.duplicateCoverageCount
        ?? 0;
    const dateBoundedBatching = candidateStats.dateBoundedBatching
        ?? requestStats?.dateBoundedBatching
        ?? true;
    const contiguousDateSegmentCount = Number(candidateStats.contiguousDateSegmentCount
        ?? requestStats?.contiguousDateSegmentCount
        ?? 0);
    const dateBoundarySplitCount = Number(candidateStats.dateBoundarySplitCount
        ?? requestStats?.dateBoundarySplitCount
        ?? 0);
    const batchUniqueDateCounts = candidateStats.batchUniqueDateCounts
        || requestStats?.batchUniqueDateCounts
        || [];
    const mixedDateBatchCount = Number(candidateStats.mixedDateBatchCount
        ?? requestStats?.mixedDateBatchCount
        ?? 0);
    const batchEventCounts = candidateStats.batchEventCounts || requestStats?.batchEventCounts || [];
    const batchPromptChars = candidateStats.batchPromptChars || requestStats?.batchPromptChars || [];
    const batchContractEventIdCounts = candidateStats.batchContractEventIdCounts
        || requestStats?.batchContractEventIdCounts
        || [];
    const batchContractThreadIdCounts = candidateStats.batchContractThreadIdCounts
        || requestStats?.batchContractThreadIdCounts
        || [];
    const batchContractActorNameCounts = candidateStats.batchContractActorNameCounts
        || requestStats?.batchContractActorNameCounts
        || [];
    const batchToolSchemaChars = candidateStats.batchToolSchemaChars
        || requestStats?.batchToolSchemaChars
        || [];
    const batchProjectedEventCounts = candidateStats.batchProjectedEventCounts
        || requestStats?.batchProjectedEventCounts
        || [];
    const batchProjectionRemovedChars = candidateStats.batchProjectionRemovedChars
        || requestStats?.batchProjectionRemovedChars
        || [];
    const batchPromptSanitizedEventCounts = candidateStats.batchPromptSanitizedEventCounts
        || requestStats?.batchPromptSanitizedEventCounts
        || [];
    const batchPromptRedactionPlaceholderCounts = candidateStats.batchPromptRedactionPlaceholderCounts
        || requestStats?.batchPromptRedactionPlaceholderCounts
        || [];
    const batchPromptSanitizationRemovedChars = candidateStats.batchPromptSanitizationRemovedChars
        || requestStats?.batchPromptSanitizationRemovedChars
        || [];
    const estimatedPromptChars = batchPromptChars.reduce((sum, chars) => sum + Number(chars || 0), 0)
        || requestStats?.estimatedPromptChars
        || requestStats?.totalRequestChars
        || 0;
    const requestBudgetChars = Number(candidateStats.requestBudgetChars
        ?? requestStats?.requestBudgetChars
        ?? candidateStats.maxPromptChars
        ?? requestStats?.maxPromptChars
        ?? DEFAULT_MAX_INPUT_CHARS);
    const eventTextCapChars = Number(candidateStats.eventTextCapChars
        ?? requestStats?.eventTextCapChars
        ?? DEFAULT_PROMPT_EVENT_TEXT_CHARS);
    const totalProjectedEventCount = Number(candidateStats.totalProjectedEventCount
        ?? candidateStats.projectedEventCount
        ?? requestStats?.totalProjectedEventCount
        ?? requestStats?.projectedEventCount
        ?? batchProjectedEventCounts.reduce((sum, count) => sum + Number(count || 0), 0));
    const totalProjectionRemovedChars = Number(candidateStats.totalProjectionRemovedChars
        ?? candidateStats.projectionRemovedChars
        ?? requestStats?.totalProjectionRemovedChars
        ?? requestStats?.projectionRemovedChars
        ?? batchProjectionRemovedChars.reduce((sum, count) => sum + Number(count || 0), 0));
    const totalPromptSanitizedEventCount = Number(candidateStats.totalPromptSanitizedEventCount
        ?? candidateStats.promptSanitizedEventCount
        ?? requestStats?.totalPromptSanitizedEventCount
        ?? requestStats?.promptSanitizedEventCount
        ?? batchPromptSanitizedEventCounts.reduce((sum, count) => sum + Number(count || 0), 0));
    const totalPromptRedactionPlaceholderCount = Number(candidateStats.totalPromptRedactionPlaceholderCount
        ?? candidateStats.promptRedactionPlaceholderCount
        ?? requestStats?.totalPromptRedactionPlaceholderCount
        ?? requestStats?.promptRedactionPlaceholderCount
        ?? batchPromptRedactionPlaceholderCounts.reduce((sum, count) => sum + Number(count || 0), 0));
    const totalPromptSanitizationRemovedChars = Number(candidateStats.totalPromptSanitizationRemovedChars
        ?? candidateStats.promptSanitizationRemovedChars
        ?? requestStats?.totalPromptSanitizationRemovedChars
        ?? requestStats?.promptSanitizationRemovedChars
        ?? batchPromptSanitizationRemovedChars.reduce((sum, count) => sum + Number(count || 0), 0));
    const modelCalled = Boolean(candidate && Number(candidateStats.modelCallCount || candidateStats.attemptsTotal || candidateStats.attempts) > 0);
    const candidateWritten = Boolean(candidate?.candidateWritten);
    return {
        schemaVersion: 2,
        agentName: delta.agentName,
        dbMaxId: delta.snapshotDbMaxId,
        cursor: delta.previousState?.cursor || { lastMessageId: 0, snapshotDbMaxId: 0 },
        nextCursor: delta.nextCursor,
        deltaCount: Array.isArray(delta.canonicalEvents) ? delta.canonicalEvents.length : 0,
        sourceMessageCount: delta.stats?.sourceMessageCount || 0,
        normalizedChars: delta.stats?.normalizedChars || 0,
        plannedBatchCount,
        totalCanonicalEventCount,
        coveredCanonicalEventCount,
        droppedCanonicalEventCount,
        duplicateCoverageCount,
        dateBoundedBatching,
        contiguousDateSegmentCount,
        dateBoundarySplitCount,
        batchUniqueDateCounts,
        mixedDateBatchCount,
        eventTextCapChars,
        totalProjectedEventCount,
        totalProjectionRemovedChars,
        batchProjectedEventCounts,
        batchProjectionRemovedChars,
        totalPromptSanitizedEventCount,
        totalPromptRedactionPlaceholderCount,
        totalPromptSanitizationRemovedChars,
        batchPromptSanitizedEventCounts,
        batchPromptRedactionPlaceholderCounts,
        batchPromptSanitizationRemovedChars,
        projectionRequiredSegmentFailures: Number(candidateStats.projectionRequiredSegmentFailures
            ?? requestStats?.projectionRequiredSegmentFailures
            ?? 0),
        batchEventCounts,
        batchPromptChars,
        batchToolSchemaChars,
        batchContractEventIdCounts,
        batchContractThreadIdCounts,
        batchContractActorNameCounts,
        estimatedPromptChars,
        requestBudgetChars,
        maxPromptChars: candidateStats.maxPromptChars ?? requestStats?.maxPromptChars ?? requestBudgetChars,
        promptChars: estimatedPromptChars,
        promptIncludedEventCount: coveredCanonicalEventCount || requestStats?.includedEventCount || 0,
        promptDroppedEventCount: droppedCanonicalEventCount,
        formatRetriesConfigured: candidateStats.formatRetriesConfigured
            ?? requestStats?.formatRetriesConfigured
            ?? DEFAULT_FORMAT_RETRIES,
        formatRetryCount: Number(candidateStats.formatRetryCount ?? requestStats?.formatRetryCount ?? 0),
        genericInvalidRequestRetryCount: Number(candidateStats.genericInvalidRequestRetryCount
            ?? requestStats?.genericInvalidRequestRetryCount
            ?? 0),
        attemptsTotal: Number(candidateStats.attemptsTotal ?? requestStats?.attemptsTotal ?? 0),
        batchFormatAttempts: candidateStats.batchFormatAttempts || requestStats?.batchFormatAttempts || [],
        modelCallCount: Number(candidateStats.modelCallCount ?? requestStats?.modelCallCount ?? 0),
        processedBatchCount: Number(candidateStats.processedBatchCount ?? requestStats?.processedBatchCount ?? 0),
        structuredChannel: candidateStats.structuredChannel || 'forced_tool_call',
        toolCallRetryCount: Number(candidateStats.toolCallRetryCount ?? requestStats?.toolCallRetryCount ?? 0),
        batchToolCallAttempts: candidateStats.batchToolCallAttempts || requestStats?.batchToolCallAttempts || [],
        wireContractVersion: Number(candidateStats.wireContractVersion
            ?? requestStats?.wireContractVersion
            ?? WIRE_CONTRACT_VERSION),
        model: modelCalled,
        candidate: candidateWritten,
        modelCalled,
        candidateWritten,
        ok: candidate ? Boolean(candidate.ok) : true,
        errorCode: candidate?.error?.code || null
    };
}

function candidateOutputPath(agentName) {
    return path.join(projectRoot(), 'Plugin', 'OneRing', 'memo-v2', `${safeAgentFileName(agentName)}.candidate.json`);
}

function buildModelClient() {
    const baseUrl = process.env.ONERING_INTERNAL_MODEL_BASE_URL;
    const apiKey = process.env.ONERING_INTERNAL_MODEL_API_KEY;
    if (!baseUrl || !apiKey) {
        const error = new Error('model environment is required');
        error.code = 'MEMO_V2_MODEL_ENV_REQUIRED';
        throw error;
    }
    return new InternalModelClient({ baseUrl, apiKey });
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
    const options = parseArgs(argv);
    if (options.help) {
        process.stdout.write(`${usage()}\n`);
        return;
    }
    const store = dependencies.store || new MemoV2Store({
        baseDir: path.join(projectRoot(), 'Plugin', 'OneRing', 'memo-v2')
    });
    const delta = typeof dependencies.buildDelta === 'function'
        ? dependencies.buildDelta({
            agentName: options.agentName,
            projectBasePath: dependencies.projectBasePath || projectRoot(),
            store,
            timelineDays: options.timelineDays,
            fallbackCount: options.fallbackCount
        })
        : buildCandidateInput({
            agentName: options.agentName,
            projectBasePath: dependencies.projectBasePath || projectRoot(),
            store,
            timelineDays: options.timelineDays,
            fallbackCount: options.fallbackCount
        });
    if (!options.callModel) {
        const plan = delta.canonicalEvents.length
            ? planMemoV2Batches({
                canonicalEvents: delta.canonicalEvents,
                previousState: delta.previousState,
                maxInputChars: options.maxInputChars,
                eventTextCapChars: options.eventTextCapChars,
                formatAttempt: options.formatRetries > 0 ? 1 : 0
            })
            : {
                plannedBatchCount: 0,
                totalEventCount: 0,
                coveredEventCount: 0,
                droppedEventCount: 0,
                duplicateCoverageCount: 0,
                batchEventCounts: [],
                dateBoundedBatching: true,
                contiguousDateSegmentCount: 0,
                dateBoundarySplitCount: 0,
                batchUniqueDateCounts: [],
                mixedDateBatchCount: 0,
                batchPromptChars: [],
                estimatedPromptChars: 0,
                requestBudgetChars: options.maxInputChars || DEFAULT_MAX_INPUT_CHARS,
                maxPromptChars: options.maxInputChars || DEFAULT_MAX_INPUT_CHARS,
                eventTextCapChars: options.eventTextCapChars,
                totalProjectedEventCount: 0,
                totalProjectionRemovedChars: 0,
                batchProjectedEventCounts: [],
                batchProjectionRemovedChars: [],
                totalPromptSanitizedEventCount: 0,
                totalPromptRedactionPlaceholderCount: 0,
                totalPromptSanitizationRemovedChars: 0,
                batchPromptSanitizedEventCounts: [],
                batchPromptRedactionPlaceholderCounts: [],
                batchPromptSanitizationRemovedChars: [],
                projectionRequiredSegmentFailures: 0,
                formatAttempt: options.formatRetries > 0 ? 1 : 0,
                formatRetriesConfigured: options.formatRetries,
                formatRetryCount: 0,
                batchFormatAttempts: [],
                modelCallCount: 0,
                processedBatchCount: 0
            };
        if (plan.formatRetriesConfigured == null) plan.formatRetriesConfigured = options.formatRetries;
        process.stdout.write(`${JSON.stringify(metricsFromDelta(delta, plan, null))}\n`);
        return;
    }
    const modelClient = dependencies.modelClient || buildModelClient();
    const candidate = await generateShadowCandidate({
        agentName: options.agentName,
        delta,
        previousState: delta.previousState,
        store,
        modelClient,
        model: options.model,
        maxInputChars: options.maxInputChars,
        eventTextCapChars: options.eventTextCapChars,
        formatRetries: options.formatRetries,
        writeCandidate: true
    });
    process.stdout.write(`${JSON.stringify(metricsFromDelta(delta, candidate.promptStats, candidate))}\n`);
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`memo-v2-shadow-candidate failed: ${error.code || 'ERROR'}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    usage,
    parseArgs,
    metricsFromDelta,
    candidateOutputPath,
    main
};
