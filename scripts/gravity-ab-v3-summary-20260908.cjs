'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const dir=path.join(__dirname,'gravity-ab-v3-20260908');
const read=n=>JSON.parse(fs.readFileSync(path.join(dir,n),'utf8'));
const api=require('./gravity-ab-v3-20260908.cjs');
const data=read('data.json'),state=read('state.json');
assert.equal(state.attempts,4);assert.equal(state.completed,4);
const totals={};
for(const branch of ['A','B']){
 const rows=[1,2].map(n=>read(branch+n+'-metrics.json'));
 totals[branch]={
  elapsedMs:rows.reduce((s,r)=>s+r.elapsedMs,0),
  requestJsonUtf16:rows.reduce((s,r)=>s+r.requestJsonUtf16,0),
  messageContentUtf16:rows.reduce((s,r)=>s+r.messageContentUtf16,0),
  outputUtf16:rows.reduce((s,r)=>s+r.outputUtf16,0),
  usage:null,actualCost:null
 };
 totals[branch].inputPlusOutputUtf16=totals[branch].messageContentUtf16+totals[branch].outputUtf16;
}
const a2=read('A2-request.json'),b2=read('B2-request.json');
const r13=api.full(data.materials.R13,'R13'),r11=api.full(data.materials.R11,'R11');
assert(a2.messages.some(m=>m.content===r13));assert(b2.messages.some(m=>m.content===r13));
assert(b2.messages.some(m=>m.content===r11));
const stub=b2.messages.find(m=>m.content.startsWith('[STUB R03;'));
assert(stub);
const b1=JSON.parse(read('B1-response.json').body.choices[0].message.content);
assert.deepEqual(b1.fold.map(f=>f.id),['R03']);
assert(b1.fold[0].keep.every(([a,b])=>b<30||a>34));
const raw=fs.readFileSync(path.join(__dirname,'..','DebugLog/chat/2026-09-08/chat-msg_1788836272272_assistant_3y6x2pe-110604_302-6b7a.json'));
assert.equal(crypto.createHash('sha256').update(raw).digest('hex'),read('plan.json').sourceHash);
const ratio=(a,b)=>(a-b)/a;
const report={
 status:'completed-two-round-record-audit-pilot',
 modelCalls:{earlierAttempts:2,v3Completed:4,totalAttempts:6,budgetExhausted:true},
 totals,
 comparison:{
  secondRoundRequestReduction:ratio(read('A2-metrics.json').requestJsonUtf16,read('B2-metrics.json').requestJsonUtf16),
  cumulativeRequestReduction:ratio(totals.A.requestJsonUtf16,totals.B.requestJsonUtf16),
  cumulativeInputPlusOutputReduction:ratio(totals.A.inputPlusOutputUtf16,totals.B.inputPlusOutputUtf16),
  elapsedRatioBtoA:totals.B.elapsedMs/totals.A.elapsedMs,
  extraOutputUtf16:totals.B.outputUtf16-totals.A.outputUtf16,
  actualR03ProjectionSavedUtf16:api.full(data.materials.R03,'R03').length-stub.content.length
 },
 checks:{
  originalSourceHashUnchanged:true,
  R13FullOriginalPresentInBothSecondRoundRequests:true,
  R11FullOriginalPresentInBSecondRound:true,
  bothFinalAnswersCorrectOnSelectedTestCountsDurationsAndValidationBoundary:true,
  allCitationsAudited:false,
  R03CorrectionLines30to34OmittedInB:true,
  restorationRequested:false,
  modelInitiatedRestorationValidated:false,
  finalRoundR13FoldHasNoObservedSendingBenefit:true
 },
 conclusion:'The treatment reduced transmitted character volume and completed this narrow evidence audit, but took longer in both observed rounds, omitted planning-correction context, and performed unrewarded final-round folding. Evidence does not justify production adoption or a claim of net Token/cost benefit.',
 limits:[
  'One record-audit case, two rounds; not live coding, not statistical validation.',
  'Historical system/RAG excluded; historical tool-call text retained; major future evidence targets disclosed in advance.',
  'First-round answers already repeated the final test facts, although original evidence was also verified present.',
  'No usage, reasoning-token, cache or actual billing measurements; character counts are not Tokens.',
  'Serial order A1 B1 B2 A2; backend load, caching and model-version uncertainty confound latency.',
  'Bridge model label is not proof of pinned underlying model version.',
  'Omitted planning correction is a risk, not proof of actual downstream task failure.',
  'No production configuration, history or embedding changes.'
 ]
};
fs.writeFileSync(path.join(dir,'final-report.json'),JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify(report,null,2));