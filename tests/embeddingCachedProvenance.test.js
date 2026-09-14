'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const CacheManager = require('../Plugin/RAGDiaryPlugin/CacheManager');
const source = fs.readFileSync(require.resolve('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin'),'utf8');
const start = source.indexOf('    async getSingleEmbeddingCached(');
const end = source.indexOf('\n    _rememberEmbeddingText(',start);
assert(start >= 0 && end > start);
const method = vm.runInNewContext(
  '({' + source.slice(start,end) + '}).getSingleEmbeddingCached',
  {crypto,structuredClone,console:{log(){},warn(){},error(){}}}
);
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function fixture() {
  const cache = new CacheManager();
  cache.createCache('embedding',{maxSize:4,ttl:60000});
  const f = {cache,calls:0};
  f.key = text => cache.generateKey({text:text.trim()});
  f.metadata = (text,vector) => ({
    schema:'embedding-generation-metadata-v1',source:'generated-single',
    textHash:hash(text.trim()),vectorHash:hash(JSON.stringify(vector)),
    fullCoverage:true,spaceVerified:false,foldEligible:false
  });
  f.plugin = {
    cacheManager:cache,pendingEmbeddingRequests:new Map(),
    _rememberEmbeddingText(){},
    _findFuzzyEmbeddingFromCache:()=>null,
    getSingleEmbedding:async(text,options)=>{
      f.calls++;
      const vector=[1,0];
      options.onResultMetadata(f.metadata(text,vector));
      return vector;
    }
  };
  f.run = (text='goal',options={}) => method.call(f.plugin,text,options);
  return f;
}
test('generated result and subsequent cache hit retain bound descriptive source',async()=>{
  const f=fixture(), reports=[];
  const first=await f.run(' goal ',{onResultMetadata:r=>reports.push(r)});
  const second=await f.run('goal',{onResultMetadata:r=>reports.push(r)});
  assert.strictEqual(first,second);
  assert.equal(f.calls,1);
  assert.equal(reports[0].route,'generated');
  assert.equal(reports[1].route,'cache');
  for(const r of reports) {
    assert.equal(r.source,'generated-single');
    assert.equal(r.spaceVerified,false);
    assert.equal(r.foldEligible,false);
  }
  assert.equal(f.plugin.pendingEmbeddingRequests.size,0);
});
test('fuzzy alias stays fuzzy when its new key is later hit exactly',async()=>{
  const f=fixture(),reports=[],vector=[0,1];
  f.plugin._findFuzzyEmbeddingFromCache=()=>({vector,similarity:0.99,length:10});
  await f.run('goal',{onResultMetadata:r=>reports.push(r)});
  await f.run('goal',{onResultMetadata:r=>reports.push(r)});
  assert.equal(f.calls,0);
  assert.equal(reports[0].route,'fuzzy');
  assert.equal(reports[1].route,'cache');
  for(const r of reports) {
    assert.equal(r.source,'fuzzy-reuse');
    assert.equal(r.generation.fullCoverage,false);
  }
});
test('legacy or modified value/text binding becomes unknown without regeneration',async()=>{
  for(const mode of ['legacy','vector-change','text-change']) {
    const f=fixture(),vector=[1,0];
    const m=mode==='legacy'?null:f.metadata(mode==='text-change'?'different':'goal',vector);
    f.cache.set('embedding',f.key('goal'),vector,m);
    if(mode==='vector-change') vector[0]=2;
    let report;
    assert.strictEqual(await f.run('goal',{onResultMetadata:r=>{report=r;}}),vector);
    assert.equal(report.source,'unknown');
    assert.equal(report.generation,null);
    assert.equal(f.calls,0);
  }
});
test('concurrent same-text requests share one generation and Promise<vector>',async()=>{
  const f=fixture(),reports=[];
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const generate=f.plugin.getSingleEmbedding;
  f.plugin.getSingleEmbedding=async(...args)=>{await gate;return generate(...args);};
  const a=f.run('goal',{onResultMetadata:r=>reports.push(r)});
  const b=f.run('goal',{onResultMetadata:r=>reports.push(r)});
  const pending=f.plugin.pendingEmbeddingRequests.get(f.key('goal'));
  assert(pending && typeof pending.then==='function');
  release();
  const [av,bv,pv]=await Promise.all([a,b,pending]);
  assert.strictEqual(av,bv);assert.strictEqual(av,pv);
  assert.equal(f.calls,1);
  assert.deepEqual(reports.map(r=>r.route).sort(),['generated','pending']);
  assert(reports.every(r=>r.source==='generated-single'));
});
test('eviction before pending reader resumes loses metadata but does not regenerate',async()=>{
  const f=fixture(),reports=[];
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const generate=f.plugin.getSingleEmbedding;
  f.plugin.getSingleEmbedding=async(...args)=>{await gate;return generate(...args);};
  const set=f.cache.set.bind(f.cache);
  f.cache.set=(...args)=>{
    set(...args);
    f.cache.caches.get('embedding').data.delete(f.key('goal'));
  };
  const a=f.run('goal',{onResultMetadata:r=>reports.push(r)});
  const b=f.run('goal',{onResultMetadata:r=>reports.push(r)});
  release();await Promise.all([a,b]);
  assert.equal(f.calls,1);
  assert.equal(reports.find(r=>r.route==='pending').source,'unknown');
});
test('generation throws synchronously or rejects without leaving pending locks',async()=>{
  for(const generate of [
    ()=>{throw Error('fixture failure');},
    async()=>{throw Error('fixture failure');}
  ]) {
    const f=fixture();f.plugin.getSingleEmbedding=generate;
    await assert.rejects(f.run(),/fixture failure/);
    assert.equal(f.plugin.pendingEmbeddingRequests.size,0);
  }
});
test('observer exceptions and late producer metadata cannot corrupt cached source',async()=>{
  for(const observer of [
    ()=>{throw Error('observer');},async()=>{throw Error('observer');}
  ]) {
    const f=fixture();
    let late;
    const generate=f.plugin.getSingleEmbedding;
    f.plugin.getSingleEmbedding=async(text,options)=>{
      late=options.onResultMetadata;return generate(text,options);
    };
    const vector=await f.run('goal',{onResultMetadata:observer});
    late({...f.metadata('goal',vector),source:'fuzzy-reuse'});
    let report;
    await f.run('goal',{onResultMetadata:r=>{report=r;}});
    assert.equal(report.source,'generated-single');
    assert.equal(f.calls,1);
    await new Promise(resolve=>setImmediate(resolve));
  }
});
test('concurrent different texts retain their own generation bindings',async()=>{
  const f=fixture(),reports={};
  await Promise.all(['alpha','beta'].map(text=>f.run(text,{
    onResultMetadata:r=>{reports[text]=r;}
  })));
  assert.equal(f.calls,2);
  for(const text of ['alpha','beta'])
    assert.equal(reports[text].generation.textHash,hash(text));
});