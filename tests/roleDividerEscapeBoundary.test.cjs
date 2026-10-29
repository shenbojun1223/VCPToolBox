'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const divider = require('../modules/roleDivider');
const Parser = require('../modules/vcpLoop/toolCallParser');
const matcher = require('../modules/vcpLoop/toolMarkerFuzzyMatcher');
const mark = name => '<'.repeat(3) + '[' + name + ']' + '>'.repeat(3);
const start = mark('TOOL_REQUEST'), end = mark('END_TOOL_REQUEST');
const us = mark('ROLE_DIVIDE_USER'), ue = mark('END_ROLE_DIVIDE_USER');
const es = '「' + '始ESCAPE」', ee = '「' + '末ESCAPE」';
const request = payload => `${start}\ntool_name:「始」Example「末」\ncontent:${es}${payload}${ee}\n${end}`;
for (const payload of ['plain', start, end, start + end, us + 'literal' + ue, start + '\n' + us]) {
  test(`ESCAPE request keeps following receipt role: ${JSON.stringify(payload)}`, () => {
    const req = request(payload);
    const source = req + us + 'ACTUAL_RESULT' + ue + 'AFTER';
    assert.equal(Parser.parse(req).length, 1);
    assert.deepEqual(divider.process([{ role: 'assistant', content: source }]), [
      { role: 'assistant', content: req }, { role: 'user', content: 'ACTUAL_RESULT' },
      { role: 'assistant', content: 'AFTER' }
    ]);
  });
}
test('multiple requests, nested receipts and array metadata survive', () => {
  const req = request(start) + request(end);
  const receipt = '[[' + 'VCP调用结果信息汇总:\nouter\n[[' + 'VCP调用结果信息汇总:\ninner\nVCP调用结果结束]]\nVCP调用结果结束]]';
  const input = [{ role: 'assistant', content: req + us + receipt + ue }];
  Object.defineProperty(input, '__oneRingMeta', { value: { id: 'sentinel' } });
  const result = divider.process(input);
  assert.equal(result[0].content, req);
  assert.deepEqual(result[1], { role: 'user', content: receipt });
  assert.equal(result.__oneRingMeta, input.__oneRingMeta);
});
test('request spanning text parts preserves bytes and image while following receipt splits', () => {
  const req = request(start + '\n' + us);
  const image = { type: 'image_url', image_url: { url: 'https://example.invalid/a.png' } };
  const parts = [
    { type: 'text', text: req.slice(0, 42) }, image,
    { type: 'text', text: req.slice(42) + us + 'ACTUAL_RESULT' + ue + 'AFTER' }
  ];
  const result = divider.process([{ role: 'assistant', content: parts }]);
  assert.equal(result.find(x => x.role === 'user').content, 'ACTUAL_RESULT');
  assert.ok(result[0].content.includes(image));
  assert.equal(result[0].content.filter(x => x.type === 'text').map(x => x.text).join(''), req);
  assert.equal(parts[2].text, req.slice(42) + us + 'ACTUAL_RESULT' + ue + 'AFTER');
});
test('incomplete ESCAPE request protects remainder', () => {
  const content = start + '\ncontent:' + es + us + 'literal';
  assert.equal(Parser.parse(content).length, 0);
  assert.deepEqual(divider.process([{ role: 'assistant', content }]), [{ role: 'assistant', content }]);
});
test('fuzzy tool block boundaries follow shared matcher', () => {
  const old = { enabled: matcher.enabled, debugMode: matcher.debugMode };
  try {
    matcher.configure({ enabled: true });
    const req = request(start).replace(start, '<<[TOOL_REQUEST]>>').replace(/\n<<<\[END_TOOL_REQUEST\]>>>$/, '\n<<[END_TOOL_REQUEST]>>');
    assert.equal(Parser.parse(req).length, 1);
    assert.equal(divider.process([{ role: 'assistant', content: req + us + 'RESULT' + ue }])[1].role, 'user');
  } finally { matcher.configure(old); }
});

const { formatToolResultBatch: escapeBoundaryBatch } = require('../modules/toolResultBatch');
const escapeBoundaryStamp = '2026-10-29T12:51:34.979Z';
const escapeBoundaryStart = mark('VCP_TOOL_BATCH_START:' + escapeBoundaryStamp);
const escapeBoundaryEnd = mark('VCP_TOOL_BATCH_END:' + escapeBoundaryStamp);
for (const payload of [
  escapeBoundaryStart,
  escapeBoundaryStart + '\n' + us + 'LITERAL' + ue + '\n' + escapeBoundaryEnd,
  escapeBoundaryEnd
]) {
  test('batch boundary: earlier ESCAPE request wins over literal batch ' + payload, () => {
    const req = request(payload);
    assert.deepEqual(divider.process([{ role: 'assistant', content: req + us + 'ACTUAL' + ue + 'AFTER' }]), [
      { role: 'assistant', content: req },
      { role: 'user', content: 'ACTUAL' },
      { role: 'assistant', content: 'AFTER' }
    ]);
    assert.equal(Parser.parse(req)[0].args.content, payload);
  });
}
test('batch boundary: earlier batch shields unfinished ESCAPE and internal roles', () => {
  const payload = start + '\ncontent:' + es + us + 'LITERAL' + ue;
  const batch = escapeBoundaryBatch([payload], false);
  assert.deepEqual(divider.process([{ role: 'assistant', content: batch + us + 'ACTUAL' + ue + 'AFTER' }]), [
    { role: 'assistant', content: batch },
    { role: 'user', content: 'ACTUAL' },
    { role: 'assistant', content: 'AFTER' }
  ]);
});
test('batch boundary: earlier legacy receipt shields an unclosed batch literal', () => {
  const receipt = '[[' + 'VCP调用结果信息汇总:\n' + escapeBoundaryStart + '\n' + us + 'LITERAL' + ue + '\nVCP调用结果结束]]';
  assert.deepEqual(divider.process([{ role: 'assistant', content: receipt + us + 'ACTUAL' + ue + 'AFTER' }]), [
    { role: 'assistant', content: receipt },
    { role: 'user', content: 'ACTUAL' },
    { role: 'assistant', content: 'AFTER' }
  ]);
});
test('batch boundary: marker split across text parts preserves image and payload', () => {
  const batch = escapeBoundaryBatch([start + '\ncontent:' + es + us + 'LITERAL' + ue], false);
  const cut = batch.indexOf('VCP_TOOL_BATCH_START') + 8;
  const image = { type: 'image_url', image_url: { url: 'https://example.invalid/batch.png' } };
  const parts = [{ type: 'text', text: batch.slice(0, cut) }, image, { type: 'text', text: batch.slice(cut) }];
  const before = JSON.stringify(parts);
  assert.deepEqual(divider.process([{ role: 'assistant', content: parts }]), [{ role: 'assistant', content: parts }]);
  assert.equal(JSON.stringify(parts), before);
});