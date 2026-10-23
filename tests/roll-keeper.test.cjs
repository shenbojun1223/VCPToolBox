'use strict';

// tests/roll-keeper.test.cjs
// 轮数保真器（modules/vcpLoop/rollKeeper.js）确定性行为单测。
// 覆盖：参数校验、depth/token 黄灯边界、repeat_halt 硬暂停、三信号优先级、
//       消息数组字节不变、reset，以及 finalContextStore.countTokensForText 的导出与回退口径。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRollKeeper } = require('../modules/vcpLoop/rollKeeper.js');
const { countTokensForText } = require('../modules/finalContextStore.js');

// 模拟 handler 循环体顶端的接线：按契约仅在触发时注入一条 system 消息。
function applyInjection(messages, keeper, recursionDepth) {
  const injection = keeper.evaluate({ recursionDepth, messages });
  if (injection && injection.kind && injection.content) {
    messages.push({ role: 'system', content: injection.content });
  }
  return injection;
}

test('参数校验：非法入参抛 TypeError', () => {
  assert.throws(() => createRollKeeper({ maxRecursion: 0 }), TypeError);
  assert.throws(() => createRollKeeper({ maxRecursion: -1 }), TypeError);
  assert.throws(() => createRollKeeper({ maxRecursion: 2.5 }), TypeError);
  assert.throws(() => createRollKeeper({}), TypeError);
  assert.throws(() => createRollKeeper({ maxRecursion: 10, yellowLightOffset: -1 }), TypeError);
  assert.throws(() => createRollKeeper({ maxRecursion: 10, yellowLightOffset: 1.5 }), TypeError);
  assert.throws(() => createRollKeeper({ maxRecursion: 10, repeatThreshold: 0 }), TypeError);
  assert.throws(() => createRollKeeper({ maxRecursion: 10, repeatThreshold: 2.5 }), TypeError);
  // tokenBudget：必须有限且 >= 0
  assert.throws(() => createRollKeeper({ maxRecursion: 10, tokenBudget: -1 }), TypeError);
  assert.throws(() => createRollKeeper({ maxRecursion: 10, tokenBudget: NaN }), TypeError);
  assert.throws(() => createRollKeeper({ maxRecursion: 10, tokenBudget: Infinity }), TypeError);
  assert.throws(() => createRollKeeper({ maxRecursion: 10, tokenBudget: '100' }), TypeError);
  // tokenYellowRatio：必须有限且 0 < ratio <= 1
  assert.throws(() => createRollKeeper({ maxRecursion: 10, tokenYellowRatio: 0 }), TypeError);
  assert.throws(() => createRollKeeper({ maxRecursion: 10, tokenYellowRatio: -0.5 }), TypeError);
  assert.throws(() => createRollKeeper({ maxRecursion: 10, tokenYellowRatio: 1.5 }), TypeError);
  assert.throws(() => createRollKeeper({ maxRecursion: 10, tokenYellowRatio: NaN }), TypeError);
  assert.throws(() => createRollKeeper({ maxRecursion: 10, tokenYellowRatio: Infinity }), TypeError);
  // 合法入参不抛
  assert.doesNotThrow(() => createRollKeeper({ maxRecursion: 20 }));
  assert.doesNotThrow(() => createRollKeeper({ maxRecursion: 20, yellowLightOffset: 0, repeatThreshold: 1 }));
  assert.doesNotThrow(() => createRollKeeper({ maxRecursion: 20, tokenBudget: 0, tokenYellowRatio: 0.9 }));
  assert.doesNotThrow(() => createRollKeeper({ maxRecursion: 20, tokenBudget: 500000, tokenYellowRatio: 0.9 }));
  assert.doesNotThrow(() => createRollKeeper({ maxRecursion: 20, tokenBudget: 100, tokenYellowRatio: 1 }));
});

test('depth 黄灯：recursionDepth 达 maxRecursion-4 首次触发，且永不再发', () => {
  const keeper = createRollKeeper({ maxRecursion: 20 });

  const below = keeper.evaluate({ recursionDepth: 15 });
  assert.equal(below.kind, null);
  assert.equal(below.content, null);

  const first = keeper.evaluate({ recursionDepth: 16 });
  assert.equal(first.kind, 'depth_yellow');
  assert.equal(typeof first.content, 'string');
  assert.ok(first.content.length > 0);
  // 简报要求模型外化的四要素
  assert.match(first.content, /目标/);
  assert.match(first.content, /已完成/);
  assert.match(first.content, /未决/);
  assert.match(first.content, /下一步/);

  // 再次 evaluate（含达到上限）不得重复注入
  assert.equal(keeper.evaluate({ recursionDepth: 17 }).kind, null);
  assert.equal(keeper.evaluate({ recursionDepth: 20 }).kind, null);
});

test('token 黄灯：budget=0 时禁用；阈值上界触发一次、下界不触发', () => {
  const disabled = createRollKeeper({ maxRecursion: 100, tokenBudget: 0, tokenYellowRatio: 1 });
  assert.equal(
    disabled.evaluate({ recursionDepth: 0, messages: [{ role: 'user', content: 'a '.repeat(5000) }] }).kind,
    null,
    'tokenBudget=0 时必须禁用 token 黄灯'
  );

  const SHORT = 'alpha';
  const LONG = 'alpha beta gamma delta epsilon zeta eta theta';
  const shortTokens = countTokensForText(SHORT).tokenCount;
  const longTokens = countTokensForText(LONG).tokenCount;
  assert.ok(longTokens > shortTokens, '测试样本需保证 token 数递增');
  const threshold = longTokens; // ratio=1 -> ceil(budget*1) = budget
  assert.ok(threshold > 0);

  const keeper = createRollKeeper({ maxRecursion: 100, tokenBudget: threshold, tokenYellowRatio: 1 });

  // 下界：低于阈值不触发
  assert.equal(keeper.evaluate({ recursionDepth: 0, messages: [{ role: 'user', content: SHORT }] }).kind, null);

  // 阈值点：恰好达到阈值触发一次
  const hit = keeper.evaluate({ recursionDepth: 1, messages: [{ role: 'user', content: LONG }] });
  assert.equal(hit.kind, 'token_yellow');
  assert.equal(typeof hit.content, 'string');
  assert.match(hit.content, /目标/);
  assert.match(hit.content, /已完成/);
  assert.match(hit.content, /未决/);
  assert.match(hit.content, /下一步/);
  assert.match(hit.content, /收拢/);
  // 明确口径：本地文本估算、非上游实测用量、附件不计
  assert.match(hit.content, /估算/);
  assert.match(hit.content, /不是上游实测用量/);
  assert.match(hit.content, /附件/);

  // 只发一次
  assert.equal(keeper.evaluate({ recursionDepth: 2, messages: [{ role: 'user', content: LONG }] }).kind, null);
});

test('token 黄灯：只计 string content 与 type=text，base64 不计入', () => {
  const keeper = createRollKeeper({ maxRecursion: 100, tokenBudget: 100, tokenYellowRatio: 1 });
  const bigBase64 = 'data:image/png;base64,' + 'A'.repeat(20000);
  const messages = [
    { role: 'system', content: 'hi' },
    { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: bigBase64 } }] }
  ];
  assert.equal(keeper.evaluate({ recursionDepth: 0, messages }).kind, null, 'base64/图片不得当作文本计入');
});

test('token 黄灯：文案比例来自可配置 ratio，不硬编码 90%', () => {
  const half = createRollKeeper({ maxRecursion: 100, tokenBudget: 10, tokenYellowRatio: 0.5 });
  const halfHit = half.evaluate({ recursionDepth: 0, messages: [{ role: 'user', content: 'a b c d e f g h i j' }] });
  assert.equal(halfHit.kind, 'token_yellow');
  assert.match(halfHit.content, /50%/);
  assert.doesNotMatch(halfHit.content, /90%/);

  const ninety = createRollKeeper({ maxRecursion: 100, tokenBudget: 10, tokenYellowRatio: 0.9 });
  const ninetyHit = ninety.evaluate({ recursionDepth: 0, messages: [{ role: 'user', content: 'a b c d e f g h i j' }] });
  assert.equal(ninetyHit.kind, 'token_yellow');
  assert.match(ninetyHit.content, /90%/);
});

test('未达任何阈值：evaluate 返回 kind=null，注入前后消息数组逐字节不变', () => {
  const keeper = createRollKeeper({ maxRecursion: 20 });
  const messages = [
    { role: 'system', content: 'fixture policy' },
    { role: 'user', content: '请读取该文件' }
  ];
  const before = Buffer.from(JSON.stringify(messages), 'utf8');
  const lengthBefore = messages.length;

  // 未达 depth 黄灯阈值 + 重复失败仅 2 次（< 3）
  assert.equal(applyInjection(messages, keeper, 5).kind, null);
  keeper.record({ name: 'fileReader', args: { path: 'a.txt' }, success: false });
  keeper.record({ name: 'fileReader', args: { path: 'a.txt' }, success: false });
  const pending = applyInjection(messages, keeper, 5);
  assert.equal(pending.kind, null);
  assert.equal(pending.content, null);

  const after = Buffer.from(JSON.stringify(messages), 'utf8');
  assert.equal(messages.length, lengthBefore);
  assert.equal(after.compare(before), 0, '消息数组应逐字节完全不变');
});

test('repeat_halt：同 name+args 连续 3 次 success=false 触发，且只发一次', () => {
  const keeper = createRollKeeper({ maxRecursion: 20 });
  const args = { path: 'a.txt', mode: 'r' };

  keeper.record({ name: 'fileReader', args, success: false });
  keeper.record({ name: 'fileReader', args, success: false });
  assert.equal(keeper.evaluate({ recursionDepth: 0 }).kind, null, '2 次失败不得触发');

  keeper.record({ name: 'fileReader', args, success: false });
  const injection = keeper.evaluate({ recursionDepth: 0 });
  assert.equal(injection.kind, 'repeat_halt');
  assert.equal(typeof injection.content, 'string');
  assert.ok(injection.content.length > 0);

  // 已发标志生效：继续同指纹失败不再重复注入
  keeper.record({ name: 'fileReader', args, success: false });
  assert.equal(keeper.evaluate({ recursionDepth: 0 }).kind, null);
});

test('repeat_halt：中间出现 success 会重置失败计数', () => {
  const keeper = createRollKeeper({ maxRecursion: 20 });
  const args = { path: 'a.txt' };
  keeper.record({ name: 'fileReader', args, success: false });
  keeper.record({ name: 'fileReader', args, success: false });
  keeper.record({ name: 'fileReader', args, success: true }); // 重置
  keeper.record({ name: 'fileReader', args, success: false });
  keeper.record({ name: 'fileReader', args, success: false });
  assert.equal(keeper.evaluate({ recursionDepth: 0 }).kind, null, 'success 后计数应从头累计');

  keeper.record({ name: 'fileReader', args, success: false }); // 第 3 次
  assert.equal(keeper.evaluate({ recursionDepth: 0 }).kind, 'repeat_halt');
});

test('repeat_halt：指纹变化会重置失败计数', () => {
  const keeper = createRollKeeper({ maxRecursion: 20 });
  keeper.record({ name: 'fileReader', args: { path: 'a.txt' }, success: false });
  keeper.record({ name: 'fileReader', args: { path: 'a.txt' }, success: false });
  keeper.record({ name: 'fileReader', args: { path: 'b.txt' }, success: false }); // 指纹变化 → 计数=1
  assert.equal(keeper.evaluate({ recursionDepth: 0 }).kind, null);

  keeper.record({ name: 'fileReader', args: { path: 'b.txt' }, success: false });
  assert.equal(keeper.evaluate({ recursionDepth: 0 }).kind, null, '新指纹 2 次仍未达阈值');
  keeper.record({ name: 'fileReader', args: { path: 'b.txt' }, success: false });
  assert.equal(keeper.evaluate({ recursionDepth: 0 }).kind, 'repeat_halt');
});

test('repeat_halt：参数 key 顺序不影响指纹（stableStringify）', () => {
  const keeper = createRollKeeper({ maxRecursion: 20 });
  keeper.record({ name: 'writer', args: { a: 1, b: 2 }, success: false });
  keeper.record({ name: 'writer', args: { a: 1, b: 2 }, success: false });
  keeper.record({ name: 'writer', args: { b: 2, a: 1 }, success: false }); // 等价参数
  assert.equal(keeper.evaluate({ recursionDepth: 0 }).kind, 'repeat_halt');
});

test('三信号优先级：repeat_halt > token_yellow > depth_yellow，各只发一次', () => {
  const messages = [{ role: 'user', content: 'one two three four five six seven' }];
  const keeper = createRollKeeper({ maxRecursion: 10, tokenBudget: 5, tokenYellowRatio: 1 }); // depth 阈值 6，token 阈值 5
  for (let i = 0; i < 3; i++) {
    keeper.record({ name: 'flaky', args: { id: 1 }, success: false });
  }

  assert.equal(keeper.evaluate({ recursionDepth: 7, messages }).kind, 'repeat_halt');
  assert.equal(keeper.evaluate({ recursionDepth: 7, messages }).kind, 'token_yellow');
  assert.equal(keeper.evaluate({ recursionDepth: 7, messages }).kind, 'depth_yellow');
  assert.equal(keeper.evaluate({ recursionDepth: 7, messages }).kind, null);
  assert.equal(keeper.evaluate({ recursionDepth: 7, messages }).kind, null);
});

test('reset：清空全部标志后可重新触发 depth/token/repeat', () => {
  const keeper = createRollKeeper({ maxRecursion: 20, tokenBudget: 5, tokenYellowRatio: 1 });
  const messages = [{ role: 'user', content: 'one two three four five six' }];

  assert.equal(keeper.evaluate({ recursionDepth: 16, messages }).kind, 'token_yellow');
  assert.equal(keeper.evaluate({ recursionDepth: 16, messages }).kind, 'depth_yellow');
  for (let i = 0; i < 3; i++) {
    keeper.record({ name: 'flaky', args: { id: 1 }, success: false });
  }
  assert.equal(keeper.evaluate({ recursionDepth: 16, messages }).kind, 'repeat_halt');

  keeper.reset();

  // 三类信号均可重新触发
  assert.equal(keeper.evaluate({ recursionDepth: 16, messages }).kind, 'token_yellow');
  assert.equal(keeper.evaluate({ recursionDepth: 16, messages }).kind, 'depth_yellow');
  for (let i = 0; i < 3; i++) {
    keeper.record({ name: 'flaky', args: { id: 1 }, success: false });
  }
  assert.equal(keeper.evaluate({ recursionDepth: 0, messages }).kind, 'repeat_halt');
});

test('countTokensForText：外部导出且保留 cl100k/回退启发式口径', () => {
  assert.equal(typeof countTokensForText, 'function');

  const empty = countTokensForText('');
  assert.equal(empty.tokenCount, 0);
  assert.ok(['@dqbd/tiktoken:cl100k_base', 'estimate'].includes(empty.tokenMethod));

  // 非字符串输入与空串一致：0，不抛错
  assert.equal(countTokensForText(undefined).tokenCount, 0);
  assert.equal(countTokensForText(12345).tokenCount, 0);
  assert.equal(countTokensForText([{ type: 'text', text: 'x' }]).tokenCount, 0);

  const heuristicTokens = (text) => {
    const cjkCount = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    const wordCount = (text.match(/[A-Za-z0-9]+/g) || []).length;
    const symbolCount = (text.match(/[^\s\w\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    return Math.max(0, Math.ceil((cjkCount + wordCount + Math.ceil(symbolCount / 3)) * 1.08));
  };

  const sample = countTokensForText('hello 世界, world!');
  assert.ok(sample.tokenCount > 0);
  if (sample.tokenMethod === 'estimate') {
    assert.equal(sample.tokenCount, heuristicTokens('hello 世界, world!'), '回退口径必须与启发式一致');
  } else {
    assert.equal(sample.tokenMethod, '@dqbd/tiktoken:cl100k_base');
  }
});