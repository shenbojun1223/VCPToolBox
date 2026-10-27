'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');

const root = path.resolve(__dirname, '..');
function load(relative, mocks = {}, globals = {}) {
  const filename = path.join(root, relative);
  let source = fs.readFileSync(filename, 'utf8');
  source = source.replace("await import('node-fetch')", '({ default: fakeFetch })');
  if (relative === 'modules/chatCompletionHandler.js') source += '\nmodule.exports.fetchWithRetry = fetchWithRetry;';
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, Buffer, AbortController, URL,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
    process: { env: {} }, console: { log() {}, warn() {}, error() {} },
    require(id) {
      if (Object.hasOwn(mocks, id)) return mocks[id];
      if (['http', 'https', 'path', 'fs', 'string_decoder'].includes(id)) return require(id);
      if (/upstreamErrors|reasoningContentAdapter|vcpToolForbiddenReceipt|interactionCompletion/.test(id)) return require(path.resolve(path.dirname(filename), id));
      const reviewedPureModules = new Set([
        'modules/opencodeGoSession.js',
        'modules/sourcePrivacyPolicy.js',
        'modules/vcpLoop/historySanitizer.js',
        'modules/vcpLoop/modelOutputGuard.js'
      ]);
      if (id.startsWith('./') || id.startsWith('../')) {
        const resolved = path.resolve(path.dirname(filename), id);
        const moduleFile = path.extname(resolved) ? resolved : resolved + '.js';
        const relativeFile = path.relative(root, moduleFile).split(path.sep).join('/');
        if (reviewedPureModules.has(relativeFile)) return require(moduleFile);
      }
      throw new Error('Unmocked dependency: ' + id);
    }, ...globals
  }, { filename });
  return module.exports;
}
function response(status = 500, code = 'sensitive_words_detected') {
  const text = JSON.stringify({ error: { code, message: 'synthetic private body' } });
  return { status, ok: status >= 200 && status < 300,
    headers: { get: () => null, forEach() {} }, body: Readable.from([Buffer.from(text)]),
    text: async () => text, arrayBuffer: async () => Buffer.from(text),
    clone() { return this; }
  };
}
const chatMocks = {
  './messageProcessor.js': {}, '../vcpInfoHandler.js': {}, './contextManager.js': {},
  './roleDivider.js': {}, './finalContextStore.js': {}, './softContextBudget.js': {},
  './multiModalConfigStore.js': null, './captchaDecoder': {},
  './vcpLoop/toolCallParser': {}, './vcpLoop/toolExecutor': class {},
  './handlers/streamHandler': class {}, './handlers/nonStreamHandler': class {}
};
function fetcher(fakeFetch, globals) {
  return load('modules/chatCompletionHandler.js', chatMocks, { fakeFetch, ...globals }).fetchWithRetry;
}
function sink() {
  const res = new EventEmitter();
  Object.assign(res, { chunks: [], ends: 0, headersSent: false, statusCode: 200, headers: {},
    status(n) { this.statusCode = n; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    write(chunk, callback) { this.headersSent = true; this.chunks.push(String(chunk)); callback?.(); return true; },
    end() { this.ends++; this.writableEnded = true; this.emit('finish'); },
    json(value) { this.write(JSON.stringify(value)); this.end(); },
    send(value) { this.write(value); this.end(); }
  });
  return res;
}
function fixture(kind = 'normal', stream = true, retryFetch, globals = {}) {
  const counters = { tools: 0, fetches: 0, sent: [] };
  const tool = { name: 'SyntheticTool' };
  const content = '合成工具调用';
  const result = { success: kind !== 'archery', content: [{ type: 'text', text: 'synthetic receipt' }] };
  const context = {
    apiUrl: 'https://synthetic.invalid', apiKey: '', DEBUG_MODE: false,
    pluginManager: { messagePreprocessors: new Map() }, writeDebugLog: async () => {},
    originalBody: { model: 'synthetic', stream, messages: [{ role: 'user', content: 'synthetic input' }] },
    abortController: new AbortController(), maxVCPLoopStream: 3, maxVCPLoopNonStream: 3,
    apiRetries: 3, apiRetryDelay: 0, isToolResultError: () => false,
    ToolCallParser: { parse: text => text.includes(content) ? [tool] : [],
      separate: calls => ({ normal: kind === 'normal' ? calls : [], archery: kind === 'archery' ? calls : [] }) },
    toolExecutor: {
      execute: async () => { counters.tools++; return result; },
      executeAll: async () => { counters.tools++; return [result]; }
    },
    fetchWithRetry: async (...args) => {
      counters.fetches++; counters.sent.push(JSON.parse(args[1].body));
      return retryFetch ? retryFetch(...args) : response();
    }
  };
  const mocks = { '../../vcpInfoHandler.js': {}, '../roleDivider.js': {},
    '../vcpLoop/rollKeeper': { createRollKeeper: () => ({ evaluate: () => null, record() {}, reset() {} }) },
    '../vcpLoop/toolPayloadTruncator.js': { truncateToolPayload: x => x },
    '../vcpLoop/safeGravityProjection.js': { safeGravityProjection: async x => x } };
  const Handler = load('modules/handlers/' + (stream ? 'streamHandler' : 'nonStreamHandler') + '.js', mocks, globals);
  const first = response(200);
  const json = JSON.stringify({ choices: [{ message: { content } }] });
  first.arrayBuffer = async () => Buffer.from(json);
  const sse = Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\ndata: [DONE]\n\n');
  first.body = Readable.from(Array.from(sse, byte => Buffer.from([byte])));
  return { context, counters, res: sink(), first, Handler, handler: new Handler(context) };
}

test('regression: deterministic HTTP 500 is fetched once with structured failure', async () => {
  let calls = 0;
  const fetch = fetcher(async () => { calls++; return response(); });
  let error;
  try { await fetch('https://synthetic.invalid', {}, { retries: 3, delay: 0 }); } catch (e) { error = e; }
  assert.equal(calls, 1);
  assert.equal(error?.status, 500);
  assert.equal(error?.code, 'sensitive_words_detected');
  assert.equal(error?.phase, 'initial');
  assert.equal(error?.attempt, 1);
});

test('regression: tool continuation must surface failure instead of silent normal return', async () => {
  const f = fixture();
  await assert.rejects(f.handler.handle({}, f.res, f.first), e => e.status === 500 && e.phase === 'tool_continuation');
  assert.equal(f.counters.tools, 1);
  assert.equal(f.counters.fetches, 1);
});

const errors = require('../modules/upstreamErrors');
const { RequestDiagnostics, BoundedJsonlWriter } = require('../modules/diagnostics/requestDiagnostics');
const { StringDecoder } = require('node:string_decoder');
function consumeSse(chunks) {
  const decoder = new StringDecoder('utf8');
  let text = '';
  // Re-chunk every byte, including inside Chinese UTF-8 and [DONE].
  for (const byte of Buffer.from(chunks.join(''))) text += decoder.write(Buffer.from([byte]));
  text += decoder.end();
  return text.split(/\r?\n/).filter(x => x.startsWith('data:')).map(x => {
    const data = x.slice(5).trim();
    return data === '[DONE]' ? data : JSON.parse(data);
  });
}
function outerFixture({ stream = true, kind = 'normal', initialFailure = false, fakeFetch, withId = false } = {}) {
  const f = fixture(kind, stream);
  const logs = [], events = [], snapshots = [], sent = [];
  const consoleMock = Object.fromEntries(['log', 'warn', 'error'].map(key => [key, (...args) => logs.push(args)]));
  let fetches = 0;
  f.first.headers.get = key => key === 'content-type' ? (stream ? 'text/event-stream' : 'application/json') : null;
  const Chat = load('modules/chatCompletionHandler.js', {
    ...chatMocks,
    './messageProcessor.js': { replaceAgentVariables: async x => x, applyDetectorsToMessages: x => x },
    './softContextBudget.js': { appendBudgetNotice: x => x },
    './finalContextStore.js': { setLastFinalContext: x => { snapshots.push(JSON.parse(JSON.stringify(x))); return 1; } },
    './vcpLoop/historySanitizer.js': { sanitizeHistoryMessages() {} },
    './handlers/streamHandler': f.Handler, './handlers/nonStreamHandler': f.Handler,
    './vcpLoop/toolCallParser': f.context.ToolCallParser
  }, { console: consoleMock, fakeFetch: async (...args) => {
    fetches++; sent.push(JSON.parse(args[1].body));
    if (fakeFetch) return fakeFetch(fetches, ...args);
    return initialFailure || fetches > 1 ? response() : f.first;
  } });
  const config = { ...f.context, activeRequests: new Map(),
    modelRedirectHandler: { redirectModelForBackend: x => x },
    writeChatLog: (...args) => logs.push(args), DEBUG_MODE: true };
  const chat = new Chat(config);
  chat.toolExecutor = f.context.toolExecutor;
  const req = new EventEmitter();
  req.body = f.context.originalBody; req.headers = {}; req.ip = '127.0.0.1';
  if (withId) req.body.requestId = 'synthetic-request';
  const diagnostics = new RequestDiagnostics({ enabled: true, env: {}, role: 'main' });
  diagnostics.writer.enqueue = line => { events.push(JSON.parse(line)); return true; };
  diagnostics.middleware({ routeClassifier: () => 'chat' })(req, f.res, () => {});
  return { ...f, chat, req, logs, events, snapshots, sent,
    fetches: () => fetches, run: () => chat.handle(req, f.res) };
}

test('GPT-6.1 Sol alias fixes outbound effort before model redirection', async () => {
  for (const effort of ['low', 'high', 'xhigh', 'max']) {
    const f = outerFixture({ initialFailure: true });
    f.req.body.model = `gpt-6.1-sol-${effort}`;
    f.req.body.reasoning_effort = 'medium';
    f.chat.config.modelRedirectHandler.redirectModelForBackend = () => 'gpt-6.1-sol';
    await f.run();
    assert.equal(f.sent[0].model, 'gpt-6.1-sol');
    assert.equal(f.sent[0].reasoning_effort, effort);
  }
});

for (const stream of [true, false]) {
  test(`initial deterministic failure: visible safe ${stream ? 'SSE' : 'JSON'} and diagnostics`, async () => {
    const f = outerFixture({ stream, initialFailure: true });
    await f.run();
    assert.equal(f.fetches(), 1);
    const payload = stream ? consumeSse(f.res.chunks).find(x => x.error) : JSON.parse(f.res.chunks.join(''));
    assert.equal(payload.error.status, 500);
    assert.equal(payload.error.phase, 'initial');
    assert.equal(payload.error.code, 'sensitive_words_detected');
    assert.equal(payload.error.attempt, 1);
    assert.match(f.res.chunks.join(''), /上游请求失败/);
    assert.equal(f.res.ends, 1);
    assert.equal(f.res.statusCode, stream ? 200 : 500);
    if (stream) assert.equal(consumeSse(f.res.chunks).filter(x => x === '[DONE]').length, 1);
    const event = f.events.find(x => x.upstreamCode);
    assert.equal(event.upstreamStatus, 500);
    assert.equal(event.upstreamPhase, 'initial');
    assert.equal(event.errorCode, 'upstream_error');
    assert(!JSON.stringify([f.logs, f.events, f.res.chunks]).includes('synthetic private body'));
  });
  for (const kind of ['normal', 'archery']) {
    test(`${stream ? 'stream' : 'nonstream'} ${kind} actual outer handler: one tool, one continuation, visible terminal failure`, async () => {
      const f = outerFixture({ stream, kind });
      await f.run();
      assert.equal(f.counters.tools, 1);
      assert.equal(f.fetches(), 2);
      assert.equal(f.res.ends, 1);
      assert.match(f.res.chunks.join(''), /上游请求失败/);
      const payload = stream ? consumeSse(f.res.chunks).find(x => x.error) : JSON.parse(f.res.chunks.join(''));
      assert.equal(payload.error.phase, 'tool_continuation');
      assert.equal(payload.error.status, 500);
      assert.equal(payload.error.attempt, 1);
      assert.equal(payload.error.code, 'sensitive_words_detected');
      if (stream) {
        const parsed = consumeSse(f.res.chunks);
        assert.equal(parsed.filter(x => x.error).length, 1);
        assert.equal(parsed.filter(x => x === '[DONE]').length, 1);
        assert(parsed.some(x => x.choices?.[0]?.delta?.content === '合成工具调用'));
      } else assert.equal(f.res.statusCode, 500);
      assert.match(JSON.stringify(f.sent[1].messages), /synthetic receipt/);
      assert(!JSON.stringify([f.sent, f.snapshots, f.context.originalBody]).includes('UPSTREAM_ERROR'));
      assert.equal(f.events.find(x => x.upstreamPhase)?.upstreamPhase, 'tool_continuation');
    });
  }
}

for (const [status, attempts] of [[400, 1], [401, 1], [403, 1], [500, 3], [503, 3], [429, 3]]) {
  test(`status ${status}: bounded ${attempts} attempts, original status retained`, async () => {
    let calls = 0, waits = 0;
    const fetch = fetcher(async () => { calls++; return response(status, 'unrecognized'); });
    await assert.rejects(fetch('https://synthetic.invalid', {}, { retries: 3, delay: 0,
      onRetry: () => { waits++; } }), e => e.status === status && e.code === 'unknown' && e.attempt === attempts);
    assert.equal(calls, attempts); assert.equal(waits, attempts - 1);
  });
}
test('network and connection timeout remain controlled and bounded', async () => {
  for (const timeout of [false, true]) {
    let calls = 0;
    const fetch = fetcher(async (url, options) => {
      calls++;
      if (timeout) await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('private network detail'))));
      throw Error('private network detail');
    });
    await assert.rejects(fetch('https://synthetic.invalid', {}, { retries: 2, delay: 0, connectionTimeout: 5 }),
      e => e.status === null && e.code === (timeout ? 'upstream_timeout' : 'network_error') && e.attempt === 2 && !e.message.includes('private'));
    assert.equal(calls, 2);
  }
});
test('deterministic error prevents model fallback and onRetry, success body is untouched', async () => {
  let calls = 0;
  const fetch = fetcher(async () => { calls++; return response(); });
  await assert.rejects(fetch('https://synthetic.invalid', { body: '{}' }, {
    retries: 1, modelFallbackCandidates: ['one', 'two', 'three'], onRetry() { assert.fail('retry'); }
  }), e => e.code === 'sensitive_words_detected');
  assert.equal(calls, 1);
  const ok = response(200);
  const success = fetcher(async () => ok);
  assert.strictEqual(await success('https://synthetic.invalid', {}), ok);
  assert.equal(ok.body.readableFlowing, null);
  assert.equal(ok.body.readableEnded, false);
});

const tick = () => new Promise(resolve => setImmediate(resolve));
for (const scenario of ['limit', 'timeout', 'error', 'abort', 'closed', 'partial', 'eof', 'empty', 'invalid', 'truncated']) {
  test(`bounded Node readable: ${scenario}, original status, cleanup`, async () => {
    const controller = new AbortController();
    let body;
    if (scenario === 'limit') body = Readable.from([Buffer.alloc(20000)]);
    else if (['timeout', 'abort', 'partial'].includes(scenario)) body = new Readable({ read() {
      if (scenario === 'partial' && !this.sent) { this.sent = true; this.push('{"error":{"code":"sensitive_words_detected"}}'); }
    } });
    else if (scenario === 'error') body = new Readable({ read() { this.destroy(Error('synthetic private stream error')); } });
    else if (scenario === 'closed') body = new Readable({ read() { this.destroy(); } });
    else body = Readable.from([Buffer.from({ eof: '{"error":{"code":"sensitive_words_detected"}}', empty: '', invalid: '<html>private</html>', truncated: '{"error":' }[scenario])]);
    const r = { ...response(503), body };
    const work = errors.responseError(r, { phase: 'tool_continuation', attempt: 2 }, { signal: controller.signal, timeoutMs: 15 });
    if (scenario === 'abort') controller.abort();
    const error = await work;
    await tick();
    assert.equal(error.status, 503);
    assert.equal(error.phase, 'tool_continuation');
    assert.equal(error.attempt, 2);
    assert.equal(error.code, scenario === 'eof' ? 'sensitive_words_detected' : scenario === 'abort' ? 'aborted' : 'unknown');
    assert(body.destroyed || body.readableEnded);
    for (const name of ['data', 'end', 'error', 'close']) assert.equal(body.listenerCount(name), 0, name);
    assert.equal(require('node:events').getEventListeners(controller.signal, 'abort').length, 0);
  });
}

test('hostile body/code/requestId cannot reach client, console or diagnostics', async () => {
  // All canaries are fabricated, never read from credentials or user input.
  const canaries = ['SYNTHETIC_SECRET_CANARY', '任意合成词条', '<script>synthetic</script>', '\u0001private'];
  const f = outerFixture({ initialFailure: true, fakeFetch: async () => {
    const r = response(403);
    r.headers.get = name => name === 'x-request-id' ? 'bad id\nprivate' : null;
    r.headers.forEach = () => assert.fail('error headers must never be exported');
    r.body = Readable.from([Buffer.from(JSON.stringify({ error: { code: canaries[0], message: canaries.join(' ') }, request_id: 'x'.repeat(97) }))]);
    return r;
  } });
  await f.run();
  const visible = JSON.stringify([f.res.chunks, f.logs, f.events]);
  for (const canary of canaries) assert(!visible.includes(canary));
  const error = consumeSse(f.res.chunks).find(x => x.error).error;
  assert.equal(error.code, 'unknown'); assert.equal(error.requestId, null);
});
test('requestId accepts only selected headers or bounded structured IDs', async () => {
  const checked = [];
  const r = response(400);
  r.headers.get = name => { checked.push(name); return name === 'request-id' ? 'req-123.A:b' : 'bad?query'; };
  const error = await errors.responseError(r);
  assert.deepEqual(checked, ['x-request-id', 'request-id']);
  assert.equal(error.requestId, 'req-123.A:b');
  const writer = new BoundedJsonlWriter({ enabled: true });
  let event; writer.enqueue = line => { event = JSON.parse(line); };
  writer.writeEvent({ upstreamPhase: 'tool_continuation', upstreamCode: '<private>', upstreamRequestId: 'bad\nID', upstreamStatus: 500, body: 'private' });
  assert.equal(event.upstreamCode, 'unknown'); assert.equal(event.upstreamRequestId, null); assert(!('body' in event));
});
test('abort during backoff stops promptly with no next fetch or terminal output', async () => {
  const controller = new AbortController(); let calls = 0;
  const fetch = fetcher(async () => { calls++; return response(503, 'unknown'); });
  const work = fetch('https://synthetic.invalid', { signal: controller.signal }, { retries: 3, delay: 10000,
    onRetry: () => setImmediate(() => controller.abort()) });
  await assert.rejects(work, e => e.name === 'AbortError');
  assert.equal(calls, 1);
  const res = sink(); errors.sendFailure(res, new errors.UpstreamError(), true, controller.signal);
  assert.equal(res.chunks.length, 0); assert.equal(res.ends, 0);
});
test('already aborted request performs no fetch', async () => {
  const controller = new AbortController(); controller.abort();
  const fetch = fetcher(async () => assert.fail('fetch after cancellation'));
  await assert.rejects(fetch('https://synthetic.invalid', { signal: controller.signal }), e => e.name === 'AbortError');
});
for (const stream of [true, false]) for (const kind of ['normal', 'archery']) {
  test(`cancel after ${kind} tool, stream=${stream}: no continuation or extra DONE`, async () => {
    const f = fixture(kind, stream);
    const key = kind === 'normal' ? 'executeAll' : 'execute';
    const original = f.context.toolExecutor[key];
    f.context.toolExecutor[key] = async (...args) => { const result = await original(...args); f.context.abortController.abort(); return result; };
    try { await f.handler.handle({}, f.res, f.first); } catch (e) { assert.equal(e.name, 'AbortError'); }
    assert.equal(f.counters.tools, 1); assert.equal(f.counters.fetches, 0);
    assert.equal(f.res.ends, 0);
    assert(!f.res.chunks.join('').includes('[DONE]'));
  });
}
test('terminal sender is idempotent and never writes a destroyed socket', () => {
  const res = sink(), error = new errors.UpstreamError();
  errors.sendFailure(res, error, true); errors.sendFailure(res, error, true);
  assert.equal(res.ends, 1); assert.equal(consumeSse(res.chunks).filter(x => x === '[DONE]').length, 1);
  const closed = sink(); closed.destroyed = true;
  errors.sendFailure(closed, error, true); assert.equal(closed.chunks.length, 0);
});

for (const withId of [false, true]) {
  test(`outer client disconnect interrupts backoff, requestId=${withId}`, async () => {
    let f;
    f = outerFixture({ withId, fakeFetch: async () => {
      setImmediate(() => { f.res.destroyed = true; f.res.emit('close'); });
      return response(503, 'unknown');
    } });
    f.chat.config.apiRetryDelay = 10000;
    await f.run(); await tick();
    assert.equal(f.fetches(), 1); assert.equal(f.counters.tools, 0);
    assert.equal(f.res.ends, 0); assert.equal(f.res.chunks.length, 0);
    assert.equal(f.chat.config.activeRequests.size, 0);
  });
}
for (const stream of [true, false]) {
  test(`success behavior retained with one tool and continuation, stream=${stream}`, async () => {
    let f;
    f = outerFixture({ stream, fakeFetch: async calls => {
      if (calls === 1) return f.first;
      const r = response(200);
      r.arrayBuffer = async () => Buffer.from(JSON.stringify({ choices: [{ message: { content: '合成成功' } }] }));
      r.body = Readable.from([Buffer.from('data: {"choices":[{"delta":{"content":"合成成功"}}]}\n\ndata: [DONE]\n\n')]);
      return r;
    } });
    await f.run();
    assert.equal(f.fetches(), 2); assert.equal(f.counters.tools, 1);
    assert.equal(f.res.statusCode, 200); assert.equal(f.res.ends, 1);
    assert.match(f.res.chunks.join(''), /合成成功/);
    assert(!f.res.chunks.join('').includes('UPSTREAM_ERROR'));
    if (stream) assert.equal(consumeSse(f.res.chunks).filter(x => x === '[DONE]').length, 1);
  });
}
test('reasoning-only semantic retry stops on deterministic HTTP failure', async () => {
  const f = outerFixture({ stream: false, fakeFetch: async calls => {
    if (calls > 1) return response();
    const r = response(200);
    r.arrayBuffer = async () => Buffer.from('{"choices":[{"message":{"content":"","reasoning_content":"synthetic thought"}}]}');
    return r;
  } });
  await f.run();
  assert.equal(f.fetches(), 2); assert.equal(f.counters.tools, 0);
  assert.equal(JSON.parse(f.res.chunks.join('')).error.code, 'sensitive_words_detected');
  assert.equal(f.res.statusCode, 500);
});
test('semantic retry delay is abortable and does not fetch again', async () => {
  const f = fixture('normal', false);
  f.context.apiRetryDelay = 10000;
  f.first.arrayBuffer = async () => {
    setImmediate(() => f.context.abortController.abort());
    return Buffer.from('{"choices":[{"message":{"reasoning_content":"synthetic"}}]}');
  };
  await assert.rejects(f.handler.handle({}, f.res, f.first), e => e.name === 'AbortError');
  assert.equal(f.counters.fetches, 0); assert.equal(f.res.ends, 0);
});
for (const mode of ['error', 'close', 'abort', 'idle']) {
  test(`SSE ${mode}: no silent completion or tool replay, timers released`, async () => {
    const timers = new Set();
    const globals = {
      setTimeout(fn, ms) { const id = setTimeout(() => { timers.delete(id); fn(); }, ms === 90000 ? 15 : ms); timers.add(id); return id; },
      clearTimeout(id) { timers.delete(id); clearTimeout(id); },
      setInterval(fn, ms) { const id = setInterval(fn, ms); timers.add(id); return id; },
      clearInterval(id) { timers.delete(id); clearInterval(id); }
    };
    const f = fixture('normal', true, null, globals);
    f.first.body = new Readable({ read() {
      if (this.started) return; this.started = true;
      this.push(Buffer.from('data: {"choices":[{"delta":{"content":"合成工具调用"}}]}\n\n'));
      if (mode === 'error') setImmediate(() => this.destroy(Error('synthetic private error')));
      if (mode === 'close') setImmediate(() => this.destroy());
      if (mode === 'abort') setImmediate(() => f.context.abortController.abort());
    } });
    let error;
    try { await f.handler.handle({}, f.res, f.first); } catch (e) { error = e; }
    assert(error);
    assert.equal(error.code, mode === 'abort' ? 'aborted' : mode === 'idle' ? 'upstream_timeout' : 'stream_error');
    errors.sendFailure(f.res, error, true, f.context.abortController.signal);
    await tick();
    assert.equal(f.counters.tools, 0); assert.equal(f.counters.fetches, 0);
    assert.equal(timers.size, 0);
    assert(f.first.body.destroyed);
    for (const name of ['data', 'error', 'end', 'close']) assert.equal(f.first.body.listenerCount(name), 0);
    assert.equal(f.res.ends, mode === 'abort' ? 0 : 1);
    assert(!f.res.chunks.join('').includes('synthetic private error'));
  });
}
test('real node-fetch Response: bounded error body and cancellation of success-body read', async () => {
  const { Response } = await import(require('node:url').pathToFileURL(require.resolve('node-fetch')).href);
  const body = new Readable({ read() {} });
  const r = new Response(body, { status: 500, headers: { 'x-request-id': 'synthetic-real-response' } });
  const baselineErrorListeners = body.listenerCount('error');
  const error = await errors.responseError(r, {}, { timeoutMs: 10 });
  await tick();
  assert.equal(error.status, 500); assert.equal(error.requestId, 'synthetic-real-response');
  assert(body.destroyed); assert.equal(body.listenerCount('error'), baselineErrorListeners);
  const f = fixture('normal', false);
  const successBody = new Readable({ read() { setImmediate(() => f.context.abortController.abort()); } });
  const success = new Response(successBody, { status: 200 });
  await assert.rejects(f.handler.handle({}, f.res, success), e => e.name === 'AbortError' && e.status === 200);
  assert(successBody.destroyed); assert.equal(f.counters.fetches, 0); assert.equal(f.res.ends, 0);
});
test('error-reader clears timeout and abort listeners on normal EOF and asynchronous destroy failure', async () => {
  const timers = new Set();
  const module = load('modules/upstreamErrors.js', {}, {
    setTimeout(fn, ms) { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; },
    clearTimeout(id) { timers.delete(id); clearTimeout(id); }
  });
  for (const destroyFailure of [false, true]) {
    const controller = new AbortController();
    const body = destroyFailure ? new Readable({ read() {}, destroy(err, cb) { setImmediate(() => cb(Error('synthetic destroy error'))); } }) : Readable.from([Buffer.from('{}')]);
    await module.readErrorBody(body, { signal: controller.signal, timeoutMs: 5 });
    await tick(); await tick();
    assert.equal(timers.size, 0);
    assert.equal(require('node:events').getEventListeners(controller.signal, 'abort').length, 0);
    for (const name of ['data', 'end', 'error', 'close']) assert.equal(body.listenerCount(name), 0);
  }
});
test('transient HTTP attempts back off only between attempts, not after final failure', async () => {
  const delays = [];
  const fetch = load('modules/chatCompletionHandler.js', { ...chatMocks,
    './upstreamErrors.js': { ...errors, abortableDelay: async ms => delays.push(ms) }
  }, { fakeFetch: async () => response(503, 'unknown') }).fetchWithRetry;
  await assert.rejects(fetch('https://synthetic.invalid', {}, { retries: 3, delay: 17 }), e => e.status === 503 && e.attempt === 3);
  assert.deepEqual(delays, [17, 34]);
});

test('default error-body timeout is independent of headers timeout and preserves HTTP status', async () => {
  const body = new Readable({ read() {} });
  const fetch = fetcher(async () => ({ ...response(500), body }));
  const started = Date.now();
  await assert.rejects(fetch('https://synthetic.invalid', {}, { retries: 1, connectionTimeout: 5 }),
    e => e.status === 500 && e.code === 'unknown' && e.attempt === 1);
  assert(Date.now() - started >= 900);
  assert(Date.now() - started < 3000);
  assert(body.destroyed);
});
test('decoded gzip error bytes are bounded and the pipeline is destroyed', async () => {
  const { gzipSync, createGunzip } = require('node:zlib');
  const { pipeline } = require('node:stream');
  const source = Readable.from([gzipSync(Buffer.alloc(1024 * 1024, 65))]);
  const decoded = createGunzip();
  const complete = new Promise(resolve => pipeline(source, decoded, () => resolve()));
  const result = await errors.readErrorBody(decoded);
  await complete;
  assert.equal(result.outcome, 'limit'); assert.equal(result.text, '');
  assert(decoded.destroyed); assert(source.destroyed);
});
test('diagnostic upstream fields cannot invoke coercion or export a changing getter', () => {
  const writer = new BoundedJsonlWriter({ enabled: true }); let event, phaseReads = 0;
  writer.enqueue = line => { event = JSON.parse(line); };
  assert.doesNotThrow(() => writer.writeEvent({
    get upstreamPhase() { return phaseReads++ === 0 ? 'initial' : 'private'; },
    upstreamAttempt: { valueOf() { throw Error('private'); } }, upstreamCode: 'private'
  }));
  assert.equal(event.upstreamPhase, 'initial'); assert.equal(event.upstreamAttempt, 1);
  assert.equal(event.upstreamCode, 'unknown'); assert(!JSON.stringify(event).includes('private'));
});
test('cancellation after successful headers disposes the unread body', async () => {
  const controller = new AbortController(); const r = response(200); controller.abort();
  await assert.rejects(errors.assertResponseOk(r, { phase: 'tool_continuation' }, controller.signal),
    e => e.name === 'AbortError' && e.status === 200 && e.phase === 'tool_continuation');
  assert(r.body.destroyed); assert.equal(r.body.readableFlowing, null);
});
test('fetch cancellation while reading an HTTP error retains its status and never retries', async () => {
  const controller = new AbortController(); let calls = 0;
  const body = new Readable({ read() { setImmediate(() => controller.abort()); } });
  const fetch = fetcher(async () => { calls++; return { ...response(500), body }; });
  await assert.rejects(fetch('https://synthetic.invalid', { signal: controller.signal }, { phase: 'tool_continuation' }),
    e => e.name === 'AbortError' && e.status === 500 && e.phase === 'tool_continuation' && e.attempt === 1);
  assert.equal(calls, 1); assert(body.destroyed);
});
test('network exception body, URL query and stack are not forwarded or logged by outer catch', async () => {
  const marker = 'synthetic-private-query';
  const f = outerFixture({ fakeFetch: async () => { throw Error('https://synthetic.invalid/?secret=' + marker); } });
  await f.run();
  assert.equal(f.fetches(), 3);
  assert(!JSON.stringify([f.res.chunks, f.logs, f.events]).includes(marker));
  assert.equal(consumeSse(f.res.chunks).find(x => x.error).error.code, 'network_error');
});
