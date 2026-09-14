'use strict';
// Read-only audit of already generated vectors. No configuration or network.
const fs = require('node:fs');
const path = require('node:path');
const {cosineSimilarity} = require('../EmbeddingUtils');
const root = path.resolve(__dirname,'..');
const dir = path.join(__dirname,'gravity-real-selection-20260908');
const source = JSON.parse(fs.readFileSync(path.join(root,
  'DebugLog/chat/2026-09-08/chat-msg_1788836272272_assistant_3y6x2pe-110604_302-6b7a.json')));
const result = JSON.parse(fs.readFileSync(path.join(dir,'replay-result-v2.json')));
const manifest = JSON.parse(fs.readFileSync(path.join(dir,'started.json')));
const vectors = new Map(manifest.inputs.map(p=>[p.index,
  JSON.parse(fs.readFileSync(path.join(dir,'vector-'+p.index+'.json'))).vector]));
const marker = '<!-- VCP_TOOL_PAYLOAD -->';
function display(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi,'Bearer [REDACTED]')
    .replace(/\b(?:sk-|ghp_)[A-Za-z0-9_-]+/g,'[REDACTED]')
    .replace(/</g,'＜').replace(/>/g,'＞');
}
const goal = manifest.inputs.find(p=>p.kind==='goal');
console.log(JSON.stringify({
  goal:display(source[goal.round].request.messages[goal.index].content),
  newEmbeddingRequests:0
}));
for (const p of manifest.inputs.filter(p=>p.kind==='receipt')) {
  const m = source[p.round].request.messages[p.index];
  const parts = JSON.parse(m.content.slice(marker.length).trim());
  const text = parts.map(p=>p.text).join('\n');
  console.log(JSON.stringify({
    index:p.index,firstRound:p.round,chars:text.length,
    preview:display(text.slice(0,650)),
    testEvidence:display(text.split(/\r?\n/).filter(s=>
      /^# (tests|pass|fail|duration_ms)\b|(?:TEST|REGRESSION)_EXIT=/.test(s.trim())
    ).slice(0,12).join('\n'))
  }));
}
for (const row of result.rows) {
  console.log(JSON.stringify({
    round:row.round,latestReceipt:row.latestReceipt,
    scores:row.scores.map(s=>({
      index:s.index,
      goalCosine:cosineSimilarity(vectors.get(goal.index),vectors.get(s.index)),
      payloadCosine:cosineSimilarity(vectors.get(row.latestReceipt),vectors.get(s.index))
    }))
  }));
}