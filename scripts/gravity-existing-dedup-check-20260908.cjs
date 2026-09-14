'use strict';
// Bounded offline check of EXISTING VCP deduplication, not omission authority.
// No database, configuration, embedding requests or production changes.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const ResultDeduplicator = require('../ResultDeduplicator');
const dir = path.join(__dirname,'gravity-real-selection-20260908');
const manifest = JSON.parse(fs.readFileSync(path.join(dir,'started.json')));
const replay = JSON.parse(fs.readFileSync(path.join(dir,'replay-result-v2.json')));
const source = fs.readFileSync(path.join(__dirname,'..',
  'DebugLog/chat/2026-09-08/chat-msg_1788836272272_assistant_3y6x2pe-110604_302-6b7a.json'));
assert.equal(createHash('sha256').update(source).digest('hex'),manifest.sourceHash);
const rounds = JSON.parse(source);
const records = new Map(manifest.inputs.map(p => {
  const record = JSON.parse(fs.readFileSync(path.join(dir,'vector-'+p.index+'.json')));
  assert.equal(record.textHash,p.textHash);
  return [p.index,record];
}));
const dimension = records.values().next().value.vector.length;
const deduplicator = new ResultDeduplicator(null,{dimension});
const marker = '<!-- VCP_TOOL_PAYLOAD -->';
async function main() {
  let proposed = 0, oldProposed = 0;
  for (const row of replay.rows) {
    const messages = rounds[row.round].request.messages.slice(0,row.latestReceipt+1);
    const receiptIndices = messages.flatMap((m,i) =>
      m.role==='user' && m.content.startsWith(marker) ? [i] : []);
    const recent = new Set(receiptIndices.slice(-2));
    const inputs = manifest.inputs.filter(p =>
      p.kind==='receipt' && p.round<=row.round && p.index<=row.latestReceipt);
    // Unique opaque text avoids KB whitespace/path identity rules for code.
    // Full bodies remain in messages. No fake KB IDs or path identities.
    const candidates = inputs.map(p => ({
      receiptIndex:p.index,text:'gravity-receipt-identity:'+p.index,
      vector:records.get(p.index).vector
    }));
    const kept = await deduplicator.deduplicate(candidates,
      records.get(row.latestReceipt).vector,
      {stage:'gravity-offline-existing-dedup',maxResults:candidates.length});
    const keptIndices = new Set(kept.map(c=>c.receiptIndex));
    const suppressed = candidates.filter(c=>!keptIndices.has(c.receiptIndex))
      .map(c=>({index:c.receiptIndex,
        protectedRecent:recent.has(c.receiptIndex),
        chars:messages[c.receiptIndex].content.length}));
    proposed += suppressed.length;
    oldProposed += suppressed.filter(s=>!s.protectedRecent).length;
    console.log(JSON.stringify({
      round:row.round,threshold:deduplicator.config.semanticThreshold,
      retained:[...keptIndices],suppressed,
      projectionApplied:false
    }));
  }
  console.log(JSON.stringify({
    summary:true,proposedOccurrences:proposed,olderProposedOccurrences:oldProposed,
    newEmbeddingRequests:0,actualSavedChars:0,
    note:'Semantic suppression proposals only; no proof of identical facts.'
  }));
}
main().catch(e=>{console.error('OFFLINE_CHECK_FAILED',e.name);process.exitCode=1;});