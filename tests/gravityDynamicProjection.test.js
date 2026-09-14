'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {createGravityReversibleSession:create} =
  require('../modules/vcpLoop/gravityReversibleSession');
function fixture() {
  return [
    {role:'system',content:'系统规则'},
    {role:'user',content:'早期讨论'},
    {role:'assistant',content:'柔和的光照穿过树叶，远处传来风声。\r\n'.repeat(80)},
    {role:'assistant',content:'安静的庭院里落满花瓣，天空渐渐明亮。\n'.repeat(80)},
    {role:'user',content:'上一轮问题'},
    {role:'assistant',content:'近期回答'.repeat(120)},
    {role:'user',content:'当前任务'},
    {role:'assistant',content:'执行调用'},
    {role:'user',content:'<!-- VCP_TOOL_PAYLOAD --> 执行完毕'}
  ];
}
function append(messages) {
  return [...messages,
    {role:'assistant',content:'检查反馈'.repeat(160)},
    {role:'user',content:'<!-- VCP_TOOL_PAYLOAD --> 最新回执'}];
}
test('append preserves handles and every current receipt; selection changes restore originals',()=>{
  const original=fixture(),snapshot=JSON.stringify(original),s=create(original);
  try {
    const a=s.project([2,3],original),current=append(original);
    const b=s.project([2],current);
    assert.equal(b.stubs[0].handle,a.stubs[0].handle);
    assert.deepEqual(b.messages.slice(original.length),current.slice(original.length));
    assert.deepEqual(b.messages[3],original[3]);
    assert.deepEqual(s.project([],current).messages,current);
    assert.equal(s.project([3],current).messages[2].content,original[2].content);
    assert.equal(JSON.stringify(original),snapshot);
  } finally {s.close();}
});
test('explicit expansion pins across append; RAG drift invalidates handle and pin',()=>{
  const original=fixture(),s=create(original);
  try {
    const handle=s.project([2],original).stubs[0].handle;
    assert.equal(s.expand([handle],append(original)).status,'expanded');
    const current=append(append(original));
    assert.equal(s.project([2],current).stubs.length,0);
    current[0]={role:'system',content:'系统规则：刷新后的记忆'};
    assert.equal(s.expand([handle],current).reason,'unknown-handle');
    const p=s.project([2],current);
    assert.equal(p.stubs.length,1);
    assert.notEqual(p.stubs[0].handle,handle);
    assert.deepEqual(p.messages[0],current[0]);
  } finally {s.close();}
});
test('changed body, reordering and truncation reject old handles before restoration',()=>{
  for(const change of [
    m=>{m[2]={...m[2],content:'新的庭院景象。'.repeat(100)};},
    m=>{[m[2],m[3]]=[m[3],m[2]];},
    m=>{m.pop();}
  ]) {
    const current=fixture(),s=create(current);
    try {
      const handle=s.project([2],current).stubs[0].handle;
      change(current);
      assert.equal(s.expand([handle],current).reason,'unknown-handle');
      assert.deepEqual(s.project([],current).messages,current);
    } finally {s.close();}
  }
});
test('projected input is refused and invalidates handles, never becomes original',()=>{
  const original=fixture(),s=create(original);
  try {
    const p=s.project([2],original),handle=p.stubs[0].handle;
    assert.equal(s.project([2],p.messages).reason,'projected-history');
    assert.equal(s.expand([handle],original).reason,'unknown-handle');
    assert.deepEqual(s.project([],original).messages,original);
  } finally {s.close();}
});
test('unsupported live history is returned intact and invalidates old handles',()=>{
  const original=fixture(),s=create(original);
  try {
    const handle=s.project([2],original).stubs[0].handle;
    const current=structuredClone(original);
    current[2].tool_calls=[];
    const result=s.project([2],current);
    assert.equal(result.reason,'unsupported-message');
    assert.equal(result.messages,current);
    assert.equal(s.expand([handle],original).reason,'unknown-handle');
  } finally {s.close();}
});
test('all loop-origin messages stay protected even when no longer recent',()=>{
  const original=fixture(),s=create(original);
  try {
    let current=original;
    for(let i=0;i<6;i++) current=append(current);
    const p=s.project(current.map((_,i)=>i),current);
    assert.deepEqual(p.stubs.map(x=>x.index),[2,3]);
    assert.deepEqual(p.messages.slice(4),current.slice(4));
  } finally {s.close();}
});
test('abort and response termination prevent subsequent restore or projection',()=>{
  for(const kind of ['abort','finish','close','error']) {
    const controller=new AbortController(),response=new EventEmitter();
    const current=fixture(),s=create(current,{signal:controller.signal,response});
    const handle=s.project([2],current).stubs[0].handle;
    if(kind==='abort') controller.abort(); else response.emit(kind);
    assert.equal(s.expand([handle],current).reason,'closed');
    assert.equal(s.project([2],current).reason,'closed');
    for(const event of ['finish','close','error'])
      assert.equal(response.listenerCount(event),0);
    s.close();
  }
});
test('five scripted rounds measure actual serialized fixture reduction including stub overhead',t=>{
  const original=fixture(),s=create(original);
  let current=original,baseline=0,projected=0,contentSaved=0;
  // Scripted relevance decisions, NOT a semantic selector or model quality test.
  const candidates=[[2,3],[2],[3],[2,3],[]];
  try {
    for(const indices of candidates) {
      const snapshot=JSON.stringify(current),p=s.project(indices,current);
      assert.equal(p.status,'projected');
      assert.equal(p.foldEligible,false);
      baseline+=snapshot.length;
      projected+=JSON.stringify(p.messages).length;
      contentSaved+=p.metrics.savedChars;
      assert.equal(p.metrics.originalChars-p.metrics.projectedChars,p.metrics.savedChars);
      for(let i=0;i<current.length;i++) {
        if(!p.stubs.some(x=>x.index===i)) assert.deepEqual(p.messages[i],current[i]);
      }
      assert.equal(JSON.stringify(current),snapshot);
      current=append(current);
    }
    assert(projected<baseline);
    assert(contentSaved>0);
    t.diagnostic(JSON.stringify({fixtureOnly:true,rounds:5,
      unit:'serialized-json-utf16-code-units',baseline,projected,
      saved:baseline-projected,ratio:(baseline-projected)/baseline,
      productionTokensMeasured:false,semanticQualityMeasured:false}));
  } finally {s.close();}
});