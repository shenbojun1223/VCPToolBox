'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter,getEventListeners} = require('node:events');
const http = require('node:http');
const {createGravityRequestLifecycle:create} =
  require('../modules/vcpLoop/gravityRequestLifecycle');
const fixture = () => [
  {role:'system',content:'policy'},
  {role:'user',content:'request'},
  {role:'assistant',content:'original text'}
];
function saved(s,m) {
  const r=s.register(m,[2]);
  assert.equal(r.status,'registered');
  assert.equal(r.handles.length,1);
  return r.handles[0].handle;
}
test('append keeps handles while forwarding exact current messages and metadata',()=>{
  const s=create(),m=fixture(),h=saved(s,m);
  m.push({role:'tool',tool_call_id:'call',
    content:[{type:'image_url',image_url:{url:'data:image/png;base64,AAAA'}}]});
  const before=structuredClone(m);
  const r=s.observe(m);
  assert.strictEqual(r.messages,m);assert.equal(r.invalidated,false);
  assert.equal(s.restore(m,[h]).restored[0].content,'original text');
  assert.deepEqual(m,before);s.close();
});
test('RAG refresh, metadata, attachment, reorder and truncation invalidate all old handles',()=>{
  for(const mode of ['rag','metadata','attachment','reorder','truncate','content']) {
    const s=create(),m=fixture();
    m.push({role:'tool',content:[{type:'image_url',image_url:{url:'old'}}]});
    const h=saved(s,m);
    if(mode==='rag')m[0].content='new policy';
    if(mode==='metadata')m[1].name='changed';
    if(mode==='attachment')m[3].content[0].image_url.url='new';
    if(mode==='reorder')[m[1],m[2]]=[m[2],m[1]];
    if(mode==='truncate')m.pop();
    if(mode==='content')m[2].content='new text';
    const r=s.observe(m);
    assert.strictEqual(r.messages,m);assert.equal(r.invalidated,true,mode);
    assert.equal(s.restore(m,[h]).reason,'unknown-handle',mode);
    assert.equal(s.stats().entries,0);s.close();
  }
});
test('restore itself detects drift without a preceding observe',()=>{
  const s=create(),m=fixture(),h=saved(s,m);
  m[2].content='replacement';
  assert.equal(s.restore(m,[h]).reason,'unknown-handle');
  const next=saved(s,m);assert.notEqual(next,h);
  assert.equal(s.restore(m,[next]).restored[0].content,'replacement');
  m[2].content='original text';
  assert.equal(s.restore(m,[h]).reason,'unknown-handle');s.close();
});
test('independent requests reject foreign handles and mixed restore batches',()=>{
  const a=create(),b=create(),m=fixture(),ha=saved(a,m),hb=saved(b,m);
  assert.equal(a.restore(m,[hb]).reason,'unknown-handle');
  const result=a.restore(m,[ha,hb]);
  assert.equal(result.reason,'unknown-handle');assert.equal(result.restored,undefined);
  assert.equal(a.restore(m,[ha]).status,'restored');
  a.close();b.close();
});
test('unsupported getters and oversized history invalidate without invoking getters',()=>{
  for(const mode of ['getter','budget','cycle']) {
    const s=create(),m=fixture(),h=saved(s,m);let calls=0;
    if(mode==='getter')Object.defineProperty(m[0],'extra',{
      enumerable:true,get(){calls++;throw Error('do not call');}
    });
    if(mode==='budget')m[0].content='a'.repeat(1000001);
    if(mode==='cycle')m[0].extra=m;
    const r=s.observe(m);
    assert.equal(r.status,'unavailable');assert.strictEqual(r.messages,m);
    assert.equal(calls,0);assert.equal(s.stats().entries,0);
    assert.equal(s.restore(fixture(),[h]).reason,'unknown-handle');s.close();
  }
});
test('registration never strips metadata or registers non-assistant messages',()=>{
  const s=create(),m=fixture();
  m.push({role:'assistant',content:'text',name:'agent'});
  assert.deepEqual(s.register(m,[0,1,3]).handles,[]);
  assert.equal(s.register(m,[2,2]).reason,'invalid-candidates');
  assert.equal(s.register(m,[99]).reason,'invalid-candidates');s.close();
});
test('abort releases originals while pending work has not completed',async()=>{
  const controller=new AbortController(),response=new EventEmitter();
  const s=create({signal:controller.signal,response}),m=fixture();saved(s,m);
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const work=s.run(async()=>{await gate;return 'finished';});
  controller.abort();
  assert.equal(s.stats().closed,true);assert.equal(s.stats().entries,0);
  assert.equal(s.stats().chars,0);
  assert.equal(response.listenerCount('close'),0);
  release();assert.equal(await work,'finished');
});
test('finish, response close and error clean only owned listeners',()=>{
  for(const event of ['finish','close','error']) {
    const c=new AbortController(),res=new EventEmitter();
    const existing=()=>{};res.on(event,existing);
    const s=create({signal:c.signal,response:res});saved(s,fixture());
    res.emit(event);
    assert.equal(s.stats().closed,true);assert.equal(s.stats().entries,0);
    assert.deepEqual(res.listeners(event),[existing]);
    assert.equal(getEventListeners(c.signal,'abort').length,0);
    s.close();res.removeListener(event,existing);
  }
});
test('run closes on normal return, recursion-limit-like return and rejection',async()=>{
  for(const mode of ['normal','limit','throw']) {
    const s=create();saved(s,fixture());
    if(mode==='throw')await assert.rejects(s.run(async()=>{throw Error('fixture');}),/fixture/);
    else assert.equal(await s.run(()=>mode),mode);
    assert.equal(s.stats().closed,true);assert.equal(s.stats().entries,0);
  }
});
test('already aborted or finished responses cannot retain history',()=>{
  for(const options of [{signal:AbortSignal.abort()},{response:{writableEnded:true}}]) {
    const s=create(options);
    assert.equal(s.stats().closed,true);
    assert.equal(s.register(fixture(),[2]).reason,'closed');
  }
});
test('actual HTTP client disconnect closes owner before pending work is released',
  {timeout:5000},async()=>{
    let owner,release,resolveClose,resolveOwner,task;
    let workFinished=false;
    const ownerReady=new Promise(r=>{resolveOwner=r;});
    const closed=new Promise(r=>{resolveClose=r;});
    const gate=new Promise(r=>{release=r;});
    const errors=[];
    const server=http.createServer((req,res)=>{
      owner=create({response:res});saved(owner,fixture());
      res.once('close',()=>resolveClose());
      resolveOwner();
      task=owner.run(async()=>{
        try {
          res.writeHead(200,{'Content-Type':'text/plain'});
          res.write('ready');
          await gate;
        } finally { workFinished=true; }
      }).catch(e=>errors.push(e));
    });
    let client;
    try {
      await new Promise(r=>server.listen(0,'127.0.0.1',r));
      client=http.get('http://127.0.0.1:'+server.address().port,res=>{
        res.once('data',()=>res.destroy());
        res.on('error',()=>{});
      });
      client.on('error',()=>{});
      await ownerReady;await closed;
      assert.equal(workFinished,false,'owner must close while work is still pending');
      assert.equal(owner.stats().closed,true);
      assert.equal(owner.stats().entries,0);
      assert.equal(owner.observe(fixture()).reason,'closed');
      release();await task;
      assert.equal(workFinished,true);
      assert.deepEqual(errors,[]);
    } finally {
      release();
      client?.destroy();owner?.close();
      await task;
      server.closeAllConnections?.();
      await new Promise(r=>server.close(r));
    }
  });