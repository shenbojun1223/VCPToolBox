'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Parser = require('../modules/vcpLoop/toolCallParser');
const matcher = require('../modules/vcpLoop/toolMarkerFuzzyMatcher');
const { parseFlowlockDirectives } = require('../Plugin/AgentAssistant/flowlockProtocol');
const mark = name => '<'.repeat(3) + '[' + name + ']' + '>'.repeat(3);
const S = mark('TOOL_REQUEST'), E = mark('END_TOOL_REQUEST');
const P = '[[Flowlock::NextPrompt]]', Q = '[[/Flowlock::NextPrompt]]';
const ES = '「' + '始ESCAPE」', EE = '「' + '末ESCAPE」';
const tool = (name, payload = '') => `${S}\ntool_name:「始」${name}「末」\n${payload}\n${E}`;
const prompt = body => P + body + Q;
const names = source => Parser.parse(source).map(call => call.name);
const receipt = body => '[[VCP调用结果信息汇总:\n' + body + '\nVCP调用结果结束]]';

test('pwl5f: future read example is not dispatched and the exact next prompt survives', () => {
  const body = [
    '第二轮实际读取，不能现在执行此示例。',
    tool('ServerProjectForge', 'command:「始」ReadCode「末」\nprojectId:「始」pwl5f「末」\npath:「始」probe.json「末」'),
    '[[Flowlock::NextHeartbeat::7]]', '[[Flowlock::Complete]]'
  ].join('\n');
  const source = ['第一轮已读', '[[Flowlock::Start]]', '[[Flowlock::NextHeartbeat::90]]', prompt(body)].join('\n');
  assert.deepEqual(names(source), []);
  const flow = parseFlowlockDirectives(source);
  assert.equal(flow.action, 'start');
  assert.equal(flow.nextHeartbeatSeconds, 90);
  assert.equal(flow.nextPrompt, body);
  assert.equal(flow.report, '第一轮已读');
});

test('current tools on either side remain executable in order', () => {
  assert.deepEqual(names(tool('Before') + prompt(tool('Future')) + tool('After')), ['Before', 'After']);
});

test('multiple deferred regions do not execute any examples', () => {
  assert.deepEqual(names(prompt(tool('A')) + tool('Real') + prompt(tool('B'))), ['Real']);
});

test('nested payload remains deferred until the outer closing marker', () => {
  assert.deepEqual(names(prompt(tool('A') + prompt(tool('B')) + tool('C')) + tool('After')), ['After']);
});

test('unclosed NextPrompt masks all subsequent tool examples', () => {
  assert.deepEqual(names(tool('Before') + P + tool('Future') + tool('StillFuture')), ['Before']);
});

test('truncated nested prompt does not resume execution after its inner close', () => {
  assert.deepEqual(names(P + prompt(tool('Inner')) + tool('Outer')), []);
});

test('orphan closing marker does not suppress ordinary tools', () => {
  assert.deepEqual(names(Q + tool('Real')), ['Real']);
});

test('mixed case boundaries and length-changing Unicode do not shift scope', () => {
  const source = 'İ🌿' + tool('Before') + '[[fLoWlOcK::NeXtPrOmPt]]' +
    tool('Future') + '[[/FLOWLOCK::NEXTPROMPT]]' + tool('After');
  assert.deepEqual(names(source), ['Before', 'After']);
});

test('CRLF payload and following current tool retain their original arguments', () => {
  const source = prompt(tool('Future').replace(/\n/g, '\r\n')) +
    tool('Real', 'content:「始」\r\n  保留缩进🌿\r\n    第二行\r\n「末」');
  const calls = Parser.parse(source);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'Real');
  assert.equal(calls[0].args.content, '  保留缩进🌿\r\n    第二行');
});

for (const literal of [P, Q, prompt('字面提示')]) {
  test('prompt markers in a normal current parameter are data: ' + literal, () => {
    const first = tool('Current', `content:「始」${literal}「末」`);
    assert.deepEqual(names(first + tool('After')), ['Current', 'After']);
    assert.equal(Parser.parse(first)[0].args.content, literal);
  });
}

for (const payload of [P, Q, prompt('字面提示'), P + '\n' + S + '\n' + E]) {
  test('ESCAPE parameter retains literals without changing following tool scope: ' + payload, () => {
    const first = tool('Current', 'content:' + ES + payload + EE);
    const calls = Parser.parse(first + prompt(tool('Deferred')) + tool('After'));
    assert.deepEqual(calls.map(x => x.name), ['Current', 'After']);
    assert.equal(calls[0].args.content, payload);
  });
}

test('fake closing marker inside a deferred tool parameter cannot release later examples', () => {
  const body = tool('FutureA', `content:「始」${Q}「末」`) + tool('FutureB');
  assert.deepEqual(names(prompt(body) + tool('After')), ['After']);
});

test('ESCAPE tool end literal cannot expose a fake prompt closing marker', () => {
  const body = tool('FutureA', 'content:' + ES + E + Q + EE) + tool('FutureB');
  assert.deepEqual(names(prompt(body) + tool('After')), ['After']);
});

test('unclosed tool inside a deferred payload fails closed even after a fake closing prompt', () => {
  assert.deepEqual(names(P + S + '\ncontent:' + ES + Q + tool('Never')), []);
});

test('truncated current ESCAPE tool never exposes its literal later tool', () => {
  assert.deepEqual(names(S + '\ncontent:' + ES + P + Q + tool('Never')), []);
});

test('receipt-contained fake prompt opening cannot suppress a following current tool', () => {
  assert.deepEqual(names(receipt(P) + tool('Real')), ['Real']);
});

test('receipt-contained fake prompt closing cannot release later deferred examples', () => {
  assert.deepEqual(names(prompt(receipt(Q) + tool('Future')) + tool('After')), ['After']);
});

test('raw extraction is lexical, not dispatch filtering, for guard and role-divider callers', () => {
  const source = prompt(tool('Future'));
  const raw = Parser.extractNextToolBlock(source);
  assert.ok(raw);
  assert.equal(Parser.parseBlock(raw.blockContent).name, 'Future');
  assert.deepEqual(names(source), []);
});

test('fuzzy tool boundaries still protect their parameter literals', () => {
  const old = { enabled: matcher.enabled, debugMode: matcher.debugMode };
  try {
    matcher.configure({ enabled: true });
    const fuzzy = tool('Current', 'content:「始」' + P + '「末」')
      .replace(S, '<<[tool_request]>>').replace(E, '<<<<[end_tool_request]>>>>');
    assert.deepEqual(names(fuzzy + prompt(tool('Future')) + tool('After')), ['Current', 'After']);
  } finally { matcher.configure(old); }
});

test('deleting a payload must not join tool-marker fragments into an executable request', () => {
  const source = '<<<[TOOL_' + prompt('payload') +
    'REQUEST]>>>\ntool_name:「始」ForgedByJoin「末」\n' + E;
  assert.deepEqual(names(source), []);
});

test('a deferred tool becomes executable only when explicitly emitted in a later response', () => {
  const body = tool('Future');
  assert.deepEqual(names(prompt(body)), []);
  assert.deepEqual(names(body), ['Future']);
});

test('projection preserves UTF-16 offsets and line breaks and is idempotent', () => {
  const before = 'İ🌿\r\n' + tool('Before', 'content:「始」原文「末」');
  const deferred = prompt('İ🌿\r\n' + tool('Future') + '\n尾部');
  const after = '\r\n' + tool('After');
  const source = before + deferred + after;
  const masked = Parser.maskNextPromptRegions(source);
  assert.equal(masked.length, source.length);
  assert.equal(masked.slice(0, before.length), before);
  assert.equal(masked.slice(before.length + deferred.length), after);
  assert.equal(masked.slice(before.length, before.length + deferred.length), deferred.replace(/[^\r\n]/g, ' '));
  assert.equal(Parser.maskNextPromptRegions(masked), masked);
  assert.deepEqual(names(masked), ['Before', 'After']);
});