'use strict';

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 250;
const MAX_TOOLS = 32;
const MAX_TOOL_SERIALIZED_CHARS = 128000;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const GENERIC_INVALID_REQUEST_CODE = 'INTERNAL_MODEL_HTTP_400_GENERIC_INVALID_REQUEST';

class InternalModelError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'InternalModelError';
        this.code = code;
        Object.assign(this, details);
    }
}

function normalizeBaseUrl(baseUrl) {
    const value = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!value) throw new InternalModelError('INTERNAL_MODEL_INVALID_CONFIG', 'Internal model baseUrl is required');
    return value;
}

function completionUrl(baseUrl) {
    return /\/v1$/i.test(baseUrl) ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
}

function isValidContent(content) {
    if (typeof content === 'string') return content.trim().length > 0;
    if (!Array.isArray(content) || content.length === 0) return false;
    return content.every(part => part && typeof part === 'object' && typeof part.type === 'string');
}

function validateMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        throw new InternalModelError('INTERNAL_MODEL_INVALID_MESSAGES', 'messages must be a non-empty array');
    }
    for (const message of messages) {
        if (!message || typeof message !== 'object' || typeof message.role !== 'string' || !message.role.trim() || !isValidContent(message.content)) {
            throw new InternalModelError('INTERNAL_MODEL_INVALID_MESSAGES', 'each message must have a valid role and content');
        }
    }
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function assertJsonCompatible(value, seen = new WeakSet()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('non-finite number');
        return;
    }
    if (Array.isArray(value)) {
        if (seen.has(value)) throw new Error('cyclic value');
        if (Object.getOwnPropertySymbols(value).length > 0) throw new Error('symbol property');
        seen.add(value);
        for (const item of value) assertJsonCompatible(item, seen);
        seen.delete(value);
        return;
    }
    if (isPlainObject(value)) {
        if (seen.has(value)) throw new Error('cyclic value');
        if (Object.getOwnPropertySymbols(value).length > 0) throw new Error('symbol property');
        seen.add(value);
        for (const key of Object.keys(value)) {
            if (PROTOTYPE_POLLUTION_KEYS.has(key)) throw new Error('prototype pollution key');
            assertJsonCompatible(value[key], seen);
        }
        seen.delete(value);
        return;
    }
    throw new Error('non-json value');
}

function validateResponseFormat(responseFormat) {
    if (!isPlainObject(responseFormat)) {
        throw new InternalModelError('INTERNAL_MODEL_INVALID_RESPONSE_FORMAT', 'responseFormat must be a JSON-compatible plain object');
    }
    try {
        assertJsonCompatible(responseFormat);
        JSON.stringify(responseFormat);
    } catch (_) {
        throw new InternalModelError('INTERNAL_MODEL_INVALID_RESPONSE_FORMAT', 'responseFormat must be a JSON-compatible plain object');
    }
    return responseFormat;
}

function validateToolName(name) {
    return typeof name === 'string' && TOOL_NAME_PATTERN.test(name);
}

function validateTools(tools) {
    if (!Array.isArray(tools) || tools.length > MAX_TOOLS) {
        throw new InternalModelError('INTERNAL_MODEL_INVALID_TOOLS', 'tools must be a bounded array');
    }
    try {
        assertJsonCompatible(tools);
        const serialized = JSON.stringify(tools);
        if (serialized.length > MAX_TOOL_SERIALIZED_CHARS) throw new Error('tools are too large');
        for (const tool of tools) {
            if (!isPlainObject(tool) || tool.type !== 'function' || !isPlainObject(tool.function)) {
                throw new Error('tool must be a function tool');
            }
            if (!validateToolName(tool.function.name) || !isPlainObject(tool.function.parameters)) {
                throw new Error('tool function is invalid');
            }
        }
    } catch (_) {
        throw new InternalModelError('INTERNAL_MODEL_INVALID_TOOLS', 'tools must be safe JSON-compatible function tools');
    }
    return tools;
}

function validateToolChoice(toolChoice, tools) {
    if (toolChoice === 'none' || toolChoice === 'auto' || toolChoice === 'required') return toolChoice;
    if (!isPlainObject(toolChoice)) {
        throw new InternalModelError('INTERNAL_MODEL_INVALID_TOOL_CHOICE', 'toolChoice must be none, auto, required, or a function choice');
    }
    try {
        assertJsonCompatible(toolChoice);
        if (toolChoice.type !== 'function' || !isPlainObject(toolChoice.function)
            || !validateToolName(toolChoice.function.name)) {
            throw new Error('function choice is invalid');
        }
        if (Array.isArray(tools) && tools.length > 0
            && !tools.some(tool => tool.function.name === toolChoice.function.name)) {
            throw new Error('function choice is not present in tools');
        }
    } catch (_) {
        throw new InternalModelError('INTERNAL_MODEL_INVALID_TOOL_CHOICE', 'toolChoice must name an allowed function');
    }
    return toolChoice;
}

function validateParallelToolCalls(value) {
    if (typeof value !== 'boolean') {
        throw new InternalModelError('INTERNAL_MODEL_INVALID_PARALLEL_TOOL_CALLS', 'parallelToolCalls must be boolean');
    }
    return value;
}

function normalizeToolCalls(rawToolCalls) {
    if (!Array.isArray(rawToolCalls)) return [];
    return rawToolCalls
        .filter(call => call && typeof call === 'object' && !Array.isArray(call))
        .map(call => {
            const functionCall = call.function && typeof call.function === 'object' && !Array.isArray(call.function)
                ? call.function
                : {};
            return {
                id: call.id == null ? null : String(call.id),
                type: call.type == null ? null : String(call.type),
                function: {
                    name: functionCall.name == null ? null : String(functionCall.name),
                    arguments: typeof functionCall.arguments === 'string' ? functionCall.arguments : null
                }
            };
        });
}

function responseStatus(response) {
    const status = Number(response?.status);
    return Number.isFinite(status) ? status : 0;
}

async function readResponseBody(response) {
    if (response && typeof response.text === 'function') return response.text();
    if (response && typeof response.json === 'function') return JSON.stringify(await response.json());
    return '';
}

function parseJsonBody(body) {
    try {
        return JSON.parse(String(body || ''));
    } catch (error) {
        throw new InternalModelError('INTERNAL_MODEL_INVALID_JSON', 'Internal model returned invalid JSON');
    }
}

function parseProviderErrorBody(body) {
    let payload;
    try {
        payload = JSON.parse(String(body || ''));
    } catch (_) {
        return null;
    }
    const providerError = payload?.error;
    if (!providerError || typeof providerError !== 'object' || Array.isArray(providerError)) return null;
    return {
        type: typeof providerError.type === 'string' ? providerError.type : null,
        code: providerError.code == null ? null : providerError.code,
        message: typeof providerError.message === 'string' ? providerError.message : null
    };
}

function isGenericInvalidRequest(status, request, providerError) {
    const codeIsEmpty = providerError?.code == null
        || (typeof providerError.code === 'string' && providerError.code.trim() === '');
    return status === 400
        && request.retryGenericInvalidRequest === true
        && providerError?.type === 'invalid_request_error'
        && typeof providerError?.message === 'string'
        && providerError.message.trim() === 'Invalid request'
        && codeIsEmpty;
}

function isRetryableStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
}

function httpErrorCode(status) {
    if (status === 429) return 'INTERNAL_MODEL_HTTP_429';
    if (status >= 500) return 'INTERNAL_MODEL_HTTP_5XX';
    if (status === 408 || status === 425) return 'INTERNAL_MODEL_HTTP_TIMEOUT';
    return 'INTERNAL_MODEL_HTTP_ERROR';
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function toErrorCode(error) {
    if (error && error.name === 'AbortError') return 'INTERNAL_MODEL_ABORTED';
    return 'INTERNAL_MODEL_NETWORK_ERROR';
}

class InternalModelClient {
    constructor(options = {}) {
        this.baseUrl = normalizeBaseUrl(options.baseUrl);
        this.apiKey = String(options.apiKey || '');
        if (!this.apiKey) throw new InternalModelError('INTERNAL_MODEL_INVALID_CONFIG', 'Internal model apiKey is required');
        this.fetchImpl = options.fetchImpl || globalThis.fetch;
        if (typeof this.fetchImpl !== 'function') {
            throw new InternalModelError('INTERNAL_MODEL_INVALID_CONFIG', 'fetch implementation is required');
        }
        this.timeoutMs = Math.max(1, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
        this.retries = Math.max(0, Math.floor(Number(options.retries ?? DEFAULT_RETRIES)));
        this.backoffMs = Math.max(0, Number(options.backoffMs ?? DEFAULT_BACKOFF_MS));
        this.sleepImpl = options.sleepImpl || sleep;
        this.logger = typeof options.logger === 'function' ? options.logger : null;
    }

    log(event) {
        if (!this.logger) return;
        try {
            this.logger({ ...event });
        } catch (_) {
            // Logging must never change the request result.
        }
    }

    async complete(request = {}) {
        const model = String(request.model || '').trim();
        if (!model) throw new InternalModelError('INTERNAL_MODEL_INVALID_REQUEST', 'model is required');
        validateMessages(request.messages);
        const attemptsAllowed = this.retries + 1;
        const body = {
            model,
            stream: false,
            messages: request.messages
        };
        if (request.maxTokens != null) body.max_tokens = Number(request.maxTokens);
        if (request.temperature != null) body.temperature = Number(request.temperature);
        let tools;
        if (request.tools !== undefined) {
            tools = validateTools(request.tools);
            body.tools = tools;
        }
        if (request.toolChoice !== undefined) {
            body.tool_choice = validateToolChoice(request.toolChoice, tools);
        }
        if (request.parallelToolCalls !== undefined) {
            body.parallel_tool_calls = validateParallelToolCalls(request.parallelToolCalls);
        }
        if (request.responseFormat !== undefined) {
            body.response_format = validateResponseFormat(request.responseFormat);
        }

        let lastError = null;
        let genericInvalidRequestRetryCount = 0;
        for (let attempt = 1; attempt <= attemptsAllowed; attempt++) {
            let controller;
            let timeoutId;
            let timedOut = false;
            let removeExternalAbortListener = () => {};
            try {
                controller = new AbortController();
                if (request.signal) {
                    if (request.signal.aborted) {
                        throw new InternalModelError('INTERNAL_MODEL_ABORTED', 'Internal model request was aborted', { attempts: attempt });
                    }
                    const onExternalAbort = () => controller.abort();
                    request.signal.addEventListener('abort', onExternalAbort, { once: true });
                    removeExternalAbortListener = () => request.signal.removeEventListener('abort', onExternalAbort);
                }
                timeoutId = setTimeout(() => {
                    timedOut = true;
                    controller.abort();
                }, this.timeoutMs);
                this.log({ event: 'internal-model-attempt', attempt });
                const response = await this.fetchImpl(completionUrl(this.baseUrl), {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                        Authorization: `Bearer ${this.apiKey}`
                    },
                    body: JSON.stringify(body),
                    signal: controller.signal
                });
                const status = responseStatus(response);
                const responseBody = await readResponseBody(response);
                if (!response || response.ok !== true) {
                    const providerError = parseProviderErrorBody(responseBody);
                    const genericInvalidRequest = isGenericInvalidRequest(status, request, providerError);
                    const retryable = genericInvalidRequest || isRetryableStatus(status);
                    const code = genericInvalidRequest ? GENERIC_INVALID_REQUEST_CODE : httpErrorCode(status);
                    if (genericInvalidRequest && attempt < attemptsAllowed) genericInvalidRequestRetryCount += 1;
                    lastError = new InternalModelError(code, `Internal model request failed with HTTP ${status || 'unknown'}`, {
                        status,
                        attempts: attempt,
                        retryable,
                        genericInvalidRequestRetryCount
                    });
                    this.log({ event: 'internal-model-response-error', attempt, status, code });
                    if (retryable && attempt < attemptsAllowed) {
                        await this.sleepImpl(this.backoffMs * Math.pow(2, attempt - 1));
                        continue;
                    }
                    throw lastError;
                }

                const payload = parseJsonBody(responseBody);
                const choice = payload?.choices?.[0];
                if (!choice || typeof choice !== 'object') {
                    throw new InternalModelError('INTERNAL_MODEL_EMPTY_CHOICES', 'Internal model returned no choices', { attempts: attempt });
                }
                const finishReason = choice.finish_reason == null ? null : String(choice.finish_reason);
                if (/content_filter|safety|blocked/i.test(finishReason || '')) {
                    throw new InternalModelError('INTERNAL_MODEL_SAFETY_BLOCKED', 'Internal model stopped for safety policy', {
                        attempts: attempt,
                        finishReason
                    });
                }
                if (/^length$/i.test(finishReason || '')) {
                    throw new InternalModelError('INTERNAL_MODEL_TRUNCATED', 'Internal model output was truncated', {
                        attempts: attempt,
                        finishReason
                    });
                }
                const content = typeof choice.message?.content === 'string' && choice.message.content.trim()
                    ? choice.message.content
                    : null;
                const toolCalls = normalizeToolCalls(choice.message?.tool_calls);
                if (content == null && toolCalls.length === 0) {
                    throw new InternalModelError('INTERNAL_MODEL_EMPTY_RESULT', 'Internal model returned no content or tool calls', {
                        attempts: attempt,
                        finishReason
                    });
                }
                const result = {
                    content,
                    toolCalls,
                    finishReason,
                    usage: payload.usage && typeof payload.usage === 'object' ? payload.usage : null,
                    attempts: attempt,
                    requestId: payload.id == null ? null : String(payload.id)
                };
                if (genericInvalidRequestRetryCount > 0) {
                    result.genericInvalidRequestRetryCount = genericInvalidRequestRetryCount;
                }
                return result;
            } catch (error) {
                if (error instanceof InternalModelError) {
                    if (error.code === 'INTERNAL_MODEL_HTTP_429'
                        || error.code === 'INTERNAL_MODEL_HTTP_5XX'
                        || error.code === 'INTERNAL_MODEL_HTTP_TIMEOUT'
                        || error.code === GENERIC_INVALID_REQUEST_CODE) {
                        lastError = error;
                        if (error.retryable && attempt < attemptsAllowed) {
                            await this.sleepImpl(this.backoffMs * Math.pow(2, attempt - 1));
                            continue;
                        }
                    }
                    throw error;
                }
                const code = timedOut ? 'INTERNAL_MODEL_TIMEOUT' : (request.signal?.aborted ? 'INTERNAL_MODEL_ABORTED' : toErrorCode(error));
                lastError = new InternalModelError(code, code === 'INTERNAL_MODEL_TIMEOUT'
                    ? 'Internal model request timed out'
                    : code === 'INTERNAL_MODEL_ABORTED' ? 'Internal model request was aborted' : 'Internal model network request failed', {
                    attempts: attempt,
                    retryable: code === 'INTERNAL_MODEL_TIMEOUT' || code === 'INTERNAL_MODEL_NETWORK_ERROR'
                });
                this.log({ event: 'internal-model-network-error', attempt, code });
                if ((code === 'INTERNAL_MODEL_TIMEOUT' || code === 'INTERNAL_MODEL_NETWORK_ERROR') && attempt < attemptsAllowed) {
                    await this.sleepImpl(this.backoffMs * Math.pow(2, attempt - 1));
                    continue;
                }
                throw lastError;
            } finally {
                if (timeoutId) clearTimeout(timeoutId);
                removeExternalAbortListener();
            }
        }
        throw lastError || new InternalModelError('INTERNAL_MODEL_FAILED', 'Internal model request failed');
    }

    request(request) {
        return this.complete(request);
    }
}

function createInternalModelClient(options) {
    return new InternalModelClient(options);
}

module.exports = {
    InternalModelClient,
    InternalModelError,
    createInternalModelClient,
    validateMessages,
    validateResponseFormat,
    validateTools,
    validateToolChoice,
    validateParallelToolCalls,
    completionUrl
};
