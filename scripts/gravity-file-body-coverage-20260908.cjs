'use strict';
// Read-only, bounded exact-coverage check. No network or historical execution.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const Parser = require('../modules/vcpLoop/toolCallParser');
const sample = path.join(__dirname,'..',
  'DebugLog/chat/2026-09-08/chat-msg_1788836272272_assistant_3y6x2pe-110604_302-6b7a.json');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname,
  'gravity-real-selection-20260908/started.json')));
const source = fs.readFileSync(sample);
const hash = value => createHash('sha256').update(value).digest('hex');
assert.equal(hash(source),manifest.sourceHash);
const rounds = JSON.parse(source);
const marker = '<!-- VCP_TOOL_PAYLOAD -->';
function partsOf(content) {
  try {
    if (typeof content !== 'string' || !content.startsWith(marker)) return null;
    const parts = JSON.parse(content.slice(marker.length).trim());
    return Array.isArray(parts) && parts.length && parts.every(p =>
      p && p.type === 'text' && typeof p.text === 'string' &&
      Object.keys(p).every(k => ['type','text'].includes(k))) ? parts : null;
  } catch { return null; }
}
let checked = 0, covered = 0;
const limit = manifest.stopped ? manifest.stopped.round : rounds.length;
for (let r=0; r<limit; r++) {
  const logged = rounds[r].request.messages;
  const last = logged.findLastIndex(m => m.role === 'user' &&
    typeof m.content === 'string' && m.content.startsWith(marker));
  if (last < 1) continue;
  const messages = logged.slice(0,last+1);
  const indices = messages.flatMap((m,i) => m.role === 'user' &&
    typeof m.content === 'string' && m.content.startsWith(marker) ? [i] : []);
  const recent = new Set(indices.slice(-2));
  const findings = [];
  for (const index of indices) {
    if (recent.has(index) || messages[index-1]?.role !== 'assistant') continue;
    const parts = partsOf(messages[index].content);
    if (!parts) continue;
    const calls = Parser.parse(messages[index-1].content);
    if (!calls.length || calls.some(c => c.archery || c.markHistory)) continue;
    const reads = [];
    for (const call of calls) {
      if (!['ServerFileOperator','FileOperator'].includes(call.name)) continue;
      for (const [key,value] of Object.entries(call.args || {})) {
        const match = key.match(/^command(\d*)$/);
        if (!match || value !== 'ReadFile') continue;
        const file = call.args['filePath'+match[1]];
        if (typeof file === 'string') reads.push(file);
      }
    }
    for (let p=0; p+1<parts.length; p++) {
      const info = parts[p].text.match(/^已读取文件 '([^'\r\n]+)'/);
      if (!info || reads.filter(f => path.win32.basename(f) === info[1]).length !== 1)
        continue;
      const body = parts[p+1].text;
      if (body.length < 2000) continue;
      checked++;
      const covers = [];
      for (let j=0; j<messages.length; j++) {
        if (j === index || messages[j].role === 'system') continue;
        const content = messages[j].content;
        if (typeof content !== 'string') continue;
        const decoded = partsOf(content);
        const texts = decoded ? decoded.map(x => x.text) : [content];
        if (texts.some(text => text.includes(body)))
          covers.push({index:j,role:messages[j].role});
      }
      if (covers.length) covered++;
      findings.push({receipt:index,part:p+1,chars:body.length,
        bodyHash:hash(body),exactCoverMessages:covers});
    }
  }
  console.log(JSON.stringify({round:r,findings}));
}
assert.equal(hash(fs.readFileSync(sample)),manifest.sourceHash);
console.log(JSON.stringify({
  checkedBodyOccurrences:checked,coveredBodyOccurrences:covered,
  projectionApplied:false,actualSavedChars:0,newEmbeddingRequests:0,
  limitations:'Parsed file boundaries are sample heuristics, not trusted metadata. Covering messages must stay visible. Matching command text is not execution evidence.'
}));