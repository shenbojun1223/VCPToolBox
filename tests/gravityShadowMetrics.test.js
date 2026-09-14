'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMetrics } = require('../modules/vcpLoop/gravityShadowMetrics');
const sample = () => ({
  status:'analyzed',reason:'shadow-only',cacheHits:3,cacheMisses:1,
  eligible:2,protected:7,wouldStub:1,potentialChars:500,elapsedMs:2
});
test('first observation emits; subsequent emissions are rate limited',()=>{
  let time=0;const lines=[];
  const m=createMetrics({now:()=>time,emit:s=>lines.push(s)});
  m.observe(sample());m.observe(sample());
  assert.equal(lines.length,1);
  time=59999;m.observe(sample());assert.equal(lines.length,1);
  time=60000;m.observe(sample());assert.equal(lines.length,2);
  const r=JSON.parse(lines[1].slice('[GravityStub:metrics] '.length));
  assert.equal(r.reports,4);assert.equal(r.cacheHits,12);
  assert.equal(r.reasons['shadow-only'],4);
});
test('unknown strings and arbitrary report fields never enter output',()=>{
  const lines=[];const m=createMetrics({emit:s=>lines.push(s)});
  const r={...sample(),status:'SECRET',reason:'SECRET',text:'SECRET',
    vector:[1,2,3],candidates:[{index:10,text:'SECRET'}],requestId:'SECRET'};
  m.observe(r);
  assert(!lines[0].includes('SECRET'));
  assert(!lines[0].includes('candidates'));assert(!lines[0].includes('requestId'));
  assert.equal(m.snapshot().reasons.other,1);assert.equal(m.snapshot().skipped,1);
});
test('numeric counters reject non-numeric, negative and non-finite values',()=>{
  const m=createMetrics({emit:()=>{}});
  m.observe({...sample(),cacheHits:'secret',cacheMisses:-1,
    wouldStub:Infinity,potentialChars:NaN,elapsedMs:1e100});
  const r=m.snapshot();
  assert.equal(r.cacheHits,0);assert.equal(r.cacheMisses,0);
  assert.equal(r.wouldStub,0);assert.equal(r.potentialChars,0);
  assert.equal(r.elapsedMsMax,1000000000);
});
test('observer retains neither report nor snapshot references',()=>{
  const m=createMetrics({emit:()=>{}}),r=sample();
  m.observe(r);r.cacheHits=999;
  const snap=m.snapshot();snap.reasons['shadow-only']=999;snap.cacheHits=999;
  assert.equal(m.snapshot().cacheHits,3);
  assert.equal(m.snapshot().reasons['shadow-only'],1);
});
test('throwing and rejecting emitters do not escape or create retry storm',async()=>{
  for(const emit of [()=>{throw Error('private');},async()=>{throw Error('private');}]){
    const m=createMetrics({now:()=>0,emit});
    m.observe(sample());m.observe(sample());
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(m.snapshot().emitFailures,1);assert.equal(m.snapshot().reports,2);
  }
});
test('malformed report getter is contained without partially updating counters',()=>{
  const m=createMetrics({emit:()=>{}});
  m.observe({get cacheHits(){throw Error('private');}});
  assert.equal(m.snapshot().reports,0);
});
test('clock rollback does not flood emissions',()=>{
  let time=100;const lines=[];
  const m=createMetrics({now:()=>time,emit:s=>lines.push(s)});
  m.observe(sample());time=0;m.observe(sample());assert.equal(lines.length,1);
});
test('production module default off and opt-in works without global debug',async()=>{
  const { projectGravityStub }=require('../modules/vcpLoop/gravityStub');
  const before=process.env.VCP_GRAVITY_METRICS,log=console.log,lines=[];
  const messages=[{role:'user',content:'private text'}];
  try {
    console.log=s=>lines.push(s);
    delete process.env.VCP_GRAVITY_METRICS;
    assert.strictEqual(await projectGravityStub(messages),messages);
    assert.equal(lines.length,0);
    process.env.VCP_GRAVITY_METRICS='true';
    assert.strictEqual(await projectGravityStub(messages,{debugMode:false}),messages);
    assert.equal(lines.length,1);assert(!lines[0].includes('private text'));
    assert(lines[0].startsWith('[GravityStub:metrics] '));
  } finally {
    console.log=log;
    if(before===undefined) delete process.env.VCP_GRAVITY_METRICS;
    else process.env.VCP_GRAVITY_METRICS=before;
  }
});test('v2 aggregates independent anchor states and separate invalid/error counters',()=>{
  const lines=[],m=createMetrics({emit:s=>lines.push(s)});
  m.observe({...sample(),reason:'anchor-cache-unavailable',status:'skipped',
    cacheInvalid:1,cacheErrors:2,anchorCache:{goal:'invalid',payload:'error'}});
  const r=m.snapshot();
  assert.equal(r.version,'gravity-metrics-v2');
  assert.equal(r.cacheInvalid,1);assert.equal(r.cacheErrors,2);
  assert.equal(r.anchorCache.goal.invalid,1);
  assert.equal(r.anchorCache.payload.error,1);
  assert.equal(r.reasons['anchor-cache-unavailable'],1);
  assert.equal(JSON.parse(lines[0].slice('[GravityStub:metrics] '.length)).version,
    'gravity-metrics-v2');
});
test('unknown or absent anchor state maps to not-read without leaking strings',()=>{
  const lines=[],m=createMetrics({emit:s=>lines.push(s)});
  m.observe({...sample(),anchorCache:{goal:'SECRET',payload:'SECRET'}});
  assert(!lines[0].includes('SECRET'));
  assert.equal(m.snapshot().anchorCache.goal['not-read'],1);
  assert.equal(m.snapshot().anchorCache.payload['not-read'],1);
  m.observe(sample());
  assert.equal(m.snapshot().anchorCache.goal['not-read'],2);
});
test('anchor snapshot detached and throwing anchor getters update no counters',()=>{
  const m=createMetrics({emit:()=>{}});
  m.observe({...sample(),anchorCache:{goal:'hit',payload:'miss'}});
  const r=m.snapshot();r.anchorCache.goal.hit=999;
  assert.equal(m.snapshot().anchorCache.goal.hit,1);
  m.observe({...sample(),anchorCache:{get goal(){throw Error('private');}}});
  assert.equal(m.snapshot().reports,1);
});