'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createGravityReversibleSession:create} =
  require('../modules/vcpLoop/gravityReversibleSession');
function fixture() {
  return [
    {role:'system',content:'系统规则'},
    {role:'user',content:'早期讨论'},
    {role:'assistant',content:'柔和的光照穿过树叶，远处传来风声。\r\n'.repeat(40)},
    {role:'assistant',content:'安静的庭院里落满花瓣，天空渐渐明亮。\n'.repeat(40)},
    {role:'user',content:'上一轮问题'},
    {role:'assistant',content:'近期回答'.repeat(120)},
    {role:'user',content:'当前任务'},
    {role:'assistant',content:'执行调用'},
    {role:'user',content:'<!-- VCP_TOOL_PAYLOAD --> 执行完毕'}
  ];
}
test('original to stub to exact expansion, without mutating source messages',()=>{
  const messages=fixture(),snapshot=JSON.stringify(messages),s=create(messages);
  assert.equal(s.status,'ready');
  try {
    const projected=s.project([2,3]);
    assert.equal(projected.stubs.length,2);
    assert.notEqual(projected.messages[2].content,messages[2].content);
    assert(projected.messages[2].content.includes('NOT a summary'));
    const result=s.expand(projected.stubs.map(x=>x.handle));
    assert.deepEqual(result.restored,[
      {index:2,content:messages[2].content},{index:3,content:messages[3].content}
    ]);
    assert.deepEqual(s.project([2,3]).messages,messages);
    assert.equal(JSON.stringify(messages),snapshot);
    assert.equal(projected.foldEligible,false);
  } finally { s.close(); }
});
test('each projection starts from snapshot and stable handles, not prior stubs',()=>{
  const messages=fixture(),s=create(messages);
  try {
    const a=s.project([2]),b=s.project([2]);
    assert.deepEqual(a,b);
    assert.deepEqual(s.project([]).messages,messages);
    assert.equal(s.project([3]).messages[2].content,messages[2].content);
  } finally { s.close(); }
});
test('source and returned message mutations cannot corrupt restoration',()=>{
  const messages=fixture(),original=messages[2].content,s=create(messages);
  try {
    messages[2].content='changed outside';
    const p=s.project([2]),handle=p.stubs[0].handle;
    p.messages[2].content='changed output';p.stubs[0].handle='changed handle';
    const restored=s.expand([handle]);
    assert.equal(restored.restored[0].content,original);
    restored.restored[0].content='changed restoration';
    assert.equal(s.project([2]).messages[2].content,original);
  } finally { s.close(); }
});
test('system, users, recent turns, protocol and critical details stay original',()=>{
  for(const prefix of ['端口 17897','必须保留','VCP上下文语义折叠-本层摘要:',
    'Flowlock::Start','OneRing通知:','路径 C:\\work','never discard','']) {
    const messages=fixture();
    if(prefix) messages[2].content=prefix+messages[2].content;
    const s=create(messages);
    try {
      const p=s.project([0,1,2,4,5,6,7,8]);
      assert.deepEqual(p.stubs.map(x=>x.index),prefix?[]:[2]);
      for(const i of [0,1,4,5,6,7,8]) assert.deepEqual(p.messages[i],messages[i]);
    } finally { s.close(); }
  }
});
test('foreign and unknown handles reject whole batch without partial pinning',()=>{
  const a=create(fixture()),b=create(fixture());
  try {
    const ap=a.project([2,3]),bp=b.project([2]);
    assert.equal(a.expand([ap.stubs[0].handle,bp.stubs[0].handle]).reason,'unknown-handle');
    assert.equal(a.project([2,3]).stubs.length,2);
    assert.equal(a.expand([ap.stubs[0].handle]).status,'expanded');
    assert.deepEqual(a.project([2,3]).stubs.map(x=>x.index),[3]);
    assert.equal(b.project([2]).stubs.length,1);
  } finally { a.close();b.close(); }
});
test('invalid candidates and restoration batches do not change state',()=>{
  const s=create(fixture());
  try {
    for(const indices of [null,[2,2],[-1],[256],['2'],[2.5],Array(65).fill(2)])
      assert.equal(s.project(indices).reason,'invalid-candidates');
    for(const handles of [null,[],['x','x']])
      assert.equal(s.expand(handles).reason,'invalid-handles');
    assert.equal(s.project([2]).stubs.length,1);
  } finally { s.close(); }
});
test('unsupported metadata, multimodal and getters are rejected without stripping',()=>{
  for(const change of [
    m=>{m[2].tool_calls=[];},m=>{m[2].content=[{type:'text',text:'text'}];},
    m=>{Object.defineProperty(m[2],'content',{get(){throw Error('must not read');}});},
    m=>{m[2]=null;},m=>{m[2].role='function';}
  ]) {
    const messages=fixture();change(messages);
    assert.equal(create(messages).reason,'unsupported-message');
  }
});
test('message and character budgets and missing user anchor reject',()=>{
  for(const messages of [[],Array(257).fill({role:'user',content:'x'})])
    assert.equal(create(messages).reason,'message-budget');
  const large=fixture();large[2].content='字'.repeat(1000001);
  assert.equal(create(large).reason,'character-budget');
  const noUser=fixture().map(m=>({...m,role:'assistant'}));
  assert.equal(create(noUser).reason,'missing-user-anchor');
});
test('close invalidates saved handles and prevents further projections',()=>{
  const s=create(fixture()),p=s.project([2]);
  s.close();s.close();
  assert.equal(s.project([2]).reason,'closed');
  assert.equal(s.expand([p.stubs[0].handle]).reason,'closed');
});