'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {VexusIndex} = require('../rust-vexus-lite');
const {scoreGravityVerifiedShadow:score} =
  require('../modules/vcpLoop/gravityVerifiedShadow');
const hash = s => createHash('sha256').update(s).digest('hex');
const native = new VexusIndex(3,16); // Isolated empty index; no production data.
function record(text,vector,index) {
  const textHash=hash(text);
  return {index,textHash,vector,provenance:{
    source:'generated-single',textHash,vectorHash:hash(JSON.stringify(vector)),
    dimension:3,chunkCount:1,usableChunks:1,fullCoverage:true,
    modelDeclarationsConsistent:true,requestedModel:'fixture',responseModel:'fixture'
  }};
}
function evidence(b) {
  return {...b,schema:'gravity-space-evidence-v1',allChunksAttested:true,
    spaceId:'synthetic',encoderRevision:'revision',
    encodingProfile:'document',compositionProfile:'single'};
}
function fixture() {
  return {
    goal:record('goal',[1,0,0]),payload:record('payload',[0,1,0]),
    candidates:[record('independent',[0,0,1],1),
      record('opposite',[-1,0,0],2),record('same',[1,0,0],3)],
    resolveEvidence:evidence,nativeIndex:native
  };
}
test('synthetic trusted contract reaches real Rust and preserves signed association',()=>{
  const f=fixture(),snapshot=JSON.stringify([f.goal,f.payload,f.candidates]);
  const r=score(f);
  assert.equal(r.status,'measured');
  assert.equal(r.backend,'vexus-computeOrthogonalProjection');
  assert.equal(r.scores.length,3);
  assert.equal(r.scores[0].residualEnergyRatio,1);
  assert.equal(r.scores[1].residualEnergyRatio,0);
  assert.equal(r.scores[1].goalCosine,-1);
  assert.equal(r.scores[2].goalCosine,1);
  assert.equal(r.foldEligible,false);assert.equal(r.spaceVerified,false);
  assert(r.scores.every(s=>s.foldEligible===false));
  assert.equal(JSON.stringify([f.goal,f.payload,f.candidates]),snapshot);
  for(const secret of [hash('goal'),'synthetic','vector','revision'])
    assert(!JSON.stringify(r).includes(secret));
});
test('missing, conflicting or stale evidence never invokes native',()=>{
  for(const mode of ['missing','mismatch','mutated']) {
    const f=fixture();let calls=0;
    f.nativeIndex={computeOrthogonalProjection(){calls++;throw Error();}};
    if(mode==='missing') delete f.resolveEvidence;
    if(mode==='mismatch') {
      let count=0;
      f.resolveEvidence=b=>({...evidence(b),spaceId:count++?'other':'synthetic'});
    }
    if(mode==='mutated') f.candidates[0].vector[2]=2;
    const r=score(f);
    assert.equal(r.status,'unavailable');assert.deepEqual(r.scores,[]);
    assert.equal(calls,0);
  }
});
test('resolver mutation of caller vectors cannot replace validated snapshot',()=>{
  const f=fixture();let first=true;
  f.resolveEvidence=b=>{
    if(first) {
      first=false;
      f.goal.vector[0]=0;
      f.candidates[0].vector[2]=0;
      f.candidates[0].index=99;
    }
    return evidence(b);
  };
  const r=score(f);
  assert.equal(r.status,'measured');
  assert.equal(r.scores[0].index,1);
  assert.equal(r.scores[0].residualEnergyRatio,1);
});
test('duplicate or out of range candidate indices and budgets reject',()=>{
  for(const change of [
    f=>{f.candidates=[];},f=>{f.candidates=new Array(63).fill(f.candidates[0]);},
    f=>{f.candidates[1].index=1;},f=>{f.candidates[0].index=-1;},
    f=>{f.candidates[0].index=256;},f=>{f.candidates[0].index=1.5;}
  ]) {
    const f=fixture();change(f);
    assert.equal(score(f).status,'unavailable');
  }
});
test('abort before scoring never invokes resolver or native',()=>{
  const f=fixture();f.signal=AbortSignal.abort();
  f.resolveEvidence=()=>{throw Error('must not call');};
  assert.equal(score(f).reason,'time-budget-or-abort');
});
test('abort during native call discards all partial results',()=>{
  const f=fixture(),controller=new AbortController();
  f.signal=controller.signal;
  let calls=0;
  f.nativeIndex={computeOrthogonalProjection(...args){
    const result=native.computeOrthogonalProjection(...args);
    if(++calls===2) controller.abort();
    return result;
  }};
  const r=score(f);
  assert.equal(r.status,'unavailable');assert.deepEqual(r.scores,[]);
  assert.equal(calls,2);
});
test('missing native or later native failure discards partial scores',()=>{
  for(const mode of ['missing','failure']) {
    const f=fixture();let calls=0;
    f.nativeIndex=mode==='missing'?{}:{computeOrthogonalProjection(...args){
      if(++calls===2) throw Error('private');
      return native.computeOrthogonalProjection(...args);
    }};
    const r=score(f);
    assert.equal(r.status,'unavailable');assert.deepEqual(r.scores,[]);
    assert(!JSON.stringify(r).includes('private'));
  }
});
test('slow synchronous resolver is detected after return without claiming preemption',()=>{
  const f=fixture();let calls=0;
  f.resolveEvidence=b=>{
    const until=performance.now()+20;
    while(performance.now()<until) {}
    return evidence(b);
  };
  f.nativeIndex={computeOrthogonalProjection(){calls++;}};
  const r=score(f);
  assert.equal(r.reason,'time-budget-or-abort');assert.equal(calls,0);
});