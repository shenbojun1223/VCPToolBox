'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {VexusIndex} = require('../rust-vexus-lite');
require('../modules/messageProcessor');
const {analyzeGravityRequestShadow:analyze} =
  require('../modules/vcpLoop/gravityRequestShadow');
const {createGravityVectorReceiver} = require('../modules/vcpLoop/gravityVectorReceiver');
const {readGravityCacheRecord:read} = require('../modules/vcpLoop/gravityCacheRecord');
const CacheManager = require('../Plugin/RAGDiaryPlugin/CacheManager');
const hash = text => createHash('sha256').update(text).digest('hex');
const native = new VexusIndex(3,16);
function record(text,vector) {
  const textHash=hash(text.trim());
  return {textHash,vector,provenance:{
    schema:'embedding-generation-metadata-v1',source:'generated-single',
    textHash,vectorHash:hash(JSON.stringify(vector)),dimension:vector.length,
    chunkCount:1,usableChunks:1,fullCoverage:true,modelDeclarationsConsistent:true,
    requestedModel:'fixture',responseModel:'fixture'
  }};
}
function evidence(b) {
  return {...b,schema:'gravity-space-evidence-v1',allChunksAttested:true,
    spaceId:'synthetic-space',encoderRevision:'synthetic-revision',
    encodingProfile:'synthetic-encoding',compositionProfile:'single'};
}
function fixture() {
  const old = '悠悠白云缓缓流过山间。'.repeat(3300);
  const goalText = '继续GravityStub的任务';
  const raw = '完整工具回执'.repeat(300);
  const latest = '<!-- VCP_TOOL_PAYLOAD -->\n截断后的回执';
  const messages = [
    {role:'system',content:'系统内容'},
    {role:'user',content:'很久之前的话题'},
    {role:'assistant',content:old},
    {role:'user',content:'上一轮请求'},
    {role:'assistant',content:'上一轮回答'},
    {role:'user',content:goalText},
    {role:'assistant',content:'工具请求'},
    {role:'user',content:latest}
  ];
  const packet = {
    version:'rag-refresh-vectors-v1',source:'current-refresh',
    provenance:'unknown',foldEligible:false,
    bindings:{userRawHash:hash(goalText),toolResultsRawHash:hash(raw)},
    goal:{...record(goalText,[1,0,0]),transform:'sanitizeForEmbedding:user'},
    payload:{...record(raw,[0,1,0]),transform:'refreshRagBlock:tool-cleanup'}
  };
  const receiver = createGravityVectorReceiver({userText:goalText,toolResultsText:raw});
  receiver.accept(packet);
  const f = {messages,old,reads:0,nativeCalls:0};
  f.options = {
    recursionDepth:0,latestPayload:latest,gravityRawToolResults:raw,
    gravityHandoff:receiver.finish(),
    contextBridge:{getEmbeddingRecordFromCache(text){
      f.reads++; assert.equal(text,old); return record(text,[0,0,1]);
    }},
    gravityShadowDependencies:{resolveEvidence:evidence,nativeIndex:{
      computeOrthogonalProjection(...args){
        f.nativeCalls++; return native.computeOrthogonalProjection(...args);
      }
    }}
  };
  f.run = () => analyze(f.messages,f.options);
  return f;
}
test('request-local real receiver to real Rust, truncated payload, originals intact',()=>{
  const f=fixture(),before=JSON.stringify(f.messages),packet=JSON.stringify(f.options.gravityHandoff);
  const r=f.run();
  assert.equal(r.status,'analyzed',r.reason);
  assert.equal(r.reason,'conditional-contract-shadow');
  assert.equal(r.scores.length,1); assert.equal(r.scores[0].index,2);
  assert.equal(r.scores[0].residualEnergyRatio,1);
  assert.equal(r.wouldStub,0); assert.equal(r.potentialChars,0);
  assert.equal(r.foldEligible,false); assert.equal(r.spaceVerified,false);
  assert.equal(f.reads,1); assert.equal(f.nativeCalls,1);
  assert.equal(JSON.stringify(f.messages),before);
  assert.equal(JSON.stringify(f.options.gravityHandoff),packet);
  for(const privateValue of [f.old,hash(f.old),'synthetic-space','vectorHash'])
    assert(!JSON.stringify(r).includes(privateValue));
});
test('missing trusted resolver skips before any cache or native work',()=>{
  const f=fixture(); delete f.options.gravityShadowDependencies;
  assert.equal(f.run().reason,'missing-space-evidence');
  assert.equal(f.reads,0);assert.equal(f.nativeCalls,0);
});
test('stale goal or raw receipt, rejected handoff, missing raw binding reject',()=>{
  for(const change of [
    f=>{f.messages[5].content='another request';},
    f=>{f.options.gravityRawToolResults='another receipt';},
    f=>{f.options.gravityHandoff.status='rejected';},
    f=>{delete f.options.gravityRawToolResults;},
    f=>{f.options.gravityHandoff.packet.payload.vector[1]=2;}
  ]) {
    const f=fixture();change(f);
    const r=f.run();assert.equal(r.status,'skipped');
    assert.deepEqual(r.scores,[]);assert.equal(f.nativeCalls,0);
  }
});
test('current payload must be the last actual receipt, not arbitrary matching old text',()=>{
  for(const change of [
    f=>{f.messages[7].content='other';},
    f=>{f.messages.push({role:'assistant',content:f.options.latestPayload});},
    f=>{f.options.latestPayload='unmarked';f.messages[7].content='unmarked';}
  ]) {
    const f=fixture();change(f);assert.equal(f.run().status,'skipped');
    assert.equal(f.reads,0);assert.equal(f.nativeCalls,0);
  }
});
test('critical details, protocol, tool metadata, recent turns are never cache candidates',()=>{
  for(const change of [
    f=>{f.messages[2].content+='必须保留';},
    f=>{f.messages[2].content+='Never discard';},
    f=>{f.messages[2].content+='OneRing';},
    f=>{f.messages[2].tool_calls=[];},
    f=>{f.messages[2].role='user';}
  ]) {
    const f=fixture();change(f);
    assert.equal(f.run().reason,'no-cached-candidates');
    assert.equal(f.reads,0);assert.equal(f.nativeCalls,0);
  }
});
test('unsupported multimodal, budgets, abort fail without reads',()=>{
  for(const change of [
    f=>{f.messages[2].content=[{type:'text',text:f.old}];},
    f=>{f.messages[2].content='short';},
    f=>{f.messages[2].content='长'.repeat(1000001);},
    f=>{f.messages=new Array(257).fill(f.messages[0]);},
    f=>{f.options.recursionDepth=-1;},
    f=>{f.options.signal=AbortSignal.abort();}
  ]) {
    const f=fixture();change(f);assert.equal(f.run().status,'skipped');
    assert.equal(f.reads,0);assert.equal(f.nativeCalls,0);
  }
});
test('bad candidate text, stale vector, fuzzy and missing cache never reach Rust',()=>{
  for(const mode of ['text','vector','fuzzy','miss','throw','promise','missing']) {
    const f=fixture();
    f.options.contextBridge.getEmbeddingRecordFromCache=text=>{
      if(mode==='throw')throw Error('private');
      if(mode==='promise')return Promise.reject(Error('private'));
      if(mode==='miss')return null;
      const r=record(text,[0,0,1]);
      if(mode==='text')r.textHash=hash('other');
      if(mode==='vector')r.vector[2]=2;
      if(mode==='fuzzy')r.provenance.source='fuzzy-reuse';
      return r;
    };
    if(mode==='missing')delete f.options.contextBridge.getEmbeddingRecordFromCache;
    const r=f.run();assert.equal(r.status,'skipped',mode);
    assert.equal(f.nativeCalls,0);assert.deepEqual(r.scores,[]);
    assert(!JSON.stringify(r).includes('private'));
  }
});
test('one outer deadline includes cache work and discards partial scores',()=>{
  const f=fixture();
  f.options.contextBridge.getEmbeddingRecordFromCache=text=>{
    const until=performance.now()+20;while(performance.now()<until){}
    return record(text,[0,0,1]);
  };
  assert.equal(f.run().reason,'time-budget-or-abort');assert.equal(f.nativeCalls,0);
});
test('cache record uses exact live entry and detached vectors with no generation',()=>{
  const cache=new CacheManager();cache.createCache('embedding',{maxSize:4,ttl:60000});
  const r=record('hello',[1,0,0]),key=cache.generateKey({text:'hello'});
  cache.set('embedding',key,r.vector,r.provenance);
  const found=read(cache,' hello ');
  assert.equal(found.textHash,r.textHash);assert.notStrictEqual(found.vector,r.vector);
  found.vector[0]=9;assert.equal(r.vector[0],1);
  assert.equal(found.provenance.foldEligible,false);
  assert.equal(read(cache,'hell'),null);
  r.vector[0]=2;assert.equal(read(cache,'hello'),null);
});
test('legacy, fuzzy, incomplete, expired and malformed cache entries return null',()=>{
  for(const mode of ['legacy','fuzzy','partial','expired','dimension','nan','model']) {
    const cache=new CacheManager();cache.createCache('embedding',{maxSize:4,ttl:60000});
    const r=record('hello',[1,0,0]),key=cache.generateKey({text:'hello'});
    if(mode==='fuzzy')r.provenance.source='fuzzy-reuse';
    if(mode==='partial')r.provenance.fullCoverage=false;
    if(mode==='dimension')r.provenance.dimension=2;
    if(mode==='nan')r.vector[0]=NaN;
    if(mode==='model')r.provenance.modelDeclarationsConsistent=false;
    cache.set('embedding',key,r.vector,mode==='legacy'?null:r.provenance);
    if(mode==='expired')cache.caches.get('embedding').data.get(key).timestamp=0;
    assert.equal(read(cache,'hello'),null,mode);
  }
});// Real handler guard and ContextBridge method; evidence is synthetic and isolated.
const fs = require('node:fs');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {safeGravityProjection} = require('../modules/vcpLoop/safeGravityProjection');
const pluginPath = require.resolve('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');
const pluginSource = fs.readFileSync(pluginPath,'utf8');
const bridgeMethodStart = pluginSource.indexOf('            getEmbeddingRecordFromCache(text) {');
const bridgeMethodEnd = pluginSource.indexOf('\n            },',bridgeMethodStart);
assert(bridgeMethodStart >= 0 && bridgeMethodEnd > bridgeMethodStart);
function realBridge(cache) {
  return vm.runInNewContext('({' +
    pluginSource.slice(bridgeMethodStart,bridgeMethodEnd) + '\n}})',{
    self:{cacheManager:cache},require:createRequire(pluginPath)
  });
}
for (const [file,variable] of [
  ['streamHandler.js','currentMessagesForLoop'],
  ['nonStreamHandler.js','currentMessagesForNonStreamLoop']
]) {
  const src=fs.readFileSync(require.resolve('../modules/handlers/'+file),'utf8');
  const guard=src.split('// GRAVITY_SAFETY_BEGIN')[1].split('// GRAVITY_SAFETY_END')[0];
  for (const trusted of [false,true]) {
    test(file+' real guard/bridge/projector, synthetic evidence='+trusted,async()=>{
      const f=fixture(),before=JSON.stringify(f.messages);
      const cache=new CacheManager();cache.createCache('embedding',{maxSize:4,ttl:60000});
      const r=record(f.old,[0,0,1]);
      cache.set('embedding',cache.generateKey({text:f.old}),r.vector,r.provenance);
      const bridge=realBridge(cache);
      let report,seenRaw,calls=0;
      const originalGetter=bridge.getEmbeddingRecordFromCache;
      bridge.getEmbeddingRecordFromCache=text=>{calls++;return originalGetter(text);};
      const context={
        [variable]:f.messages,toolResultsTextForRAG:f.options.gravityRawToolResults,
        payloadForLoop:f.options.latestPayload,recursionDepth:0,
        gravityHandoff:f.options.gravityHandoff,
        pluginManager:{messagePreprocessors:new Map([
          ['RAGDiaryPlugin',{getContextBridge:()=>bridge}]
        ])},
        DEBUG_MODE:false,abortController:new AbortController(),
        require:id=>{
          assert.equal(id,'../vcpLoop/safeGravityProjection.js');
          return {safeGravityProjection:async(messages,options)=>{
            seenRaw=options.gravityRawToolResults;
            return safeGravityProjection(messages,{
              ...options,enabled:true,shadow:true,
              ...(trusted ? {gravityShadowDependencies:f.options.gravityShadowDependencies}:{}),
              onGravityReport:r=>{report=r;}
            });
          }};
        }
      };
      const output=await vm.runInNewContext('(async()=>{'+guard+
        ';return messagesForUpstream;})()',context);
      assert.strictEqual(output,f.messages);
      assert.equal(JSON.stringify(f.messages),before);
      assert.equal(seenRaw,f.options.gravityRawToolResults);
      assert.equal(report.version,'request-contract-shadow-v1');
      assert.equal(report.reason,trusted ?
        'conditional-contract-shadow':'missing-space-evidence');
      assert.equal(report.foldEligible,false);
      assert.equal(report.wouldStub,0);
      assert.equal(calls,trusted?1:0);
      assert.equal(f.nativeCalls,trusted?1:0);
      assert(!JSON.stringify(output).includes('vectorHash'));
    });
  }
}
test('real bridge returns null on unavailable cache without calling other plugin APIs',()=>{
  assert.equal(realBridge(null).getEmbeddingRecordFromCache('hello'),null);
});