'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeGravityStub, projectGravityStub } = require('../modules/vcpLoop/gravityStub');
const { safeGravityProjection } = require('../modules/vcpLoop/safeGravityProjection');
const OLD = 'gentle clouds drift across the quiet sky. '.repeat(1000);
const GOAL = 'investigate the current task';
const RECEIPT = '<!-- VCP_TOOL_PAYLOAD -->\ncurrent receipt';
function fixture() {
  const messages = [
    {role:'system',content:'policy'},
    {role:'assistant',content:OLD,name:'agent'},
    {role:'user',content:'previous request'},
    {role:'assistant',content:'previous answer'},
    {role:'user',content:GOAL},
    {role:'assistant',content:'tool call'},
    {role:'user',content:RECEIPT},
    {role:'assistant',content:'current answer'},
    {role:'user',content:RECEIPT},
    {role:'assistant',content:'continuing'}
  ];
  const cache = new Map([[OLD,[0,1]],[GOAL,[1,0]],[RECEIPT,[1,0]]]);
  const reads = [];
  const options = {recursionDepth:1,latestPayload:RECEIPT,contextBridge:{
    getEmbeddingFromCache(text) { reads.push(text); return cache.get(text); },
    embedText() { throw Error('network forbidden'); },
    getAggregatedVector() { throw Error('global context forbidden'); },
    getFuzzyEmbeddingFromCache() { throw Error('fuzzy forbidden'); },
    sanitize() { throw Error('rewriting cache key forbidden'); }
  }};
  return {messages,cache,reads,options};
}
test('cache-only analysis finds low relevance without mutating input or vectors',()=>{
  const f=fixture(), before=JSON.stringify(f.messages), vectors=JSON.stringify([...f.cache]);
  const r=analyzeGravityStub(f.messages,f.options);
  assert.equal(r.status,'analyzed'); assert.equal(r.wouldStub,1);
  assert.equal(r.candidates[0].index,1); assert(r.potentialChars>0);
  assert.deepEqual(f.reads,[GOAL,RECEIPT,OLD]);
  assert.equal(JSON.stringify(f.messages),before);
  assert.equal(JSON.stringify([...f.cache]),vectors);
});
test('production entry always returns original even with enabled true',async()=>{
  const f=fixture(); let report;
  const out=await projectGravityStub(f.messages,{...f.options,enabled:true,
    onGravityReport:r=>{report=r;}});
  assert.strictEqual(out,f.messages); assert.equal(report.wouldStub,1);
});
test('uncached anchors and candidates fail open without fallback',()=>{
  for (const key of [GOAL,RECEIPT,OLD]) {
    const f=fixture(); f.cache.delete(key);
    assert.equal(analyzeGravityStub(f.messages,f.options).wouldStub,0);
    assert(f.reads.every(t=>[GOAL,RECEIPT,OLD].includes(t)));
  }
});
test('invalid vectors are rejected',()=>{
  for (const v of [[0,0],[NaN,1],[Infinity,1],[1,0,0],Promise.resolve([0,1]),['0',1]]) {
    const f=fixture(); f.cache.set(OLD,v);
    assert.equal(analyzeGravityStub(f.messages,f.options).wouldStub,0);
  }
});
test('typed vectors work without modification',()=>{
  const f=fixture(); f.cache.set(OLD,new Float32Array([0,1]));
  assert.equal(analyzeGravityStub(f.messages,f.options).wouldStub,1);
});
test('either goal or receipt relevance protects the candidate',()=>{
  for (const key of [GOAL,RECEIPT]) {
    const f=fixture(); f.cache.set(key,[0,1]);
    assert.equal(analyzeGravityStub(f.messages,f.options).wouldStub,0);
  }
});
test('protocol, numeric facts, paths, code and requirements are protected',()=>{
  for (const detail of ['port 17897','C:\\project','/tmp/file','`flag`','API',
    'VCP_TOOL_PAYLOAD','TOOL_REQUEST','Flowlock::','系统提示','元思维',
    '必须保留','never discard','https://example.test']) {
    const f=fixture(); f.messages[1].content=OLD+detail;
    f.cache.set(f.messages[1].content,[0,1]);
    assert.equal(analyzeGravityStub(f.messages,f.options).wouldStub,0,detail);
    assert(!f.reads.includes(f.messages[1].content));
  }
});
test('non-assistant, multimodal and native tool messages are immune',()=>{
  for (const patch of [
    {role:'system'},{role:'developer'},{role:'user'},{role:'tool'},
    {content:[{type:'text',text:OLD},{type:'image_url',image_url:{url:'private'}}]},
    {tool_calls:[{id:'x'}]},{function_call:{name:'f'}},{tool_call_id:'x'}
  ]) {
    const f=fixture();Object.assign(f.messages[1],patch);
    assert.equal(analyzeGravityStub(f.messages,f.options).wouldStub,0);
  }
});
test('previous turn and whole current loop remain immune beyond last four messages',()=>{
  const f=fixture();
  for(const i of [3,5,7,9]) f.messages[i].content=OLD;
  const r=analyzeGravityStub(f.messages,f.options);
  assert.deepEqual(r.candidates.map(c=>c.index),[1]);
});
test('external payload cannot be a probe',()=>{
  const f=fixture();f.options.latestPayload='external receipt';
  assert.equal(analyzeGravityStub(f.messages,f.options).reason,'missing-payload-anchor');
  assert.equal(f.reads.length,0);
});
test('array tool receipt uses text only, does not query image URL',()=>{
  const f=fixture(), parts=[{type:'text',text:RECEIPT},
    {type:'image_url',image_url:{url:'private-image'}}];
  f.messages[8].content=parts; f.options.latestPayload=parts;
  assert.equal(analyzeGravityStub(f.messages,f.options).wouldStub,1);
  assert(!f.reads.includes('private-image'));
});
test('contextBridge can be obtained through plugin manager',()=>{
  const f=fixture(), bridge=f.options.contextBridge; delete f.options.contextBridge;
  f.options.pluginManager={messagePreprocessors:new Map([
    ['RAGDiaryPlugin',{getContextBridge:()=>bridge}]])};
  assert.equal(analyzeGravityStub(f.messages,f.options).wouldStub,1);
});
test('missing or throwing bridge and aborted request remain non-fatal',async()=>{
  for(const patch of [
    {contextBridge:null},
    {contextBridge:{getEmbeddingFromCache(){throw Error('cache failure');}}},
    {signal:AbortSignal.abort()}
  ]) {
    const f=fixture(), opts={...f.options,...patch};
    assert.equal(analyzeGravityStub(f.messages,opts).wouldStub,0);
    assert.strictEqual(await projectGravityStub(f.messages,opts),f.messages);
  }
});
test('watermark and recursion gates avoid cache queries',()=>{
  for(const kind of ['short','first']) {
    const f=fixture();
    if(kind==='short') f.messages[1].content='short';
    else delete f.options.recursionDepth;
    assert.equal(analyzeGravityStub(f.messages,f.options).wouldStub,0);
    assert.equal(f.reads.length,0);
  }
});
test('shadow wrapper discards even a malicious projected change',async()=>{
  const f=fixture(), before=JSON.stringify(f.messages);
  const out=await safeGravityProjection(f.messages,{
    enabled:true,shadow:true,loadProjector:()=>copy=>{
      copy[1].content='lost';return copy;
    }
  });
  assert.strictEqual(out,f.messages); assert.equal(JSON.stringify(f.messages),before);
});
test('explicit disabled overrides shadow without loading',async()=>{
  const f=fixture();let loads=0;
  const out=await safeGravityProjection(f.messages,{
    enabled:false,shadow:true,loadProjector:()=>{loads++;throw Error();}
  });
  assert.strictEqual(out,f.messages);assert.equal(loads,0);
});
test('real safety wrapper plus real projector runs shadow report but sends original',async()=>{
  const f=fixture(); let report;
  const out=await safeGravityProjection(f.messages,{
    ...f.options,enabled:true,shadow:true,onGravityReport:r=>{report=r;}
  });
  assert.strictEqual(out,f.messages);assert.equal(report.wouldStub,1);
});
test('new focus reanalyzes original text with no retained stubs',async()=>{
  const f=fixture(), first=analyzeGravityStub(f.messages,f.options);
  f.cache.set(RECEIPT,[0,1]);
  const second=analyzeGravityStub(f.messages,f.options);
  assert.equal(first.wouldStub,1); assert.equal(second.wouldStub,0);
  assert.equal(f.messages[1].content,OLD);
});
test('throwing and rejecting report observers do not interrupt continuation',async()=>{
  for(const onGravityReport of [()=>{throw Error();},async()=>{throw Error();}]) {
    const f=fixture();
    assert.strictEqual(await projectGravityStub(f.messages,{...f.options,onGravityReport}),f.messages);
  }
});test('zero-based first post-tool depth is analyzed, invalid depths are rejected',()=>{
  const first=fixture();
  first.options.recursionDepth=0;
  assert.equal(analyzeGravityStub(first.messages,first.options).wouldStub,1);
  for(const depth of [-1,0.5,NaN,Infinity,'0',undefined]) {
    const f=fixture(); f.options.recursionDepth=depth;
    assert.equal(analyzeGravityStub(f.messages,f.options).reason,'not-tool-loop');
    assert.equal(f.reads.length,0);
  }
});
test('depth zero without a matching receipt cannot enter analysis',()=>{
  const f=fixture();
  f.options.recursionDepth=0;
  f.options.latestPayload='absent receipt';
  assert.equal(analyzeGravityStub(f.messages,f.options).reason,'missing-payload-anchor');
  assert.equal(f.reads.length,0);
});test('anchor diagnostics distinguish absent goal from independently valid payload',()=>{
  const f=fixture();f.cache.delete(GOAL);
  const r=analyzeGravityStub(f.messages,f.options);
  assert.deepEqual(f.reads,[GOAL,RECEIPT]);
  assert.deepEqual(r.anchorCache,{goal:'miss',payload:'hit'});
  assert.equal(r.reason,'anchor-cache-unavailable');
  assert.equal(r.cacheMisses,1);assert.equal(r.cacheHits,1);
  assert.equal(r.cacheInvalid,0);assert.equal(r.wouldStub,0);
});
test('anchor diagnostics distinguish invalid, missing, and throwing cache',()=>{
  const f=fixture();f.cache.set(GOAL,[NaN,1]);f.cache.delete(RECEIPT);
  const r=analyzeGravityStub(f.messages,f.options);
  assert.deepEqual(r.anchorCache,{goal:'invalid',payload:'miss'});
  assert.equal(r.cacheInvalid,1);assert.equal(r.cacheMisses,1);
  const g=fixture();
  g.options.contextBridge.getEmbeddingFromCache=text=>{
    if(text===GOAL) throw Error('private detail');
    return g.cache.get(text);
  };
  const e=analyzeGravityStub(g.messages,g.options);
  assert.deepEqual(e.anchorCache,{goal:'error',payload:'hit'});
  assert.equal(e.cacheErrors,1);assert(!JSON.stringify(e).includes('private detail'));
});
test('payload dimension mismatch is invalid, not a cache miss',()=>{
  const f=fixture();f.cache.set(RECEIPT,[1,0,0]);
  const r=analyzeGravityStub(f.messages,f.options);
  assert.deepEqual(r.anchorCache,{goal:'hit',payload:'invalid'});
  assert.equal(r.cacheMisses,0);assert.equal(r.cacheInvalid,1);
  assert.equal(r.wouldStub,0);
});
test('candidate invalid vector and cache exception preserve original candidate',()=>{
  for(const failure of ['invalid','error']) {
    const f=fixture();
    f.options.contextBridge.getEmbeddingFromCache=text=>{
      if(text!==OLD) return f.cache.get(text);
      if(failure==='error') throw Error('private');
      return [Infinity,1];
    };
    const r=analyzeGravityStub(f.messages,f.options);
    assert.equal(r.wouldStub,0);assert.equal(f.messages[1].content,OLD);
    assert.equal(r[failure==='error'?'cacheErrors':'cacheInvalid'],1);
  }
});
test('accidental rejected cache Promise is invalid and rejection is contained',async()=>{
  const f=fixture();
  f.options.contextBridge.getEmbeddingFromCache=text=>
    text===GOAL ? Promise.reject(Error('private rejection')) : f.cache.get(text);
  const r=analyzeGravityStub(f.messages,f.options);
  assert.deepEqual(r.anchorCache,{goal:'invalid',payload:'hit'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(r.wouldStub,0);
});
test('abort after goal read leaves payload unqueried',()=>{
  const f=fixture(),controller=new AbortController();
  f.options.signal=controller.signal;
  f.options.contextBridge.getEmbeddingFromCache=text=>{
    f.reads.push(text);controller.abort();return f.cache.get(text);
  };
  const r=analyzeGravityStub(f.messages,f.options);
  assert.deepEqual(f.reads,[GOAL]);
  assert.equal(r.anchorCache.payload,'not-read');assert.equal(r.wouldStub,0);
  assert.equal(r.reason,'time-budget-or-abort');
});