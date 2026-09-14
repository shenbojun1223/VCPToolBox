'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {createGravityVectorReceiver:create} = require('../modules/vcpLoop/gravityVectorReceiver');
const hash = text => createHash('sha256').update(text).digest('hex');
function fixture(goal='goal', tool='tool') {
  return {
    receiver:create({userText:goal,toolResultsText:tool}),
    packet:{
      version:'rag-refresh-vectors-v1',source:'current-refresh',
      provenance:'unknown',foldEligible:false,
      bindings:{userRawHash:hash(goal),toolResultsRawHash:hash(tool)},
      goal:{vector:[1,0],textHash:hash('clean '+goal),transform:'sanitizeForEmbedding:user'},
      payload:{vector:[0,1],textHash:hash('clean '+tool),transform:'refreshRagBlock:tool-cleanup'}
    }
  };
}
test('bound packet is copied and remains explicitly unverified',()=>{
  const f=fixture();f.packet.privateText='must not retain';
  f.receiver.accept(f.packet);f.packet.goal.vector[0]=99;
  const out=f.receiver.finish();
  assert.equal(out.status,'received-unverified');
  assert.equal(out.packet.goal.vector[0],1);
  assert.equal(out.packet.provenance,'unknown');
  assert.equal(out.packet.foldEligible,false);
  assert(!JSON.stringify(out).includes('must not retain'));
});
test('no refresh and unavailable inputs yield no packet',()=>{
  assert.equal(fixture().receiver.finish().status,'not-received');
  assert.equal(create({userText:'',toolResultsText:'tool'}).finish().status,'unavailable');
});
test('different requests or tool results cannot exchange packets',()=>{
  for(const f of [fixture('other'),fixture('goal','other tool')]) {
    f.receiver.accept(fixture().packet);
    const out=f.receiver.finish();
    assert.equal(out.status,'rejected');assert.equal(out.packet,null);
  }
});
test('identical repeats allowed, conflicting repeats reject the whole handoff',()=>{
  const f=fixture();f.receiver.accept(f.packet);f.receiver.accept(f.packet);
  assert.equal(f.receiver.finish().accepted,2);
  const g=fixture();g.receiver.accept(g.packet);
  g.packet.goal.vector=[0,1];g.receiver.accept(g.packet);
  assert.equal(g.receiver.finish().status,'rejected');
});
test('finish is one-shot and late callbacks cannot mutate results',()=>{
  const f=fixture();f.receiver.accept(f.packet);const out=f.receiver.finish();
  f.packet.goal.vector[0]=99;f.receiver.accept(f.packet);
  assert.equal(out.packet.goal.vector[0],1);
  assert.equal(f.receiver.finish().status,'closed');
  const g=fixture();assert.equal(g.receiver.finish().status,'not-received');
  g.receiver.accept(g.packet);assert.equal(g.receiver.finish().packet,null);
});
test('malformed vectors, hashes and provenance escalation rejected',()=>{
  for(const edit of [
    p=>{p.goal.vector=null;},p=>{p.goal.vector=[NaN,1];},
    p=>{p.goal.vector=[0,0];},p=>{p.goal.vector=[1,0,0];},
    p=>{p.payload.textHash='invalid';},p=>{p.provenance='exact';},
    p=>{p.foldEligible=true;},p=>{p.bindings.userRawHash=hash('different');}
  ]) {
    const f=fixture();edit(f.packet);f.receiver.accept(f.packet);
    assert.equal(f.receiver.finish().status,'rejected');
  }
});
test('callback budget and throwing fields fail closed',()=>{
  const f=fixture();for(let i=0;i<17;i++) f.receiver.accept(f.packet);
  assert.equal(f.receiver.finish().status,'rejected');
  const g=fixture();g.receiver.accept({get version(){throw Error('private');}});
  assert.equal(g.receiver.finish().status,'rejected');
});
test('interleaved request-local receivers remain isolated',()=>{
  const a=fixture('alpha','tool alpha'),b=fixture('beta','tool beta');
  b.receiver.accept(b.packet);a.receiver.accept(a.packet);
  assert.equal(a.receiver.finish().packet.bindings.userRawHash,hash('alpha'));
  assert.equal(b.receiver.finish().packet.bindings.userRawHash,hash('beta'));
});function attachSource(packet) {
  for (const anchor of [packet.goal,packet.payload]) {
    anchor.provenance = {
      source:'generated-single',route:'generated',
      textHash:anchor.textHash,vectorHash:hash(JSON.stringify(anchor.vector)),
      dimension:anchor.vector.length,chunkCount:1,usableChunks:1,
      fullCoverage:true,modelDeclarationsConsistent:true,
      requestedModel:'fixture',responseModel:'fixture',
      spaceVerified:false,foldEligible:false
    };
  }
}
test('receiver retains bound source descriptions without promoting trust',()=>{
  const f=fixture();attachSource(f.packet);
  f.receiver.accept(f.packet);
  f.packet.goal.provenance.responseModel='mutated';
  const out=f.receiver.finish();
  assert.equal(out.status,'received-unverified');
  assert.equal(out.packet.goal.provenance.source,'generated-single');
  assert.equal(out.packet.goal.provenance.responseModel,'fixture');
  assert.equal(out.packet.goal.provenance.spaceVerified,false);
  assert.equal(out.packet.goal.provenance.foldEligible,false);
  assert.equal(out.packet.foldEligible,false);
});
test('generated and cache routes do not conflict when generation evidence is identical',()=>{
  const f=fixture();attachSource(f.packet);
  f.receiver.accept(f.packet);
  f.packet.goal.provenance.route='cache';
  f.packet.payload.provenance.route='pending';
  f.receiver.accept(f.packet);
  const out=f.receiver.finish();
  assert.equal(out.status,'received-unverified');
  assert.equal(out.accepted,2);
  assert(!('route' in out.packet.goal.provenance));
});
test('conflicting model evidence rejects repeated handoff rather than last writer wins',()=>{
  const f=fixture();attachSource(f.packet);
  f.receiver.accept(f.packet);
  f.packet.payload.provenance.responseModel='different-model';
  f.receiver.accept(f.packet);
  assert.equal(f.receiver.finish().status,'rejected');
});
test('source binding mismatch becomes unknown without discarding otherwise valid packet',()=>{
  for(const field of ['textHash','vectorHash','dimension']) {
    const f=fixture();attachSource(f.packet);
    f.packet.goal.provenance[field]=field==='dimension'?999:hash('different');
    f.receiver.accept(f.packet);
    const out=f.receiver.finish();
    assert.equal(out.status,'received-unverified');
    assert.equal(out.packet.goal.provenance.source,'unknown');
  }
});
test('fuzzy and incomplete source cannot claim full coverage or verified space',()=>{
  for(const mode of ['fuzzy','partial']) {
    const f=fixture();attachSource(f.packet);
    const p=f.packet.goal.provenance;
    if(mode==='fuzzy') p.source='fuzzy-reuse';
    else p.usableChunks=0;
    p.spaceVerified=true;p.foldEligible=true;
    f.receiver.accept(f.packet);
    const out=f.receiver.finish().packet.goal.provenance;
    assert.equal(out.fullCoverage,false);
    assert.equal(out.modelDeclarationsConsistent,false);
    assert.equal(out.spaceVerified,false);
    assert.equal(out.foldEligible,false);
  }
});