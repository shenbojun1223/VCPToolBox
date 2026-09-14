'use strict';
// OFFLINE comparison, not production policy or semantic omission permission.
// Uses only already measured scores and each round's original prefix.
// A 50% older-receipt retention budget is a declared experimental constraint,
// not a similarity threshold fitted to produce savings.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const root = path.resolve(__dirname,'..');
const dir = path.join(__dirname,'gravity-real-selection-20260908');
const source = fs.readFileSync(path.join(root,
  'DebugLog/chat/2026-09-08/chat-msg_1788836272272_assistant_3y6x2pe-110604_302-6b7a.json'));
const rounds = JSON.parse(source);
const measured = JSON.parse(fs.readFileSync(path.join(dir,'replay-result-v2.json')));
assert.equal(createHash('sha256').update(source).digest('hex'),measured.sourceHash);
const marker = '<!-- VCP_TOOL_PAYLOAD -->';
const clean = text => text.replace(/</g,'＜').replace(/>/g,'＞');
const rows = [];
let previous = new Set(), baseline = 0, projected = 0;
for (const row of measured.rows) {
  assert.equal(row.status,'projected');
  const originals = rounds[row.round].request.messages.slice(0,row.latestReceipt+1);
  const before = JSON.stringify(originals);
  const output = structuredClone(originals);
  // Only previously scored eligible receipts. Missing vectors and recent batches
  // are never promoted into candidates by this comparison.
  const ranked = row.scores.slice().sort((a,b)=>
    b.similarity-a.similarity || b.index-a.index);
  const candidateChars = ranked.reduce((n,s)=>n+originals[s.index].content.length,0);
  const target = candidateChars * 0.5;
  const retained = new Set();
  let retainedChars = 0;
  for (const s of ranked) {
    // Keep strongest evidence first, including a whole item crossing the budget.
    if (retainedChars < target) {
      retained.add(s.index);
      retainedChars += originals[s.index].content.length;
    }
  }
  const changed = [];
  const audits = [];
  for (const s of ranked) {
    if (retained.has(s.index)) continue;
    const text = originals[s.index].content;
    const stub = marker+'\n[OFFLINE_RELATIVE_SELECTION originalIndex='+s.index+
      '; originalChars='+text.length+'; literal excerpts, not a summary]\n'+
      text.slice(marker.length,marker.length+600)+
      '\n[... omitted ...]\n'+text.slice(-400);
    if (stub.length >= text.length) continue;
    output[s.index].content = stub;
    changed.push(s.index);
    const parts = JSON.parse(text.slice(marker.length).trim());
    const body = parts.map(p=>p.text).join('\n');
    const shown = output[s.index].content;
    // Evidence visibility probes, not a complete safety classifier.
    const evidence = body.split(/\r?\n/).map(l=>l.trim()).filter(l=>
      /^# (tests|pass|fail|duration_ms)\b/.test(l));
    audits.push({
      index:s.index,
      contentLabel:clean(body.slice(0,240)),
      sourceTestEvidence:evidence,
      evidenceNotVisibleInOwnStub:evidence.filter(l=>!shown.includes(l))
    });
  }
  const automaticReturns = [...previous].filter(i=>
    row.scores.some(s=>s.index===i) && retained.has(i) &&
    output[i].content===originals[i].content);
  previous = new Set(changed);
  assert.equal(JSON.stringify(originals),before);
  for(let i=0;i<originals.length;i++)
    if(!changed.includes(i)) assert.deepEqual(output[i],originals[i]);
  const size = JSON.stringify(output).length;
  baseline += before.length;
  projected += size;
  const report = {
    round:row.round,candidateChars,targetRetainedChars:target,retainedChars,
    rank:ranked.map(s=>({index:s.index,similarity:s.similarity,
      retained:retained.has(s.index)})),
    changed,automaticReturns,baseline:before.length,projected:size,audits
  };
  rows.push(report);
  console.log(JSON.stringify(report));
}
const summary = {
  policy:'relative relevance ranking with 50% old-candidate retention target',
  unit:'serialized-messages-json-utf16-code-units',
  rows:rows.length,baseline,projected,saved:baseline-projected,
  savedRatio:baseline?(baseline-projected)/baseline:0,
  automaticReturns:rows.flatMap(r=>r.automaticReturns),
  omittedReceipts:[...new Set(rows.flatMap(r=>r.changed))],
  evidenceVisibilityWarnings:rows.flatMap(r=>r.audits.filter(a=>
    a.evidenceNotVisibleInOwnStub.length).map(a=>({round:r.round,...a}))),
  semanticSafetyValidated:false,taskQualityValidated:false,
  productionFolding:false,newEmbeddingRequests:0,
  caveat:'Budget forces omission; ranking is not proof omitted content is unnecessary.'
};
fs.writeFileSync(path.join(dir,'relative-comparison.json'),
  JSON.stringify({summary,rows},null,2),{flag:'wx'});
console.log(JSON.stringify({summary}));