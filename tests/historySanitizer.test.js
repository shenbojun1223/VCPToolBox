// tests/historySanitizer.test.js
// 验收测试：modules/vcpLoop/historySanitizer.js
// 目标：证明未闭合工具块残片被切除，完整块与普通文本零副作用。

const path = require('path');
const assert = require('assert');
const {
  inspectToolBlockClosure,
  sanitizeContent,
  sanitizeHistoryMessages
} = require(path.join(__dirname, '..', 'modules', 'vcpLoop', 'historySanitizer.js'));

const S = '<<<[TOOL_REQUEST]>>>';
const E = '<<<[END_TOOL_REQUEST]>>>';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  PASS  ' + name);
  } catch (err) {
    fail++;
    failures.push(name + ' :: ' + err.message);
    console.log('  FAIL  ' + name + ' :: ' + err.message);
  }
}

console.log('historySanitizer acceptance test');

check('plain text untouched', () => {
  assert.strictEqual(sanitizeContent('hello world'), 'hello world');
});

check('complete block preserved', () => {
  const input = 'A' + S + '\nfield\n' + E + 'B';
  assert.strictEqual(sanitizeContent(input), input);
});

check('trailing fragment removed', () => {
  const input = 'prefix\n' + S + '\npartial body';
  assert.strictEqual(sanitizeContent(input), 'prefix\n');
});

check('complete block then fragment', () => {
  const input = 'A' + S + 'ok' + E + 'B' + S + 'partial';
  assert.strictEqual(sanitizeContent(input), 'A' + S + 'ok' + E + 'B');
});

check('multiple complete blocks preserved', () => {
  const input = S + '1' + E + 'mid' + S + '2' + E;
  assert.strictEqual(sanitizeContent(input), input);
});

check('orphan end marker untouched', () => {
  const input = 'text' + E + 'more';
  assert.strictEqual(sanitizeContent(input), input);
});

check('inspect detects unclosed', () => {
  assert.strictEqual(inspectToolBlockClosure(S + 'x').hasUnclosed, true);
});

check('inspect reports closed', () => {
  assert.strictEqual(inspectToolBlockClosure(S + 'x' + E).hasUnclosed, false);
});

check('messages sanitized in place', () => {
  const msgs = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'x' + S + 'y' }
  ];
  sanitizeHistoryMessages(msgs);
  assert.strictEqual(msgs[0].content, 'hi');
  assert.strictEqual(msgs[1].content, 'x');
});

check('array content untouched', () => {
  const parts = [{ type: 'text', text: S + 'inner' }];
  const msgs = [{ role: 'user', content: parts }];
  sanitizeHistoryMessages(msgs);
  assert.strictEqual(msgs[0].content, parts);
  assert.strictEqual(msgs[0].content[0].text, S + 'inner');
});

check('null and empty safe', () => {
  assert.strictEqual(sanitizeContent(''), '');
  assert.strictEqual(sanitizeContent(null), null);
  assert.strictEqual(sanitizeContent(undefined), undefined);
  assert.deepStrictEqual(sanitizeHistoryMessages(null), null);
});

check('onSanitize callback fires', () => {
  let called = 0;
  sanitizeHistoryMessages([{ role: 'assistant', content: S + 'x' }], {
    onSanitize: () => { called++; }
  });
  assert.strictEqual(called, 1);
});

console.log('');
console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) {
  console.log('FAILURES:');
  failures.forEach(f => console.log('  - ' + f));
}
process.exit(fail === 0 ? 0 : 1);