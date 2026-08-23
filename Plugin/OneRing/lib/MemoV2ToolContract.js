'use strict';

const {
    MAX_FACTS,
    MAX_THREAD_UPDATES,
    MAX_SOURCE_IDS_PER_ITEM,
    MAX_FACT_TEXT_CHARS,
    MAX_TASK_CHARS,
    MAX_CONSTRAINTS,
    MAX_CONSTRAINT_CHARS,
    STATUSES,
    parseStrictJson
} = require('./MemoV2Reducer.js');
const {
    WIRE_CONTRACT_VERSION,
    NEW_THREAD_WIRE_TOKEN,
    NO_ASSIGNEE_WIRE_TOKEN
} = require('./MemoV2WireTokens.js');

const REDUCTION_TOOL_NAME = 'submit_memo_reduction';

function toolContractError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function stableAllowlist(values, name, required) {
    if (!Array.isArray(values)) {
        throw toolContractError('MEMO_V2_TOOL_ALLOWLIST_INVALID', `${name} must be an array`);
    }
    const result = [];
    const seen = new Set();
    for (const value of values) {
        if (typeof value !== 'string' && typeof value !== 'number') {
            throw toolContractError('MEMO_V2_TOOL_ALLOWLIST_INVALID', `${name} must contain strings or numbers`);
        }
        const item = String(value).trim();
        if (!item) {
            throw toolContractError('MEMO_V2_TOOL_ALLOWLIST_INVALID', `${name} must not contain empty values`);
        }
        if (!seen.has(item)) {
            seen.add(item);
            result.push(item);
        }
    }
    if (result.some(item => item === NEW_THREAD_WIRE_TOKEN || item === NO_ASSIGNEE_WIRE_TOKEN)) {
        throw toolContractError(
            'MEMO_V2_TOOL_RESERVED_TOKEN_COLLISION',
            `${name} contains a reserved wire token`
        );
    }
    if (required && result.length === 0) {
        throw toolContractError('MEMO_V2_TOOL_ALLOWLIST_EMPTY', `${name} must not be empty`);
    }
    return result;
}

function enumStringWithSentinel(sentinel, values) {
    return {
        type: 'string',
        enum: [sentinel, ...values]
    };
}

function sourceMessageIdsSchema(currentEventIds) {
    return {
        type: 'array',
        minItems: 1,
        maxItems: MAX_SOURCE_IDS_PER_ITEM,
        uniqueItems: true,
        items: {
            type: 'string',
            enum: currentEventIds
        }
    };
}

function buildReductionToolContract(options = {}) {
    const currentEventIds = stableAllowlist(options.currentEventIds, 'currentEventIds', true);
    const existingThreadIds = stableAllowlist(options.existingThreadIds || [], 'existingThreadIds', false);
    const currentActorNames = stableAllowlist(options.currentActorNames || [], 'currentActorNames', false);
    const sourceIds = sourceMessageIdsSchema(currentEventIds);
    const parameters = {
        type: 'object',
        additionalProperties: false,
        required: ['facts', 'threadUpdates'],
        properties: {
            facts: {
                type: 'array',
                maxItems: MAX_FACTS,
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['text', 'sourceMessageIds'],
                    properties: {
                        text: { type: 'string', minLength: 1, maxLength: MAX_FACT_TEXT_CHARS },
                        sourceMessageIds: sourceIds
                    }
                }
            },
            threadUpdates: {
                type: 'array',
                maxItems: MAX_THREAD_UPDATES,
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['threadId', 'task', 'status', 'constraints', 'assignedBy', 'sourceMessageIds'],
                    properties: {
                        threadId: enumStringWithSentinel(NEW_THREAD_WIRE_TOKEN, existingThreadIds),
                        task: { type: 'string', minLength: 1, maxLength: MAX_TASK_CHARS },
                        status: { type: 'string', enum: [...STATUSES] },
                        constraints: {
                            type: 'array',
                            maxItems: MAX_CONSTRAINTS,
                            items: { type: 'string', minLength: 1, maxLength: MAX_CONSTRAINT_CHARS }
                        },
                        assignedBy: enumStringWithSentinel(NO_ASSIGNEE_WIRE_TOKEN, currentActorNames),
                        sourceMessageIds: sourceIds
                    }
                }
            }
        }
    };
    return {
        tools: [{
            type: 'function',
            function: {
                name: REDUCTION_TOOL_NAME,
                description: 'Submit the validated memo reduction for the current canonical event batch.',
                parameters
            }
        }],
        toolChoice: {
            type: 'function',
            function: { name: REDUCTION_TOOL_NAME }
        },
        parallelToolCalls: false
    };
}

function extractReductionToolArguments(response) {
    const toolCalls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
    if (toolCalls.length === 0) {
        throw toolContractError('MEMO_V2_TOOL_CALL_MISSING', 'required reduction tool call is missing');
    }
    if (toolCalls.length !== 1) {
        throw toolContractError('MEMO_V2_TOOL_CALL_MULTIPLE', 'exactly one reduction tool call is required');
    }
    const toolCall = toolCalls[0];
    if (!toolCall || toolCall.type !== 'function') {
        throw toolContractError('MEMO_V2_TOOL_CALL_WRONG_TYPE', 'reduction tool call must be a function call');
    }
    const functionCall = toolCall.function;
    if (!functionCall || typeof functionCall !== 'object' || functionCall.name !== REDUCTION_TOOL_NAME) {
        throw toolContractError('MEMO_V2_TOOL_CALL_WRONG_NAME', 'reduction tool call name is not allowed');
    }
    if (typeof functionCall.arguments !== 'string' || !functionCall.arguments.trim()) {
        throw toolContractError('MEMO_V2_TOOL_ARGUMENTS_MISSING', 'reduction tool call arguments are required');
    }
    parseStrictJson(functionCall.arguments);
    return functionCall.arguments.trim();
}

function decodeReductionWirePayload(value) {
    const parsed = typeof value === 'string' ? parseStrictJson(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
    if (!Array.isArray(parsed.threadUpdates)) return { ...parsed };
    return {
        ...parsed,
        threadUpdates: parsed.threadUpdates.map(update => {
            if (!update || typeof update !== 'object' || Array.isArray(update)) return update;
            const decoded = { ...update };
            if (decoded.threadId === NEW_THREAD_WIRE_TOKEN) decoded.threadId = null;
            if (decoded.assignedBy === NO_ASSIGNEE_WIRE_TOKEN) decoded.assignedBy = null;
            return decoded;
        })
    };
}

function decodeReductionToolArguments(response) {
    return decodeReductionWirePayload(extractReductionToolArguments(response));
}

module.exports = {
    WIRE_CONTRACT_VERSION,
    NEW_THREAD_WIRE_TOKEN,
    NO_ASSIGNEE_WIRE_TOKEN,
    REDUCTION_TOOL_NAME,
    buildReductionToolContract,
    extractReductionToolArguments,
    decodeReductionWirePayload,
    decodeReductionToolArguments,
    stableAllowlist
};
