'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {assessGravitySpace:assess} = require('../modules/vcpLoop/gravitySpaceContract');
const hash = text => createHash('sha256').update(text).digest('hex');
function record(text, vector = [1,0,0]) {
  const textHash = hash(text);
  return {textHash,vector,provenance:{
    source:'generated-single',textHash,vectorHash:hash(JSON.stringify(vector)),
    dimension:vector.length,chunkCount:1,usableChunks:1,fullCoverage:true,
    modelDeclarationsConsistent:true,requestedModel:'model',responseModel:'model',
    spaceVerified:true,foldEligible:true
  }};
}
// Explicitly synthetic trusted evidence. These tests are NOT provider attestation.
function evidence(binding) {
  return {...binding,schema:'gravity-space-evidence-v1',allChunksAttested:true,
    spaceId:'fixture-space',encoderRevision:'fixture-revision',
    encodingProfile:'fixture-document-profile',compositionProfile:'fixture-single'};
}
function records() { return [record('goal'),record('payload',[0,1,0])]; }
test('matching names, dimensions and claimed flags without resolver are insufficient',()=>{
  const r=assess(records());
  assert.equal(r.reason,'missing-space-evidence');
  assert.equal(r.spaceVerified,false);assert.equal(r.foldEligible,false);
});
test('complete bound synthetic evidence admits conditional shadow compatibility',()=>{
  const input=records(),snapshot=JSON.stringify(input);
  const r=assess(input,{resolveEvidence:evidence});
  assert.equal(r.status,'compatible');assert.equal(r.spaceVerified,false);
  assert.equal(r.foldEligible,false);assert.equal(JSON.stringify(input),snapshot);
  for(const value of [hash('goal'),'fixture-space','fixture-revision','vectorHash'])
    assert(!JSON.stringify(r).includes(value));
});
test('resolver is never consulted until every vector binding has passed',()=>{
  let calls=0;const input=records();input[1].vector[1]=2;
  assert.equal(assess(input,{resolveEvidence:b=>{calls++;return evidence(b);}}).reason,
    'binding-mismatch');
  assert.equal(calls,0);
});
test('text mismatch, malformed hashes and dimension drift reject',()=>{
  for(const change of [
    r=>{r.textHash=hash('other');},r=>{r.textHash='not-hash';},
    r=>{r.provenance.dimension=2;}
  ]) {
    const input=records();change(input[0]);
    assert.equal(assess(input,{resolveEvidence:evidence}).reason,'binding-mismatch');
  }
});
test('fuzzy, partial, legacy and inconsistent generation evidence reject',()=>{
  for(const change of [
    p=>{p.source='fuzzy-reuse';},p=>{p.fullCoverage=false;},
    p=>{p.usableChunks=0;},p=>{p.chunkCount=2;},
    p=>{p.source='generated-chunk-merge';},p=>{p.modelDeclarationsConsistent=false;},
    p=>{p.requestedModel=null;},p=>{p.responseModel=' model';}
  ]) {
    const input=records();change(input[0].provenance);
    assert.equal(assess(input,{resolveEvidence:evidence}).reason,'incomplete-generation');
  }
  const input=records();delete input[0].provenance;
  assert.equal(assess(input,{resolveEvidence:evidence}).reason,'binding-mismatch');
});
test('different space, revision, encoding or composition never compare',()=>{
  for(const field of ['spaceId','encoderRevision','encodingProfile','compositionProfile']) {
    let n=0;
    const r=assess(records(),{resolveEvidence:b=>{
      const e=evidence(b);if(n++) e[field]='different';return e;
    }});
    assert.equal(r.reason,'space-mismatch');
  }
});
test('evidence binding and mandatory coverage fields are rechecked',()=>{
  for(const field of ['textHash','vectorHash','dimension','requestedModel','responseModel',
    'source','chunkCount','allChunksAttested','schema','spaceId','encoderRevision',
    'encodingProfile','compositionProfile']) {
    const r=assess(records(),{resolveEvidence:b=>{
      const e=evidence(b);delete e[field];return e;
    }});
    assert.equal(r.reason,'invalid-space-evidence',field);
  }
});
test('malformed and zero vectors never invoke resolver',()=>{
  for(const vector of [[],[0,0,0],[NaN,0,0],[Infinity,0,0],['1',0,0],
    [1e200,0,0],new Array(4097).fill(1),{}]) {
    const input=records();input[0].vector=vector;let calls=0;
    assert.equal(assess(input,{resolveEvidence:()=>{calls++;}}).reason,'invalid-vector');
    assert.equal(calls,0);
  }
});
test('record budgets enforced',()=>{
  for(const input of [null,[],[record('only')],new Array(65).fill(record('many'))])
    assert.equal(assess(input,{resolveEvidence:evidence}).reason,'record-budget');
});
test('resolver exceptions and rejecting promises are contained',async()=>{
  assert.equal(assess(records(),{resolveEvidence:()=>{throw Error('private');}}).reason,
    'space-contract-error');
  for(const resolveEvidence of [async()=>{throw Error('private');},async b=>evidence(b)])
    assert.equal(assess(records(),{resolveEvidence}).reason,'async-space-evidence');
  await new Promise(resolve=>setImmediate(resolve));
});
test('resolver receives only frozen detached scalars',()=>{
  const input=records(),snapshot=JSON.stringify(input);
  const r=assess(input,{resolveEvidence:b=>{
    assert(Object.isFrozen(b));assert(!('vector' in b));return evidence(b);
  }});
  assert.equal(r.status,'compatible');assert.equal(JSON.stringify(input),snapshot);
});
test('typed vectors use the same canonical hash binding',()=>{
  const input=records();input[0].vector=new Float32Array(input[0].vector);
  input[1].vector=new Float64Array(input[1].vector);
  assert.equal(assess(input,{resolveEvidence:evidence}).status,'compatible');
});
test('complete chunk means require matching explicit composition evidence',()=>{
  const input=records();
  for(const r of input) Object.assign(r.provenance,{
    source:'generated-chunk-merge',chunkCount:2,usableChunks:2
  });
  assert.equal(assess(input,{resolveEvidence:b=>({
    ...evidence(b),compositionProfile:'fixture-token-weighted-mean-v1'
  })}).status,'compatible');
});test('expired admission skips resolver entirely',()=>{
  let calls=0;
  const r=assess(records(),{isExpired:()=>true,
    resolveEvidence:b=>{calls++;return evidence(b);}});
  assert.equal(r.reason,'time-budget-or-abort');assert.equal(calls,0);
});
test('expiry during first resolver prevents querying remaining records',()=>{
  let expired=false,calls=0;
  const r=assess(records(),{isExpired:()=>expired,
    resolveEvidence:b=>{calls++;expired=true;return evidence(b);}});
  assert.equal(r.reason,'time-budget-or-abort');assert.equal(calls,1);
});
test('expiry still contains rejected asynchronous evidence',async()=>{
  let expired=false,calls=0;
  const r=assess(records(),{isExpired:()=>expired,
    resolveEvidence:()=>{calls++;expired=true;return Promise.reject(Error('fixture'));}});
  assert.equal(r.reason,'time-budget-or-abort');assert.equal(calls,1);
  await new Promise(resolve=>setImmediate(resolve));
});