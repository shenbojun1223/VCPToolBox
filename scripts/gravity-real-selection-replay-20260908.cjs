'use strict';
// Offline only. No embedding client, server, configuration or network imports.
// Log records include trailing assistant output. Reconstruct the prefix ending
// at the latest receipt; do not count that trailing output as input or evidence.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {createGravityReceiptExperiment} = require('../modules/vcpLoop/gravityStub');
const root = path.resolve(__dirname,'..');
const dir = path.join(__dirname,'gravity-real-selection-20260908');
const manifest = JSON.parse(fs.readFileSync(path.join(dir,'started.json')));
const source = fs.readFileSync(path.join(root,
  'DebugLog/chat/2026-09-08/chat-msg_1788836272272_assistant_3y6x2pe-110604_302-6b7a.json'));
const hash = value => createHash('sha256').update(value).digest('hex');
assert.equal(hash(source),manifest.sourceHash);
const rounds = JSON.parse(source), marker = '<!-- VCP_TOOL_PAYLOAD -->';
const vectors = new Map(manifest.inputs.map(p=>{
  const v = JSON.parse(fs.readFileSync(path.join(dir,'vector-'+p.index+'.json')));
  assert.equal(v.textHash,p.textHash);
  return [p.index,v];
}));
const session = createGravityReceiptExperiment();
const rows = [], audit = [];
let baseline = 0, projected = 0, previousSelected = new Set();
try {
  for(let r=0;r<rounds.length;r++) {
    if(manifest.stopped && r>=manifest.stopped.round) break;
    const logged = rounds[r].request.messages;
    const index = logged.findLastIndex(m=>m.role==='user' &&
      typeof m.content==='string' && m.content.startsWith(marker));
    const item = manifest.inputs.find(p=>p.index===index && p.kind==='receipt');
    const goal = manifest.inputs.filter(p=>p.kind==='goal' &&
      p.index<index && p.round<=r).at(-1);
    if(!item || !goal) continue;
    assert(item.round<=r);
    const messages = logged.slice(0,index+1);
    const before = JSON.stringify(messages);
    const raw = messages[index].content.slice(marker.length).trim();
    const text = JSON.parse(raw).map(p=>p.text).join('\n');
    const userText = messages[goal.index].content;
    assert.equal(hash(text),item.textHash);
    assert.equal(hash(userText),goal.textHash);
    const packet = {version:'rag-refresh-vectors-v1',source:'current-refresh',
      provenance:'unknown',foldEligible:false,
      bindings:{userRawHash:hash(userText),toolResultsRawHash:hash(raw)},
      goal:{vector:vectors.get(goal.index).vector,textHash:goal.textHash,
        transform:'sanitizeForEmbedding:user'},
      payload:{vector:vectors.get(index).vector,textHash:item.textHash,
        transform:'refreshRagBlock:tool-cleanup'}};
    // Packet labels adapt the experiment API only. This is NOT a production RAG
    // packet or evidence that the RAG sanitizer was reproduced.
    const result = session.project(messages,{userText,
      latestPayload:messages[index].content,gravityRawToolResults:raw,
      gravityHandoff:{packet}});
    assert.equal(JSON.stringify(messages),before);
    const changed = messages.flatMap((m,i)=>
      result.messages[i].content!==m.content?[i]:[]);
    const automaticReturns = [...previousSelected].filter(i=>
      result.scores.some(s=>s.index===i && !s.selected) &&
      result.messages[i].content===messages[i].content);
    previousSelected = new Set(changed);
    const size = JSON.stringify(result.messages).length;
    baseline += before.length; projected += size;
    const row = {round:r,latestReceipt:index,
      excludedTrailingMessages:logged.length-messages.length,
      status:result.status,reason:result.reason,scores:result.scores,
      changed,automaticReturns,baseline:before.length,projected:size};
    rows.push(row);
    console.log(JSON.stringify(row));
    for(const i of changed) if(!audit.some(a=>a.index===i)) {
      audit.push({index:i,firstOmittedRound:r,
        omittedMiddle:messages[i].content.slice(marker.length+600,-400)});
    }
  }
} finally {session.close();}
assert(rows.length>0,'No replay rows');
const result = {sourceHash:manifest.sourceHash,rows,baseline,projected,
  saved:baseline-projected,ratio:baseline?(baseline-projected)/baseline:0,
  threshold:0.35,unit:'serialized-messages-json-utf16-code-units',
  scope:'reconstructed prefixes ending at receipts; not verified wire requests',
  realEmbeddings:true,productionRagHandoff:false,ragCleanupReproduced:false,
  productionFolding:false,semanticSafetyValidated:false,newEmbeddingRequests:0,
  automaticReturns:rows.flatMap(r=>r.automaticReturns)};
fs.writeFileSync(path.join(dir,'replay-result-v2.json'),JSON.stringify(result,null,2),{flag:'wx'});
fs.writeFileSync(path.join(dir,'replay-omission-audit-v2.json'),JSON.stringify(audit,null,2),{flag:'wx'});
console.log(JSON.stringify({summary:true,...result,rows:rows.length,
  omittedIndices:audit.map(a=>a.index)}));