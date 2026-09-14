'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../EmbeddingUtils.js'), 'utf8');
const start = source.indexOf('async function _sendBatch(');
const end = source.indexOf('\nasync function getEmbeddingsBatch(', start);
assert(start >= 0 && end > start);
const body = source.slice(start,end).replace(
  "const { default: fetch } = await import('node-fetch');",
  'const fetch = fixtureFetch;'
);
assert(!body.includes("await import('node-fetch')"), 'network seam must be replaced');
async function run(data) {
  let requests=0;
  const audited=[];
  const send = vm.runInNewContext('('+body+'\n)', {
    fixtureFetch: async()=>{
      requests++;
      return {ok:true,status:200,text:async()=>JSON.stringify({data,model:'fixture-model'})};
    },
    _getEmbeddingModelCandidates:()=>['fixture-model'],
    _writeEmbeddingAuditLog:async texts=>audited.push(...texts),
    console:{log(){},warn(){},error(){}},
    setTimeout
  });
  const result=await send(['alpha','beta','gamma'],
    {apiUrl:'http://fixture.invalid',apiKey:'fixture-only'},1);
  assert.equal(requests,1,'response validation must not add generation requests');
  return {vectors:JSON.parse(JSON.stringify(result)),audited};
}
test('response order follows explicit index, not response array order',async()=>{
  const r=await run([
    {index:2,embedding:[0,0,1]},
    {index:0,embedding:[1,0,0]},
    {index:1,embedding:[0,1,0]}
  ]);
  assert.deepEqual(r.vectors,[[1,0,0],[0,1,0],[0,0,1]]);
});
test('missing middle result stays null without shifting later vector',async()=>{
  const r=await run([{index:0,embedding:[1,0,0]},{index:2,embedding:[0,0,1]}]);
  assert.deepEqual(r.vectors,[[1,0,0],null,[0,0,1]]);
  assert.deepEqual(r.audited,['alpha','gamma']);
});
test('duplicate index is ambiguous and invalidates that slot',async()=>{
  const r=await run([
    {index:0,embedding:[1,0,0]},
    {index:1,embedding:[0,1,0]},
    {index:1,embedding:[1,1,0]},
    {index:2,embedding:[0,0,1]}
  ]);
  assert.deepEqual(r.vectors,[[1,0,0],null,[0,0,1]]);
  assert.deepEqual(r.audited,['alpha','gamma']);
});
test('invalid indices cannot populate another text slot',async()=>{
  const r=await run([
    {index:-1,embedding:[1,0,0]},
    {index:3,embedding:[0,1,0]},
    {index:'0',embedding:[1,1,0]},
    {index:2,embedding:[0,0,1]}
  ]);
  assert.deepEqual(r.vectors,[null,null,[0,0,1]]);
  assert.deepEqual(r.audited,['gamma']);
});
test('empty response preserves full batch shape',async()=>{
  assert.deepEqual((await run([])).vectors,[null,null,null]);
});// Exercise both actual production functions together; only network, token
// counting and audit I/O are fixtures. No production API or files are used.
async function runBatches(texts, responder) {
  const batchStart=source.indexOf('async function getEmbeddingsBatch(');
  const batchEnd=source.indexOf('\nfunction cosineSimilarity(',batchStart);
  assert(batchStart>=0 && batchEnd>batchStart);
  const calls=[],completed=[];
  const context={
    fixtureFetch:async(_url,options)=>{
      const inputs=JSON.parse(options.body).input;
      calls.push(inputs);
      const data=await responder(inputs);
      completed.push(inputs[0]);
      return {ok:true,status:200,text:async()=>JSON.stringify({data})};
    },
    _getEmbeddingModelCandidates:()=>['fixture-model'],
    _writeEmbeddingAuditLog:async()=>{},
    encoding:{encode:text=>({length:text==='oversize'?101:1})},
    safeMaxTokens:100,MAX_BATCH_ITEMS:3,DEFAULT_CONCURRENCY:2,
    console:{log(){},warn(){},error(){}},setTimeout
  };
  const batch=vm.runInNewContext(
    body+'\n'+source.slice(batchStart,batchEnd)+'\ngetEmbeddingsBatch',context);
  const vectors=await batch(texts,{apiUrl:'http://fixture.invalid',apiKey:'fixture-only'});
  return {vectors:JSON.parse(JSON.stringify(vectors)),calls,completed};
}
test('interleaved batches preserve a missing middle slot through final assembly',async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const r=await runBatches(['A','B','C','D','E','F'],async inputs=>{
    if(inputs[0]==='A') {
      await gate;
      return [{index:0,embedding:[1,0]},{index:2,embedding:[3,0]}];
    }
    release();
    return [
      {index:2,embedding:[6,0]},
      {index:0,embedding:[4,0]},
      {index:1,embedding:[5,0]}
    ];
  });
  assert.equal(r.calls.length,2);
  assert.deepEqual(r.vectors,[[1,0],null,[3,0],[4,0],[5,0],[6,0]]);
});
test('skipped oversize inputs do not shift subsequent batch positions',async()=>{
  const r=await runBatches(['A','oversize','C','D'],async()=>[
    {index:2,embedding:[4,0]},{index:0,embedding:[1,0]}
  ]);
  assert.deepEqual(r.calls,[['A','C','D']]);
  assert.deepEqual(r.vectors,[[1,0],null,null,[4,0]]);
});
test('failed batch stays null while another batch succeeds without extra attempts',async()=>{
  const r=await runBatches(['A','B','C','D'],async inputs=>{
    if(inputs[0]==='A') throw Error('fixture network failure');
    return [{index:0,embedding:[4,0]}];
  });
  assert.equal(r.calls.length,2);
  assert.deepEqual(r.vectors,[null,null,null,[4,0]]);
});
test('null rows, malformed vectors and repeated invalid slot remain unavailable',async()=>{
  const r=await run([
    null,{index:0,embedding:['bad']},
    {index:0,embedding:[1,0]},
    {index:1,embedding:[]},
    {index:2,embedding:[0,0,1]}
  ]);
  assert.deepEqual(r.vectors,[null,null,[0,0,1]]);
  assert.deepEqual(r.audited,['gamma']);
});