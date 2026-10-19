const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

function listen(target) {
  return new Promise((resolve, reject) => {
    const server = target.listen(0, '127.0.0.1');
    server.once('error', reject);
    server.once('listening', () => resolve({ server, port: server.address().port }));
  });
}

test('Gemini bridge accepts standard text parts and forwards the conversation', async t => {
  const upstreamMessages = [];
  const upstream = express();
  upstream.use(express.json());
  upstream.post('/v1/chat/completions', (req, res) => {
    upstreamMessages.push(req.body.messages);
    res.json({
      model: req.body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }]
    });
  });
  const upstreamServer = await listen(upstream);
  const oldPort = process.env.PORT;
  process.env.PORT = String(upstreamServer.port);

  delete require.cache[require.resolve('../routes/protocolBridge')];
  const bridge = express();
  bridge.use(express.json());
  bridge.use(require('../routes/protocolBridge'));
  const bridgeServer = await listen(http.createServer(bridge));
  t.after(async () => {
    await new Promise(resolve => bridgeServer.server.close(resolve));
    await new Promise(resolve => upstreamServer.server.close(resolve));
    if (oldPort === undefined) delete process.env.PORT;
    else process.env.PORT = oldPort;
  });

  const response = await fetch(`http://127.0.0.1:${bridgeServer.port}/v1beta/models/go-gemini4-low:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: 'Reply briefly.' }] },
      contents: [
        { role: 'user', parts: [{ text: 'Say OK.' }] },
        { role: 'model', parts: [{ text: 'Understood.' }] },
        { role: 'user', parts: [{ text: 'Now answer.' }] }
      ]
    })
  });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(upstreamMessages[0], [
    { role: 'system', content: 'Reply briefly.' },
    { role: 'user', content: 'Say OK.' },
    { role: 'assistant', content: 'Understood.' },
    { role: 'user', content: 'Now answer.' }
  ]);
  assert.equal(result.candidates[0].content.parts[0].text, 'OK');
});
