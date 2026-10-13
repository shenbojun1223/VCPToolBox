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

function withEnv(name, value, run) {
  const previous = process.env[name];
  try {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    return run();
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