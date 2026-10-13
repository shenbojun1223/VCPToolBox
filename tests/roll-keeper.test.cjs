'use strict';

// tests/roll-keeper.test.cjs
// 轮数保真器（modules/vcpLoop/rollKeeper.js）确定性行为单测。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRollKeeper } = require('../modules/vcpLoop/rollKeeper.js');

// 模拟 handler 循环体顶端的接线：按契约仅在触发时注入一条 system 消息。
function applyInjection(messages, keeper, recursionDepth) {
  const injection = keeper.evaluate({ recursionDepth });
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
  // 合法入参不抛
  assert.doesNotThrow(() => createRollKeeper({ maxRecursion: 20 }));
  assert.doesNotThrow(() => createRollKeeper({ maxRecursion: 20, yellowLightOffset: 0, repeatThreshold: 1 }));
});

test('黄灯：recursionDepth 达 maxRecursion-4 首次触发，且永不再发', () => {
  const keeper = createRollKeeper({ maxRecursion: 20 });

  const below = keeper.evaluate({ recursionDepth: 15 });
  assert.equal(below.kind, null);
  assert.equal(below.content, null);

  const first = keeper.evaluate({ recursionDepth: 16 });
  assert.equal(first.kind, 'yellow');
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

test('未达阈值：evaluate 返回 kind=null，注入前后消息数组逐字节不变', () => {
  const keeper = createRollKeeper({ maxRecursion: 20 });
  const messages = [
    { role: 'system', content: 'fixture policy' },
    { role: 'user', content: '请读取该文件' }
  ];
  const before = Buffer.from(JSON.stringify(messages), 'utf8');
  const lengthBefore = messages.length;

  // 未达黄灯阈值 + 重复失败仅 2 次（< 3）
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

test('重复失败：同 name+args 连续 3 次 success=false 触发 repeat，且只发一次', () => {
  const keeper = createRollKeeper({ maxRecursion: 20 });
  const args = { path: 'a.txt', mode: 'r' };

  keeper.record({ name: 'fileReader', args, success: false });
  keeper.record({ name: 'fileReader', args, success: false });
  assert.equal(keeper.evaluate({ recursionDepth: 0 }).kind, null, '2 次失败不得触发');

  keeper.record({ name: 'fileReader', args, success: false });
  const injection = keeper.evaluate({ recursionDepth: 0 });
  assert.equal(injection.kind, 'repeat');
  assert.equal(typeof injection.content, 'string');
  assert.ok(injection.content.length > 0);

  // 已发标志生效：继续同指纹失败不再重复注入
  keeper.record({ name: 'fileReader', args, success: false });
  assert.equal(keeper.evaluate({ recursionDepth: 0 }).kind, null);
});

test('重复失败：中间出现 success 会重置失败计数', () => {
  const keeper = createRollKeeper({ maxRecursion: 20 });
  const args = { path: 'a.txt' };
  keeper.record({ name: 'fileReader', args, success: false });
  keeper.record({ name: 'fileReader', args, success: false });
  keeper.record({ name: 'fileReader', args, success: true }); // 重置
  keeper.record({ name: 'fileReader', args, success: false });
  keeper.record({ name: 'fileReader', args, success: false });
  assert.equal(keeper.evaluate({ recursionDepth: 0 }).kind, null, 'success 后计数应从头累计');

  keeper.record({ name: 'fileReader', args, success: false }); // 第 3 次
  assert.equal(keeper.evaluate({ recursionDepth: 0 }).kind, 'repeat');
});

test('重复失败：指纹变化会重置失败计数', () => {
  const keeper = createRollKeeper({ maxRecursion: 20 });
  keeper.record({ name: 'fileReader', args: { path: 'a.txt' }, success: false });
  keeper.record({ name: 'fileReader', args: { path: 'a.txt' }, success: false });
  keeper.record({ name: 'fileReader', args: { path: 'b.txt' }, success: false }); // 指纹变化 → 计数=1
  assert.equal(keeper.evaluate({ recursionDepth: 0 }).kind, null);

  keeper.record({ name: 'fileReader', args: { path: 'b.txt' }, success: false });
  assert.equal(keeper.evaluate({ recursionDepth: 0 }).kind, null, '新指纹 2 次仍未达阈值');
  keeper.record({ name: 'fileReader', args: { path: 'b.txt' }, success: false });
  assert.equal(keeper.evaluate({ recursionDepth: 0 }).kind, 'repeat');
});

test('重复失败：参数 key 顺序不影响指纹（stableStringify）', () => {
  const keeper = createRollKeeper({ maxRecursion: 20 });
  keeper.record({ name: 'writer', args: { a: 1, b: 2 }, success: false });
  keeper.record({ name: 'writer', args: { a: 1, b: 2 }, success: false });
  keeper.record({ name: 'writer', args: { b: 2, a: 1 }, success: false }); // 等价参数
  assert.equal(keeper.evaluate({ recursionDepth: 0 }).kind, 'repeat');
});

test('优先级：repeat 优先于 yellow，且两者各自只发一次', () => {
  const keeper = createRollKeeper({ maxRecursion: 10 }); // 黄灯阈值 6
  for (let i = 0; i < 3; i++) {
    keeper.record({ name: 'flaky', args: { id: 1 }, success: false });
  }
  const first = keeper.evaluate({ recursionDepth: 7 });
  assert.equal(first.kind, 'repeat');
  const second = keeper.evaluate({ recursionDepth: 7 });
  assert.equal(second.kind, 'yellow');
  assert.equal(keeper.evaluate({ recursionDepth: 7 }).kind, null);
});

test('reset：清空状态后可重新触发黄灯与 repeat', () => {
  const keeper = createRollKeeper({ maxRecursion: 20 });

  assert.equal(keeper.evaluate({ recursionDepth: 16 }).kind, 'yellow');
  assert.equal(keeper.evaluate({ recursionDepth: 16 }).kind, null);
  for (let i = 0; i < 3; i++) {
    keeper.record({ name: 'flaky', args: { id: 1 }, success: false });
  }
  assert.equal(keeper.evaluate({ recursionDepth: 16 }).kind, 'repeat');

  keeper.reset();

  // 黄灯可重新触发
  assert.equal(keeper.evaluate({ recursionDepth: 16 }).kind, 'yellow');
  // repeat 可重新触发
  for (let i = 0; i < 3; i++) {
    keeper.record({ name: 'flaky', args: { id: 1 }, success: false });
  }
  assert.equal(keeper.evaluate({ recursionDepth: 0 }).kind, 'repeat');
});
