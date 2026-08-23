'use strict';

const {
    DEFAULT_MAX_INPUT_CHARS,
    DEFAULT_PROMPT_EVENT_TEXT_CHARS,
    buildReductionPrompt
} = require('./MemoV2PromptBuilder.js');
const { normalizePromptEventTextCap } = require('./MemoV2PromptProjector.js');
const { eventDate } = require('./MemoV2Reducer.js');

function plannerError(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, details);
    return error;
}

function eventId(event) {
    const value = String(event?.eventId ?? '').trim();
    if (!value) throw plannerError('MEMO_V2_INVALID_EVENT_ID', 'canonical event id is required');
    return value;
}

function promptFor(events, previousState, maxInputChars, eventTextCapChars, formatAttempt = 0, previousValidationCode = null) {
    return buildReductionPrompt({
        canonicalEvents: events,
        previousState,
        maxInputChars,
        eventTextCapChars,
        formatAttempt,
        previousValidationCode
    });
}

function planMemoV2Batches(options = {}) {
    const events = Array.isArray(options.canonicalEvents) ? options.canonicalEvents : [];
    const previousState = options.previousState || {};
    const maxInputChars = Number(options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS);
    const eventTextCapChars = normalizePromptEventTextCap(options.eventTextCapChars ?? DEFAULT_PROMPT_EVENT_TEXT_CHARS);
    const formatAttempt = options.formatAttempt == null ? 0 : Number(options.formatAttempt);
    if (!Number.isSafeInteger(maxInputChars) || maxInputChars < 1) {
        throw plannerError('MEMO_V2_PROMPT_BUDGET_INVALID', 'prompt budget must be a positive integer');
    }

    const allIds = events.map(eventId);
    const seenIds = new Set();
    for (const id of allIds) {
        if (seenIds.has(id)) {
            throw plannerError('MEMO_V2_DUPLICATE_CANONICAL_EVENT', 'canonical event ids must be unique');
        }
        seenIds.add(id);
    }
    const trustedEventDates = events.map(eventDate);
    let contiguousDateSegmentCount = 0;
    let dateBoundarySplitCount = 0;
    trustedEventDates.forEach((date, index) => {
        if (index === 0) {
            contiguousDateSegmentCount = 1;
        } else if (date !== trustedEventDates[index - 1]) {
            contiguousDateSegmentCount += 1;
            dateBoundarySplitCount += 1;
        }
    });

    const batches = [];
    const batchPromptChars = [];
    const batchToolSchemaChars = [];
    const batchPromptStats = [];
    const batchUniqueDateCounts = [];
    let currentBatch = [];
    let currentPromptChars = 0;
    let currentPromptStats = null;
    let currentBatchDate = null;

    const appendBatch = () => {
        if (!currentBatch.length) return;
        batches.push(currentBatch);
        batchPromptChars.push(currentPromptChars);
        batchToolSchemaChars.push(Number(currentPromptStats?.toolSchemaChars) || 0);
        batchPromptStats.push(currentPromptStats);
        batchUniqueDateCounts.push(new Set(currentBatch.map(eventDate)).size);
        currentBatch = [];
        currentPromptChars = 0;
        currentPromptStats = null;
        currentBatchDate = null;
    };

    const planningValidationCode = formatAttempt > 0 ? 'MEMO_V2_INVALID_MODEL_RESPONSE' : null;
    const tryPrompt = candidate => promptFor(
        candidate,
        previousState,
        maxInputChars,
        eventTextCapChars,
        formatAttempt,
        planningValidationCode
    );

    for (const [index, event] of events.entries()) {
        const trustedDate = trustedEventDates[index];
        if (currentBatch.length && currentBatchDate !== trustedDate) appendBatch();
        const candidate = [...currentBatch, event];
        try {
            const prompt = tryPrompt(candidate);
            currentBatch = candidate;
            currentBatchDate = trustedDate;
            currentPromptChars = prompt.stats.totalRequestChars;
            currentPromptStats = prompt.stats;
            continue;
        } catch (error) {
            if (error?.code !== 'MEMO_V2_PROMPT_BUDGET_EXCEEDED') throw error;
            if (!currentBatch.length) {
                throw plannerError(
                    'MEMO_V2_EVENT_EXCEEDS_PROMPT_BUDGET',
                    'one canonical event cannot fit the minimum legal prompt',
                    { eventId: eventId(event) }
                );
            }
        }

        appendBatch();
        try {
            const prompt = tryPrompt([event]);
            currentBatch = [event];
            currentBatchDate = trustedDate;
            currentPromptChars = prompt.stats.totalRequestChars;
            currentPromptStats = prompt.stats;
        } catch (error) {
            if (error?.code === 'MEMO_V2_PROMPT_BUDGET_EXCEEDED') {
                throw plannerError(
                    'MEMO_V2_EVENT_EXCEEDS_PROMPT_BUDGET',
                    'one canonical event cannot fit the minimum legal prompt',
                    { eventId: eventId(event) }
                );
            }
            throw error;
        }
    }
    appendBatch();

    const coveredIds = batches.flatMap(batch => batch.map(eventId));
    const coveredSet = new Set(coveredIds);
    const duplicateCoverageCount = coveredIds.length - coveredSet.size;
    const droppedEventCount = allIds.filter(id => !coveredSet.has(id)).length;
    const mixedDateBatchCount = batchUniqueDateCounts.filter(count => count !== 1).length;
    if (coveredIds.length !== allIds.length || droppedEventCount !== 0 || duplicateCoverageCount !== 0
        || coveredIds.some((id, index) => id !== allIds[index]) || mixedDateBatchCount !== 0) {
        throw plannerError('MEMO_V2_BATCH_COVERAGE_MISMATCH', 'planned batches do not exactly cover canonical events');
    }

    return {
        batches,
        batchIds: batches.map(batch => batch.map(eventId)),
        plannedBatchCount: batches.length,
        totalEventCount: events.length,
        coveredEventCount: coveredIds.length,
        droppedEventCount: 0,
        duplicateCoverageCount: 0,
        batchEventCounts: batches.map(batch => batch.length),
        dateBoundedBatching: true,
        contiguousDateSegmentCount,
        dateBoundarySplitCount,
        batchUniqueDateCounts,
        mixedDateBatchCount,
        batchPromptChars,
        batchToolSchemaChars,
        batchContractEventIdCounts: batchPromptStats.map(stats => stats?.currentEventIdCount || 0),
        batchContractThreadIdCounts: batchPromptStats.map(stats => stats?.existingThreadIdCount || 0),
        batchContractActorNameCounts: batchPromptStats.map(stats => stats?.currentActorNameCount || 0),
        eventTextCapChars: batchPromptStats[0]?.eventTextCapChars ?? eventTextCapChars,
        batchProjectedEventCounts: batchPromptStats.map(stats => stats?.projectedEventCount || 0),
        batchProjectionRemovedChars: batchPromptStats.map(stats => stats?.projectionRemovedChars || 0),
        totalProjectedEventCount: batchPromptStats.reduce((sum, stats) => sum + Number(stats?.projectedEventCount || 0), 0),
        totalProjectionRemovedChars: batchPromptStats.reduce((sum, stats) => sum + Number(stats?.projectionRemovedChars || 0), 0),
        batchPromptSanitizedEventCounts: batchPromptStats.map(stats => stats?.promptSanitizedEventCount || 0),
        batchPromptRedactionPlaceholderCounts: batchPromptStats.map(stats => stats?.promptRedactionPlaceholderCount || 0),
        batchPromptSanitizationRemovedChars: batchPromptStats.map(stats => stats?.promptSanitizationRemovedChars || 0),
        totalPromptSanitizedEventCount: batchPromptStats.reduce((sum, stats) => sum + Number(stats?.promptSanitizedEventCount || 0), 0),
        totalPromptRedactionPlaceholderCount: batchPromptStats.reduce((sum, stats) => sum + Number(stats?.promptRedactionPlaceholderCount || 0), 0),
        totalPromptSanitizationRemovedChars: batchPromptStats.reduce((sum, stats) => sum + Number(stats?.promptSanitizationRemovedChars || 0), 0),
        estimatedPromptChars: batchPromptChars.reduce((sum, chars) => sum + chars, 0),
        maxPromptChars: maxInputChars,
        requestBudgetChars: maxInputChars,
        formatAttempt
    };
}

module.exports = {
    planMemoV2Batches,
    plannerError
};
