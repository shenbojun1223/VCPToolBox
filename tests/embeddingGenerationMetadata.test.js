'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const {getWeightedAverageVector} = require('../Plugin/RAGDiaryPlugin/VectorMathUtils');
const source = fs.readFileSync(require.resolve('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin'), 'utf8');
const start = source.indexOf('    async getSingleEmbedding(');
const end = source.indexOf('\n    _generateCacheKey(', start);
assert(start >= 0 && end > start);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));
const quiet = {log(){},warn(){},error(){}};

async function run(text, vectors, records, observer) {
  let calls = 0, receivedChunks, metadata;
  const method = vm.runInNewContext(
    '({' + source.slice(start,end) + '}).getSingleEmbedding',
    {
      crypto,Float32Array,Float64Array,console:quiet,
      process:{env:{API_Key:'fixture-key',API_URL:'http://fixture.invalid'}},
      chunkText:value=>value.split('|'),
      getEmbeddingsBatch:async(chunks,config)=>{
        calls++;
        receivedChunks=Array.from(chunks);
        config.onResultMetadata?.(records);
        return vectors;
      }
    }
  );
  const plugin = {
    _estimateTokens:()=>1,
    _getWeightedAverageVector:(v,w)=>getWeightedAverageVector(v,w,{logger:quiet})
  };
  const options = observer === false ? {} : {
    onResultMetadata:m=>{
      metadata=plain(m);
      return observer?.(m);
    }
  };
  const result = await method.call(plugin,text,options);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,1,'metadata must not add generation calls');
  return {result,metadata,receivedChunks};
}
function record(model='model-a',dimension=2) {
  return {
    schema:'embedding-result-metadata-v1',source:'api-response',
    indexBinding:'explicit-unique',dimension,
    requestedModel:model,responseModel:model,spaceVerified:false
  };
}
test('single generation binds normalized text and returned vector without claiming trust',async()=>{
  const r=await run('  private source  ',[[1,0]],[record()]);
  assert.deepEqual(r.receivedChunks,['private source']);
  assert.equal(r.metadata.source,'generated-single');
  assert.equal(r.metadata.textHash,hash('private source'));
  assert.equal(r.metadata.vectorHash,hash(JSON.stringify([1,0])));
  assert.equal(r.metadata.fullCoverage,true);
  assert.equal(r.metadata.modelDeclarationsConsistent,true);
  assert.equal(r.metadata.spaceVerified,false);
  assert.equal(r.metadata.foldEligible,false);
  assert(!JSON.stringify(r.metadata).includes('private source'));
});
test('complete chunk merge records coverage and exact merged vector binding',async()=>{
  const r=await run('alpha|beta',[[1,0],[0,1]],[record(),record()]);
  assert.deepEqual(r.result,[0.5,0.5]);
  assert.equal(r.metadata.source,'generated-chunk-merge');
  assert.equal(r.metadata.chunkCount,2);
  assert.equal(r.metadata.usableChunks,2);
  assert.equal(r.metadata.fullCoverage,true);
  assert.equal(r.metadata.vectorHash,hash(JSON.stringify(r.result)));
});
test('partial failure preserves existing vector return but cannot claim full coverage',async()=>{
  const r=await run('alpha|beta',[[1,0],null],[record(),null]);
  assert.deepEqual(r.result,[1,0]);
  assert.equal(r.metadata.fullCoverage,false);
  assert.equal(r.metadata.usableChunks,1);
  assert.equal(r.metadata.modelDeclarationsConsistent,false);
  assert.equal(r.metadata.responseModel,null);
});
test('mixed declared models are not merged into a single claimed space',async()=>{
  const r=await run('alpha|beta',[[1,0],[0,1]],[record('a'),record('b')]);
  assert.equal(r.metadata.fullCoverage,true);
  assert.equal(r.metadata.modelDeclarationsConsistent,false);
  assert.equal(r.metadata.requestedModel,null);
  assert.equal(r.metadata.responseModel,null);
});
test('missing metadata cannot certify models even if every vector is present',async()=>{
  const r=await run('alpha|beta',[[1,0],[0,1]],undefined);
  assert.equal(r.metadata.fullCoverage,true);
  assert.equal(r.metadata.describedChunks,0);
  assert.equal(r.metadata.modelDeclarationsConsistent,false);
});
test('mismatched dimensions are not counted as complete coverage',async()=>{
  const r=await run('alpha|beta',[[1,0],[0,1,0]],[record(),record('model-a',3)]);
  assert.equal(r.metadata.fullCoverage,false);
  assert.equal(r.metadata.usableChunks,1);
});
test('throwing or rejecting metadata observer preserves result and call count',async()=>{
  for(const observer of [
    ()=>{throw Error('fixture observer');},
    async()=>{throw Error('fixture observer');}
  ]) {
    const r=await run('alpha',[[1,0]],[record()],observer);
    assert.deepEqual(r.result,[1,0]);
  }
});
test('legacy opt-out and wholly failed generation keep old return shape',async()=>{
  const legacy=await run('alpha',[[1,0]],[record()],false);
  assert.deepEqual(legacy.result,[1,0]);
  assert.equal(legacy.metadata,undefined);
  const failed=await run('alpha|beta',[null,null],[null,null]);
  assert.equal(failed.result,null);
  assert.equal(failed.metadata,undefined);
});