'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const file = 'DebugLog/chat/2026-09-08/chat-msg_1788836272272_assistant_3y6x2pe-110604_302-6b7a.json';
const raw = fs.readFileSync(path.join(root,file));
const rounds = JSON.parse(raw);
const report = {rounds:rounds.length, snapshotRound:8, sha256:crypto.createHash('sha256').update(raw).digest('hex'), messages:[]};
const marker = '<!-- VCP_TOOL_PAYLOAD -->';
for (const [i,m] of rounds[8].request.messages.entries()) {
  if (m.role === 'system') continue;
  const t = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
  const receipt = t.startsWith(marker);
  let parts = [];
  if (receipt) { try { parts = JSON.parse(t.slice(marker.length).trim()); } catch {} }
  report.messages.push({
    index:i, role:m.role, chars:t.length, receipt,
    partTitles:parts.map(p => p.text?.split('\n').find(l => l.trim())?.slice(0,150)),
    testEvidence:parts.flatMap(p => (p.text || '').split('\n').filter(l => /^# (tests|pass|fail|duration_ms|cancelled|skipped|suites)\b/.test(l.trim()))),
    callTools:m.role === 'assistant' ? [...t.matchAll(/tool_name:\s*「始」([^「]+)「末」/g)].map(x => x[1]) : undefined
  });
}
fs.writeFileSync(path.join(__dirname,'gravity-ab-inspect-20260908-result.json'), JSON.stringify(report,null,2));
console.log(JSON.stringify(report));