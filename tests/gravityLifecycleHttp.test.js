'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const {createGravityReversibleSession:create} =
  require('../modules/vcpLoop/gravityReversibleSession');

// TEST-ONLY lifecycle owner + observation seam. Production Handler is compiled
// unchanged. This does not prove production has a finally/abort cleanup hook.
const CALL = 'LIFECYCLE_FAKE_CALL';
const ANSWER = 'LIFECYCLE_FINAL_ANSWER';
const frame = content => 'data: '+JSON.stringify({
  choices:[{index:0,delta:{content},finish_reason:null}]
})+'\n\n';
function fixture(label) {
  return [
    {role:'system',content:'fixture policy'},
    {role:'user',content:'early topic'},
    {role:'assistant',content:('柔和的云朵飘过安静的树林，'+
      (label === 'alpha' ? '花瓣轻轻落下。' : '微风缓缓吹过。')).repeat(60)},
    {role:'assistant',content:'older answer'},
    {role:'user',content:'previous topic'},
    {role:'assistant',content:'recent answer'},
    {role:'user',content:'current task'},
    {role:'assistant',content:'current context'}
  ];
}
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
    const req=http.request(url,{method:options.method||'GET',
      headers:options.headers,signal:options.signal,agent:false},res=>resolve({
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
function loadHandler(streaming,observe) {
  const filename=path.resolve(__dirname,'../modules/handlers/',
    streaming?'streamHandler.js':'nonStreamHandler.js');
  const m=new Module(filename,module);
  m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
  const nativeRequire=Module.createRequire(filename);
  m.require=id=>id==='../vcpLoop/safeGravityProjection.js'
    ? {safeGravityProjection:async messages=>{
      await observe(messages);
      return messages; // Never forward experimental projections.
    }} : nativeRequire(id);
  m._compile(fs.readFileSync(filename,'utf8'),filename);
  return m.exports;
}
async function scenario(streaming,mode='normal',label='alpha',onRound) {
  const original=fixture(label),snapshot=JSON.stringify(original);
  const s=create(original);
  assert.equal(s.status,'ready');
  const controller=new AbortController();
  const observed={tools:0,rounds:0,fetches:0,bodies:[],errors:[],pins:[],closed:false};
  let handle,closeCalls=0,gateway;
  const closeSession=()=>{
    if(observed.closed) return;
    observed.closed=true;closeCalls++;s.close();
  };
  // Owner lives outside Handler for this experiment. The abort hook releases
  // retained originals before an awaited tool is required to return.
  controller.signal.addEventListener('abort',closeSession,{once:true});
  const observe=async messages=>{
    try {
    observed.rounds++;
    if(observed.closed) {
      assert.equal(s.project([2]).reason,'closed');return;
    }
    // Compare existing non-system prefix before applying fixed-snapshot mechanics.
    // Tail is NOT reconstructed from that snapshot; the complete live messages
    // are forwarded unchanged by the seam above.
    for(let i=1;i<original.length;i++)
      assert.deepEqual(messages[i],original[i]);
    const p=s.project([2]);
    assert.equal(p.status,'projected');
    if(!handle) {
      assert.equal(p.stubs.length,1);handle=p.stubs[0].handle;
      const r=s.expand([handle]);
      assert.equal(r.restored[0].content,original[2].content);
    } else {
      assert.equal(p.stubs.length,0);
      assert.equal(p.messages[2].content,original[2].content);
      observed.pins.push(true);
    }
    await onRound?.({session:s,handle,round:observed.rounds});
    } catch (error) {
      // Handler intentionally catches optional projector failures. Preserve the
      // assertion outside that failure boundary so tests cannot silently pass.
      observed.errors.push('observation: '+error.message);
      throw error;
    }
  };
  const upstream=http.createServer(async(req,res)=>{
    try {
      let body='';for await(const c of req) body+=c;
      const parsed=JSON.parse(body);observed.bodies.push(parsed.messages);
      assert.equal(parsed.messages[2].content,original[2].content);
      assert(!JSON.stringify(parsed.messages).includes('gs1_'));
      assert(!JSON.stringify(parsed.messages).includes('VCP_GRAVITY_STUB'));
      if(observed.bodies.length>1)
        assert(parsed.messages.some(m=>String(m.content).includes('LIFECYCLE_RECEIPT')));
      const content=observed.bodies.length<=2?CALL:ANSWER;
      if(streaming) {
        res.writeHead(200,{'Content-Type':'text/event-stream'});
        res.end(frame(content)+'data: [DONE]\n\n');
      } else {
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({choices:[{
          index:0,message:{role:'assistant',content},finish_reason:'stop'
        }]}));
      }
    } catch(e){observed.errors.push(e.message);res.destroy();}
  });
  try {
    const url=await listen(upstream);
    const Handler=loadHandler(streaming,observe);
    gateway=http.createServer(async(req,res)=>{
      try {
        res.writeHead(200,{'Content-Type':streaming?'text/event-stream':'application/json'});
        res.send=data=>res.end(data);
        const context={
          apiUrl:url,apiKey:'fixture-only',abortController:controller,
          originalBody:{model:'fixture',messages:original,stream:streaming},
          pluginManager:{messagePreprocessors:new Map()},
          maxVCPLoopStream:mode==='limit'?1:3,maxVCPLoopNonStream:mode==='limit'?1:3,
          apiRetries:0,apiRetryDelay:0,SHOW_VCP_OUTPUT:false,DEBUG_MODE:false,
          RAGMemoRefresh:false,isToolResultError:()=>false,
          ToolCallParser:{
            parse:text=>text.includes(CALL)?[{name:'FixtureTool',arguments:{}}]:[],
            separate:calls=>({normal:calls,archery:[]})
          },
          toolExecutor:{executeAll:async calls=>{
            observed.tools+=calls.length;
            if(mode==='abort' && observed.tools===2) {
              controller.abort();
              assert.equal(s.expand([handle]).reason,'closed');
            }
            if(mode==='throw' && observed.tools===2) throw Error('fixture tool exception');
            return calls.map(()=>({success:true,
              content:[{type:'text',text:'LIFECYCLE_RECEIPT'}]}));
          }},
          fetchWithRetry:async(u,o)=>{observed.fetches++;return request(u,o);}
        };
        const first=await request(url+'/v1/chat/completions',{
          method:'POST',body:JSON.stringify(context.originalBody)
        });
        await new Handler(context).handle(req,res,first);
      } catch(e){observed.errors.push(e.message);}
      finally {
        closeSession();
        controller.signal.removeEventListener('abort',closeSession);
        if(!res.writableEnded) res.end();
      }
    });
    const client=await request(await listen(gateway));
    let received='';for await(const c of client.body) received+=c;
    assert.equal(JSON.stringify(original),snapshot);
    assert.equal(observed.closed,true);
    assert.equal(s.project([2]).reason,'closed');
    assert.equal(s.expand([handle]).reason,'closed');
    assert.equal(closeCalls,1);
    return {...observed,received};
  } finally {
    closeSession();
    controller.signal.removeEventListener('abort',closeSession);
    await stop(gateway);await stop(upstream);
  }
}
for(const streaming of [true,false]) {
  const name=streaming?'stream':'nonstream';
  test(name+' full Handler: two rounds preserve pin and send live originals',
    {timeout:8000},async()=>{
      const r=await scenario(streaming);
      assert.deepEqual(r.errors,[]);
      assert.equal(r.tools,2);assert.equal(r.rounds,2);
      assert.equal(r.fetches,2);assert.equal(r.bodies.length,3);
      assert.deepEqual(r.pins,[true]);
      assert(r.bodies[2].length>r.bodies[1].length);
      assert(r.received.includes(ANSWER));
    });
  test(name+' abort closes owner during tool, no next fetch',{timeout:8000},async()=>{
    const r=await scenario(streaming,'abort');
    assert.deepEqual(r.errors,[]);assert.equal(r.tools,2);
    assert.equal(r.fetches,1);assert.equal(r.bodies.length,2);
    assert(!r.received.includes(ANSWER));
  });
  test(name+' thrown tool failure still releases owner',{timeout:8000},async()=>{
    const r=await scenario(streaming,'throw');
    assert.equal(r.tools,2);
    assert(r.errors.some(e=>e.includes('fixture tool exception')));
    assert.equal(r.fetches,1);
  });
  test(name+' recursion limit releases owner',{timeout:8000},async()=>{
    const r=await scenario(streaming,'limit');
    assert.deepEqual(r.errors,[]);assert.equal(r.tools,1);
    assert.equal(r.fetches,1);
  });
}
test('concurrent independent Handler requests cannot expand foreign handles',
  {timeout:8000},async()=>{
    const active=new Map();
    let foreignChecks=0,release;
    const barrier=new Promise(resolve=>{release=resolve;});
    const timer=setTimeout(()=>release(),2000);
    const hook=label=>async({session,handle,round})=>{
      active.set(label,{session,handle});
      if(round!==1) return;
      if(active.size===2) release();
      await barrier;
      assert.equal(active.size,2,'both requests must reach the barrier');
      for(const [other,v] of active) {
        if(other===label) continue;
        assert.equal(v.session.project([]).status,'projected','peer store must be live');
        assert.equal(session.expand([v.handle]).reason,'unknown-handle');
        assert.equal(v.session.expand([handle]).reason,'unknown-handle');
        foreignChecks++;
      }
    };
    try {
      const results=await Promise.all([
        scenario(true,'normal','alpha',hook('alpha')),
        scenario(false,'normal','beta',hook('beta'))
      ]);
      assert.equal(foreignChecks,2,'both live requests must reject the peer handle');
      for(const r of results) assert.deepEqual(r.errors,[]);
    } finally { clearTimeout(timer); }
  });