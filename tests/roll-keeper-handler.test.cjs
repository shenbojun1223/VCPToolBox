'use strict';

// tests/roll-keeper-handler.test.cjs
// rollKeeper v2 与真实 handler 的离线接线测试（无真实网络、无真实上游）。
// 使用真实 modules/handlers/{stream,nonStream}Handler.js 与真实 ToolCallParser，
// 仅将 toolExecutor / fetchWithRetry / 上游响应替换为合成对象。

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const StreamHandler = require('../modules/handlers/streamHandler.js');
const NonStreamHandler = require('../modules/handlers/nonStreamHandler.js');
const ToolCallParser = require('../modules/vcpLoop/toolCallParser.js');
const { countTokensForText } = require('../modules/finalContextStore.js');

const TOOL_NAME = 'fileReader';
const PLAIN_TEXT = '任务已完成，无需调用工具。';

function toolCallText() {
  return [
    'assistant wants to read a file',
    '<<<[TOOL_REQUEST]>>>',
    'tool_name:「始」' + TOOL_NAME + '「末」',
    'path:「始」a.txt「末」',
    '<<<[END_TOOL_REQUEST]>>>',
    'after the block'
  ].join('\n');
}

function assertToolCallParses() {
  const parsed = ToolCallParser.parse(toolCallText());
  assert.equal(parsed.length, 1, '合成工具调用必须能被真实 ToolCallParser 解析');
  assert.equal(parsed[0].name, TOOL_NAME);
  assert.equal(parsed[0].archery, false);
  return parsed[0];
}

// ---- 合成上游 ----

function sseBuffer(text) {
  const events = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`
  ];
  return Buffer.from(events.join(''), 'utf8');
}

function streamResponse(text) {
  return { ok: true, status: 200, body: Readable.from([sseBuffer(text)]) };
}

function nonStreamResponse(text) {
  const payload = Buffer.from(JSON.stringify({
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }]
  }), 'utf8');
  return { ok: true, status: 200, body: null, arrayBuffer: async () => payload };
}

// ---- 合成工具执行器 ----

function makeExecutor({ success = false, rawError = 'simulated_failure' } = {}) {
  const executed = [];
  let executeAllCalls = 0;
  return {
    executed,
    get executeAllCalls() { return executeAllCalls; },
    async executeAll(calls) {
      executeAllCalls += 1;
      executed.push(...calls.map(c => ({ name: c.name, args: c.args })));
      return calls.map(() => ({
        success,
        content: [{ type: 'text', text: 'simulated tool failure' }],
        raw: rawError ? { error: rawError } : null
      }));
    },
    async execute(call) {
      executed.push({ name: call.name, args: call.args });
      return { success, content: [{ type: 'text', text: 'simulated tool failure' }], raw: rawError ? { error: rawError } : null };
    }
  };
}

// ---- 合成工具执行器（按调用序号返回不同回执，用于构造 token 阈值前后阶段） ----

function makeSizedExecutor(plans) {
  const executed = [];
  let executeAllCalls = 0;
  const planFor = (index) => (plans && plans.length)
    ? (plans[Math.min(index, plans.length - 1)] || {})
    : {};
  return {
    executed,
    get executeAllCalls() { return executeAllCalls; },
    async executeAll(calls) {
      const plan = planFor(executeAllCalls);
      executeAllCalls += 1;
      executed.push(...calls.map(c => ({ name: c.name, args: c.args })));
      return calls.map(() => ({
        success: plan.success !== false,
        content: [{ type: 'text', text: typeof plan.text === 'string' ? plan.text : 'ok' }],
        raw: null
      }));
    },
    async execute(call) {
      const plan = planFor(executeAllCalls);
      executed.push({ name: call.name, args: call.args });
      return {
        success: plan.success !== false,
        content: [{ type: 'text', text: typeof plan.text === 'string' ? plan.text : 'ok' }],
        raw: null
      };
    }
  };
}

// ---- 合成上游请求捕获：在 fetchWithRetry 边界解析实际序列化 body，保存不可变快照 ----

function makeCapturingFetch(respond) {
  const requests = [];
  const fetchFn = async (url, options) => {
    const body = JSON.parse(options.body);
    const snapshot = {
      url,
      stream: body.stream === true,
      // 深拷贝快照：绝不持有随后仍会被 handler 变更的 messages 引用。
      messages: JSON.parse(JSON.stringify(body.messages))
    };
    requests.push(snapshot);
    return respond(requests.length, snapshot);
  };
  return { requests, fetchFn };
}

// ---- 黄灯判读（只读快照，不含任何 handler 接线） ----

const DEPTH_YELLOW_MARKER = '[系统·轮数保真器·黄灯]';
const TOKEN_YELLOW_MARKER = '[系统·轮数保真器·Token 黄灯]';

function systemContents(request) {
  return (request.messages || [])
    .filter(m => m && m.role === 'system')
    .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
}

function countMarker(request, marker) {
  return systemContents(request).filter(text => text.includes(marker)).length;
}

// 供测试自身核验“越线前/越线后”的本地口径：只拼接 string content 与 type=text 部分，
// 与 rollKeeper 可见文本口径一致；不复制任何循环/送达接线。
function ledgerText(request) {
  const chunks = [];
  for (const message of request.messages || []) {
    if (!message || typeof message !== 'object') continue;
    if (typeof message.content === 'string') { chunks.push(message.content); continue; }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part && part.type === 'text' && typeof part.text === 'string') chunks.push(part.text);
      }
    }
  }
  return chunks.join('\n');
}

function ledgerTokenCount(request) {
  return countTokensForText(ledgerText(request)).tokenCount;
}

// 用真实计数函数把合成文本放大到至少 minTokens，不依赖猜字符/token 比率。
function buildTextReachingTokens(minTokens) {
  let text = 'roll keeper token padding sample unit ';
  while (countTokensForText(text).tokenCount < minTokens) {
    text += text;
  }
  return text;
}

// ---- 合成 res ----

function parseSse(raw) {
  const events = [];
  for (const part of raw.split('\n\n')) {
    const line = part.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') { events.push({ done: true }); continue; }
    try { events.push({ data: JSON.parse(payload) }); } catch { events.push({ raw: payload }); }
  }
  return events;
}

function createStreamRes() {
  const chunks = [];
  return {
    chunks,
    writes: [],
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    ends: 0,
    write(chunk, cb) {
      this.writes.push(String(chunk));
      chunks.push(String(chunk));
      if (typeof cb === 'function') cb();
      return true;
    },
    end(cb) {
      if (!this.writableEnded) { this.writableEnded = true; this.ends += 1; }
      if (typeof cb === 'function') cb();
      return this;
    },
    status() { return this; },
    setHeader() {},
    json() {}
  };
}

function createNonStreamRes() {
  const sent = [];
  return {
    sent,
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    setHeader() {},
    status() { return this; },
    json(payload) { sent.push(payload); this.writableEnded = true; return this; },
    send(payload) { sent.push(payload); this.writableEnded = true; return this; }
  };
}

// ---- 合成 context ----

function baseContext(extra) {
  return Object.assign({
    apiUrl: 'http://offline.invalid',
    apiKey: 'offline-test-key',
    pluginManager: { messagePreprocessors: new Map(), executeMessagePreprocessor: async () => [] },
    writeDebugLog: () => {},
    writeChatLog: () => {},
    webSocketServer: null,
    DEBUG_MODE: false,
    SHOW_VCP_OUTPUT: false,
    apiRetries: 1,
    apiRetryDelay: 0,
    RAGMemoRefresh: false,
    enableRoleDivider: false,
    enableRoleDividerInLoop: false,
    roleDividerIgnoreList: [],
    roleDividerSwitches: {},
    roleDividerScanSwitches: {},
    roleDividerRemoveDisabledTags: true,
    ToolCallParser,
    abortController: new AbortController(),
    originalBody: { model: 'offline-model', messages: [{ role: 'user', content: '请继续' }], requestId: 'req-offline-1', stream: true },
    clientIp: '127.0.0.1',
    _refreshRagBlocksIfNeeded: async (messages) => messages,
    vcpToolUseForbidden: false,
    vcpToolForbiddenReceipt: null,
    apiConnectionTimeoutMs: 1000,
    semanticModelFallbackCandidates: [],
    oneRingResponseMeta: null,
    shouldProcessMedia: false,
    shouldProcessMediaPlus: false,
    isTextOnlyForceTranslateModel: false,
    requestPreprocessorConfig: {},
    reasoningToContentEnabled: false,
    reasoningToContentTag: 'think',
    reasoningToContentModels: [],
    isToolResultError: (raw) => Boolean(raw && raw.error)
  }, extra);
}

// 异步环境隔离：run 若返回 Promise，必须 await 到 resolve/reject 后才恢复环境。
// 否则异步 handler 会在测试值被提前还原后读到宿主环境（例如宿主 40/500000）。
async function withEnv(name, value, run) {
  const previous = process.env[name];
  try {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    return await run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

// —— 用例 ——

test('流式：连续同指纹失败后硬暂停，后续工具不派发，回执 VCP_TOOL_LOOP_STUCK，DONE/end 各一次', async () => {
  assertToolCallParses();
  const executor = makeExecutor({ success: false });
  let fetchCount = 0;
  const context = baseContext({
    maxVCPLoopStream: '40',
    toolExecutor: executor,
    fetchWithRetry: async () => { fetchCount += 1; return streamResponse(toolCallText()); }
  });
  const res = createStreamRes();
  const result = await new StreamHandler(context).handle({}, res, streamResponse(toolCallText()));

  // 3 次失败后，第 4 轮在循环顶端被硬暂停：执行器只被调用 3 次。
  assert.equal(executor.executeAllCalls, 3, '连续失败后必须停止派发后续工具');
  assert.equal(executor.executed.length, 3);
  assert.equal(fetchCount, 3, '硬暂停后不得再发起上游请求');
  assert.equal(res.ends, 1, '流式必须恰好结束一次');
  assert.equal((res.writes.join('').match(/data: \[DONE\]/g) || []).length, 1, '必须恰好发送一个 [DONE]');
  assert.ok(res.writes.join('').trimEnd().endsWith('data: [DONE]'), '最后必须是 [DONE]');

  const events = parseSse(res.writes.join(''));
  const statusEvents = events.filter(e => e.data && e.data.vcp_status);
  // 暂停通知 + 最终 chunk 各携带一次 vcp_status（沿用既有 limit 收口语义）。
  assert.equal(statusEvents.length, 2, '暂停通知与最终 chunk 各带一次 vcp_status');
  assert.ok(statusEvents.every(e => e.data.vcp_status.code === 'VCP_TOOL_LOOP_STUCK'));
  assert.equal(statusEvents[0].data.choices[0].finish_reason, null, '首条为暂停通知');
  const terminal = statusEvents[statusEvents.length - 1];
  assert.equal(terminal.data.vcp_status.pendingToolCalls, 1, '须如实报告未派发的 pending 工具数量');
  assert.equal(terminal.data.vcp_status.current, 3);
  assert.equal(terminal.data.choices[0].finish_reason, 'stop');

  const raw = res.writes.join('');
  assert.doesNotMatch(raw, /VCP_TOOL_LOOP_LIMIT/, 'stuck 与 limit 必须互斥');
  assert.match(raw, /任务尚未完成/);
  assert.match(raw, /不会自动重放/);
  assert.match(raw, /检查阻塞原因/);
  assert.match(raw, /完全相同参数连续失败/);
  assert.equal(result.completed, false, '未完成任务不得标记为成功完成');
});

test('流式：raw 显式失败但 success=true 仍按失败计数（不靠回执文本猜成败）', async () => {
  const executor = makeExecutor({ success: true, rawError: 'simulated_failure' });
  const context = baseContext({
    maxVCPLoopStream: '40',
    toolExecutor: executor,
    fetchWithRetry: async () => streamResponse(toolCallText())
  });
  const res = createStreamRes();
  await new StreamHandler(context).handle({}, res, streamResponse(toolCallText()));
  assert.equal(executor.executeAllCalls, 3, 'success=true + raw 报错仍须累计为失败并硬暂停');
  assert.match(res.writes.join(''), /VCP_TOOL_LOOP_STUCK/);
  assert.equal(res.ends, 1);
});

test('流式：正常路径（无工具）完成一次，保留既有结束语义', async () => {
  let fetchCount = 0;
  const context = baseContext({
    maxVCPLoopStream: '40',
    toolExecutor: makeExecutor(),
    fetchWithRetry: async () => { fetchCount += 1; return streamResponse(PLAIN_TEXT); }
  });
  const res = createStreamRes();
  const result = await new StreamHandler(context).handle({}, res, streamResponse(PLAIN_TEXT));
  assert.equal(fetchCount, 0, '无工具时不得发起续跑请求');
  assert.equal(res.ends, 1);
  assert.equal((res.writes.join('').match(/data: \[DONE\]/g) || []).length, 1);
  assert.doesNotMatch(res.writes.join(''), /VCP_TOOL_LOOP_STUCK|VCP_TOOL_LOOP_LIMIT/);
  assert.equal(result.completed, true);
});

test('流式：达到轮数上限仍保留 VCP_TOOL_LOOP_LIMIT 行为（与 stuck 互斥）', async () => {
  const executor = makeExecutor({ success: false });
  let fetchCount = 0;
  const context = baseContext({
    maxVCPLoopStream: '1',
    toolExecutor: executor,
    fetchWithRetry: async () => { fetchCount += 1; return streamResponse(toolCallText()); }
  });
  const res = createStreamRes();
  await new StreamHandler(context).handle({}, res, streamResponse(toolCallText()));

  assert.equal(executor.executeAllCalls, 1);
  assert.equal(fetchCount, 1);
  assert.equal(res.ends, 1);
  const raw = res.writes.join('');
  assert.match(raw, /VCP_TOOL_LOOP_LIMIT/);
  assert.doesNotMatch(raw, /VCP_TOOL_LOOP_STUCK/);
  const events = parseSse(raw);
  const statusEvents = events.filter(e => e.data && e.data.vcp_status);
  assert.equal(statusEvents.length, 2, 'limit 通知与最终 chunk 各带一次 vcp_status');
  assert.ok(statusEvents.every(e => e.data.vcp_status.code === 'VCP_TOOL_LOOP_LIMIT'));
  const terminal = statusEvents[statusEvents.length - 1];
  assert.equal(terminal.data.choices[0].finish_reason, 'length');
  assert.equal((raw.match(/data: \[DONE\]/g) || []).length, 1);
});

test('流式：非法或非正的 VCP_CONTEXT_SOFT_BUDGET 不影响请求完成（禁用 token 黄灯）', async () => {
  for (const budget of [undefined, '', 'abc', '-5', '0']) {
    await withEnv('VCP_CONTEXT_SOFT_BUDGET', budget, async () => {
      const context = baseContext({
        maxVCPLoopStream: '40',
        toolExecutor: makeExecutor(),
        fetchWithRetry: async () => streamResponse(PLAIN_TEXT)
      });
      const res = createStreamRes();
      const result = await new StreamHandler(context).handle({}, res, streamResponse(PLAIN_TEXT));
      assert.equal(res.ends, 1, 'budget=' + budget + ' 时仍须正常结束');
      assert.equal(result.completed, true, 'budget=' + budget + ' 时不得抛错或改变完成语义');
    });
  }
});

test('非流式：连续同指纹失败后硬暂停，返回一次最终 JSON 且状态为 VCP_TOOL_LOOP_STUCK', async () => {
  assertToolCallParses();
  const executor = makeExecutor({ success: true, rawError: 'simulated_failure' });
  let fetchCount = 0;
  const context = baseContext({
    maxVCPLoopNonStream: '40',
    toolExecutor: executor,
    fetchWithRetry: async () => { fetchCount += 1; return nonStreamResponse(toolCallText()); },
    originalBody: { model: 'offline-model', messages: [{ role: 'user', content: '请继续' }], requestId: 'req-offline-2', stream: false }
  });
  const res = createNonStreamRes();
  const result = await new NonStreamHandler(context).handle({ headers: {} }, res, nonStreamResponse(toolCallText()));

  assert.equal(executor.executeAllCalls, 3, '连续失败后必须停止派发后续工具');
  assert.equal(fetchCount, 3, '硬暂停后不得再发起上游请求');
  assert.equal(res.sent.length, 1, '非流式必须恰好返回一次最终 JSON');

  const final = JSON.parse(res.sent[0].toString('utf8'));
  assert.equal(final.vcp_status.code, 'VCP_TOOL_LOOP_STUCK');
  assert.equal(final.vcp_status.pendingToolCalls, 1, '须如实报告未派发的 pending 工具数量');
  assert.equal(final.choices[0].finish_reason, 'stop');
  const content = final.choices[0].message.content;
  assert.match(content, /任务尚未完成/);
  assert.match(content, /不会自动重放/);
  assert.match(content, /检查阻塞原因/);
  assert.match(content, /完全相同参数连续失败/);
  assert.equal(result.completed, false, '未完成任务不得标记为成功完成');
});

test('非流式：正常路径（无工具）返回一次，无 vcp_status', async () => {
  const executor = makeExecutor();
  const context = baseContext({
    maxVCPLoopNonStream: '40',
    toolExecutor: executor,
    fetchWithRetry: async () => nonStreamResponse(PLAIN_TEXT),
    originalBody: { model: 'offline-model', messages: [{ role: 'user', content: '请继续' }], requestId: 'req-offline-3', stream: false }
  });
  const res = createNonStreamRes();
  const result = await new NonStreamHandler(context).handle({ headers: {} }, res, nonStreamResponse(PLAIN_TEXT));
  assert.equal(res.sent.length, 1);
  assert.equal(executor.executeAllCalls, 0);
  const final = JSON.parse(res.sent[0].toString('utf8'));
  assert.equal(final.vcp_status, undefined);
  assert.equal(final.choices[0].finish_reason, 'stop');
  assert.equal(result.completed, true);
});

test('非流式：达到轮数上限仍保留 VCP_TOOL_LOOP_LIMIT 行为（与 stuck 互斥）', async () => {
  const executor = makeExecutor();
  const context = baseContext({
    maxVCPLoopNonStream: '1',
    toolExecutor: executor,
    fetchWithRetry: async () => nonStreamResponse(toolCallText()),
    originalBody: { model: 'offline-model', messages: [{ role: 'user', content: '请继续' }], requestId: 'req-offline-4', stream: false }
  });
  const res = createNonStreamRes();
  await new NonStreamHandler(context).handle({ headers: {} }, res, nonStreamResponse(toolCallText()));
  assert.equal(res.sent.length, 1);
  const final = JSON.parse(res.sent[0].toString('utf8'));
  assert.equal(final.vcp_status.code, 'VCP_TOOL_LOOP_LIMIT');
  assert.equal(final.vcp_status.code === 'VCP_TOOL_LOOP_STUCK', false);
  assert.equal(final.choices[0].finish_reason, 'length');
});


// —— rollKeeper 黄灯送达（真实 handler + 合成边界，无真实网络/真实模型） ——
//
// 捕获序号映射：第 N 次续轮 request = 迭代索引 N-1 结束时发出的那条续跑 request。
// rollKeeper 在每个迭代顶端 evaluate，黄灯注入后出现在“下一个检查时机”发出的续轮 request 里。
// depth 黄灯在 maxRecursion=40、offset=4 时于 recursionDepth=36 注入，首现于第 37 次续轮。

const ENV_SOFT_BUDGET = 'VCP_CONTEXT_SOFT_BUDGET';
const TOKEN_TEST_BUDGET = '1000'; // ratio 0.9 → 阈值 900
const TOKEN_TEST_THRESHOLD = 900;

test('流式：token 黄灯真实进入序列化续轮 request（越线后下一个检查时机注入一次并随历史保留）', async () => {
  await withEnv(ENV_SOFT_BUDGET, TOKEN_TEST_BUDGET, async () => {
    assertToolCallParses();
    const bigText = buildTextReachingTokens(TOKEN_TEST_THRESHOLD);
    // 阈值构造证据（真实 countTokensForText，不猜字符/token 比率）：
    assert.ok(countTokensForText(bigText).tokenCount >= TOKEN_TEST_THRESHOLD, '合成大回执自身必须达到阈值');
    assert.ok(countTokensForText('ok\n请继续').tokenCount < TOKEN_TEST_THRESHOLD, '初始小消息必须远低于阈值');

    const executor = makeSizedExecutor([{ text: 'ok' }, { text: bigText }]);
    const { requests, fetchFn } = makeCapturingFetch((ordinal) =>
      ordinal <= 3 ? streamResponse(toolCallText()) : streamResponse(PLAIN_TEXT));
    const context = baseContext({ maxVCPLoopStream: '40', toolExecutor: executor, fetchWithRetry: fetchFn });
    const res = createStreamRes();
    const result = await new StreamHandler(context).handle({}, res, streamResponse(toolCallText()));

    assert.equal(requests.length, 4, '两次以上续轮后由无工具正文收口');
    assert.ok(ledgerTokenCount(requests[0]) < TOKEN_TEST_THRESHOLD, '续轮 #1 仍在阈值之下');
    assert.equal(countMarker(requests[0], TOKEN_YELLOW_MARKER), 0, '越线前续轮不得带 Token 黄灯');
    assert.ok(ledgerTokenCount(requests[1]) >= TOKEN_TEST_THRESHOLD, '续轮 #2 已携带足量大回执越过阈值');
    assert.equal(countMarker(requests[1], TOKEN_YELLOW_MARKER), 0, '越过阈值发生在序列化之后，同轮不立即重检');
    assert.equal(countMarker(requests[2], TOKEN_YELLOW_MARKER), 1, '下一个检查时机的续轮 #3 必须有且只有一条 Token 黄灯');
    const injected = systemContents(requests[2]).find(text => text.includes(TOKEN_YELLOW_MARKER));
    assert.match(injected, /已达到软预算阈值 900/);
    assert.match(injected, /软预算 1000 tokens 的 90%/);
    assert.match(injected, /本地文本上下文估算/);
    assert.match(injected, /不是上游实测用量/);
    // 注入后持续携带同一条提示属历史保留，不是重复注入。
    assert.equal(countMarker(requests[3], TOKEN_YELLOW_MARKER), 1);
    assert.equal(systemContents(requests[3]).find(text => text.includes(TOKEN_YELLOW_MARKER)), injected);
    for (const request of requests) {
      assert.ok(countMarker(request, TOKEN_YELLOW_MARKER) <= 1, '每个续轮请求最多一条 Token 黄灯');
      assert.equal(countMarker(request, DEPTH_YELLOW_MARKER), 0, 'depth 阈值 36 之前不得出现轮数黄灯');
    }
    assert.equal(res.ends, 1);
    assert.equal((res.writes.join('').match(/data: \[DONE\]/g) || []).length, 1);
    assert.doesNotMatch(res.writes.join(''), /VCP_TOOL_LOOP_STUCK|VCP_TOOL_LOOP_LIMIT/);
    assert.equal(result.completed, true);
  });
});

test('非流式：token 黄灯真实进入序列化续轮 request（越线后下一个检查时机注入一次并随历史保留）', async () => {
  await withEnv(ENV_SOFT_BUDGET, TOKEN_TEST_BUDGET, async () => {
    assertToolCallParses();
    const bigText = buildTextReachingTokens(TOKEN_TEST_THRESHOLD);
    assert.ok(countTokensForText(bigText).tokenCount >= TOKEN_TEST_THRESHOLD, '合成大回执自身必须达到阈值');

    const executor = makeSizedExecutor([{ text: 'ok' }, { text: bigText }]);
    const { requests, fetchFn } = makeCapturingFetch((ordinal) =>
      ordinal <= 3 ? nonStreamResponse(toolCallText()) : nonStreamResponse(PLAIN_TEXT));
    const context = baseContext({
      maxVCPLoopNonStream: '40',
      toolExecutor: executor,
      fetchWithRetry: fetchFn,
      originalBody: { model: 'offline-model', messages: [{ role: 'user', content: '请继续' }], requestId: 'req-token-nonstream', stream: false }
    });
    const res = createNonStreamRes();
    const result = await new NonStreamHandler(context).handle({ headers: {} }, res, nonStreamResponse(toolCallText()));

    assert.equal(requests.length, 4, '两次以上续轮后由无工具正文收口');
    assert.equal(requests.every(r => r.stream === false), true, '捕获的必须是非流式序列化 body');
    assert.ok(ledgerTokenCount(requests[0]) < TOKEN_TEST_THRESHOLD);
    assert.equal(countMarker(requests[0], TOKEN_YELLOW_MARKER), 0);
    assert.ok(ledgerTokenCount(requests[1]) >= TOKEN_TEST_THRESHOLD);
    assert.equal(countMarker(requests[1], TOKEN_YELLOW_MARKER), 0);
    assert.equal(countMarker(requests[2], TOKEN_YELLOW_MARKER), 1);
    const injected = systemContents(requests[2]).find(text => text.includes(TOKEN_YELLOW_MARKER));
    assert.match(injected, /已达到软预算阈值 900/);
    assert.match(injected, /不是上游实测用量/);
    assert.equal(countMarker(requests[3], TOKEN_YELLOW_MARKER), 1);
    assert.equal(systemContents(requests[3]).find(text => text.includes(TOKEN_YELLOW_MARKER)), injected);
    for (const request of requests) {
      assert.ok(countMarker(request, TOKEN_YELLOW_MARKER) <= 1);
      assert.equal(countMarker(request, DEPTH_YELLOW_MARKER), 0);
    }
    assert.equal(res.sent.length, 1);
    const final = JSON.parse(res.sent[0].toString('utf8'));
    assert.equal(final.choices[0].finish_reason, 'stop');
    assert.equal(final.vcp_status, undefined);
    assert.equal(result.completed, true);
  });
});

test('流式：depth 黄灯真实进入序列化续轮 request（depth36 之后一次，不重复）', async () => {
  await withEnv(ENV_SOFT_BUDGET, '0', async () => {
    assertToolCallParses();
    const executor = makeSizedExecutor([{ text: 'ok' }]);
    const { requests, fetchFn } = makeCapturingFetch((ordinal) =>
      ordinal <= 37 ? streamResponse(toolCallText()) : streamResponse(PLAIN_TEXT));
    const context = baseContext({ maxVCPLoopStream: '40', toolExecutor: executor, fetchWithRetry: fetchFn });
    const res = createStreamRes();
    const result = await new StreamHandler(context).handle({}, res, streamResponse(toolCallText()));

    assert.equal(requests.length, 38, 'depth36 后至少再推进一次检查，再由无工具正文收口');
    for (let i = 0; i < 36; i++) {
      assert.equal(countMarker(requests[i], DEPTH_YELLOW_MARKER), 0, '第 ' + (i + 1) + ' 次续轮不得早于 depth36 出现轮数黄灯');
    }
    assert.equal(countMarker(requests[36], DEPTH_YELLOW_MARKER), 1, 'depth36 迭代之后发出的续轮必须有且只有一条黄灯');
    const injected = systemContents(requests[36]).find(text => text.includes(DEPTH_YELLOW_MARKER));
    assert.match(injected, /36\/40/);
    assert.match(injected, /目标/);
    assert.match(injected, /已完成/);
    assert.match(injected, /未决/);
    assert.match(injected, /下一步/);
    assert.equal(countMarker(requests[37], DEPTH_YELLOW_MARKER), 1, '下一次检查不得重复注入');
    assert.equal(systemContents(requests[37]).find(text => text.includes(DEPTH_YELLOW_MARKER)), injected);
    for (const request of requests) {
      assert.ok(countMarker(request, DEPTH_YELLOW_MARKER) <= 1);
      assert.equal(countMarker(request, TOKEN_YELLOW_MARKER), 0, 'token 黄灯已禁用');
    }
    assert.equal(res.ends, 1);
    assert.equal((res.writes.join('').match(/data: \[DONE\]/g) || []).length, 1);
    assert.doesNotMatch(res.writes.join(''), /VCP_TOOL_LOOP_STUCK|VCP_TOOL_LOOP_LIMIT/);
    assert.equal(result.completed, true);
  });
});

test('非流式：depth 黄灯真实进入序列化续轮 request（depth36 之后一次，不重复）', async () => {
  await withEnv(ENV_SOFT_BUDGET, '0', async () => {
    assertToolCallParses();
    const executor = makeSizedExecutor([{ text: 'ok' }]);
    const { requests, fetchFn } = makeCapturingFetch((ordinal) =>
      ordinal <= 37 ? nonStreamResponse(toolCallText()) : nonStreamResponse(PLAIN_TEXT));
    const context = baseContext({
      maxVCPLoopNonStream: '40',
      toolExecutor: executor,
      fetchWithRetry: fetchFn,
      originalBody: { model: 'offline-model', messages: [{ role: 'user', content: '请继续' }], requestId: 'req-depth-nonstream', stream: false }
    });
    const res = createNonStreamRes();
    const result = await new NonStreamHandler(context).handle({ headers: {} }, res, nonStreamResponse(toolCallText()));

    assert.equal(requests.length, 38, 'depth36 后至少再推进一次检查，再由无工具正文收口');
    for (let i = 0; i < 36; i++) {
      assert.equal(countMarker(requests[i], DEPTH_YELLOW_MARKER), 0, '第 ' + (i + 1) + ' 次续轮不得早于 depth36 出现轮数黄灯');
    }
    assert.equal(countMarker(requests[36], DEPTH_YELLOW_MARKER), 1);
    const injected = systemContents(requests[36]).find(text => text.includes(DEPTH_YELLOW_MARKER));
    assert.match(injected, /36\/40/);
    assert.match(injected, /目标/);
    assert.match(injected, /已完成/);
    assert.match(injected, /未决/);
    assert.match(injected, /下一步/);
    assert.equal(countMarker(requests[37], DEPTH_YELLOW_MARKER), 1, '下一次检查不得重复注入');
    assert.equal(systemContents(requests[37]).find(text => text.includes(DEPTH_YELLOW_MARKER)), injected);
    for (const request of requests) {
      assert.ok(countMarker(request, DEPTH_YELLOW_MARKER) <= 1);
      assert.equal(countMarker(request, TOKEN_YELLOW_MARKER), 0, 'token 黄灯已禁用');
    }
    assert.equal(res.sent.length, 1);
    const final = JSON.parse(res.sent[0].toString('utf8'));
    assert.equal(final.choices[0].finish_reason, 'stop');
    assert.equal(final.vcp_status, undefined);
    assert.equal(result.completed, true);
  });
});

test('流式对照：消息始终低于已设阈值且 depth 未达阈值时，全部续轮 request 不含任何黄灯', async () => {
  await withEnv(ENV_SOFT_BUDGET, '50000', async () => {
    assertToolCallParses();
    const executor = makeSizedExecutor([{ text: 'ok' }]);
    const { requests, fetchFn } = makeCapturingFetch((ordinal) =>
      ordinal <= 3 ? streamResponse(toolCallText()) : streamResponse(PLAIN_TEXT));
    const context = baseContext({ maxVCPLoopStream: '40', toolExecutor: executor, fetchWithRetry: fetchFn });
    const res = createStreamRes();
    const result = await new StreamHandler(context).handle({}, res, streamResponse(toolCallText()));

    assert.equal(requests.length, 4);
    assert.ok(requests.every(r => ledgerTokenCount(r) < 45000), '消息须始终低于已设阈值');
    for (const request of requests) {
      assert.equal(countMarker(request, DEPTH_YELLOW_MARKER), 0);
      assert.equal(countMarker(request, TOKEN_YELLOW_MARKER), 0);
    }
    assert.equal(res.ends, 1);
    assert.equal((res.writes.join('').match(/data: \[DONE\]/g) || []).length, 1);
    assert.doesNotMatch(res.writes.join(''), /VCP_TOOL_LOOP_STUCK|VCP_TOOL_LOOP_LIMIT/);
    assert.equal(result.completed, true);
  });
});

test('非流式对照：消息始终低于已设阈值且 depth 未达阈值时，全部续轮 request 不含任何黄灯', async () => {
  await withEnv(ENV_SOFT_BUDGET, '50000', async () => {
    assertToolCallParses();
    const executor = makeSizedExecutor([{ text: 'ok' }]);
    const { requests, fetchFn } = makeCapturingFetch((ordinal) =>
      ordinal <= 3 ? nonStreamResponse(toolCallText()) : nonStreamResponse(PLAIN_TEXT));
    const context = baseContext({
      maxVCPLoopNonStream: '40',
      toolExecutor: executor,
      fetchWithRetry: fetchFn,
      originalBody: { model: 'offline-model', messages: [{ role: 'user', content: '请继续' }], requestId: 'req-control-nonstream', stream: false }
    });
    const res = createNonStreamRes();
    const result = await new NonStreamHandler(context).handle({ headers: {} }, res, nonStreamResponse(toolCallText()));

    assert.equal(requests.length, 4);
    assert.ok(requests.every(r => ledgerTokenCount(r) < 45000), '消息须始终低于已设阈值');
    for (const request of requests) {
      assert.equal(countMarker(request, DEPTH_YELLOW_MARKER), 0);
      assert.equal(countMarker(request, TOKEN_YELLOW_MARKER), 0);
    }
    assert.equal(res.sent.length, 1);
    const final = JSON.parse(res.sent[0].toString('utf8'));
    assert.equal(final.choices[0].finish_reason, 'stop');
    assert.equal(result.completed, true);
  });
});

test('环境 helper：异步 run 期间读到测试值，resolve/reject 后都恢复原值（不串扰宿主环境）', async () => {
  const original = process.env[ENV_SOFT_BUDGET];
  const sentinel = 'host-sentinel-999999';
  process.env[ENV_SOFT_BUDGET] = sentinel;
  try {
    let seenDuringResolve = null;
    await withEnv(ENV_SOFT_BUDGET, '1234', async () => {
      await Promise.resolve();
      seenDuringResolve = process.env[ENV_SOFT_BUDGET];
    });
    assert.equal(seenDuringResolve, '1234', '异步 run 期间必须读到测试值');
    assert.equal(process.env[ENV_SOFT_BUDGET], sentinel, 'resolve 后必须恢复原值');

    let seenDuringReject = null;
    await assert.rejects(withEnv(ENV_SOFT_BUDGET, '4321', async () => {
      await Promise.resolve();
      seenDuringReject = process.env[ENV_SOFT_BUDGET];
      throw new Error('boom');
    }), /boom/);
    assert.equal(seenDuringReject, '4321', '异步 run 期间必须读到测试值');
    assert.equal(process.env[ENV_SOFT_BUDGET], sentinel, 'reject 后必须恢复原值');

    await withEnv(ENV_SOFT_BUDGET, undefined, async () => {
      await Promise.resolve();
      assert.equal(process.env[ENV_SOFT_BUDGET], undefined, 'undefined 表示临时删除测试键');
    });
    assert.equal(process.env[ENV_SOFT_BUDGET], sentinel, '删除后亦须恢复原值');
  } finally {
    if (original === undefined) delete process.env[ENV_SOFT_BUDGET];
    else process.env[ENV_SOFT_BUDGET] = original;
  }
});