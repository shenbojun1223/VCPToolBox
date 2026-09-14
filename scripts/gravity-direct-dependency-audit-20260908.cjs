'use strict';
// Offline task-object protection audit. Filename overlap is a conservative
// KEEP signal, never evidence that unmatched content is safe to omit.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const Parser = require('../modules/vcpLoop/toolCallParser');
const root = path.resolve(__dirname,'..');
const dir = path.join(__dirname,'gravity-real-selection-20260908');
const source = fs.readFileSync(path.join(root,
  'DebugLog/chat/2026-09-08/chat-msg_1788836272272_assistant_3y6x2pe-110604_302-6b7a.json'));
const manifest = JSON.parse(fs.readFileSync(path.join(dir,'started.json')));
assert.equal(createHash('sha256').update(source).digest('hex'),manifest.sourceHash);
const rounds = JSON.parse(source);
const replay = JSON.parse(fs.readFileSync(path.join(dir,'replay-result-v2.json')));
const marker = '<!-- VCP_TOOL_PAYLOAD -->';
const filenames = text => [...new Set(
  (String(text).match(/[A-Za-z0-9_-]+(?:[.][A-Za-z0-9_-]+)*[.](?:js|cjs|mjs|json|md)\b/g)||[])
    .map(x=>x.toLowerCase()))];
for (const row of replay.rows) {
  const messages = rounds[row.round].request.messages.slice(0,row.latestReceipt+1);
  const calls = Parser.parse(messages[row.latestReceipt-1].content);
  const targets = [...new Set(calls.flatMap(call =>
    Object.entries(call.args||{}).flatMap(([key,value]) =>
      /^(?:filePath|sourcePath|destinationPath|command|query|search_path)\d*$/.test(key) &&
      typeof value==='string' ? filenames(value) : [])))];
  const candidates = row.scores.map(score=>{
    const receipt = messages[score.index].content;
    const mentions = new Set(filenames(receipt));
    const matched = targets.filter(name=>mentions.has(name));
    let text = '';
    try { text = JSON.parse(receipt.slice(marker.length).trim())
      .map(part=>part.text||'').join('\n'); } catch {}
    const testEvidence = text.split(/\r?\n/).map(s=>s.trim())
      .filter(s=>/^# (?:tests|pass|fail|duration_ms)\b/.test(s));
    return {
      index:score.index,chars:receipt.length,
      topicSimilarity:score.similarity,
      matchedTaskObjects:matched,
      disposition:matched.length ? 'keep-direct-object-evidence' :
        targets.length ? 'review-needed-not-proven-unneeded' : 'no-task-object-signal',
      testEvidence
    };
  });
  console.log(JSON.stringify({
    round:row.round,currentObjects:targets,candidates,
    limits:'Basename matches may overprotect. Misses do not exclude indirect dependencies.',
    projectionApplied:false,newEmbeddingRequests:0
  }));
}