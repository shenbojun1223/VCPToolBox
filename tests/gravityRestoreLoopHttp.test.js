'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const Parser = require('../modules/vcpLoop/toolCallParser');
const {createGravityOriginalStore} = require('../modules/vcpLoop/gravityOriginalStore');
const {createGravityRestoreAdapter} = require('../modules/vcpLoop/gravityRestoreAdapter');

// TEST ONLY: unchanged full Handlers, real text parser, local HTTP upstream.
// Projector and executor are injected. Production safety rules are NOT relaxed.
// Scripted upstream tests transport, not a model's autonomous recovery decision.
const PAYLOAD = '<!-- VCP_TOOL_PAYLOAD -->';
const ANSWER = 'RESTORE_LOOP_FINAL';
const callText = (name,args={}) => '<<<['+'TOOL_REQUEST'+']>>>\n' +
  Object.entries({tool_name:name,...args}).map(([k,v]) =>
    k+': \u300c始\u300d'+v+'\u300c末\u300d').join(',\n') +
  '\n<<<['+'END_TOOL_REQUEST'+']>>>';
const frame = content => 'data: '+JSON.stringify({
  choices:[{index:0,delta:{content},finish_reason:null}]
})+'\n\n';
async function listen(server) {
  await new Promise((resolve,reject)=>{
    server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
  });
  return 'http://127.0.0.1:'+server.address().port;
}
async function stop(server) {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise(resolve=>server.close(resolve));
}
function request(url,options={}) {
  return new Promise((resolve,reject)=>{
    const req=http.request(url,{method:options.method||'GET',agent:false,
      headers:options.headers,signal:options.signal},res=>resolve({
      ok:res.statusCode===200,status:res.statusCode,body:res,
      arrayBuffer:async()=>{
        const chunks=[];for await(const c of res) chunks.push(Buffer.from(c));
        const b=Buffer.concat(chunks);
        return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);
      }
    }));
    req.on('error',reject);
    req.setTimeout(3000,()=>req.destroy(Error('fixture timeout')));
    req.end(options.body);
  });
}
function loadHandler(streaming,project) {
  const filename=path.resolve(__dirname,'../modules/handlers/',
    streaming?'streamHandler.js':'nonStreamHandler.js');
  const m=new Module(filename,module),nativeRequire=Module.createRequire(filename);
  m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
  m.require=id=>id==='../vcpLoop/safeGravityProjection.js'
    ? {safeGravityProjection:project} : nativeRequire(id);
  m._compile(fs.readFileSync(filename,'utf8'),filename);
  return m.exports;
}
async function scenario(streaming,mode) {
  const controller=new AbortController(),store=createGravityOriginalStore();
  const adapter=createGravityRestoreAdapter({enabled:true,store});
  // A second live owner supplies a genuinely valid but foreign handle.
  const peer=createGravityOriginalStore();
  const peerSaved=peer.register(3,'PEER_PRIVATE_ORIGINAL');
  const evidence='BEGIN_RECEIPT\n'+'irrelevant padding\n'.repeat(160)+
    'AUDIT_NONCE=fixture-only-73419\n'+'trailing padding\n'.repeat(160);
  const receipt=PAYLOAD+'\n'+JSON.stringify([{type:'text',text:evidence}]);
  const original=[
    {role:'system',content:'Fixture policy'},
    {role:'user',content:'Old request',name:'fixture-user'},
    {role:'assistant',content:callText('HistoricalPowerShell',{command:'DO_NOT_EXECUTE'})},
    {role:'user',content:receipt},
    {role:'assistant',content:'Prior result received'},
    {role:'user',content:'Current audit request'},
    {role:'assistant',content:'Ready for new tool result'}
  ];
  const snapshot=JSON.stringify(original);
  const state={errors:[],bodies:[],tick:0,restore:0,fetches:0};
  let saved,gateway;
  const close=()=>adapter.close();
  controller.signal.addEventListener('abort',close,{once:true});
  const capture=fn=>{try{return fn();}catch(e){state.errors.push(e.message);throw e;}};
  const project=async messages=>capture(()=>{
    assert.equal(messages[3].content,receipt,'Handler must keep live originals');
    // Match safeGravityProjection's abort passthrough contract. The Handler may
    // enter this seam after a tool aborts, but must not make another HTTP fetch.
    if (controller.signal.aborted) {
      assert.equal(store.stats().closed,true);
      assert.equal(store.stats().entries,0);
      assert.equal(store.restore(saved.handle).reason,'closed');
      return messages;
    }
    const output=structuredClone(messages);
    saved=store.register(3,receipt);
    assert.equal(saved.status,'registered');
    output[3].content=PAYLOAD+'\n[VCP_GRAVITY_STUB handle='+saved.handle+
      '; batchCallIndex=2; original omitted; test-only restore available]';
    for(let i=0;i<messages.length;i++)
      if(i!==3) assert.deepEqual(output[i],messages[i]);
    return output;
  });
  const upstream=http.createServer(async(req,res)=>{
    try {
      let body='';for await(const c of req) body+=c;
      const messages=JSON.parse(body).messages;
      state.bodies.push(messages);
      const round=state.bodies.length;
      let content;
      if(round===1) {
        assert.deepEqual(messages,original);
        content=callText('FixtureTick');
      } else if(round===2) {
        assert(messages[3].content.includes(saved.handle));
        assert(!JSON.stringify(messages).includes('AUDIT_NONCE'));
        assert(messages.some(m=>String(m.content).includes('FRESH_RECEIPT')));
        const handle=mode==='foreign'?peerSaved.handle:
          mode==='unknown'?'gs1_'+'0'.repeat(48):saved.handle;
        content=callText('GravityRestoreFixture',{handle});
      } else {
        assert.equal(round,3);
        const last=messages.at(-1);
        assert.equal(last.role,'user');
        assert(last.content.startsWith(PAYLOAD));
        const parts=JSON.parse(last.content.slice(PAYLOAD.length).trim());
        const result=JSON.parse(parts[0].text);
        if(mode==='normal') {
          assert.equal(result.status,'restored');
          assert.equal(result.index,3);
          assert.equal(result.text,receipt);
        } else {
          assert.equal(result.status,'unavailable');
          assert.equal(result.reason,'unknown-handle');
          assert(!JSON.stringify(messages).includes('AUDIT_NONCE'));
        }
        assert(!JSON.stringify(messages).includes('PEER_PRIVATE_ORIGINAL'));
        assert.deepEqual(messages[2],original[2]);
        content=ANSWER;
      }
      if(streaming) {
        res.writeHead(200,{'Content-Type':'text/event-stream'});
        res.end(frame(content)+'data: [DONE]\n\n');
      } else {
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({choices:[{index:0,
          message:{role:'assistant',content},finish_reason:'stop'}]}));
      }
    } catch(e){state.errors.push(e.message);res.destroy();}
  });
  try {
    const url=await listen(upstream),Handler=loadHandler(streaming,project);
    gateway=http.createServer(async(req,res)=>{
      res.on('finish',close);res.on('close',close);res.on('error',close);
      try {
        res.writeHead(200,{'Content-Type':streaming?'text/event-stream':'application/json'});
        res.send=data=>res.end(data);
        const context={
          apiUrl:url,apiKey:'fixture-only',abortController:controller,
          originalBody:{model:'fixture',messages:original,stream:streaming},
          pluginManager:{messagePreprocessors:new Map()},
          maxVCPLoopStream:4,maxVCPLoopNonStream:4,
          apiRetries:0,apiRetryDelay:0,SHOW_VCP_OUTPUT:false,DEBUG_MODE:false,
          RAGMemoRefresh:false,isToolResultError:()=>false,
          ToolCallParser:Parser,
          toolExecutor:{executeAll:async(calls,ip,live)=>calls.map(call=>capture(()=>{
            // No production executor or plugin dispatch exists in this test.
            assert.equal(live[3].content,receipt);
            if(call.name==='FixtureTick') {
              state.tick++;
              return {success:true,content:[{type:'text',text:'FRESH_RECEIPT'}]};
            }
            assert.equal(call.name,'GravityRestoreFixture',
              'Historical or unexpected tools must never be replayed');
            state.restore++;
            if(mode==='abort') controller.abort();
            const result=adapter.restore(call.args);
            if(mode==='abort') assert.equal(result.reason,'closed');
            return {success:result.status==='restored',
              content:[{type:'text',text:JSON.stringify(result)}]};
          }))},
          fetchWithRetry:async(u,o)=>{state.fetches++;return request(u,o);}
        };
        const first=await request(url+'/v1/chat/completions',{
          method:'POST',body:JSON.stringify(context.originalBody)});
        await new Handler(context).handle(req,res,first);
      } catch(e){state.errors.push(e.message);}
      finally {close();if(!res.writableEnded)res.end();}
    });
    const client=await request(await listen(gateway));
    let received='';for await(const c of client.body) received+=c;
    assert.deepEqual(state.errors,[]);
    assert.equal(state.tick,1);
    assert.equal(state.restore,1);
    assert.equal(state.bodies.length,mode==='abort'?2:3);
    assert.equal(state.fetches,mode==='abort'?1:2);
    assert.equal(received.includes(ANSWER),mode!=='abort');
    assert.equal(JSON.stringify(original),snapshot);
    assert.equal(store.stats().closed,true);
    assert.equal(store.stats().entries,0);
    assert.equal(store.restore(saved.handle).reason,'closed');
    assert.equal(peer.restore(peerSaved.handle).text,'PEER_PRIVATE_ORIGINAL');
    if(streaming && mode!=='abort')
      assert.equal((received.match(/data: \[DONE\]/g)||[]).length,1);
  } finally {
    close();peer.close();
    controller.signal.removeEventListener('abort',close);
    await stop(gateway);await stop(upstream);
  }
}
for(const streaming of [true,false]) {
  for(const mode of ['normal','unknown','foreign','abort']) {
    test((streaming?'stream':'nonstream')+' same-request restore loop '+mode,
      {timeout:10000},()=>scenario(streaming,mode));
  }
}