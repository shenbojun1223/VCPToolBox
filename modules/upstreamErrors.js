'use strict';

// Error bodies are decoded Node readable streams in node-fetch (including gzip).
// Bound decoded bytes and wall time independently of the connection timeout.
const ERROR_BODY_MAX_BYTES = 16 * 1024;
const ERROR_BODY_TIMEOUT_MS = 1000;
const CODES = new Set(['sensitive_words_detected', 'invalid_api_key', 'rate_limit_exceeded',
  'unknown', 'network_error', 'upstream_timeout', 'stream_error', 'aborted', 'internal_error']);
const REMOTE_CODES = new Set(['sensitive_words_detected', 'invalid_api_key', 'rate_limit_exceeded']);
const safeCode = value => CODES.has(value) ? value : 'unknown';
const safeRequestId = value => typeof value === 'string' && value.length <= 96 &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) ? value : null;
const safePhase = value => value === 'tool_continuation' ? value : 'initial';
const safeStatus = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;

class UpstreamError extends Error {
  constructor({ status = null, code = 'unknown', phase = 'initial', attempt = 1, requestId = null } = {}) {
    super('Upstream request failed.');
    this.name = code === 'aborted' ? 'AbortError' : 'UpstreamError';
    this.status = safeStatus(status);
    this.code = safeCode(code);
    this.phase = safePhase(phase);
    this.attempt = Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 1;
    this.requestId = safeRequestId(requestId);
  }
}

function safeErrorFields(error) {
  return { status: safeStatus(error?.status), code: safeCode(error?.code),
    phase: safePhase(error?.phase),
    attempt: Number.isSafeInteger(error?.attempt) && error.attempt > 0 ? error.attempt : 1,
    requestId: safeRequestId(error?.requestId) };
}

function abortError(fields = {}) { return new UpstreamError({ ...fields, code: 'aborted' }); }
function throwIfAborted(signal) { if (signal?.aborted) throw abortError(); }

function abortableDelay(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    const onAbort = () => { cleanup(); reject(abortError()); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function readErrorBody(body, { signal, maxBytes = ERROR_BODY_MAX_BYTES, timeoutMs = ERROR_BODY_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    if (!body || typeof body.on !== 'function') { resolve({ text: '', outcome: 'empty' }); return; }
    let chunks = [], bytes = 0, settled = false, timer;
    const detach = () => {
      body.removeListener('data', onData); body.removeListener('end', onEnd);
      body.removeListener('error', onError); body.removeListener('close', onClose);
    };
    const finish = (outcome, destroy = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      body.removeListener('data', onData); body.removeListener('end', onEnd);
      const text = outcome === 'eof' ? Buffer.concat(chunks, bytes).toString('utf8') : '';
      chunks = [];
      if (destroy && !body.destroyed) {
        body.pause();
        // Retain the error listener until close to cover asynchronous _destroy errors.
        body.destroy();
      } else detach();
      resolve({ text, outcome });
    };
    const onData = chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes + buffer.length > maxBytes) { finish('limit', true); return; }
      bytes += buffer.length; chunks.push(buffer);
    };
    const onEnd = () => finish('eof');
    const onError = () => finish('error', true);
    const onClose = () => { finish('closed'); detach(); };
    const onAbort = () => finish('aborted', true);
    body.on('error', onError); body.on('close', onClose); body.on('end', onEnd);
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish('timeout', true), timeoutMs);
    if (signal?.aborted) { onAbort(); return; }
    if (body.destroyed || body.readableEnded) { finish('closed'); return; }
    body.on('data', onData);
  });
}

async function responseError(response, fields = {}, readOptions = {}) {
  let requestId = null;
  for (const name of ['x-request-id', 'request-id']) {
    try { requestId = safeRequestId(response.headers?.get(name)); } catch (_) { /* no headers exported */ }
    if (requestId) break;
  }
  const { text, outcome } = await readErrorBody(response.body, readOptions);
  let code = 'unknown';
  if (outcome === 'eof') {
    try {
      const parsed = JSON.parse(text);
      const value = parsed?.error?.code ?? parsed?.code;
      code = REMOTE_CODES.has(value) ? value : 'unknown';
      requestId ||= safeRequestId(parsed?.request_id) || safeRequestId(parsed?.error?.request_id);
    } catch (_) { /* Never retain the raw body, parser message or stack. */ }
  }
  return new UpstreamError({ ...fields, status: response.status,
    code: outcome === 'aborted' || readOptions.signal?.aborted ? 'aborted' : code, requestId });
}

async function assertResponseOk(response, fields, signal) {
  if (!response.ok) throw await responseError(response, fields, { signal });
  if (signal?.aborted) {
    response.body?.destroy();
    throw abortError({ ...fields, status: response.status });
  }
}

const terminated = new WeakSet();
function sendFailure(res, error, streaming, signal) {
  if (signal?.aborted || error?.name === 'AbortError' || res.destroyed || res.writableEnded || terminated.has(res)) return;
  terminated.add(res);
  const fields = safeErrorFields(error);
  const message = `[UPSTREAM_ERROR] 上游请求失败（${fields.status ?? '连接错误'} / ${fields.code}），本次处理已停止。`;
  try {
    if (streaming) {
      if (!res.headersSent) {
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
      }
      res.write('data: ' + JSON.stringify({ id: 'chatcmpl-vcp-error-' + Date.now(), object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000), model: 'vcp-upstream-error',
        choices: [{ index: 0, delta: { content: '\n' + message }, finish_reason: 'stop' }],
        error: { type: 'upstream_error', ...fields } }) + '\n\n');
      if (!signal?.aborted && !res.destroyed && !res.writableEnded) {
        res.write('data: [DONE]\n\n');
        if (!res.destroyed && !res.writableEnded) res.end();
      }
    } else if (!res.headersSent) {
      res.status(fields.status >= 400 ? fields.status : fields.code === 'internal_error' ? 500 : 502)
        .json({ error: { type: 'upstream_error', ...fields, message } });
    }
  } catch (_) {
    if (!signal?.aborted && !res.destroyed && !res.writableEnded) {
      try { res.end(); } catch (_) { /* Disconnected transport. */ }
    }
  }
}

module.exports = { UpstreamError, safeCode, safeRequestId, safeErrorFields, readErrorBody,
  responseError, assertResponseOk, abortableDelay, abortError, throwIfAborted, sendFailure,
  ERROR_BODY_MAX_BYTES, ERROR_BODY_TIMEOUT_MS };
