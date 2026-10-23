const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveOpenCodeGoSession } = require('../modules/opencodeGoSession.js');

test('keeps a client session ID unchanged across turns', () => {
  const req = { headers: { 'x-opencode-session': 'session-123' }, body: { messages: [] } };
  assert.equal(resolveOpenCodeGoSession(req, 'secret'), 'session-123');
});

test('derives a stable ID from the first user message across turns', () => {
  const headers = { authorization: 'Bearer client-key' };
  const first = { headers, body: { messages: [{ role: 'user', content: 'Start this conversation' }] } };
  const next = {
    headers,
    body: { messages: [
      { role: 'user', content: 'Start this conversation' },
      { role: 'assistant', content: 'Ready' },
      { role: 'user', content: 'Continue' }
    ] }
  };
  assert.equal(resolveOpenCodeGoSession(first, 'secret'), resolveOpenCodeGoSession(next, 'secret'));
});

test('separates explicit conversations with the same first message', () => {
  const req = id => ({
    headers: {},
    body: { conversationId: id, messages: [{ role: 'user', content: 'Hello' }] }
  });
  assert.notEqual(resolveOpenCodeGoSession(req('one'), 'secret'), resolveOpenCodeGoSession(req('two'), 'secret'));
});

test('does not forward an invalid client header', () => {
  const req = { headers: { 'x-opencode-session': 'invalid\nvalue' }, body: { messages: [{ role: 'user', content: 'Hello' }] } };
  assert.match(resolveOpenCodeGoSession(req, 'secret'), /^vcp_[0-9a-f]{32}$/);
});
