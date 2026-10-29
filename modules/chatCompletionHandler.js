const { UpstreamError, responseError, assertResponseOk, abortableDelay, abortError, throwIfAborted, safeErrorFields, sendFailure } = require('./upstreamErrors.js');
// modules/chatCompletionHandler.js
const messageProcessor = require('./messageProcessor.js');
const vcpInfoHandler = require('../vcpInfoHandler.js');
const contextManager = require('./contextManager.js');
const roleDivider = require('./roleDivider.js');
const fs = require('fs').promises;
const path = require('path');
const http = require('http');
const https = require('https');
const finalContextStore = require('./finalContextStore.js');
const { appendBudgetNotice } = require('./softContextBudget.js');
const { resolveOpenCodeGoSession } = require('./opencodeGoSession.js');
const { createRequestSourcePrivacyPolicy, SourcePrivacyFallbackError, SourcePrivacyProcessingError } = require('./sourcePrivacyPolicy.js');
// AICW 内层禁工具消费回执（opt-in，本机控制头）：仅在显式控制头存在时启用，普通请求零影响。
const { beginVcpToolForbiddenReceipt, emitVcpToolForbiddenReceipt } = require('./vcpToolForbiddenReceipt.js');

// AICW inner tool-forbidden consumption receipt: the ONE fail-closed exit for an
// explicit (opt-in) violation. Fixed codes only - the raw control header, the raw
// body, the model and every credential are never echoed - and the reserved receipt
// namespace is force-overwritten with `rejected:<code>`.
const VCP_TFR_REFUSAL_MESSAGE = '[VCP_TFR] the local tool-forbidden receipt check failed; the request was stopped before model dispatch.';

class VcpToolForbiddenRefusal extends Error {
  constructor(receiptCode) {
    const fixed = typeof receiptCode === 'string' && /^[a-z0-9_]{1,64}$/.test(receiptCode) ? receiptCode : 'control_invalid';
    super('vcp_tfr_' + fixed);
    this.name = 'VcpToolForbiddenRefusal';
    this.receiptCode = fixed;
    this.code = 'vcp_tfr_' + fixed;
    this.status = 400;
  }
}

// The ONE fail-closed writer: it answers with a fixed-code JSON error. Only fixed codes
// leave this module - no raw control header, no raw body, no model and no credential is
// ever echoed. The reserved receipt namespace was already force-overwritten by
// refuseVcpToolForbiddenReceipt with `rejected:<code>`.
function respondVcpToolForbiddenRefusal(res, refusal) {
  if (!res || typeof res.json !== 'function' || typeof res.setHeader !== 'function') return false;
  if (res.headersSent || res.writableEnded || res.destroyed) return false;
  const status = refusal && refusal.status ? refusal.status : 400;
  res.status(status).json({
    error: { type: 'upstream_error', status, code: refusal && refusal.code ? refusal.code : 'vcp_tfr_control_invalid', message: VCP_TFR_REFUSAL_MESSAGE }
  });
  return true;
}

function respondSourcePrivacyFailure(res, error) {
  if (!res || typeof res.status !== 'function' || typeof res.json !== 'function' ||
      res.headersSent || res.writableEnded || res.destroyed) return false;
  res.status(error.status).json({
    error: {
      type: error.status === 400 ? 'invalid_request' : 'internal_error',
      status: error.status,
      code: error.code,
      message: error.message
    }
  });
  return true;
}

function refuseVcpToolForbiddenReceipt(res, binding, code) {
  const refusal = new VcpToolForbiddenRefusal(code);
  emitVcpToolForbiddenReceipt(res, {
    binding,
    markerConsumed: binding && binding.markerConsumed === true,
    toolForbidden: false,
    toolParsingSkipped: false,
    toolsExecuted: 0,
    responseText: ''
  });
  // The refused token is ALWAYS the fixed code of THIS refusal (the code is sanitised
  // by VcpToolForbiddenRefusal): the single emission above cannot decide the token of an
  // emission-time refusal (for example a valid binding whose real backend identity could
  // not be observed), and the reserved namespace must never end up with a less specific
  // refusal token than the answered error code.
  if (res && typeof res.setHeader === 'function') {
    res.setHeader('x-aicw-tfr-receipt', 'rejected:' + refusal.receiptCode);
  }
  return refusal;
}

// AICW request-private single-attempt limit (opt-in, local control header): the ONE
// legal value is the string "1" and an ABSENT header leaves every ordinary request
// byte-identical to the frozen path. The control value selects a request-private
// budget that is occupied at the REAL upstream fetch boundary, so the initial send,
// an inner fetch retry, a semantic model fallback, a response-read re-send and any
// later call of the same request share ONE attempt. No credential, no task and no
// cross-request state is added.
const SINGLE_ATTEMPT_HEADER = 'x-vcp-single-attempt';
const SINGLE_ATTEMPT_REFUSAL_MESSAGE = '[VCP_SINGLE_ATTEMPT] the request-private single upstream attempt limit refused this request before model dispatch.';
const SINGLE_ATTEMPT_CODE_RE = /^vcp_single_attempt_[a-z0-9_]{1,48}$/;

class VcpSingleAttemptRefusal extends Error {
  constructor(code) {
    const fixed = typeof code === 'string' && SINGLE_ATTEMPT_CODE_RE.test(code) ? code : 'vcp_single_attempt_control_invalid';
    super(fixed);
    this.name = 'VcpSingleAttemptRefusal';
    this.code = fixed;
    this.receiptCode = fixed;
    this.status = 400;
  }
}

// The ONE fail-closed writer of this control: fixed code only - the raw control value,
// the raw body, the model and every credential are never echoed, and the failure is
// answered before any upstream dispatch.
function respondVcpSingleAttemptRefusal(res, refusal) {
  if (!res || typeof res.json !== 'function' || typeof res.setHeader !== 'function') return false;
  if (res.headersSent || res.writableEnded || res.destroyed) return false;
  const status = refusal && refusal.status ? refusal.status : 400;
  res.status(status).json({
    error: { type: 'upstream_error', status, code: refusal && refusal.code ? refusal.code : 'vcp_single_attempt_control_invalid', message: SINGLE_ATTEMPT_REFUSAL_MESSAGE }
  });
  return true;
}

// A refusal always answers with a fixed code. When the request also carries a VALID
// tool-forbidden binding, the reserved receipt namespace is force-overwritten with the
// same refusal token; the TFR protocol itself (control shape, receipt fields) is never
// touched or extended.
function refuseVcpSingleAttempt(res, binding, code) {
  const refusal = new VcpSingleAttemptRefusal(code);
  if (binding && binding.active === true) {
    refuseVcpToolForbiddenReceipt(res, binding, refusal.receiptCode);
  }
  return refusal;
}

// Presence and value of the ONE reserved control key. A header map spelling the same
// reserved key under more than one case-variant name is ambiguous and refused, and a
// present value that is not the exact string "1" is refused by type/value instead of
// being coerced. Only "no own entry at all" means the mechanism is off.
function readSingleAttemptControlHeader(req) {
  if (!req || typeof req.headers !== 'object' || req.headers === null || Array.isArray(req.headers)) {
    return { present: false, ambiguous: false, value: null };
  }
  let present = false;
  let ambiguous = false;
  let value = null;
  for (const [name, entry] of Object.entries(req.headers)) {
    if (String(name).toLowerCase() !== SINGLE_ATTEMPT_HEADER) continue;
    if (present) { ambiguous = true; break; }
    present = true;
    value = entry;
  }
  return { present, ambiguous, value };
}

// The ONE request-private budget. It is occupied once per REAL upstream attempt and is
// never refunded on a network error, an HTTP failure, a body error or a cancel, never
// recreated for a later call of the same request and never shared between requests.
function createSingleAttemptBudget() {
  let consumed = false;
  return {
    consume() {
      if (consumed) throw new VcpSingleAttemptRefusal('vcp_single_attempt_exhausted');
      consumed = true;
    }
  };
}

// 多模态配置真相源（JSON 优先 + 热更新），用于在请求时动态拉取 MultiModalForceTranslateModels
let multiModalConfigStore = null;
try {
  multiModalConfigStore = require('./multiModalConfigStore.js');
} catch (storeError) {
  multiModalConfigStore = null;
}

// 🌟 核心网络优化：引入防御性长连接池 (Keep-Alive Pool)
// 解决 "-1s Socket Hang Up" 与上游代理秒断僵尸连接的问题
const agentOptions = {
  keepAlive: true,
  keepAliveMsecs: 1000,     // 维持 Node.js 默认的 1s TCP 探针间隔
  freeSocketTimeout: 8000,  // 绝杀机制：空闲 Socket 8 秒后主动销毁，防止复用到被上游代理 (如 Nginx) 静默杀死的僵尸连接
  scheduling: 'lifo',       // 后进先出：永远优先复用刚刚才活跃过、最新鲜的热连接
  maxSockets: 10000         // 维持全局高并发上限
};
const keepAliveHttpAgent = new http.Agent(agentOptions);
const keepAliveHttpsAgent = new https.Agent(agentOptions);

const getFetchAgent = function(_parsedURL) {
  return _parsedURL.protocol === 'http:' ? keepAliveHttpAgent : keepAliveHttpsAgent;
};

const { getAuthCode } = require('./captchaDecoder');
const ToolCallParser = require('./vcpLoop/toolCallParser');
const ToolExecutor = require('./vcpLoop/toolExecutor');
const StreamHandler = require('./handlers/streamHandler');
const NonStreamHandler = require('./handlers/nonStreamHandler');
const { createInteractionCompletion } = require('./handlers/interactionCompletion');

const VCP_TOOL_USE_FORBIDDEN_PLACEHOLDER = '[[VCPToolUse=Forbidden]]';

function applyFixedSolReasoningEffort(body, requestedModel) {
  const match = /^gpt-6\.1-sol-(low|medium|high|xhigh|max)$/i.exec(String(requestedModel || '').trim());
  if (match) body.reasoning_effort = match[1].toLowerCase();
}

function parseBooleanEnv(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return String(value).toLowerCase() === 'true';
}

function normalizeClientIp(ip) {
  if (ip && ip.substr(0, 7) === '::ffff:') {
    return ip.substr(7);
  }
  return ip || 'unknown';
}

class ResponseReplayCache {
  constructor({ enabled = false, maxEntries = 100, debugMode = false } = {}) {
    this.enabled = enabled;
    this.maxEntries = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : 100;
    this.debugMode = debugMode;
    this.cache = new Map();
  }

  buildKey(clientIp, messageId) {
    if (!this.enabled || !messageId) return null;
    return `${normalizeClientIp(clientIp)}::${String(messageId)}`;
  }

  get(key) {
    if (!this.enabled || !key || !this.cache.has(key)) return null;
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, entry) {
    if (!this.enabled || !key || !entry || !Array.isArray(entry.chunks) || entry.chunks.length === 0) return;
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, {
      ...entry,
      chunks: entry.chunks.map(chunk => Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk))),
      cachedAt: Date.now()
    });

    while (this.cache.size > this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    if (this.debugMode) {
      console.log(`[ResponseReplayCache] Cached response for key=${key}. entries=${this.cache.size}/${this.maxEntries}`);
    }
  }

  replay(key, req, res) {
    const entry = this.get(key);
    if (!entry) return false;

    if (this.debugMode) {
      console.log(`[ResponseReplayCache] Replaying cached response for key=${key}. No tool chain will be executed.`);
    }

    if (!res.headersSent) {
      res.status(entry.statusCode || 200);
      for (const [name, value] of Object.entries(entry.headers || {})) {
        if (value !== undefined && value !== null) {
          res.setHeader(name, value);
        }
      }
    }

    for (const chunk of entry.chunks) {
      if (res.writableEnded || res.destroyed) break;
      res.write(chunk);
    }

    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }

    return true;
  }
}

function installResponseCacheRecorder(res, { cache, cacheKey, id, clientIp, streamMode, debugMode }) {
  if (!cache?.enabled || !cacheKey || res.__vcpReplayCacheRecorderInstalled) {
    return () => {};
  }

  res.__vcpReplayCacheRecorderInstalled = true;

  const capturedChunks = [];
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  let finalized = false;

  const captureChunk = (chunk, encoding) => {
    if (chunk === undefined || chunk === null) return;
    if (Buffer.isBuffer(chunk)) {
      capturedChunks.push(Buffer.from(chunk));
    } else {
      capturedChunks.push(Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8'));
    }
  };

  res.write = function patchedWrite(chunk, encoding, callback) {
    captureChunk(chunk, encoding);
    return originalWrite(chunk, encoding, callback);
  };

  res.end = function patchedEnd(chunk, encoding, callback) {
    captureChunk(chunk, encoding);
    return originalEnd(chunk, encoding, callback);
  };

  const finalize = () => {
    if (finalized) return;
    finalized = true;

    const statusCode = res.statusCode || 200;
    if (statusCode >= 200 && statusCode < 500 && capturedChunks.length > 0) {
      cache.set(cacheKey, {
        id,
        clientIp,
        streamMode,
        statusCode,
        headers: res.getHeaders ? res.getHeaders() : {},
        chunks: capturedChunks
      });
    } else if (debugMode) {
      console.log(`[ResponseReplayCache] Skip caching key=${cacheKey}, status=${statusCode}, chunks=${capturedChunks.length}`);
    }
  };

  res.once('finish', finalize);

  return finalize;
}

/**
 * 从顶层 system 提示词中检测并移除 VCP 工具禁用占位符。
 * 只扫描首个连续 system 消息区间，避免普通上下文/用户内容误触发。
 * @param {Array} messages
 * @returns {boolean}
 */
function consumeVcpToolUseForbiddenPlaceholder(messages) {
  if (!Array.isArray(messages)) return false;

  let found = false;
  for (const msg of messages) {
    if (!msg || msg.role !== 'system') break;

    if (typeof msg.content === 'string') {
      if (msg.content.includes(VCP_TOOL_USE_FORBIDDEN_PLACEHOLDER)) {
        found = true;
        msg.content = msg.content.split(VCP_TOOL_USE_FORBIDDEN_PLACEHOLDER).join('');
      }
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type === 'text' && typeof part.text === 'string' && part.text.includes(VCP_TOOL_USE_FORBIDDEN_PLACEHOLDER)) {
          found = true;
          part.text = part.text.split(VCP_TOOL_USE_FORBIDDEN_PLACEHOLDER).join('');
        }
      }
    }
  }

  return found;
}

/**
 * 检测当前真实后端模型是否命中纯文本模型 Tag 列表（不区分大小写）。
 * 配合模型动态路由（VCPModelAuto / SemanticModelRouter）使用：
 * 当语义路由切换到不支持多模态的模型（如 deepseek-v4 / GLM-4.5）时，
 * 自动把 base64 翻译为文本，避免上游 API 报错或丢图。
 *
 * @param {string} modelName 真实后端模型名（已经过 ModelRedirect 与语义路由解析）
 * @param {string[]} tagList tag 数组（已统一为小写，由 server.js 解析）
 * @returns {boolean} 是否命中
 */
function isTextOnlyModelByTag(modelName, tagList) {
  if (!modelName || !Array.isArray(tagList) || tagList.length === 0) return false;
  const lowerName = String(modelName).toLowerCase();
  for (const tag of tagList) {
    if (!tag) continue;
    if (lowerName.includes(tag)) return true;
  }
  return false;
}

/**
 * 检测一条消息（或其 content 数组）中是否包含 base64 多模态部分。
 * 仅用于 Force-Translate 触发判定，避免在没有图片/音视频的请求里空转翻译插件。
 *
 * @param {Array} messages 消息数组
 * @returns {boolean}
 */
function messagesContainBase64Media(messages) {
  if (!Array.isArray(messages)) return false;
  for (const msg of messages) {
    if (!msg || (msg.role !== 'user' && msg.role !== 'system')) continue;
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (
        part &&
        part.type === 'image_url' &&
        part.image_url &&
        typeof part.image_url.url === 'string' &&
        /^data:(image|audio|video)\/[^;]+;base64,/.test(part.image_url.url)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Copy non-enumerable array metadata produced by upstream preprocessors.
 * OneRing attaches __oneRingMeta to the messages array itself; any pipeline
 * step that returns a fresh array must preserve it explicitly.
 */
function copyArrayMetadata(source, target) {
  if (!Array.isArray(source) || !Array.isArray(target)) return target;

  for (const key of Object.getOwnPropertyNames(source)) {
    if (/^(?:length|\d+)$/.test(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) continue;
    try {
      Object.defineProperty(target, key, descriptor);
    } catch (e) {
      // Metadata preservation is best-effort and must not break request flow.
    }
  }

  return target;
}

/**
 * 检测工具返回结果是否为错误
 * @param {any} result - 工具返回的结果
 * @returns {boolean} - 是否为错误结果
 */
function isToolResultError(result) {
  if (result === undefined || result === null) {
    return false; // 空结果不视为错误
  }

  // 1. 对象形式的错误检测
  if (typeof result === 'object') {
    // 判定顺序必须先看明确成功标志：
    // 工具成功返回的正文/嵌套字段里可能包含“拒绝/错误/error”等业务文本，不能因此覆盖 status: success。
    if (
      result.success === true ||
      result.status === 'success' ||
      result.status === 'ok' ||
      result.ok === true
    ) {
      return false;
    }

    // 然后只信任结构化失败字段。
    if (
      result.error === true ||
      result.success === false ||
      result.status === 'error' ||
      result.status === 'failed' ||
      result.status === 'failure' ||
      result.ok === false
    ) {
      return true;
    }

    const codeValue = result.code ?? result.statusCode ?? result.httpStatus;
    const numericCode = Number(codeValue);
    if (Number.isFinite(numericCode) && numericCode >= 400 && numericCode < 600) {
      return true;
    }

    return false;
  }

  // 2. 字符串形式的错误检测（模糊匹配）
  if (typeof result === 'string') {
    const lowerResult = result.toLowerCase();

    // 检查是否以错误前缀开头（更可靠的判断）
    const errorPrefixes = [
      '[error]', '[错误]', '[失败]', 'error:', '错误：', '失败：'
    ];
    for (const prefix of errorPrefixes) {
      if (lowerResult.startsWith(prefix)) {
        return true;
      }
    }

    // 字符串仅接受显式错误前缀/格式，不再因正文任意位置包含“错误/失败/拒绝”等业务文本而误判。
    if (lowerResult.includes('error:') || lowerResult.includes('failed:')) {
      return true;
    }
  }

  return false;
}

/**
 * 格式化工具结果为字符串
 * @param {any} result - 工具返回的结果
 * @returns {string} - 格式化后的字符串
 */
function formatToolResult(result) {
  if (result === undefined || result === null) {
    return '(无返回内容)';
  }
  if (typeof result === 'object') {
    return JSON.stringify(result, null, 2);
  }
  return String(result);
}

async function getRealAuthCode(debugMode = false) {
  try {
    const authCodePath = path.join(__dirname, '..', 'Plugin', 'UserAuth', 'code.bin');
    // 使用正确的 getAuthCode 函数，它会自行处理文件读取和解码
    return await getAuthCode(authCodePath);
  } catch (error) {
    if (debugMode) {
      console.error('[VCPToolCode] Failed to read or decrypt auth code:', error);
    }
    return null; // Return null if code cannot be obtained
  }
}

function applyModelFallbackForAttempt(options, candidates, attemptIndex, debugMode = false) {
  if (!Array.isArray(candidates) || candidates.length === 0 || !options || typeof options.body !== 'string') {
    return options;
  }

  const selectedModel = candidates[Math.min(attemptIndex, candidates.length - 1)];
  if (!selectedModel) return options;

  try {
    const parsedBody = JSON.parse(options.body);
    if (!parsedBody || typeof parsedBody !== 'object') return options;

    const previousModel = parsedBody.model;
    parsedBody.model = selectedModel;

    if (debugMode && previousModel !== selectedModel) {
      console.log(`[SemanticModelRouter] 容灾切换上游模型: ${previousModel} -> ${selectedModel} (attempt=${attemptIndex + 1})`);
    }

    return {
      ...options,
      body: JSON.stringify(parsedBody)
    };
  } catch (error) {
    if (debugMode) {
      console.warn('[SemanticModelRouter] 无法为本次重试替换模型，继续使用原始请求体。');
    }
    return options;
  }
}

// AICW R2: the model this attempt really serialises onto the wire, read from the
// exact (possibly model-fallback-rewritten) body of the attempt - never from an
// earlier routing snapshot and never from the client control document.
function readDispatchedModel(options) {
  if (!options || typeof options.body !== 'string') return null;
  try {
    const parsedBody = JSON.parse(options.body);
    return parsedBody && typeof parsedBody.model === 'string' ? parsedBody.model : null;
  } catch (_) {
    return null;
  }
}

// A helper function to handle fetch with retries for specific status codes
// connectionTimeout: 连接超时安全网，防止上游 API 静默挂起导致永久等待（仅覆盖到收到响应头为止）
async function fetchWithRetry(
  url,
  options,
  { retries = 3, delay = 1000, debugMode = false, onRetry = null, onRequestSent = null, onResponseHeaders = null, connectionTimeout = 900000, modelFallbackCandidates = null, phase = 'initial', onModelDispatched = null, attemptBudget = null, redirect = null } = {},
) {
  const { default: fetch } = await import('node-fetch');
  const maxAttempts = Math.max(
    Number.isFinite(Number(retries)) && Number(retries) > 0 ? Math.floor(Number(retries)) : 1,
    Array.isArray(modelFallbackCandidates) ? modelFallbackCandidates.length : 0
  );
  const externalSignal = options.signal;
  for (let i = 0; i < maxAttempts; i++) {
    throwIfAborted(externalSignal);
    // The request-private budget is occupied at the REAL fetch boundary: before any
    // attempt wiring and deliberately OUTSIDE the network-error catch, so a refusal can
    // never be reclassified as a transport failure and never leaks a listener. A cancel
    // before the first dispatch therefore occupies nothing, and an attempt that already
    // left this process is never refunded and never repeated.
    if (attemptBudget && typeof attemptBudget.consume === 'function') attemptBudget.consume();
    const attemptController = new AbortController();
    let didTimeout = false;
    const forwardAbort = () => attemptController.abort();
    externalSignal?.addEventListener('abort', forwardAbort, { once: true });
    const timeoutId = connectionTimeout > 0
      ? setTimeout(() => { didTimeout = true; attemptController.abort(); }, connectionTimeout)
      : null;
    let failure;
    let response;
    let attemptModel = null;
    // Only the actual fetch is in the network-error catch. HTTP failures and
    // observational callbacks must never be reclassified as network failures.
    try {
      const attemptOptions = applyModelFallbackForAttempt(options, modelFallbackCandidates, i, debugMode);
      attemptModel = readDispatchedModel(attemptOptions);
      try { onRequestSent?.(); } catch (_) { /* observational */ }
      // `redirect` is only ever supplied by the opt-in single-attempt wrapper (which
      // pins it to "error"); an ordinary request keeps node-fetch default behaviour.
      response = await fetch(url, { ...attemptOptions, agent: getFetchAgent, signal: attemptController.signal, ...(redirect ? { redirect } : {}) });
    } catch (_) {
      failure = externalSignal?.aborted ? abortError({ phase, attempt: i + 1 })
        : new UpstreamError({ code: didTimeout ? 'upstream_timeout' : 'network_error', phase, attempt: i + 1 });
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      externalSignal?.removeEventListener('abort', forwardAbort);
    }
    if (response) {
      try { onResponseHeaders?.(response.status); } catch (_) { /* observational */ }
      if (response.ok) {
        if (externalSignal?.aborted) {
          response.body?.destroy();
          throw abortError({ status: response.status, phase, attempt: i + 1 });
        }
        // The ACCEPTED attempt is the only source of the backend-identity fact: an
        // observation callback only, it neither re-sends nor rewrites the request.
        if (typeof onModelDispatched === 'function') {
          try { onModelDispatched(attemptModel, i + 1); } catch (_) { /* observational only */ }
        }
        return response; // Success body belongs exclusively to the handler.
      }
      failure = await responseError(response, { phase, attempt: i + 1 }, { signal: externalSignal });
    }
    if (failure.name === 'AbortError') throw failure;
    const retryable = failure.status === null || [500, 503, 429].includes(failure.status);
    if (failure.code === 'sensitive_words_detected' || !retryable || i === maxAttempts - 1) throw failure;
    if (debugMode) console.warn('[Fetch Retry]', safeErrorFields(failure));
    if (onRetry) await onRetry(i + 1, safeErrorFields(failure));
    await abortableDelay(delay * (i + 1), externalSignal);
  }
}

// 剥离 Markdown 代码块，避免 VCP Refresh 误扫源码示例中的伪 RAG 标签
function stripMarkdownCodeFencesForRagRefresh(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/```[\s\S]*?```/g, '');
}

// 安全解析 RAG metadata：必须是合法 JSON 对象，否则跳过（不抛错污染用户请求）
function safeParseRagBlockMetadata(rawMetadata, debugMode = false) {
  if (typeof rawMetadata !== 'string') return null;
  const trimmed = rawMetadata.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    if (debugMode) console.warn(`[VCP Refresh] 跳过非 JSON metadata: ${trimmed.slice(0, 80)}`);
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch (e) {
    if (debugMode) console.warn(`[VCP Refresh] metadata JSON 解析失败，跳过: ${e.message}`);
    return null;
  }
}

// 辅助函数：根据新上下文刷新对话历史中由真实 system 消息承载的 RAG 区块
async function _refreshRagBlocksIfNeeded(messages, newContext, pluginManager, debugMode = false) {
  const ragPlugin = pluginManager.messagePreprocessors?.get('RAGDiaryPlugin');
  // 检查插件是否存在且是否实现了refreshRagBlock方法
  if (!ragPlugin || typeof ragPlugin.refreshRagBlock !== 'function') {
    if (debugMode) {
      console.log('[VCP Refresh] RAGDiaryPlugin 未找到或版本不兼容 (缺少 refreshRagBlock)，跳过刷新。');
    }
    return messages;
  }

  // 创建消息数组的深拷贝以安全地进行修改
  const newMessages = JSON.parse(JSON.stringify(messages));
  let hasRefreshed = false;

  // metadata 只接受 JSON 对象，避免误匹配源码示例、正则模板和未渲染占位符。
  const ragBlockRegex = /<!-- VCP_RAG_BLOCK_START\s+(\{[\s\S]*?\})\s+-->([\s\S]*?)<!-- VCP_RAG_BLOCK_END -->/g;

  for (let i = 0; i < newMessages.length; i++) {
    // 安全边界：只刷新协议层真实的 system 消息。
    // 不接受 assistant、普通 user 或通过文本前缀模拟的“虚拟 system-user”，
    // 否则客户端可自行构造合法 RAG metadata，在工具循环中触发任意日记本刷新。
    if (newMessages[i]?.role === 'system' && typeof newMessages[i].content === 'string') {
      // 先剥离 Markdown 代码围栏，避免扫描到示例中的伪 RAG 标签。
      let messageContent = stripMarkdownCodeFencesForRagRefresh(newMessages[i].content);

      // 快速检查是否存在标记，避免无效正则匹配
      if (!messageContent.includes('VCP_RAG_BLOCK_START')) {
        continue;
      }

      // 使用 replace 的回调函数模式来处理异步逻辑通常比较麻烦
      // 所以我们先收集所有匹配项，然后串行处理替换
      const matches = [...messageContent.matchAll(ragBlockRegex)];

      if (matches.length > 0) {
        if (debugMode) console.log(`[VCP Refresh] 消息[${i}]中发现 ${matches.length} 个 RAG 区块，准备刷新...`);

        // 我们从后往前替换，这样替换操作不会影响前面匹配项的索引位置（虽然 replace(str) 不依赖索引，但这是一个好习惯）
        // 这里为了简单，我们直接构建一个新的 content 字符串或使用 split/join 策略

        for (const match of matches) {
          const fullMatchString = match[0]; // 完整的 ... const metadataJson = match[1];    // 第一个捕获组：元数据 JSON
          const metadataJson = match[1];

          try {
            const metadata = safeParseRagBlockMetadata(metadataJson, debugMode);
            if (!metadata) {
              continue;
            }

            if (debugMode) {
              console.log(`[VCP Refresh] 正在刷新区块 (${metadata.dbName})...`);
            }

            // The RAG carrier's position does not identify the current user turn.
            // Select from this request's complete history using the shared selector.
            // Pass raw text: refreshRagBlock owns embedding sanitization.
            const selectedUser = messageProcessor.findLastRealUserMessage(messages);
            const originalUserQuery = selectedUser.rawContent || '';
            if (!originalUserQuery && debugMode) {
              console.warn(`[VCP Refresh] Could not find a true user query for the RAG block at index ${i}. Refresh may be inaccurate.`);
            }

            // 调用 RAG 插件的刷新接口, now with originalUserQuery
            const newBlock = await ragPlugin.refreshRagBlock(metadata, newContext, originalUserQuery);

            // 🟢 改进点4：关键修复！使用回调函数进行替换，防止 newBlock 中的 "$" 符号被解析为正则特殊字符
            // 这是一个极其常见的 Bug，导致包含 $ 的内容（如公式、代码）替换失败或乱码
            messageContent = messageContent.replace(fullMatchString, () => newBlock);

            hasRefreshed = true;

          } catch (e) {
            console.error("[VCP Refresh] 刷新 RAG 区块失败:", e.message);
            if (debugMode) console.error(e);
            // 出错时保持原样，不中断流程
          }
        }
        newMessages[i].content = messageContent;
      }
    }
  }

  if (hasRefreshed && debugMode) {
    console.log("[VCP Refresh] ✅ 对话历史中的 RAG 记忆区块已根据新上下文成功刷新。");
  }

  return newMessages;
}

class ChatCompletionHandler {
  constructor(config) {
    this.config = config;
    this.responseReplayCache = new ResponseReplayCache({
      enabled: parseBooleanEnv(config.responseReplayCacheEnabled ?? process.env.ResponseReplayCacheEnabled, false),
      maxEntries: parseInt(config.responseReplayCacheMaxEntries ?? process.env.ResponseReplayCacheMaxEntries, 10) || 100,
      debugMode: config.DEBUG_MODE
    });
    this.toolExecutor = new ToolExecutor({
      pluginManager: config.pluginManager,
      webSocketServer: config.webSocketServer,
      debugMode: config.DEBUG_MODE,
      vcpToolCode: config.VCPToolCode,
      getRealAuthCode: getRealAuthCode
    });
  }

  async handle(req, res, forceShowVCP = false) {
    const {
      apiUrl,
      apiKey,
      modelRedirectHandler,
      pluginManager,
      activeRequests,
      writeDebugLog,
      writeChatLog,
      webSocketServer,
      DEBUG_MODE,
      SHOW_VCP_OUTPUT,
      VCPToolCode,
      maxVCPLoopStream,
      maxVCPLoopNonStream,
      apiRetries,
      apiRetryDelay,
      RAGMemoRefresh,
      apiConnectionTimeoutMs,
      enableRoleDivider, // 新增
      enableRoleDividerInLoop, // 新增
      roleDividerIgnoreList, // 新增
      roleDividerSwitches, // 新增
      roleDividerScanSwitches, // 新增
      roleDividerRemoveDisabledTags, // 新增
      chinaModel1, // 新增
      chinaModel1Cot, // 新增
      semanticModelRouter,
      multiModalForceTranslateModels: configForceTranslateModels, // 启动时快照（ENV）作为兜底
    } = this.config;

    // 优先从 multimodal-config.json 真相源拉取最新 tag 列表，失败时回退 ENV 快照
    let multiModalForceTranslateModels = configForceTranslateModels;
    if (multiModalConfigStore) {
      try {
        const liveTags = multiModalConfigStore.getForceTranslateModels();
        if (Array.isArray(liveTags)) {
          multiModalForceTranslateModels = liveTags;
        }
      } catch (storeReadErr) {
        // 静默回退，不阻塞请求
      }
    }

    const shouldShowVCP = SHOW_VCP_OUTPUT || forceShowVCP;
    const applyChinaModelThinkingControl = (body) => {
      if (!body || !body.model || !chinaModel1 || !Array.isArray(chinaModel1) || chinaModel1.length === 0) {
        return body;
      }

      const modelNameLower = String(body.model).toLowerCase();
      const isChinaModel = chinaModel1.some(m => modelNameLower.includes(String(m).toLowerCase()));
      if (!isChinaModel) return body;

      if (chinaModel1Cot) {
        body.thinking = { type: "enabled" };
      } else {
        delete body.thinking;
      }

      if (DEBUG_MODE) {
        console.log(`[ChinaModel] 模型 '${body.model}' 匹配成功。思维链状态: ${chinaModel1Cot ? '开启 (enabled)' : '关闭 (已移除字段)'}`);
      }

      return body;
    };

    let clientIp = normalizeClientIp(req.ip);
    const openCodeGoSession = process.env.OpenCodeGoSessionEnabled === 'true'
      ? resolveOpenCodeGoSession(req, process.env.Key)
      : null;
    const openCodeGoSessionHeader = openCodeGoSession
      ? { 'x-opencode-session': openCodeGoSession }
      : {};

    const requestDiagnostic = req.__vcpDiagnostics;
    if (requestDiagnostic) requestDiagnostic.stage('preprocess_start');
    const observedFetchWithRetry = requestDiagnostic
      ? (url, options, retryOptions = {}) => fetchWithRetry(url, options, {
        ...retryOptions,
        onRequestSent: () => {
          requestDiagnostic.stage('upstream_request_sent');
          if (typeof retryOptions.onRequestSent === 'function') retryOptions.onRequestSent();
        },
        onResponseHeaders: status => {
          requestDiagnostic.stage('upstream_response_headers', status);
          if (typeof retryOptions.onResponseHeaders === 'function') retryOptions.onResponseHeaders(status);
        }
      })
      : fetchWithRetry;


    // AICW R2 (request-private, in-memory only): the model THIS request really sent on
    // the attempt whose response was accepted. It is observed through a narrow callback
    // bound to this request, never through a global mutable snapshot and never derived
    // from the client control document. It stays unobserved until the real dispatch.
    let dispatchedBackendModel = null;

    const id = req.body.requestId || req.body.messageId;
    let originalBody = req.body;
    // AICW inner tool-forbidden consumption receipt: the entry pre-check runs FIRST -
    // before the response-cache replay and before ANY processing that could change the
    // bound message projection (sanitise/consume/prune/redirect). An absent control
    // header keeps the ordinary request path byte-identical to the frozen source; a
    // present header is an explicit opt-in, and every illegal / ambiguous /
    // non-`stream:false` value fails closed before model dispatch, never a downgrade.
    const vcpToolForbiddenReceipt = beginVcpToolForbiddenReceipt(req, originalBody);
    if (vcpToolForbiddenReceipt !== null && vcpToolForbiddenReceipt.valid !== true) {
      const refusal = refuseVcpToolForbiddenReceipt(res, vcpToolForbiddenReceipt, vcpToolForbiddenReceipt.code || 'control_invalid');
      respondVcpToolForbiddenRefusal(res, refusal);
      return;
    }
    // AICW request-private single-attempt opt-in: only the exact string "1" switches the
    // mechanism on, and it is accepted only together with a VALID tool-forbidden binding
    // (which already requires an explicit `stream: false`). Every absent, illegal,
    // ambiguous or non-matching input is refused with a fixed code BEFORE preprocessing,
    // tool parsing or model dispatch; the budget itself is created here and stays private
    // to this one request.
    const singleAttemptControl = readSingleAttemptControlHeader(req);
    let singleAttemptBudget = null;
    if (singleAttemptControl.present) {
      const singleAttemptControlCode = singleAttemptControl.ambiguous ? 'vcp_single_attempt_control_ambiguous'
        : typeof singleAttemptControl.value !== 'string' ? 'vcp_single_attempt_control_type'
        : singleAttemptControl.value !== '1' ? 'vcp_single_attempt_control_value'
        : null;
      if (singleAttemptControlCode !== null) {
        respondVcpSingleAttemptRefusal(res, refuseVcpSingleAttempt(res, vcpToolForbiddenReceipt, singleAttemptControlCode));
        return;
      }
      if (vcpToolForbiddenReceipt === null || vcpToolForbiddenReceipt.valid !== true) {
        respondVcpSingleAttemptRefusal(res, refuseVcpSingleAttempt(res, vcpToolForbiddenReceipt, 'vcp_single_attempt_requires_tfr'));
        return;
      }
      singleAttemptBudget = createSingleAttemptBudget();
    }

    // The request-scoped dispatch boundary: in single-attempt mode EVERY upstream send
    // of THIS request goes through this wrapper, so the one shared budget and the
    // no-redirect rule also cover the inner fetch retry, the semantic model fallback and
    // each NonStreamHandler re-send. An ordinary request keeps the exact frozen function.
    const requestFetchWithRetry = singleAttemptBudget === null
      ? observedFetchWithRetry
      : (url, options, retryOptions = {}) => observedFetchWithRetry(url, options, {
        ...retryOptions,
        retries: 1,
        modelFallbackCandidates: null,
        attemptBudget: singleAttemptBudget,
        redirect: 'error'
      });

    const vcpchatExtensions = originalBody && typeof originalBody === 'object'
      ? originalBody.vcpchatExtensions
      : null;
    if (vcpchatExtensions !== undefined) {
      delete originalBody.vcpchatExtensions;
      const bindingCount = Array.isArray(vcpchatExtensions?.messageTimestampBindings)
        ? vcpchatExtensions.messageTimestampBindings.length
        : 0;
      console.log(`[VCPChatExtensions] Intercepted and stripped vcpchatExtensions before upstream forwarding. timestampBindings=${bindingCount}`);
    }
    const requestPreprocessorConfig = vcpchatExtensions
      ? { vcpchatExtensions }
      : {};
    // 请求独享，PluginManager 浅拷贝配置时仍保留此对象引用。
    requestPreprocessorConfig.tavernInteraction = {};
    const isOriginalRequestStreaming = originalBody.stream === true;
    // An explicit opt-in request never replays a cached response and is never cached:
    // a cached body is not evidence of THIS run's consumption, so it must neither
    // short-circuit the entry pre-check nor satisfy a fresh nonce.
    const responseCacheKey = vcpToolForbiddenReceipt === null
      ? this.responseReplayCache.buildKey(clientIp, id)
      : null;

    if (responseCacheKey && this.responseReplayCache.replay(responseCacheKey, req, res)) {
      return;
    }

    const abortController = new AbortController();

    let clientDisconnectedAbortReason = null;
    let cleanupClientDisconnectListeners = () => {};
    let finalizeResponseCacheRecorder = () => {};
    let interactionCompletion = null;
    let interactionOutcomeAccepted = false;

    if (responseCacheKey) {
      finalizeResponseCacheRecorder = installResponseCacheRecorder(res, {
        cache: this.responseReplayCache,
        cacheKey: responseCacheKey,
        id,
        clientIp,
        streamMode: isOriginalRequestStreaming,
        debugMode: DEBUG_MODE
      });
    }

    if (id) {
      activeRequests.set(id, {
        req,
        res,
        abortController,
        timestamp: Date.now(),
        aborted: false, // 修复 Bug #4: 添加中止标志
        abortReason: null
      });
    }

    {
      // 通用前端兼容：如果客户端没有显式调用 /v1/interrupt，
      // 但 HTTP/SSE 连接已经断开，则把传输层断联转换为同一条级联中止链路。
      // 注意：这里不能区分“用户点停止 / 刷新页面 / 网络断线 / 代理断开”，统一视为客户端不再等待响应。
      const triggerClientDisconnectAbort = (reason) => {
        const requestData = id ? activeRequests.get(id) : null;

        // 正常完成的响应也会触发 close，此时不能误杀已经完成的请求。
        if (res.writableEnded) return;

        if (abortController.signal.aborted) return;

        if (requestData) {
          requestData.aborted = true;
          requestData.abortReason = reason;
        }
        clientDisconnectedAbortReason = reason;

        if (!abortController.signal.aborted) {
          abortController.abort();
        }

        if (DEBUG_MODE) console.log('[ClientDisconnect] Upstream request aborted.');
      };

      const onReqAborted = () => triggerClientDisconnectAbort('request_aborted');
      const onReqClose = () => {
        if (req.aborted && !res.writableEnded) {
          triggerClientDisconnectAbort('request_close_after_abort');
        }
      };
      const onResClose = () => {
        if (!res.writableEnded) {
          triggerClientDisconnectAbort('response_close_before_finish');
        }
      };

      req.on('aborted', onReqAborted);
      req.on('close', onReqClose);
      res.on('close', onResClose);

      cleanupClientDisconnectListeners = () => {
        req.off('aborted', onReqAborted);
        req.off('close', onReqClose);
        res.off('close', onResClose);
      };
    }

    // --- 上下文控制 (Context Control) ---
    // 1. 拦截 contextTokenLimit 参数
    const contextTokenLimit = originalBody.contextTokenLimit;
    if (contextTokenLimit !== undefined) {
      if (DEBUG_MODE) console.log(`[ContextControl] 检测到 contextTokenLimit: ${contextTokenLimit}`);
      // 2. 从发送给后端的 body 中移除该参数
      delete originalBody.contextTokenLimit;

      // 3. 执行上下文修剪
      if (originalBody.messages && Array.isArray(originalBody.messages)) {
        const originalCount = originalBody.messages.length;
        originalBody.messages = await contextManager.pruneMessagesSmart(
          originalBody.messages,
          contextTokenLimit,
          DEBUG_MODE
        );
        if (DEBUG_MODE && originalBody.messages.length < originalCount) {
          console.log(`[ContextControl] 上下文已修剪: ${originalCount} -> ${originalBody.messages.length} 条消息`);
        }
      }
    }

    try {
      if (originalBody.model) {
        const originalModel = originalBody.model;
        const isSemanticRoutingModel = semanticModelRouter && typeof semanticModelRouter.isRoutingModel === 'function'
          ? semanticModelRouter.isRoutingModel(originalModel)
          : false;

        if (!isSemanticRoutingModel) {
          // The model suffix fixes the effort even when a client sends its default effort.
          // Set it before model redirection, which may replace the public alias.
          applyFixedSolReasoningEffort(originalBody, originalModel);
          const redirectedModel = modelRedirectHandler.redirectModelForBackend(originalModel);
          if (redirectedModel !== originalModel) {
            originalBody = { ...originalBody, model: redirectedModel };
            console.log(`[ModelRedirect] 客户端请求模型 '${originalModel}' 已重定向为后端模型 '${redirectedModel}'`);
          }

          // --- 国产A类模型推理功能控制 (ChinaModel Thinking Control) ---
          applyChinaModelThinkingControl(originalBody);
        } else if (DEBUG_MODE) {
          console.log(`[SemanticModelRouter] 检测到语义路由模型 '${originalModel}'，延后到消息预处理完成后选择真实后端模型。`);
        }
      }

      await writeDebugLog('LogInput', originalBody);

      // ★ 入口历史净化：剥除历史消息中尾部未闭合的 VCP 工具块残片。
      //   防御路径：上一轮 MaxVCPLoopStream 熔断时，未闭合的 TOOL_REQUEST 语法
      //   被流式透传并落盘到 history.json，如果不在入口净化，会被重新送入模型
      //   上下文，引发 Attention 撕裂与 ToolCallParser 幽灵解析。
      if (Array.isArray(originalBody.messages)) {
        try {
          const { sanitizeHistoryMessages } = require('./vcpLoop/historySanitizer.js');
          sanitizeHistoryMessages(originalBody.messages, { debugMode: DEBUG_MODE });
        } catch (sanitizeErr) {
          if (DEBUG_MODE) console.warn('[ChatCompletionHandler] History sanitize failed:', sanitizeErr.message);
        }
      }

      const vcpToolUseForbidden = consumeVcpToolUseForbiddenPlaceholder(originalBody.messages);
      // 回执只能来自本次真实消费结果：由冻结消费函数的布尔返回值派生，绝不硬填。
      if (vcpToolForbiddenReceipt) {
        vcpToolForbiddenReceipt.markerConsumed = vcpToolUseForbidden === true;
      }
      // Explicit opt-in but the marker was not really consumed by this entry: refuse
      // before model dispatch and before any inner tool parsing/execution. The thrown
      // fixed error is handled by the shared failure path, which keeps the already
      // forced `rejected:<code>` receipt header.
      if (vcpToolForbiddenReceipt !== null && vcpToolForbiddenReceipt.markerConsumed !== true) {
        throw refuseVcpToolForbiddenReceipt(res, vcpToolForbiddenReceipt, 'marker_not_consumed');
      }
      if (vcpToolUseForbidden && DEBUG_MODE) {
        console.log(`[VCPToolUse] Detected ${VCP_TOOL_USE_FORBIDDEN_PLACEHOLDER} in top-level system prompt. Tool parsing/execution is disabled for this request.`);
      }

      let shouldProcessMedia = false;
      let shouldProcessMediaPlus = false;
      if (originalBody.messages && Array.isArray(originalBody.messages)) {
        for (const msg of originalBody.messages) {
          let foundPlaceholderInMsg = false;
          let foundPlusPlaceholderInMsg = false;
          if (msg.role === 'user' || msg.role === 'system') {
            if (typeof msg.content === 'string') {
              if (msg.content.includes('{{TransBase64+}}')) {
                foundPlusPlaceholderInMsg = true;
                msg.content = msg.content.replace(/\{\{TransBase64\+\}\}/g, '');
              } else if (msg.content.includes('{{TransBase64}}')) {
                foundPlaceholderInMsg = true;
                msg.content = msg.content.replace(/\{\{TransBase64\}\}/g, '');
              }
            } else if (Array.isArray(msg.content)) {
              for (const part of msg.content) {
                if (part.type === 'text' && typeof part.text === 'string') {
                  if (part.text.includes('{{TransBase64+}}')) {
                    foundPlusPlaceholderInMsg = true;
                    part.text = part.text.replace(/\{\{TransBase64\+\}\}/g, '');
                  } else if (part.text.includes('{{TransBase64}}')) {
                    foundPlaceholderInMsg = true;
                    part.text = part.text.replace(/\{\{TransBase64\}\}/g, '');
                  }
                }
              }
            }
          }
          if (foundPlaceholderInMsg || foundPlusPlaceholderInMsg) {
            shouldProcessMedia = true;
            if (foundPlusPlaceholderInMsg) {
              shouldProcessMediaPlus = true;
            }
            if (DEBUG_MODE) console.log(`[Server] Media translation enabled by ${foundPlusPlaceholderInMsg ? '{{TransBase64+}}' : '{{TransBase64}}'} placeholder.`);
            // Removed break to ensure all + modifiers are processed if present in multiple messages
          }
        }
      }

      // --- VCPTavern 优先处理 ---
      // 在任何变量替换之前，首先运行 VCPTavern 来注入预设内容
      let tavernProcessedMessages = originalBody.messages;
      if (pluginManager.messagePreprocessors.has('VCPTavern')) {
        if (DEBUG_MODE) console.log(`[Server] Calling priority message preprocessor: VCPTavern`);
        try {
          tavernProcessedMessages = await pluginManager.executeMessagePreprocessor('VCPTavern', originalBody.messages, requestPreprocessorConfig);
        } catch (pluginError) {
          console.error(`[Server] Error in priority preprocessor VCPTavern:`, pluginError);
        }
      }

      // --- 语义模型路由：在变量替换前确定真实后端模型 ---
      // 这一步必须放在 VCPTavern 之后、变量替换之前：
      // 1) 路由依据已经包含 Tavern 注入的最新 user/assistant 上下文，更贴近真实意图。
      // 2) 在变量替换前完成，使后续的 SarPrompt、ChinaModel 等模型相关注入能针对真实路由模型生效。
      let semanticRoutePlan = null;
      let semanticModelFallbackCandidates = null;
      if (semanticModelRouter && typeof semanticModelRouter.isRoutingModel === 'function' && semanticModelRouter.isRoutingModel(originalBody.model)) {
        semanticRoutePlan = await semanticModelRouter.resolveRoute({
          requestedModel: originalBody.model,
          messages: tavernProcessedMessages,
          pluginManager
        });

        if (semanticRoutePlan && semanticRoutePlan.active) {
          applyFixedSolReasoningEffort(originalBody, semanticRoutePlan.selectedModel);
          const rawCandidates = Array.isArray(semanticRoutePlan.candidates) && semanticRoutePlan.candidates.length > 0
            ? semanticRoutePlan.candidates
            : [semanticRoutePlan.selectedModel];

          semanticModelFallbackCandidates = rawCandidates
            .map(model => modelRedirectHandler.redirectModelForBackend(model))
            .filter(Boolean)
            .filter((model, index, arr) => arr.indexOf(model) === index);

          const selectedBackendModel = semanticModelFallbackCandidates[0] || modelRedirectHandler.redirectModelForBackend(semanticRoutePlan.selectedModel);
          const previousModel = originalBody.model;
          originalBody = { ...originalBody, model: selectedBackendModel };

          if (DEBUG_MODE || previousModel !== selectedBackendModel) {
            console.log(
              `[SemanticModelRouter] 请求模型 '${previousModel}' 已路由到 '${selectedBackendModel}' ` +
              `(preset=${semanticRoutePlan.presetName}, reason=${semanticRoutePlan.reason}, candidates=${semanticModelFallbackCandidates.join(' -> ')})`
            );
          }

          applyChinaModelThinkingControl(originalBody);
        }
      }

      const sourcePrivacyPolicy = createRequestSourcePrivacyPolicy(
        originalBody.model,
        semanticModelFallbackCandidates
      );
      requestPreprocessorConfig.sourcePrivacyPolicy = sourcePrivacyPolicy;

      // --- 纯文本模型强制翻译多模态 ---
      // 当语义路由 / ModelRedirect 解析后的真实后端模型命中
      // MultiModalForceTranslateModels 列表（不区分大小写、tag 子串匹配）时：
      // 1) 自动开启多模态翻译（无视用户是否配置 {{TransBase64}}/{{TransBase64+}}）
      // 2) 强制关闭 + 模式的 base64 还原（因为目标模型是纯文本模型，无法处理 base64）
      // 3) 初始请求仍仅在消息确实含有 base64 多模态时执行翻译，避免空转翻译插件
      // 4) 该标记也会传递给 VCP loop，用于工具回包后才出现 image_url 的情况
      const isTextOnlyForceTranslateModel = Array.isArray(multiModalForceTranslateModels) &&
        multiModalForceTranslateModels.length > 0 &&
        isTextOnlyModelByTag(originalBody.model, multiModalForceTranslateModels);
      if (
        isTextOnlyForceTranslateModel &&
        messagesContainBase64Media(tavernProcessedMessages)
      ) {
        const previousMode = shouldProcessMediaPlus ? 'TransBase64+' : (shouldProcessMedia ? 'TransBase64' : 'none');
        shouldProcessMedia = true;
        shouldProcessMediaPlus = false; // 关键：禁用还原 base64
        console.log(
          `[MultiModalForceTranslate] 模型 '${originalBody.model}' 命中纯文本模型 tag 列表，` +
          `自动启用多模态文本翻译并禁用 base64 还原（先前模式: ${previousMode}）。`
        );
      }

      // --- 统一处理所有变量替换 ---
      // 创建一个包含所有所需依赖的统一上下文
      const processingContext = {
        pluginManager,
        sourcePrivacyPolicy,
        webSocketServer,
        cachedEmojiLists: this.config.cachedEmojiLists,
        detectors: this.config.detectors,
        superDetectors: this.config.superDetectors,
        DEBUG_MODE,
        messages: tavernProcessedMessages, // 将近期消息列表传递下去，用于支持上下文动态折叠 (Contextual Folding)
        // 静态/混合/分布式插件上报内容由 preprocessor_order.json 中的
        // $StaticPlaceholderInjection 虚拟阶段注入，避免动态网页文本在
        // CapturePreprocessor 之前生成可执行截图占位符。
        deferStaticPluginPlaceholders: true,
        // 🔒 灵魂级占位符去重：跨消息共享展开状态
        // Agent 类：整个上下文只允许展开一个 agent（第一个遇到的），后续所有 agent 占位符均不展开
        // Toolbox 类：每种 toolbox 各允许展开一次，同名重复出现时不再展开
        // VCP 工具 / 静态插件 / 全局清单类：每种在整个请求生命周期内只展开一次
        expandedAgentName: null,    // string | null - 已展开的唯一 Agent 别名
        expandedToolboxes: new Set(), // Set<string> - 已展开的 Toolbox 别名集合
        expandedVcpTools: new Set(), // Set<string> - 已展开的 VCP 工具别名集合
        expandedStaticPlaceholders: new Set(), // Set<string> - 已展开的静态插件占位符集合
        expandedGlobalPlaceholders: new Set() // Set<string> - 已展开的全局清单占位符集合
      };

      // 🔒 顺序处理消息（非并发），确保 agent/toolbox 的"首次展开"语义正确
      // 如果使用 Promise.all 并发，多条消息可能同时展开同一个 agent，违反"只展开一个"的约束
      let processedMessages = [];
      for (const msg of tavernProcessedMessages) {
        const newMessage = JSON.parse(JSON.stringify(msg));
        if (newMessage.content && typeof newMessage.content === 'string') {
          newMessage.content = await messageProcessor.replaceAgentVariables(
            newMessage.content,
            originalBody.model,
            msg.role,
            processingContext,
          );
        } else if (Array.isArray(newMessage.content)) {
          const newParts = [];
          for (const part of newMessage.content) {
            if (part.type === 'text' && typeof part.text === 'string') {
              const newPart = JSON.parse(JSON.stringify(part));
              newPart.text = await messageProcessor.replaceAgentVariables(
                newPart.text,
                originalBody.model,
                msg.role,
                processingContext,
              );
              newParts.push(newPart);
            } else {
              newParts.push(part);
            }
          }
          newMessage.content = newParts;
        }
        processedMessages.push(newMessage);
      }
      if (DEBUG_MODE) await writeDebugLog('LogAfterVariableProcessing', processedMessages);

      if (shouldProcessMedia && shouldProcessMediaPlus) {
        for (const msg of processedMessages) {
          if (msg.role === 'user' && Array.isArray(msg.content)) {
            const mediaParts = msg.content.filter(part => part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string' && /^data:(image|audio|video)\/[^;]+;base64,/.test(part.image_url.url));
            if (mediaParts.length > 0) {
              msg.__vcp_media_backup__ = JSON.parse(JSON.stringify(mediaParts));
            }
          }
        }
      }

      // --- 可排序消息处理管线 ---
      // VCPTavern 已在变量展开前执行；其余真实预处理器与静态占位符注入
      // 严格遵循 preprocessor_order.json，确保动态插件文本不能污染前置捕获指令。
      const STATIC_PLACEHOLDER_INJECTION_STAGE = '$StaticPlaceholderInjection';
      const selectedMediaProcessor = pluginManager.messagePreprocessors.has('MultiModalProcessor')
        ? 'MultiModalProcessor'
        : 'ImageProcessor';
      const orderedPipeline = Array.isArray(pluginManager.preprocessorOrder)
        ? pluginManager.preprocessorOrder
        : Array.from(pluginManager.messagePreprocessors.keys());

      for (const name of orderedPipeline) {
        if (name === 'VCPTavern') continue;

        if (name === STATIC_PLACEHOLDER_INJECTION_STAGE) {
          if (DEBUG_MODE) console.log('[Server] Injecting static/hybrid/distributed plugin placeholders.');
          processedMessages = await messageProcessor.injectStaticPluginPlaceholdersInMessages(
            processedMessages,
            {
              ...processingContext,
              messages: processedMessages
            }
          );
          continue;
        }

        if (name === 'ImageProcessor' || name === 'MultiModalProcessor') {
          if (!shouldProcessMedia || name !== selectedMediaProcessor) continue;
        }

        if (!pluginManager.messagePreprocessors.has(name)) continue;

        if (DEBUG_MODE) console.log(`[Server] Calling message preprocessor: ${name}`);
        try {
          processedMessages = await pluginManager.executeMessagePreprocessor(
            name,
            processedMessages,
            requestPreprocessorConfig
          );
        } catch (pluginError) {
          if (sourcePrivacyPolicy.enabled && name === 'OneRing') {
            sourcePrivacyPolicy.state.oneRing = 'failed';
            throw new SourcePrivacyProcessingError();
          }
          console.error(`[Server] Error in preprocessor ${name}:`, pluginError);
        }
      }
      if (sourcePrivacyPolicy.enabled && pluginManager.messagePreprocessors?.has?.('OneRing') &&
          sourcePrivacyPolicy.state.oneRing !== 'complete') {
        throw new SourcePrivacyProcessingError();
      }
      if (DEBUG_MODE) await writeDebugLog('LogAfterPreprocessors', processedMessages);

      // --- TransBase64+ Cleanup & Restore ---
      if (shouldProcessMediaPlus) {
        for (const msg of processedMessages) {
          if (msg.role === 'user') {
            // Remove the info block
            if (typeof msg.content === 'string') {
              msg.content = msg.content.replace(/<VCP_MULTIMODAL_INFO>[\s\S]*?<\/VCP_MULTIMODAL_INFO>/g, '');
            } else if (Array.isArray(msg.content)) {
              for (const part of msg.content) {
                if (part.type === 'text' && typeof part.text === 'string') {
                  part.text = part.text.replace(/<VCP_MULTIMODAL_INFO>[\s\S]*?<\/VCP_MULTIMODAL_INFO>/g, '');
                }
              }
            }

            // Restore the backup
            if (msg.__vcp_media_backup__) {
              if (typeof msg.content === 'string') {
                msg.content = [
                  { type: 'text', text: msg.content },
                  ...msg.__vcp_media_backup__
                ];
              } else if (Array.isArray(msg.content)) {
                msg.content = [
                  ...msg.content,
                  ...msg.__vcp_media_backup__
                ];
              }
              delete msg.__vcp_media_backup__;
            }
          }
        }
        if (DEBUG_MODE) console.log(`[Server] TransBase64+ cleanup and media restore complete.`);
      }

      // --- Detector / SuperDetector 后置处理 ---
      // 保证所有消息预处理器执行完成后，再统一应用 Detector 与 SuperDetector；
      // Role Divider 必须在其后作为最终消息拆分步骤。
      // Detector 会返回 fresh array；必须显式保护 OneRing 等预处理器挂在数组上的非枚举元数据。
      const messagesBeforeDetectors = processedMessages;
      processedMessages = copyArrayMetadata(
        messagesBeforeDetectors,
        messageProcessor.applyDetectorsToMessages(processedMessages, processingContext)
      );
      if (DEBUG_MODE) await writeDebugLog('LogAfterDetectors', processedMessages);

      // --- 角色分割处理 (Role Divider) - 最终阶段 ---
      if (enableRoleDivider) {
        if (DEBUG_MODE) console.log('[Server] Applying Role Divider processing (Final Stage)...');
        // skipCount: 1 to exclude the initial SystemPrompt from splitting
        processedMessages = roleDivider.process(processedMessages, {
          ignoreList: roleDividerIgnoreList,
          switches: roleDividerSwitches,
          scanSwitches: roleDividerScanSwitches,
          removeDisabledTags: roleDividerRemoveDisabledTags,
          skipCount: 1
        });
        if (DEBUG_MODE) await writeDebugLog('LogAfterFinalRoleDivider', processedMessages);
      }

      // 前端的展示姓名不是上游参与者标识（中文姓名还可能触发上游 name 格式校验）。
      // 必须在所有预处理器/原消息恢复完成后清理，避免 OneRing 恢复视图时重新带回；
      // 此时来源识别与时间戳绑定已完成，正文中的 OneRing 来源通知保持不变。
      // 不清理 function/tool 消息：旧式 function 协议依赖 name 匹配调用结果。
      for (const message of processedMessages) {
        if (message && ['system', 'developer', 'user', 'assistant'].includes(message.role)) {
          delete message.name;
        }
      }

      // 经过改造后，processedMessages 已经是最终版本，无需再调用 replaceOtherVariables
      originalBody.messages = processedMessages;

      let oneRingResponseMeta = null;
      try {
        const oneRingModule = pluginManager?.messagePreprocessors?.get?.('OneRing');
        if (oneRingModule && typeof oneRingModule.extractMetaFromMessages === 'function') {
          oneRingResponseMeta = oneRingModule.extractMetaFromMessages(processedMessages);
          if (DEBUG_MODE && oneRingResponseMeta) {
            console.log(`[OneRing] Frozen response meta before upstream fetch: agent=${oneRingResponseMeta.agentName} frontend=${oneRingResponseMeta.frontendSource} turn=${oneRingResponseMeta.turnId || 'none'}`);
          }
        }
      } catch (oneRingMetaError) {
        console.warn('[OneRing] Failed to freeze response meta before upstream fetch:', oneRingMetaError.message);
      }

      interactionCompletion = createInteractionCompletion({
        res,
        signal: abortController.signal,
        oneRingModule: pluginManager?.messagePreprocessors?.get?.('OneRing'),
        oneRingMeta: oneRingResponseMeta,
        messages: processedMessages,
        tavernInteraction: requestPreprocessorConfig.tavernInteraction
      });

      const willStreamResponse = isOriginalRequestStreaming;
      const finalUpstreamBody = { ...originalBody, stream: willStreamResponse };

      let budgetTokenCount;
      try {
        budgetTokenCount = finalContextStore.setLastFinalContext(finalUpstreamBody, {
          requestId: req.body.requestId || null,
          messageId: req.body.messageId || null,
          clientIp,
          forceShowVCP,
          capturedStage: 'before_upstream_fetch',
          budgetNoticeExcluded: true
        });
      } catch {
        console.warn('[FinalContextStore] Snapshot/count failed; continuing chat.');
      }

      // Outbound-only copy: originalBody remains the unmodified input to tool
      // loops/RAG. Check growth again on the next external request, not each loop.
      finalUpstreamBody.messages = appendBudgetNotice(
        finalUpstreamBody.messages, vcpchatExtensions, budgetTokenCount
      );

      await writeDebugLog('LogOutputAfterProcessing', finalUpstreamBody);

      if (requestDiagnostic) requestDiagnostic.stage('preprocess_end');

      let firstAiAPIResponse = await requestFetchWithRetry(
        `${apiUrl}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            ...openCodeGoSessionHeader,
            ...(req.headers['user-agent'] && { 'User-Agent': req.headers['user-agent'] }),
            Accept: willStreamResponse ? 'text/event-stream' : req.headers['accept'] || 'application/json',
          },
          body: JSON.stringify(finalUpstreamBody),
          signal: abortController.signal,
        },
        {
          retries: apiRetries,
          delay: apiRetryDelay,
          debugMode: DEBUG_MODE,
          connectionTimeout: apiConnectionTimeoutMs,
          modelFallbackCandidates: semanticModelFallbackCandidates,
          // Observation only: the model the ACCEPTED attempt really serialised (after
          // semantic routing and after any model-fallback rewrite). It adds no attempt.
          onModelDispatched: model => { dispatchedBackendModel = typeof model === 'string' ? model : null; },
          onRetry: async (attempt, errorInfo) => {
            if (!res.headersSent && isOriginalRequestStreaming) {
              if (DEBUG_MODE)
                console.log(`[VCP Retry] First retry attempt (#${attempt}). Sending 200 OK to client to establish stream.`);
              res.status(200);
              res.setHeader('Content-Type', 'text/event-stream');
              res.setHeader('Cache-Control', 'no-cache');
              res.setHeader('Connection', 'keep-alive');
            }
          },
        },
      );

      await assertResponseOk(firstAiAPIResponse, { phase: 'initial' }, abortController.signal);

      // AICW R2: the backend-identity fact is taken at the ACTUAL dispatch boundary of
      // the request that produced THIS response - after semantic routing and after any
      // model-fallback attempt. An unobservable fact fails the opt-in request closed
      // instead of being reported as "the same as the bound entry logical model".
      if (vcpToolForbiddenReceipt !== null && vcpToolForbiddenReceipt.valid === true) {
        if (typeof dispatchedBackendModel !== 'string' || dispatchedBackendModel.length === 0) {
          throw refuseVcpToolForbiddenReceipt(res, vcpToolForbiddenReceipt, 'backend_identity_unobserved');
        }
        vcpToolForbiddenReceipt.backendModel = dispatchedBackendModel;
      }
      const isUpstreamStreaming =
        willStreamResponse && firstAiAPIResponse.headers.get('content-type')?.includes('text/event-stream');

      if (!res.headersSent) {
        const upstreamStatus = firstAiAPIResponse.status;

        // Normal header setting for non-streaming or successful streaming responses
        res.status(upstreamStatus);
        firstAiAPIResponse.headers.forEach((value, name) => {
          if (
            !['content-encoding', 'transfer-encoding', 'connection', 'content-length', 'keep-alive'].includes(
              name.toLowerCase(),
            )
          ) {
            res.setHeader(name, value);
          }
        });
        if (isOriginalRequestStreaming && !res.getHeader('Content-Type')?.includes('text/event-stream')) {
          res.setHeader('Content-Type', 'text/event-stream');
          if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-cache');
          if (!res.getHeader('Connection')) res.setHeader('Connection', 'keep-alive');
        }
      }

      const context = {
        ...this.config,
        toolExecutor: this.toolExecutor,
        ToolCallParser,
        abortController,
        originalBody,
        clientIp,
        forceShowVCP,
        _refreshRagBlocksIfNeeded,
        fetchWithRetry: requestFetchWithRetry,
        isToolResultError,
        formatToolResult,
        vcpToolUseForbidden,
        vcpToolForbiddenReceipt,
        apiConnectionTimeoutMs,
        semanticModelFallbackCandidates,
        oneRingResponseMeta,
        shouldProcessMedia,
        shouldProcessMediaPlus,
        isTextOnlyForceTranslateModel,
        requestPreprocessorConfig,
        openCodeGoSessionHeader
      };

      const outcome = isUpstreamStreaming
        ? await new StreamHandler(context).handle(req, res, firstAiAPIResponse)
        : await new NonStreamHandler(context).handle(req, res, firstAiAPIResponse);
      interactionOutcomeAccepted = true;
      interactionCompletion.accept(outcome);
    } catch (error) {
      if (error instanceof SourcePrivacyFallbackError || error instanceof SourcePrivacyProcessingError) {
        respondSourcePrivacyFailure(res, error);
        return;
      }
      // Explicit opt-in refusal: fixed code only, answered BEFORE the generic failure
      // path so the reserved receipt namespace and the HTTP status stay exact.
      if (error instanceof VcpToolForbiddenRefusal) {
        respondVcpToolForbiddenRefusal(res, error);
        return;
      }
      // Request-private single-attempt refusal (fixed code only): answered before the
      // generic failure path so the HTTP status and the reserved receipt namespace stay
      // exact - a valid TFR binding keeps the already forced `rejected:<code>` token and
      // a TFR-less request never grows a receipt header it did not opt into.
      if (error instanceof VcpSingleAttemptRefusal) {
        refuseVcpSingleAttempt(res, vcpToolForbiddenReceipt, error.code);
        respondVcpSingleAttemptRefusal(res, error);
        return;
      }
      if (error.name === 'AbortError') {
        if (error instanceof UpstreamError && error.status !== null && requestDiagnostic?.upstreamError) {
          requestDiagnostic.upstreamError(error);
        } else requestDiagnostic?.error('aborted', res.statusCode);
        // 显式 /v1/interrupt 或客户端断联都会走到这里。
        // 如果是客户端断联，响应通道通常已经不可写；如果是显式 interrupt，则由 interrupt 路由负责关闭响应流。
        // 这里仅停止后续处理，避免与中止链路竞态写入。
        if (DEBUG_MODE) console.log('[Abort] Request processing stopped.');
        return; // Stop processing and allow the 'finally' block to clean up.
      }
      const failure = error instanceof UpstreamError ? error : new UpstreamError({ code: 'internal_error' });
      if (requestDiagnostic?.upstreamError && error instanceof UpstreamError) {
        requestDiagnostic.upstreamError(failure);
      } else {
        requestDiagnostic?.error(error instanceof UpstreamError ? 'upstream_error' : 'handler_error', failure.status || 500);
      }
      console.error('[ChatCompletionHandler] Request failed:', safeErrorFields(failure));
      sendFailure(res, failure, isOriginalRequestStreaming, abortController.signal);
    } finally {
      if (!interactionOutcomeAccepted) interactionCompletion?.fail();
      cleanupClientDisconnectListeners();

      if (!res.writableEnded && !res.destroyed) {
        // 仍未结束的异常路径不应写入缓存；正常 finish 会自动 finalize。
      } else {
        finalizeResponseCacheRecorder();
      }

      if (id) {
        const requestData = activeRequests.get(id);
        if (requestData) {
          // 修复 Bug #4: 只有在未被 interrupt 路由中止时才执行清理
          // 优化清理逻辑：只有在请求未正常结束且未被中止时才调用 abort
          // 🟢 修复：不再在 finally 块中盲目 abort
          // 只有在客户端连接已断开（res.destroyed）且请求未正常结束时才中止上游
          // 这防止了在模型输出异常（如潜空间坍缩）导致处理逻辑快速结束时，服务器误杀上游连接
          if (!requestData.aborted && requestData.abortController && !requestData.abortController.signal.aborted) {
            if (res.destroyed && !res.writableEnded) {
              requestData.aborted = true;
              requestData.abortReason = 'response_destroyed_in_finally';
              requestData.abortController.abort();
            }
          }

          // 无论如何都要删除 Map 条目以释放内存
          // 但使用 setImmediate 延迟删除，确保 interrupt 路由完成操作
          setImmediate(() => {
            activeRequests.delete(id);
            if (DEBUG_MODE) console.log(`[ChatHandler Cleanup] Removed request ${id} from activeRequests.`);
          });
        }
      }
    }
  }
}

// 暴露纯刷新入口供安全回归测试和内部复用；请求主链路仍通过 handler context 调用同一实现。
Object.defineProperty(ChatCompletionHandler, 'refreshRagBlocksIfNeeded', {
  value: _refreshRagBlocksIfNeeded,
  writable: false,
  configurable: false,
  enumerable: false
});

// 供离线验收直接驱动同一入口实现（非枚举、不可写）：主链路调用的是同一函数。
Object.defineProperty(ChatCompletionHandler, 'consumeVcpToolUseForbiddenPlaceholder', {
  value: consumeVcpToolUseForbiddenPlaceholder,
  writable: false,
  configurable: false,
  enumerable: false
});
Object.defineProperty(ChatCompletionHandler, 'beginVcpToolForbiddenReceipt', {
  value: beginVcpToolForbiddenReceipt,
  writable: false,
  configurable: false,
  enumerable: false
});

module.exports = ChatCompletionHandler;
