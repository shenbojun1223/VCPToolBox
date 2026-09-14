'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');

// Execute the actual production method without constructing the RAG singleton,
// loading databases, starting watchers, or contacting an embedding service.
const source = fs.readFileSync(
  require.resolve('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js'), 'utf8');
const start = source.indexOf('    async refreshRagBlock(');
const end = source.indexOf('\n    async _processRAGPlaceholder(', start);
assert(start >= 0 && end > start, 'production method extraction boundary');
const refresh = vm.runInNewContext(
  '({' + source.slice(start, end) + '}).refreshRagBlock',
  {crypto, structuredClone, Float32Array, Float64Array, console:{log(){},warn(){},error(){}}}
);
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const metadata = {dbName:'isolated',modifiers:'',k:1};
function fixture() {
  const vectors = [[1,0],[0.5,0.5],[0,1]];
  const calls = [];
  const plugin = {
    sanitizeForEmbedding: (text,role) => role + ':' + text,
    _jsonToMarkdown: value => 'markdown:' + value.text,
    _stripHtml: text => text,
    _stripEmoji: text => text,
    getSingleEmbeddingCached: async text => {
      calls.push(text);
      if(text.startsWith('user:')) return vectors[0];
      if(text.startsWith('assistant:')) return vectors[1];
      return vectors[2];
    },
    _getWeightedAverageVector: () => [0.5,0.5],
    timeParser:{parse:()=>[]},
    _processRAGPlaceholder: async () => 'refreshed content'
  };
  const context = {
    lastAiMessage:'assistant fixture',
    toolResultsText:JSON.stringify({text:'tool fixture'})
  };
  return {vectors,calls,plugin,context};
}
const run = (f, goal='goal fixture') =>
  refresh.call(f.plugin, metadata, f.context, goal);

test('real refresh exports bound transformed vectors without extra embedding calls',async()=>{
  const f=fixture();let packet;
  f.context.onGravityVectors = value => {packet=value;};
  assert.equal(await run(f),'refreshed content');
  assert.deepEqual(f.calls,[
    'user:goal fixture','assistant:assistant fixture','markdown:tool fixture'
  ]);
  assert.equal(packet.version,'rag-refresh-vectors-v1');
  assert.equal(packet.source,'current-refresh');
  assert.equal(packet.provenance,'unknown');
  assert.equal(packet.foldEligible,false);
  assert.equal(packet.bindings.userRawHash,hash('goal fixture'));
  assert.equal(packet.bindings.toolResultsRawHash,hash(f.context.toolResultsText));
  assert.equal(packet.goal.textHash,hash('user:goal fixture'));
  assert.equal(packet.payload.textHash,hash('markdown:tool fixture'));
  assert.deepEqual(Array.from(packet.goal.vector),[1,0]);
  assert.deepEqual(Array.from(packet.payload.vector),[0,1]);
  assert(!JSON.stringify(packet).includes('goal fixture'));
  assert(!JSON.stringify(packet).includes('tool fixture'));
});

test('handoff and embedding cache do not share vector references',async()=>{
  const f=fixture();let packet;
  f.context.onGravityVectors = value => {packet=value;value.goal.vector[0]=99;};
  await run(f);
  assert.equal(f.vectors[0][0],1);
  f.vectors[2][1]=77;
  assert.equal(packet.payload.vector[1],1);
});

test('absent, throwing and rejecting observers preserve refresh return and call count',async()=>{
  for(const observer of [undefined,()=>{throw Error('observer failure');},
    async()=>{throw Error('async observer failure');}]) {
    const f=fixture(); f.context.onGravityVectors=observer;
    assert.equal(await run(f),'refreshed content');
    assert.equal(f.calls.length,3);
  }
  await new Promise(resolve=>setImmediate(resolve));
});

test('failed or empty RAG result does not export a successful handoff',async()=>{
  for(const mode of ['throw','empty']) {
    const f=fixture();let packets=0;
    f.context.onGravityVectors=()=>{packets++;};
    f.plugin._processRAGPlaceholder=async()=>{
      if(mode==='throw') throw Error('retrieval failed');
      return '';
    };
    if(mode==='throw') await assert.rejects(run(f),/retrieval failed/);
    else assert.equal(await run(f),'');
    assert.equal(packets,0);
  }
});

test('malformed vectors are exported as unavailable, never as valid evidence',async()=>{
  for(const value of [null,[NaN,1],[0,0],[Infinity,1],['1',0],new Array(4097).fill(1)]) {
    const f=fixture(); f.vectors[0]=value;let packet;
    f.context.onGravityVectors=v=>{packet=v;};
    assert.equal(await run(f),'refreshed content');
    assert.equal(packet.goal.vector,null);
    assert.equal(packet.foldEligible,false);
  }
});

test('typed vectors are copied to bounded numeric arrays',async()=>{
  const f=fixture();f.vectors[0]=new Float32Array([1,0]);let packet;
  f.context.onGravityVectors=v=>{packet=v;};
  await run(f);
  assert(Array.isArray(packet.goal.vector));
  assert.deepEqual(Array.from(packet.goal.vector),[1,0]);
});

test('interleaved requests on one plugin keep callbacks and bindings separate',async()=>{
  const f=fixture();const packets={};const waiting=[];
  f.plugin._processRAGPlaceholder=()=>new Promise(resolve=>waiting.push(resolve));
  const makeContext=label=>({
    lastAiMessage:'assistant '+label,
    toolResultsText:JSON.stringify({text:'tool '+label}),
    onGravityVectors:packet=>{packets[label]=packet;}
  });
  const alpha=makeContext('alpha'),beta=makeContext('beta');
  const a=refresh.call(f.plugin,metadata,alpha,'goal alpha');
  const b=refresh.call(f.plugin,metadata,beta,'goal beta');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(waiting.length,2);
  waiting[1]('beta result');
  assert.equal(await b,'beta result');
  assert.equal(packets.alpha,undefined);
  waiting[0]('alpha result');
  assert.equal(await a,'alpha result');
  for(const [label,context] of [['alpha',alpha],['beta',beta]]) {
    assert.equal(packets[label].bindings.userRawHash,hash('goal '+label));
    assert.equal(packets[label].bindings.toolResultsRawHash,hash(context.toolResultsText));
  }
  assert(!Object.hasOwn(f.plugin,'onGravityVectors'));
});

test('non-string source binding does not produce an unverifiable packet',async()=>{
  const f=fixture();let packets=0;
  f.context.toolResultsText={text:'object result'};
  f.context.onGravityVectors=()=>{packets++;};
  assert.equal(await run(f),'refreshed content');
  assert.equal(packets,0);
});function enableSourceFixture(f, edit = () => {}) {
  const original = f.plugin.getSingleEmbeddingCached;
  f.plugin.getSingleEmbeddingCached = async (text, options) => {
    const vector = await original(text);
    const record = {
      schema:'embedding-cache-result-v1',route:'generated',source:'generated-single',
      generation:{
        schema:'embedding-generation-metadata-v1',source:'generated-single',
        textHash:hash(text.trim()),vectorHash:hash(JSON.stringify(Array.from(vector))),
        chunkCount:1,usableChunks:1,fullCoverage:true,
        modelDeclarationsConsistent:true,requestedModel:'fixture',responseModel:'fixture',
        spaceVerified:false,foldEligible:false
      }
    };
    edit(record,text,vector);
    options?.onResultMetadata?.(record);
    return vector;
  };
}
test('refresh preserves bound source descriptions without promoting trust',async()=>{
  const f=fixture();enableSourceFixture(f);let packet;
  f.context.onGravityVectors=p=>{packet=p;};
  await run(f);
  assert.equal(f.calls.length,3);
  for(const anchor of [packet.goal,packet.payload]) {
    assert.equal(anchor.provenance.source,'generated-single');
    assert.equal(anchor.provenance.fullCoverage,true);
    assert.equal(anchor.provenance.vectorHash,hash(JSON.stringify(anchor.vector)));
    assert.equal(anchor.provenance.spaceVerified,false);
    assert.equal(anchor.provenance.foldEligible,false);
  }
  assert.equal(packet.provenance,'unknown');
  assert.equal(packet.foldEligible,false);
});
test('text mismatch or vector mutation during retrieval loses source description',async()=>{
  for(const mode of ['text-mismatch','late-vector-mutation']) {
    const f=fixture();let packet;
    enableSourceFixture(f,record=>{
      if(mode==='text-mismatch') record.generation.textHash=hash('different text');
    });
    if(mode==='late-vector-mutation') f.plugin._processRAGPlaceholder=async()=>{
      f.vectors[0][0]=2;return 'refreshed';
    };
    f.context.onGravityVectors=p=>{packet=p;};
    await run(f);
    assert.equal(packet.goal.provenance.source,'unknown');
    assert.equal(packet.foldEligible,false);
  }
});
test('fuzzy source cannot export producer claims of complete coverage or verified space',async()=>{
  const f=fixture();let packet;
  enableSourceFixture(f,record=>{
    record.source='fuzzy-reuse';
    record.generation.source='fuzzy-reuse';
    record.generation.spaceVerified=true;
    record.generation.foldEligible=true;
  });
  f.context.onGravityVectors=p=>{packet=p;};
  await run(f);
  for(const anchor of [packet.goal,packet.payload]) {
    assert.equal(anchor.provenance.source,'fuzzy-reuse');
    assert.equal(anchor.provenance.fullCoverage,false);
    assert.equal(anchor.provenance.modelDeclarationsConsistent,false);
    assert.equal(anchor.provenance.responseModel,null);
    assert.equal(anchor.provenance.spaceVerified,false);
    assert.equal(anchor.provenance.foldEligible,false);
  }
});
test('source callbacks after generation completes cannot replace captured provenance',async()=>{
  const f=fixture();let packet;const callbacks=[];
  enableSourceFixture(f);
  const generate=f.plugin.getSingleEmbeddingCached;
  f.plugin.getSingleEmbeddingCached=async(text,options)=>{
    if(options?.onResultMetadata) callbacks.push(options.onResultMetadata);
    return generate(text,options);
  };
  f.plugin._processRAGPlaceholder=async()=>{
    for(const callback of callbacks) callback({source:'late invalid description'});
    return 'refreshed';
  };
  f.context.onGravityVectors=p=>{packet=p;};
  await run(f);
  assert.equal(callbacks.length,2);
  assert.equal(packet.goal.provenance.source,'generated-single');
  assert.equal(packet.payload.provenance.source,'generated-single');
});