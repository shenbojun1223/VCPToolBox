'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Parser = require('../modules/vcpLoop/toolCallParser');
const { ModelOutputGuard } = require('../modules/vcpLoop/modelOutputGuard');

const begin = String.fromCharCode(0x300c, 0x59cb, 0x300d);
const end = String.fromCharCode(0x300c, 0x672b, 0x300d);
const startRequest = '<<<' + '[TOOL_REQUEST]>>>';
const endRequest = '<<<' + '[END_TOOL_REQUEST]>>>';
const openThought = String.fromCharCode(60) + 'think>';
const closeThought = String.fromCharCode(60) + '/think>';
function request(name, payload = '', escape = false) {
  const fieldStart = escape ? begin.slice(0, -1) + 'ESCAPE' + begin.slice(-1) : begin;
  const fieldEnd = escape ? end.slice(0, -1) + 'ESCAPE' + end.slice(-1) : end;
  return [
    startRequest,
    'tool_name:' + begin + name + end + ',',
    'command:' + fieldStart + payload + fieldEnd,
    endRequest
  ].join('\n');
}

for (const escape of [false, true]) {
  test('merge retention: parameter tag literals preserve adjacent requests; escaped=' + escape, () => {
    const payload = "const syntheticFixture = '" + openThought + "';\n// inert parser data";
    const text = [
      request('Before', 'before'),
      request('SyntheticTerminal', payload, escape),
      request('After', 'after')
    ].join('\n');
    const expected = ['Before', 'SyntheticTerminal', 'After'];
    const parsed = Parser.parse(text);
    assert.deepEqual(parsed.map(call => call.name), expected);
    assert.equal(parsed[1].args.command, payload);
    for (const size of [1, 7, 64, text.length]) {
      const guard = new ModelOutputGuard();
      for (let i = 0; i < text.length; i += size) guard.push(text.slice(i, i + size));
      guard.finish();
      assert.equal(guard.halt, null);
      const projected = Parser.parse(guard.executionText());
      assert.deepEqual(projected.map(call => call.name), expected);
      assert.equal(projected[1].args.command, payload);
    }
  });
}
test('merge retention: actual reasoning still suppresses enclosed requests', () => {
  const text = [
    openThought, request('NotExecutable', 'hidden'), closeThought,
    request('Visible', 'visible')
  ].join('\n');
  assert.deepEqual(Parser.parse(text).map(call => call.name), ['Visible']);
});
