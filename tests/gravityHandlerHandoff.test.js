'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const {createGravityVectorReceiver} = require('../modules/vcpLoop/gravityVectorReceiver');
const {findLastRealUserMessage} = require('../modules/messageProcessor');
const {safeGravityProjection} = require('../modules/vcpLoop/safeGravityProjection');
const {projectGravityStub} = require('../modules/vcpLoop/gravityStub');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function packet(goal, tool) {
  return {
    version:'rag-refresh-vectors-v1',source:'current-refresh',provenance:'unknown',
    foldEligible:false,
    bindings:{userRawHash:hash(goal),toolResultsRawHash:hash(tool)},
    goal:{vector:[1,0],textHash:hash(goal),transform:'sanitizeForEmbedding:user'},
    payload:{vector:[0,1],textHash:hash(tool),transform:'refreshRagBlock:tool-cleanup'}
  };
}
for(const [file,variable] of [
  ['streamHandler.js','currentMessagesForLoop'],
  ['nonStreamHandler.js','currentMessagesForNonStreamLoop']
]) {
  const src=fs.readFileSync(require.resolve('../modules/handlers/'+file),'utf8');
  const start=src.indexOf('// Request-local, round-local handoff;');
  const end=src.indexOf('const hasImage',start);
  assert(start>=0 && end>start);
  const lifecycle=src.slice(start,end);
  const guard=src.split('// GRAVITY_SAFETY_BEGIN')[1].split('// GRAVITY_SAFETY_END')[0];
  async function run({goal='goal',tool='tool',enabled=true,refresh=true,
      failLoad=false,failRefresh=false,deliver=true,wrong=false,wait}={}) {
    const messages=[{role:'system',content:'policy'},{role:'user',content:goal}];
    const original=JSON.stringify(messages);
    let loads=0,refreshes=0,late,seen,report,cacheReads=0;
    const context={
      [variable]:messages, toolResultsTextForRAG:tool,
      currentAIContentForLoop:'tool call',RAGMemoRefresh:refresh,
      pluginManager:{},DEBUG_MODE:false,payloadForLoop:'receipt',recursionDepth:0,
      abortController:new AbortController(),
      process:{env:{VCP_GRAVITY_SHADOW:enabled?'true':'false'}},
      require:id=>{
        if(id==='../vcpLoop/gravityVectorReceiver.js') {
          loads++; if(failLoad) throw Error('receiver unavailable');
          return {createGravityVectorReceiver};
        }
        if(id==='../messageProcessor.js') return {findLastRealUserMessage};
        if(id==='../vcpLoop/safeGravityProjection.js') return {
          safeGravityProjection:async(m,options)=>{
            seen=options.gravityHandoff;
            return safeGravityProjection(m,{
              ...options,enabled:true,shadow:true,
              contextBridge:{getEmbeddingFromCache(){cacheReads++;return [1,0];}},
              onGravityReport:r=>{report=r;}
            });
          }
        };
        throw Error('unexpected dependency');
      },
      _refreshRagBlocksIfNeeded:async(m,c)=>{
        refreshes++;late=c.onGravityVectors;
        if(wait) await wait;
        if(deliver) c.onGravityVectors?.(packet(wrong?'other':goal,tool));
        if(failRefresh) throw Error('refresh failed');
        return m;
      }
    };
    const result=await vm.runInNewContext('(async()=>{let error=null;try{'+
      lifecycle+guard+
      ';return {handoff:gravityHandoff,messages:messagesForUpstream};'+
      '}catch(e){return {error:e.message};}})()',context);
    assert.equal(JSON.stringify(messages),original);
    return {result,loads,refreshes,late,seen,report,cacheReads};
  }
  test(file+' real lifecycle and guard deliver an unverified packet but send originals',async()=>{
    const r=await run();
    assert.equal(r.result.handoff.status,'received-unverified');
    assert.strictEqual(r.seen,r.result.handoff);
    // Two-message fixture reaches the request budget gate before scoring.
    assert.equal(r.report.reason,'message-budget');
    assert.equal(r.report.version,'request-contract-shadow-v1');
    assert.equal(r.report.foldEligible,false);
    assert.equal(r.cacheReads,0);
    assert.equal(r.result.messages[1].content,'goal');
    assert(!JSON.stringify(r.result.messages).includes('vector'));
  });
  test(file+' disabled refresh or observation does not create receiver',async()=>{
    for(const opts of [{refresh:false},{enabled:false}]) {
      const r=await run(opts);
      assert.equal(r.loads,0);assert.equal(r.result.handoff,null);
      assert.equal(r.result.messages[1].content,'goal');
    }
  });
  test(file+' receiver load failure preserves refresh and original messages',async()=>{
    const r=await run({failLoad:true});
    assert.equal(r.refreshes,1);assert.equal(r.result.handoff,null);
    assert.equal(r.result.messages[1].content,'goal');
  });
  test(file+' missing or mismatched packet cannot yield usable vectors',async()=>{
    for(const opts of [{deliver:false},{wrong:true}]) {
      const r=await run(opts);
      assert.equal(r.result.handoff.packet,null);assert.equal(r.cacheReads,0);
      assert.equal(r.report.reason,'message-budget');
      assert.equal(r.report.version,'request-contract-shadow-v1');
      assert.equal(r.report.foldEligible,false);
    }
  });
  test(file+' failed refresh closes receiver without changing existing failure contract',async()=>{
    const r=await run({failRefresh:true});
    assert.equal(r.result.error,'refresh failed');
    assert.doesNotThrow(()=>r.late(packet('goal','tool')));
    assert.equal(r.seen,undefined);
  });
  test(file+' late callback and next round cannot reuse old packet',async()=>{
    const first=await run({deliver:false});
    first.late(packet('goal','tool'));
    assert.equal(first.result.handoff.packet,null);
    const next=await run({tool:'next result',deliver:false});
    assert.equal(next.result.handoff.status,'not-received');
  });
  test(file+' interleaved request contexts remain isolated',async()=>{
    let release; const wait=new Promise(r=>{release=r;});
    const a=run({goal:'alpha',tool:'alpha result',wait});
    const b=await run({goal:'beta',tool:'beta result'});
    release();const ar=await a;
    assert.equal(ar.result.handoff.packet.bindings.userRawHash,hash('alpha'));
    assert.equal(b.result.handoff.packet.bindings.userRawHash,hash('beta'));
  });
}
test('consumer rejects handoff before any bridge/cache access and never reports packet data',async()=>{
  const messages=[{role:'user',content:'goal'}];let report;
  const out=await projectGravityStub(messages,{
    gravityHandoff:{status:'received-unverified',packet:packet('goal','tool')},
    get contextBridge(){throw Error('must not query');},
    onGravityReport:r=>{report=r;}
  });
  assert.strictEqual(out,messages);
  assert.equal(report.reason,'handoff-unverified');
  assert(!JSON.stringify(report).includes(hash('goal')));
});