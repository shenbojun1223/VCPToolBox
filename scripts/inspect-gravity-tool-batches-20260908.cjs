'use strict';
// Read-only inspection of one sample. Never executes historical commands.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const sample = 'DebugLog/chat/2026-09-08/chat-msg_1788836272272_assistant_3y6x2pe-110604_302-6b7a.json';
const rounds = JSON.parse(fs.readFileSync(path.join(root, sample), 'utf8'));
const begin = '<<<[' + 'TOOL_REQUEST' + ']>>>';
const end = '<<<[' + 'END_TOOL_REQUEST' + ']>>>';
const payload = '<!-- VCP_TOOL_PAYLOAD -->';
const count = (text, marker) => text.split(marker).length - 1;
const last = rounds.at(-1)?.request?.messages;
if (!Array.isArray(last)) throw Error('Unexpected sample structure');
console.log(JSON.stringify({sample, rounds: rounds.length}));
for (let i = 0; i < last.length; i++) {
  const m = last[i], text = typeof m.content === 'string' ? m.content : '';
  console.log(JSON.stringify({
    index: i, role: m.role, keys: Object.keys(m), chars: text.length,
    requestStarts: count(text, begin), requestEnds: count(text, end),
    payloadMarkers: count(text, payload),
    payloadAtStart: text.startsWith(payload),
    nativeToolCalls: Array.isArray(m.tool_calls) ? m.tool_calls.length : 0,
    nativeResultId: typeof m.tool_call_id === 'string',
    hasHistoryRetentionFlag: /ink\s*:\s*\u300c始\u300dmark_history\u300c末\u300d/.test(text)
  }));
}
for (const relative of [
  'modules/handlers/streamHandler.js',
  'modules/handlers/nonStreamHandler.js'
]) {
  const lines = fs.readFileSync(path.join(root, relative), 'utf8').split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (/finalToolPayloadForAI|toolResultsTextForRAG|role:\s*['"]assistant['"]|assistantMessageFor/.test(lines[i]))
      hits.push(i);
  }
  const emitted = new Set();
  console.log('--- ' + relative + ' ---');
  for (const hit of hits.slice(0, 16)) {
    for (let i = Math.max(0, hit - 3); i <= Math.min(lines.length - 1, hit + 5); i++) {
      if (!emitted.has(i)) {
        console.log((i + 1) + ': ' + lines[i]);
        emitted.add(i);
      }
    }
  }
}// Inspect result envelopes, never log command arguments or receipt text.
const Parser = require('../modules/vcpLoop/toolCallParser');
console.log('--- batch-envelope-inspection ---');
for (let i = 2; i + 1 < last.length; i++) {
  const callMessage = last[i], resultMessage = last[i + 1];
  if (callMessage.role !== 'assistant' || resultMessage.role !== 'user' ||
      typeof callMessage.content !== 'string' ||
      typeof resultMessage.content !== 'string' ||
      !resultMessage.content.startsWith(payload)) continue;
  const calls = Parser.parse(callMessage.content);
  let envelope;
  try {
    const parsed = JSON.parse(resultMessage.content.slice(payload.length).trim());
    envelope = {
      parsed: true, isArray: Array.isArray(parsed),
      items: Array.isArray(parsed) ? parsed.map(item => ({
        keys: item && typeof item === 'object' ? Object.keys(item) : [],
        type: item?.type,
        textChars: typeof item?.text === 'string' ? item.text.length : null,
        nestedJsonKeys: (() => {
          if (typeof item?.text !== 'string') return null;
          try {
            const nested = JSON.parse(item.text);
            return nested && typeof nested === 'object' ? Object.keys(nested) : [];
          } catch { return null; }
        })()
      })) : undefined
    };
  } catch {
    envelope = {parsed: false, reason: 'non-json-or-truncated'};
  }
  console.log(JSON.stringify({
    callIndex: i, resultIndex: i + 1,
    calls: calls.map(call => ({
      name: call.name, archery: call.archery, markHistory: call.markHistory
    })),
    envelope
  }));
}
console.log('--- round-prefix-check ---');
for (let r = 1; r < rounds.length; r++) {
  const previous = rounds[r - 1].request.messages;
  const current = rounds[r].request.messages;
  const changedExistingNonSystemIndices = [];
  for (let i = 0; i < previous.length; i++) {
    if (previous[i].role !== 'system' &&
        JSON.stringify(previous[i]) !== JSON.stringify(current[i]))
      changedExistingNonSystemIndices.push(i);
  }
  console.log(JSON.stringify({
    round: r, appendedCount: current.length - previous.length,
    changedExistingNonSystemIndices
  }));
}