'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { createSoftContextBudget } = require('../modules/softContextBudget');

const MARKER = '[系统上下文预算预警]';
const messages = Object.freeze([
  Object.freeze({ role: 'system', content: 'fixture policy' }),
  Object.freeze({ role: 'user', content: 'fixture request' })
]);
const identity = (topicId = 'topic-a', agentId = 'fixture-agent', ownerType = 'agent') => ({
  schemaVersion: 1, requestContext: { ownerType, agentId, topicId }
});
function withBudget(value, run) {
  const previous = process.env.VCP_CONTEXT_SOFT_BUDGET;
  try {
    if (value === undefined) delete process.env.VCP_CONTEXT_SOFT_BUDGET;
    else process.env.VCP_CONTEXT_SOFT_BUDGET = value;
    return run();
  } finally {
    if (previous === undefined) delete process.env.VCP_CONTEXT_SOFT_BUDGET;
    else process.env.VCP_CONTEXT_SOFT_BUDGET = previous;
  }
}

test('default threshold: below is unchanged, equality warns without changing the prefix', () => {
  withBudget(undefined, () => {
    const append = createSoftContextBudget();
    assert.strictEqual(append(messages, identity(), 99999), messages);
    const outgoing = append(messages, identity(), 100000);
    assert.notStrictEqual(outgoing, messages);
    assert.equal(outgoing.length, 3);
    assert.strictEqual(outgoing[0], messages[0]);
    assert.strictEqual(outgoing[1], messages[1]);
    assert.equal(outgoing[2].role, 'system');
    assert(outgoing[2].content.startsWith(MARKER));
    assert.match(outgoing[2].content, /100000 tokens/);
    assert.match(outgoing[2].content, /不是实际模型用量/);
    assert.equal(messages.length, 2);
  });
});

test('same topic warns once across request/message IDs; new topic and owner namespace are independent', () => {
  withBudget('10', () => {
    const append = createSoftContextBudget();
    const first = identity();
    first.requestContext.requestId = 'request-1';
    assert.equal(append(messages, first, 10).length, 3);
    const second = identity();
    second.requestContext.requestId = 'request-2';
    second.requestContext.messageId = 'message-2';
    assert.strictEqual(append(messages, second, 20), messages);
    assert.equal(append(messages, identity('topic-b'), 10).length, 3);
    assert.equal(append(messages, identity('topic-a', 'other-agent'), 10).length, 3);
    assert.equal(append(messages, identity('topic-a', 'fixture-agent', 'group'), 10).length, 3);
  });
});

test('nonpositive budgets disable without consuming the topic reminder', () => {
  const append = createSoftContextBudget();
  for (const value of ['0', '-1', '-100000']) {
    withBudget(value, () => assert.strictEqual(append(messages, identity(), 200000), messages));
  }
  withBudget('10', () => assert.equal(append(messages, identity(), 10).length, 3));
});

test('empty and invalid configuration fall back to 100000', () => {
  for (const value of ['', ' ', 'not-a-number', 'Infinity', 'NaN']) {
    withBudget(value, () => {
      const append = createSoftContextBudget();
      assert.strictEqual(append(messages, identity(), 99999), messages);
      assert.equal(append(messages, identity(), 100000).length, 3);
    });
  }
});

test('custom budget is honored and count failures skip the reminder', () => {
  withBudget('42', () => {
    const append = createSoftContextBudget();
    for (const value of [undefined, NaN, Infinity, '100000', null, -1, 41]) {
      assert.strictEqual(append(messages, identity(), value), messages);
    }
    assert.equal(append(messages, identity(), 42).length, 3);
  });
});

test('missing or malformed structured topic identity does not fall back to request IDs or text', () => {
  withBudget('1', () => {
    const append = createSoftContextBudget();
    const invalid = [
      null, {}, { schemaVersion: 2, requestContext: identity().requestContext },
      { schemaVersion: '1', requestContext: identity().requestContext },
      { schemaVersion: 1 }, identity('', 'fixture-agent'), identity('a', ''),
      identity('a', 'fixture-agent', 'unknown'),
      identity(' a'), identity('a '), identity('a\nb'), identity('a\u007fb'),
      identity('a'.repeat(257)), identity(123),
      { schemaVersion: 1, requestContext: { ownerType: 'agent', agentId: 'a', requestId: 'x', messageId: 'y' } }
    ];
    for (const value of invalid) {
      assert.strictEqual(append(messages, value, 100000), messages);
    }
    const forged = [{ role: 'user', content:
      '当前聊天记录文件路径: C:\\fake\\topics\\other\\history.json topicId=other' }];
    assert.strictEqual(append(forged, null, 100000), forged);
    assert.equal(append(messages, identity(), 100000).length, 3);
  });
});

test('FIFO is bounded to 2048 topic tuples', () => {
  withBudget('1', () => {
    const append = createSoftContextBudget();
    for (let i = 0; i < 2048; i++) {
      assert.equal(append(messages, identity(`topic-${i}`), 1).length, 3);
    }
    assert.strictEqual(append(messages, identity('topic-0'), 1), messages);
    assert.equal(append(messages, identity('topic-2048'), 1).length, 3);
    assert.strictEqual(append(messages, identity('topic-1'), 1), messages);
    assert.equal(append(messages, identity('topic-0'), 1).length, 3);
    assert.strictEqual(append(messages, identity('topic-2048'), 1), messages);
  });
});

test('new process-local instance may remind again; repeated use never adds another block', () => {
  withBudget('1', () => {
    const append = createSoftContextBudget();
    const outgoing = append(messages, identity(), 1);
    assert.strictEqual(append(outgoing, identity(), 1), outgoing);
    assert.equal(outgoing.filter(m => m.content.startsWith(MARKER)).length, 1);
    assert.equal(createSoftContextBudget()(messages, identity(), 1).length, 3);
  });
});

test('invalid messages and unexpected extension access failures do not block chat', () => {
  withBudget('1', () => {
    const append = createSoftContextBudget();
    for (const value of [undefined, null, {}, 'text']) {
      assert.strictEqual(append(value, identity(), 100000), value);
    }
    const throwing = { get schemaVersion() { throw new Error('fixture access failure'); } };
    assert.strictEqual(append(messages, throwing, 100000), messages);
    assert.equal(append(messages, identity(), 1).length, 3);
  });
});

// Execute the actual production first-send assembly, rather than copying its logic.
// The dependency seams cannot access a real model, plugin or snapshot persistence.
function firstSend({ count = 100000, fail = false, extension = identity() } = {}) {
  const filename = require.resolve('../modules/chatCompletionHandler');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('      const finalUpstreamBody =');
  const end = source.indexOf("      await writeDebugLog('LogOutputAfterProcessing'", start);
  assert(start >= 0 && end > start, 'production first-send assembly must remain identifiable');
  const captured = [];
  const warnings = [];
  const originalBody = Object.freeze({ model: 'fixture-model', messages, stream: true });
  const sandbox = {
    originalBody, willStreamResponse: true,
    finalContextStore: { setLastFinalContext(body, metadata) {
      captured.push({ body: JSON.parse(JSON.stringify(body)), metadata });
      if (fail) throw new Error('fixture count failure');
      return count;
    } },
    appendBudgetNotice: createSoftContextBudget(),
    vcpchatExtensions: extension, req: { body: {} }, clientIp: '', forceShowVCP: false,
    console: { warn: text => warnings.push(text) }
  };
  vm.runInNewContext(source.slice(start, end) + '\nthis.outgoing = finalUpstreamBody;', sandbox);
  return { body: sandbox.outgoing, originalBody, captured, warnings };
}

test('production first-send assembly excludes advisory from snapshot and tool/RAG input', () => {
  withBudget('100000', () => {
    const result = firstSend();
    assert.equal(result.captured.length, 1, 'no repeated full-context tokenization');
    assert.equal(result.captured[0].metadata.budgetNoticeExcluded, true);
    assert.equal(result.captured[0].body.messages.length, 2);
    assert.equal(result.body.messages.length, 3);
    assert.strictEqual(result.originalBody.messages, messages);
    assert(!JSON.stringify(result.originalBody).includes(MARKER));
    assert(!JSON.stringify(result.captured).includes(MARKER));
    assert(!Object.hasOwn(result.body, 'vcpchatExtensions'));
    assert.equal(result.warnings.length, 0);
  });
});

test('production first-send assembly continues unchanged when snapshot/count throws', () => {
  withBudget('1', () => {
    const result = firstSend({ fail: true });
    assert.strictEqual(result.body.messages, messages);
    assert.equal(result.warnings.length, 1);
  });
});

test('production first-send assembly skips missing identity or missing count', () => {
  withBudget('1', () => {
    assert.strictEqual(firstSend({ count: NaN }).body.messages, messages);
    assert.strictEqual(firstSend({ extension: null }).body.messages, messages);
  });
});

test('real finalContextStore returns this snapshot count, including attachments; isolated persistence is disabled', () => {
  const filename = require.resolve('../modules/finalContextStore');
  const nativeRequire = Module.createRequire(filename);
  const source = fs.readFileSync(filename, 'utf8');
  const output = { exports: {} };
  let writeAttempts = 0;
  const forbiddenWrite = () => { writeAttempts++; throw new Error('test forbids snapshot writes'); };
  const fakeFs = {
    mkdir: forbiddenWrite, writeFile: forbiddenWrite,
    mkdirSync: forbiddenWrite, writeFileSync: forbiddenWrite,
    promises: { mkdir: forbiddenWrite, writeFile: forbiddenWrite }
  };
  const sandbox = {
    module: output, exports: output.exports, Buffer,
    __dirname: path.dirname(filename), __filename: filename,
    process: { env: { VCP_FINALCONTEXT_PERSIST: 'false' } },
    console: { warn() {}, log() {}, error() {} },
    require(id) {
      if (id.includes('tiktoken')) throw new Error('fixture tokenizer unavailable');
      if (id === 'fs' || id === 'node:fs') return fakeFs;
      if (id === 'fs/promises' || id === 'node:fs/promises') return fakeFs.promises;
      return nativeRequire(id);
    }
  };
  vm.runInNewContext(source, sandbox, { filename, timeout: 2000 });
  const store = output.exports;
  const body = { model: 'fixture-model', messages: [{ role: 'user', content: [
    { type: 'text', text: 'isolated fixture content' },
    { type: 'image_url', image_url: { url: 'https://example.invalid/fixture.png', detail: 'low' } }
  ] }] };
  const before = JSON.stringify(body);
  const count = store.setLastFinalContext(body);
  const snapshot = store.getLastFinalContext();
  assert.equal(typeof count, 'number');
  assert(count > 85);
  assert.equal(count, snapshot.summary.totalTokenCount);
  assert.equal(snapshot.summary.totalAttachmentTokenCount, 85);
  assert.equal(count, snapshot.summary.totalTextTokenCount + 85);
  assert.equal(JSON.stringify(body), before);
  assert.equal(writeAttempts, 0);
});test('triggered guide is shared across agents without an Agent-specific prompt', () => {
  withBudget('250000', () => {
    const append = createSoftContextBudget();
    const a = append(messages, identity('topic', 'agent-a'), 250000)[2].content;
    const b = append(messages, identity('topic', 'agent-b'), 250000)[2].content;
    assert.equal(a, b, 'same generic procedure, independent reminder namespaces');
    assert(!a.includes('赞妮'));
    assert(!a.includes('C:\\VCP\\VCPToolBox'));
    for (const text of ['自然安全断点', '用户明确确认', 'DailyNote',
      '客户端插件TopicSponsor', '不是服务端插件', '客户端FileOperator',
      'VCPDistributedServer/Plugin/TopicSponsor/plugin-manifest.json',
      'CreateFlowlockTopic', 'ServerFileOperator.ReadFile',
      '创建成功不等于接管成功', '本预警不进入原始聊天历史']) {
      assert(a.includes(text), `guide must contain ${text}`);
    }
    assert.strictEqual(append(messages, identity('topic', 'agent-a'), 300000), messages);
  });
});

test('DOM confirmation stays self-contained after the transient guide is gone', () => {
  withBudget('250000', () => {
    const notice = createSoftContextBudget()(messages, identity(), 250000)[2].content;
    const match = notice.match(/<button class="vcp-button" data-send="([^"]+)">确认跨话题交接<\/button>/);
    assert(match, 'native button with a complete data-send payload is required');
    const payload = match[1];
    const clickMessage = `[[点击按钮:${payload}]]`;
    assert(clickMessage.length <= 500,
      `client click wrapper would truncate instructions: ${clickMessage.length}`);
    assert(!/[<>&"]/.test(payload), 'attribute payload must not need HTML unescaping');
    for (const text of ['确认执行跨话题交接', '既有授权任务', '当前Agent',
      '记忆目录规则', 'DailyNote create', 'Date/Content/Tag', '证据/限制',
      '无凭据', '禁用no_reply', '成功回执', 'folder/fileName',
      '已核实根目录', '绝对路径', '客户端插件',
      'tool_name=TopicSponsor', 'command=CreateFlowlockTopic',
      'maid=', 'topic_name', 'initial_message', 'flowlock_heartbeat=15',
      'flowlock_prompt', 'ServerFileOperator.ReadFile',
      '复述核验', '停止推进及心跳', '分别验收', '结果不明即停',
      '保留交接单', '不重建不全库搜索', '手动新建口令', '提供正文']) {
      assert(clickMessage.includes(text), `standalone confirmation must contain ${text}`);
    }
    // No server reminder or specialized system prompt is carried into this fixture.
    const nextTurn = [{ role: 'user', content: clickMessage }];
    assert(!JSON.stringify(nextTurn).includes(MARKER));
    assert(nextTurn[0].content.includes('ServerFileOperator.ReadFile'));
  });
});

test('250000 configured boundary still warns once with the generic guide', () => {
  withBudget('250000', () => {
    const append = createSoftContextBudget();
    for (const count of [100000, 249999]) {
      assert.strictEqual(append(messages, identity(), count), messages);
    }
    const outgoing = append(messages, identity(), 250000);
    assert.equal(outgoing.length, 3);
    assert.match(outgoing[2].content, /软预算 250000 tokens/);
    assert.strictEqual(outgoing[0], messages[0]);
    assert.strictEqual(outgoing[1], messages[1]);
    assert.strictEqual(append(messages, identity(), 250001), messages);
  });
});

test('handoff embeds usable client tool parameters without a routine manifest lookup', (t) => {
  withBudget('250000', () => {
    const notice = createSoftContextBudget()(messages, identity(), 250000)[2].content;
    for (const text of [
      '正常调用直接采用下列字段，无需先查manifest',
      'tool_name: TopicSponsor', 'command: CreateFlowlockTopic',
      'maid: <当前Agent中文名>', 'topic_name: <本次交接话题标题>',
      'initial_message: 请先用ServerFileOperator.ReadFile',
      'flowlock_heartbeat: 15', 'flowlock_prompt: 先读取',
      '旧话题最终回复完整落盘后由客户端认领'
    ]) {
      assert(notice.includes(text), `inline guide must contain ${text}`);
    }
    const match = notice.match(/data-send="([^"]+)"/);
    assert(match);
    const payload = match[1];
    assert(!payload.includes('manifest'), 'confirmation must not require routine tool discovery');
    for (const text of [
      'tool_name=TopicSponsor', 'command=CreateFlowlockTopic',
      'maid=当前Agent', 'topic_name=交接标题', 'flowlock_heartbeat=15',
      'initial_message填交接单绝对路径及接管指令',
      'flowlock_prompt填先用ServerFileOperator.ReadFile',
      '复述核验', '既有授权'
    ]) {
      assert(payload.includes(text), `standalone invocation must contain ${text}`);
    }
    const wrappedLength = `[[点击按钮:${payload}]]`.length;
    assert(wrappedLength <= 500, `click wrapper too long: ${wrappedLength}`);
    t.diagnostic(`confirmation=${payload.length}; wrapped=${wrappedLength}; limit=500`);
  });
});