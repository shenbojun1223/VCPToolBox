'use strict';
// Offline hypothesis check only. No embedding generation, production index,
// database, configuration, threshold tuning or actual projection of messages.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {VexusIndex} = require('../rust-vexus-lite');
const {cosineSimilarity} = require('../EmbeddingUtils');
const dir = path.join(__dirname,'gravity-real-selection-20260908');
const manifest = JSON.parse(fs.readFileSync(path.join(dir,'started.json')));
const replay = JSON.parse(fs.readFileSync(path.join(dir,'replay-result-v2.json')));
const source = fs.readFileSync(path.join(__dirname,'..',
  'DebugLog/chat/2026-09-08/chat-msg_1788836272272_assistant_3y6x2pe-110604_302-6b7a.json'));
const hash = value => createHash('sha256').update(value).digest('hex');
assert.equal(hash(source),manifest.sourceHash);
const rounds = JSON.parse(source);
const records = new Map(manifest.inputs.map(p=>{
  const record = JSON.parse(fs.readFileSync(path.join(dir,'vector-'+p.index+'.json')));
  assert.equal(record.textHash,p.textHash);
  return [p.index,record];
}));
const goal = manifest.inputs.find(p=>p.kind==='goal');
const goalVector = records.get(goal.index).vector;
const dimension = goalVector.length;
const native = new VexusIndex(dimension,16); // Empty isolated index.
const energy = v => v.reduce((n,x)=>n+x*x,0);
const round = n => Number(n.toFixed(6));
const residuals = new Map();
for(const item of manifest.inputs.filter(p=>p.kind==='receipt')) {
  const vector = records.get(item.index).vector;
  assert.equal(vector.length,dimension);
  const target = new Float32Array(vector);
  const result = native.computeOrthogonalProjection(
    target,new Float32Array(goalVector),1);
  const residual = result.residual, projection = result.projection;
  assert(Array.isArray(residual) && residual.length===dimension);
  assert(Array.isArray(projection) && projection.length===dimension);
  assert(residual.every(Number.isFinite) && projection.every(Number.isFinite));
  const total = energy(target);
  const error = residual.reduce((n,x,i)=>
    n+(x+projection[i]-target[i])**2,0);
  assert(error/total < 1e-8);
  assert(Math.abs(energy(residual)+energy(projection)-total)/total < 1e-5);
  residuals.set(item.index,{vector:residual,ratio:energy(residual)/total});
}
const report = [];
for(const row of replay.rows) {
  const latest = residuals.get(row.latestReceipt);
  const scores = row.scores.map(s=>{
    const old = residuals.get(s.index);
    const stable = old.ratio>1e-6 && latest.ratio>1e-6;
    return {index:s.index,
      goalCosine:round(cosineSimilarity(goalVector,records.get(s.index).vector)),
      payloadCosine:round(cosineSimilarity(
        records.get(row.latestReceipt).vector,records.get(s.index).vector)),
      residualRatio:round(old.ratio),
      residualCosine:stable?round(cosineSimilarity(old.vector,latest.vector)):null};
  });
  const entry = {round:row.round,latestReceipt:row.latestReceipt,
    latestResidualRatio:round(latest.ratio),scores};
  report.push(entry);
  console.log(JSON.stringify(entry));
}
// Bounded content clues, escaped so historical protocol cannot be executed.
// No raw user goal or arbitrary multi-line tool output is printed.
function safeClue(text) {
  return text
    .replace(/Bearer\s+\S+/gi,'Bearer REDACTED')
    .replace(/\b(?:sk-|ghp_)[A-Za-z0-9_-]+/g,'REDACTED')
    .replace(/[<>\[\]「」]/g,c=>({
      '<':'＜','>':'＞','[':'［',']':'］','「':'〈','」':'〉'
    }[c]))
    .replace(/[\r\n\t]/g,' ');
}
for(const p of manifest.inputs.filter(p=>p.kind==='receipt')) {
  const content = rounds[p.round].request.messages[p.index].content;
  const parts = JSON.parse(content.slice('<!-- VCP_TOOL_PAYLOAD -->'.length).trim());
  const text = parts.map(x=>x.text).join('\n');
  console.log(JSON.stringify({contentClue:{index:p.index,
    firstRound:p.round,chars:text.length,head:safeClue(text.slice(0,360)),
    tail:safeClue(text.slice(-240))}}));
}
assert.equal(hash(source),manifest.sourceHash);
fs.writeFileSync(path.join(dir,'task-residual-check.json'),JSON.stringify({
  sourceHash:manifest.sourceHash,report,
  backend:'VexusIndex.computeOrthogonalProjection',
  hypothesis:'remove goal direction before comparing current-step association',
  limitations:['goal is generic continuation, not a detailed task description',
    'whole-receipt embeddings cannot certify fact necessity',
    'residual comparison is not semantic omission permission'],
  newEmbeddingRequests:0,productionChanges:false,projectionApplied:false
},null,2),{flag:'wx'});
console.log(JSON.stringify({complete:true,newEmbeddingRequests:0,
  projectionApplied:false,semanticSelectionValidated:false}));