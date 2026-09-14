'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../EmbeddingUtils'), 'utf8');
const start = source.indexOf('async function _sendBatch(');
const end = source.indexOf('\nfunction cosineSimilarity(', start);
assert(start >= 0 && end > start);
const body = source.slice(start, end).replace(
  "const { default: fetch } = await import('node-fetch');",
  'const fetch = fixtureFetch;'
);
assert(!body.includes("await import('node-fetch')"));
const plain = value => JSON.parse(JSON.stringify(value));

async function run(texts, respond, observer, models=['primary']) {
  const requests=[];
  const context={
    fixtureFetch:async(_url, options)=>{
      const request=JSON.parse(options.body);
      requests.push(request);
      const response=await respond(request);
      return {ok:response.status===undefined || response.status===200,
        status:response.status || 200,
        text:async()=>JSON.stringify(response.body || {})};
    },
    _getEmbeddingModelCandidates:()=>models,
    _writeEmbeddingAuditLog:async()=>{},
    encoding:{encode:text=>({length:text==='oversize'?101:1})},
    safeMaxTokens:100,MAX_BATCH_ITEMS:2,DEFAULT_CONCURRENCY:2,
    console:{log(){},warn(){},error(){}},
    // Fixture retries do not wait or contact any external endpoint.
    setTimeout:fn=>{fn();return 0;}
  };
  const batch=vm.runInNewContext(body+'\ngetEmbeddingsBatch',context);
  const vectors=await batch(texts,{
    apiUrl:'http://fixture.invalid',apiKey:'private-fixture-key',
    onResultMetadata:observer
  });
  await new Promise(resolve=>setImmediate(resolve));
  return {vectors:plain(vectors),requests};
}

test('interleaved batches keep source models and missing slots aligned',async()=>{
  let release, count=0, metadata;
  const gate=new Promise(resolve=>{release=resolve;});
  const r=await run(['A','B','C','D'],async request=>{
    if(request.input[0]==='A') {
      await gate;
      return {body:{model:'model-alpha',data:[{index:1,embedding:[2,0]}]}};
    }
    const response={body:{model:'model-beta',data:[
      {index:1,embedding:[4,0]},{index:0,embedding:[3,0]}
    ]}};
    release();
    return response;
  }, records=>{count++;metadata=plain(records);});
  assert.equal(count,1);
  assert.equal(r.requests.length,2);
  assert.deepEqual(r.vectors,[null,[2,0],[3,0],[4,0]]);
  assert.deepEqual(metadata.map(m=>m?.responseModel || null),
    [null,'model-alpha','model-beta','model-beta']);
  assert(metadata.filter(Boolean).every(m=>
    m.requestedModel==='primary' && m.dimension===2 && m.spaceVerified===false));
});

test('oversize, failed and duplicate slots have no success metadata',async()=>{
  let metadata;
  const r=await run(['oversize','A','B','C'],async request=>{
    if(request.input[0]==='C') throw Error('fixture failure');
    return {body:{data:[
      {index:0,embedding:[1,0]},{index:0,embedding:[9,0]},
      {index:1,embedding:[2,0]}
    ]}};
  }, records=>{metadata=plain(records);});
  assert.deepEqual(r.vectors,[null,null,[2,0],null]);
  assert.deepEqual(metadata.map(m=>m===null),[true,true,false,true]);
  assert.equal(metadata[2].responseModel,null);
  assert.equal(r.requests.length,2);
});

test('fallback records successful requested model rather than the original choice',async()=>{
  let metadata;
  const r=await run(['A'],async request=>request.model==='primary'
    ? {status:503,body:{error:'fixture unavailable'}}
    : {body:{model:'reported-backup',data:[{index:0,embedding:[1,0]}]}},
    records=>{metadata=plain(records);},['primary','backup']);
  assert.equal(r.requests.length,2);
  assert.equal(metadata[0].requestedModel,'backup');
  assert.equal(metadata[0].responseModel,'reported-backup');
  assert.equal(metadata[0].spaceVerified,false);
});

test('metadata observer throw and rejection never retry or change vectors',async()=>{
  for(const observer of [
    ()=>{throw Error('observer failure');},
    async()=>{throw Error('observer rejection');}
  ]) {
    const r=await run(['A'],async()=>({body:{data:[{index:0,embedding:[1,0]}]}}),observer);
    assert.deepEqual(r.vectors,[[1,0]]);
    assert.equal(r.requests.length,1);
  }
});

test('observer receives no vector references, source text, endpoint or credentials',async()=>{
  let serialized;
  const r=await run(['private-source-text'],async()=>({
    body:{model:'reported',data:[{index:0,embedding:[1,0]}]}
  }), records=>{
    serialized=JSON.stringify(records);
    records[0].dimension=999;
    records[0].responseModel='mutated';
    records[0]=null;
  });
  assert.deepEqual(r.vectors,[[1,0]]);
  for(const secret of ['private-source-text','fixture.invalid','private-fixture-key','embedding":'])
    assert(!serialized.includes(secret));
});

test('legacy caller retains array output without opting into metadata',async()=>{
  const r=await run(['A'],async()=>({
    body:{model:'reported',data:[{index:0,embedding:[1,0]}]}
  }));
  assert.deepEqual(r.vectors,[[1,0]]);
  assert.equal(r.requests.length,1);
});

test('malformed response model is not promoted to a space identity',async()=>{
  for(const model of [null,{},'x'.repeat(257)]) {
    let metadata;
    await run(['A'],async()=>({
      body:{model,data:[{index:0,embedding:[1,0]}]}
    }),records=>{metadata=plain(records);});
    assert.equal(metadata[0].responseModel,null);
    assert.equal(metadata[0].spaceVerified,false);
  }
});