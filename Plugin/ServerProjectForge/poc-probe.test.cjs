'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  normalizeAgentStatus, normalizeSession, sha256Text, verifyPrompt,
  runDispatch, runResume,
} = require('./poc-probe.cjs');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-driver-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prompt = '中文派工：只修改 src/slug.js，保留原有连字符。';
  const promptFile = path.join(root, 'prompt.txt');
  const checkpoint = path.join(root, 'checkpoint.json');
  fs.writeFileSync(promptFile, prompt, 'utf8');
  const calls = [];
  let submitted = false;
  let running = Boolean(options.running);
  const client = {
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === 'pi_project_open') return {};
      if (name === 'pi_session_create') return { session: { id: 'test-session' } };
      if (name === 'pi_session_configure') return { session: { permissionMode: 'auto' } };
      if (name === 'pi_agent_prompt') {
        assert.equal(JSON.parse(fs.readFileSync(checkpoint)).state, 'submitting_unknown');
        submitted = true;
        if (options.promptError) throw new Error('ack connection lost');
        return { accepted: true };
      }
      if (name === 'pi_agent_status') {
        return { status: { isRunning: running, pendingToolConfirmations: options.pending || 0 } };
      }
      if (name === 'pi_session_get') {
        return { session: {
          id: 'test-session', permissionMode: options.permission || 'auto',
          messages: submitted ? [{ role: 'user', content: prompt }] : [],
        } };
      }
      throw new Error(`Unexpected tool: ${name}`);
    },
  };
  return {
    root, prompt, checkpoint, calls, client,
    args: { checkpoint, 'prompt-file': promptFile, project: root, 'timeout-ms': '100', 'poll-ms': '1' },
    read: () => JSON.parse(fs.readFileSync(checkpoint, 'utf8')),
    stop: () => { running = false; },
  };
}

test('status supports direct and wrapped responses', () => {
  assert.equal(normalizeAgentStatus({ isRunning: false }).isRunning, false);
  assert.equal(normalizeAgentStatus({ status: { isRunning: true, pendingToolConfirmations: [{ id: 'x' }] } }).pendingToolConfirmations, 1);
});

test('malformed status fails closed', () => {
  for (const raw of [null, {}, { status: {} }, { isRunning: 'false' },
    { isRunning: false, pendingToolConfirmations: -1 }]) {
    assert.throws(() => normalizeAgentStatus(raw), /Invalid pi_agent_status/);
  }
});

test('session supports nested and legacy message arrays', () => {
  const messages = [{ role: 'user', content: '中文' }];
  assert.deepEqual(normalizeSession({ session: { id: 'x', messages } }).messages, messages);
  assert.deepEqual(normalizeSession({ session: { id: 'x' }, messages }).messages, messages);
  assert.deepEqual(normalizeSession({ id: 'x', messages: [] }).messages, []);
  assert.throws(() => normalizeSession({ session: {} }), /messages missing/);
});

test('durable Chinese prompt hash supports string and content blocks', () => {
  const text = '中文 标题__测试';
  for (const content of [text, [{ type: 'text', text: '中文 ' }, { type: 'text', text: '标题__测试' }]]) {
    const verified = verifyPrompt({ session: { messages: [{ role: 'user', content }] } }, sha256Text(text));
    assert.equal(verified.promptHashMatch, true);
  }
  assert.equal(verifyPrompt({ messages: [] }, sha256Text(text)).promptHashMatch, false);
  assert.equal(verifyPrompt({ messages: [{ role: 'user', content: text }] }, sha256Text('损坏')).promptHashMatch, false);
});

test('wrapped dispatch completes with readback and durable hash', async t => {
  const f = fixture(t);
  const result = await runDispatch(f.client, f.args);
  assert.equal(result.ok, true);
  assert.equal(result.promptHashMatch, true);
  assert.equal(f.read().permissionMode, 'auto');
  assert.equal(f.calls.filter(call => call.name === 'pi_session_create').length, 1);
});

test('existing checkpoint refuses duplicate dispatch before any tool', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.checkpoint, '{}');
  await assert.rejects(runDispatch(f.client, f.args), /Checkpoint already exists/);
  assert.equal(f.calls.length, 0);
});

test('permission readback cannot be overridden by configure acknowledgement', async t => {
  const f = fixture(t, { permission: 'inherit' });
  await assert.rejects(runDispatch(f.client, f.args), /mismatch|Expected permissionMode/);
  assert.equal(f.calls.some(call => call.name === 'pi_agent_prompt'), false);
});

test('uncertain prompt acknowledgement persists original session and blocks replay', async t => {
  const f = fixture(t, { promptError: true });
  await assert.rejects(runDispatch(f.client, f.args), /connection lost/);
  assert.equal(f.read().state, 'submitting_unknown');
  assert.equal(f.read().sessionId, 'test-session');
  await assert.rejects(runDispatch(f.client, f.args), /Checkpoint already exists/);
  const resumed = await runResume(f.client, f.checkpoint);
  assert.equal(resumed.ok, true);
  assert.equal(f.calls.filter(call => call.name === 'pi_agent_prompt').length, 1);
});

test('pending tool confirmation is checkpointed without spawning another worker', async t => {
  const f = fixture(t, { running: true, pending: 1 });
  await assert.rejects(runDispatch(f.client, f.args), /pendingToolConfirmations=1/);
  assert.equal(f.read().state, 'blocked_on_confirmation');
  const result = await runResume(f.client, f.checkpoint);
  assert.equal(result.state, 'blocked_on_confirmation');
  assert.equal(result.ok, false);
});

test('timeout resumes the same session read-only, then completes', async t => {
  const f = fixture(t, { running: true });
  f.args['timeout-ms'] = '3';
  const timed = await runDispatch(f.client, f.args);
  assert.equal(timed.state, 'timeout');
  assert.equal(timed.ok, false);
  const before = f.calls.length;
  assert.equal((await runResume(f.client, f.checkpoint)).state, 'running');
  f.stop();
  assert.equal((await runResume(f.client, f.checkpoint)).ok, true);
  assert.equal(f.read().state, 'completed');
  assert.ok(f.calls.slice(before).every(call => ['pi_agent_status', 'pi_session_get'].includes(call.name)));
});

test('resume does not accept idle session without matching durable prompt', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.checkpoint, JSON.stringify({ sessionId: 'test-session', promptSha256: sha256Text(f.prompt) }));
  const result = await runResume(f.client, f.checkpoint);
  assert.equal(result.state, 'idle_unverified');
  assert.equal(result.ok, false);
});

test('invalid timing values fail before checkpoint or tool mutation', async t => {
  const f = fixture(t);
  f.args['timeout-ms'] = 'NaN';
  await assert.rejects(runDispatch(f.client, f.args), /positive finite/);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(f.checkpoint), false);
});