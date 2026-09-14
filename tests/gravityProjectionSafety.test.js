
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { safeGravityProjection } = require('../modules/vcpLoop/safeGravityProjection');
const make = () => [
  {role:'system',content:'policy'},
  {role:'assistant',content:'old text',name:'agent'},
  {role:'user',content:'goal'},
  {role:'assistant',content:[{type:'text',text:'image caption'},{type:'image_url',image_url:{url:'test'}}]},
  {role:'assistant',content:'call',tool_calls:[{id:'call-1'}]},
  {role:'tool',content:'result',tool_call_id:'call-1'},
  {role:'user',content:'latest'},
  {role:'assistant',content:'recent'}
];
const run = (m, fn, extra={}) => safeGravityProjection(m,{
  // Explicit fixture mode: production SHADOW env must not change test semantics.
  enabled:true,shadow:false,loadProjector:()=>fn,...extra
});
test('disabled never loads module',async()=>{
  const m=make(); assert.strictEqual(await run(m,()=>{throw Error();},{
    enabled:false,loadProjector:()=>{throw Error('must not load');}
  }),m);
});
test('missing module falls back',async()=>{
  const m=make(); assert.strictEqual(await run(m,null,{
    loadProjector:()=>{throw Error('MODULE_NOT_FOUND');}
  }),m);
});
test('synchronous throw and rejected promise fall back',async()=>{
  for(const fn of [()=>{throw Error();},async()=>{throw Error();}]){
    const m=make(); assert.strictEqual(await run(m,fn),m);
  }
});
test('never-settling projector times out',async()=>{
  const m=make(); assert.strictEqual(await run(m,()=>new Promise(()=>{}),{timeoutMs:5}),m);
});
test('late mutation and rejection cannot touch source',async()=>{
  const m=make(), original=JSON.stringify(m);
  assert.strictEqual(await run(m,async copy=>{
    await new Promise(r=>setTimeout(r,20));
    copy[0].content='corrupted'; throw Error('late');
  },{timeoutMs:2}),m);
  await new Promise(r=>setTimeout(r,35));
  assert.equal(JSON.stringify(m),original);
});
test('invalid result and metadata changes rejected',async()=>{
  for(const fn of [()=>null,()=>[],copy=>{copy[1].name='other';return copy;}]){
    const m=make(); assert.strictEqual(await run(m,fn),m);
  }
});
test('system user multimodal native tool and recent messages protected',async()=>{
  for(const index of [0,2,3,4,5,6,7]){
    const m=make();
    assert.strictEqual(await run(m,copy=>{copy[index].content='lost';return copy;}),m);
  }
});
test('plain old assistant may change without mutating source',async()=>{
  const m=make(), original=JSON.stringify(m);
  const out=await run(m,copy=>{copy[1].content='stub';return copy;});
  assert.equal(out[1].content,'stub');assert.equal(JSON.stringify(m),original);
});
test('aborted request skips projector',async()=>{
  const m=make(), c=new AbortController();c.abort();
  assert.strictEqual(await run(m,()=>{throw Error();},{signal:c.signal}),m);
});
for(const [file,arrayName] of [
  ['streamHandler.js','currentMessagesForLoop'],
  ['nonStreamHandler.js','currentMessagesForNonStreamLoop']
]){
  test(file+' actual guard catches load failure and preserves continuation',async()=>{
    const src=fs.readFileSync(require.resolve('../modules/handlers/'+file),'utf8');
    const block=src.split('// GRAVITY_SAFETY_BEGIN')[1].split('// GRAVITY_SAFETY_END')[0];
    const m=make();
    for(const fail of [true,false]){
      const context={require:()=>{if(fail)throw Error('load failed');
        return {safeGravityProjection:async()=>{throw Error('runtime failed');}};},
        [arrayName]:m,pluginManager:{},payloadForLoop:'receipt',recursionDepth:0,
        DEBUG_MODE:false,abortController:new AbortController()};
      const result=await vm.runInNewContext('(async()=>{'+block+
        ';return {messagesForUpstream,continued:true};})()',context);
      assert.strictEqual(result.messagesForUpstream,m);assert.equal(result.continued,true);
    }
  });
}
test('VCP protocol and known injected markers cannot be rewritten', async () => {
  for (const marker of [
    'VCP_TOOL_PAYLOAD', 'TOOL_REQUEST', 'END_TOOL_REQUEST',
    'VCP调用', 'Flowlock::', '系统提示', '元思维', '元思考'
  ]) {
    const m = make();
    m[1].content = marker + ' protected text';
    assert.strictEqual(await run(m, copy => {
      copy[1].content = 'lost';
      return copy;
    }), m);
  }
});
test('developer message remains protected anywhere in history', async () => {
  const m = make();
  m[1] = {role:'developer', content:'required instructions'};
  assert.strictEqual(await run(m, copy => {
    copy[1].content = 'lost'; return copy;
  }), m);
});
test('oversized inputs bypass projector before loading', async () => {
  const cases = [
    Array.from({length:257}, () => ({role:'assistant',content:'a'})),
    [{role:'assistant',content:'x'.repeat(1000001)}],
    [{role:'assistant',content:'ok',metadata:Array.from({length:12001}, () => 0)}]
  ];
  for (const m of cases) {
    let loads = 0;
    const out = await run(m, null, {loadProjector:() => {
      loads++; return copy => copy;
    }});
    assert.strictEqual(out, m);
    assert.equal(loads, 0);
  }
});
test('cyclic and accessor input bypass without invoking getter', async () => {
  const cyclic = make();
  cyclic[1].metadata = cyclic;
  const accessor = make();
  let getterCalls = 0, loads = 0;
  Object.defineProperty(accessor[1], 'metadata', {
    enumerable:true, get() { getterCalls++; return 'unsafe'; }
  });
  for (const m of [cyclic, accessor]) {
    assert.strictEqual(await run(m, null, {loadProjector:() => {
      loads++; return copy => copy;
    }}), m);
  }
  assert.equal(loads, 0); assert.equal(getterCalls, 0);
});
test('oversized output falls back', async () => {
  const m = make();
  assert.strictEqual(await run(m, copy => {
    copy[1].content = 'x'.repeat(1000001); return copy;
  }), m);
});
test('successful output detached from projector retained references', async () => {
  const m = make(), original = JSON.stringify(m);
  let retained;
  const out = await run(m, copy => {
    retained = copy; copy[1].content = 'stub'; return copy;
  });
  assert.notStrictEqual(out, m);
  retained[1].content = 'late corruption';
  retained[3].content[1].image_url.url = 'changed';
  assert.equal(out[1].content, 'stub');
  assert.equal(out[3].content[1].image_url.url, 'test');
  assert.equal(JSON.stringify(m), original);
});
test('abort while projector is pending returns original', async () => {
  const m = make(), controller = new AbortController();
  assert.strictEqual(await run(m, async copy => {
    controller.abort(); return copy;
  }, {signal:controller.signal}), m);
});
test('repeated calls reproject from originals rather than prior stubs', async () => {
  const m = make();
  const first = await run(m, copy => {
    copy[1].content = 'stub'; return copy;
  });
  const second = await run(m, copy => copy);
  assert.equal(first[1].content, 'stub');
  assert.equal(second[1].content, 'old text');
  assert.equal(m[1].content, 'old text');
});