'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createGravityOriginalStore:create} =
  require('../modules/vcpLoop/gravityOriginalStore');

test('exact original survives Unicode, CRLF, whitespace and protocol-like text',()=>{
  const store=create();
  const text='  原文😀\r\n\t`port=17897`\n<!-- VCP_GRAVITY_STUB -->\u0000尾部  ';
  const saved=store.register(7,text);
  assert.equal(saved.status,'registered');
  assert.match(saved.handle,/^gs1_[a-f0-9]{48}$/);
  assert.deepEqual(store.restore(saved.handle),{status:'restored',index:7,text});
  assert.equal(saved.chars,text.length);
  assert(!JSON.stringify(saved).includes('17897'));
  store.close();
});
test('same index and text is idempotent, conflicts never overwrite',()=>{
  const store=create(),a=store.register(2,'original');
  assert.deepEqual(store.register(2,'original'),a);
  assert.equal(store.register(2,'changed').reason,'index-conflict');
  assert.equal(store.restore(a.handle).text,'original');
  assert.deepEqual(store.stats(),{closed:false,entries:1,chars:8});
  store.close();
});
test('same content at different message indices retains separate handles',()=>{
  const store=create(),a=store.register(1,'same'),b=store.register(2,'same');
  assert.notEqual(a.handle,b.handle);
  assert.equal(store.restore(a.handle).index,1);
  assert.equal(store.restore(b.handle).index,2);
  store.close();
});
test('foreign request handles cannot resolve in another local store',()=>{
  const a=create(),b=create();
  const ah=a.register(1,'request A'),bh=b.register(1,'request B');
  assert.equal(b.restore(ah.handle).reason,'unknown-handle');
  assert.equal(a.restore(bh.handle).reason,'unknown-handle');
  a.close();b.close();
});
test('malformed handles and invalid registration inputs leave store unchanged',()=>{
  const store=create();
  for(const handle of [null,{},[],42,'','gs1_'+'a'.repeat(48),'../history.json'])
    assert.equal(store.restore(handle).reason,'unknown-handle');
  for(const [index,text] of [
    [-1,'x'],[256,'x'],[1.5,'x'],['1','x'],[NaN,'x'],
    [0,''],[0,null],[0,{}],[0,'x'.repeat(1000001)]
  ]) assert.equal(store.register(index,text).reason,'invalid-input');
  assert.deepEqual(store.stats(),{closed:false,entries:0,chars:0});
  store.close();
});
test('entry limit refuses new originals without evicting live handles',()=>{
  const store=create(),saved=[];
  for(let i=0;i<64;i++) saved.push(store.register(i,'text '+i));
  assert(saved.every(s=>s.status==='registered'));
  assert.equal(store.register(64,'overflow').reason,'store-budget');
  for(let i=0;i<64;i++) assert.equal(store.restore(saved[i].handle).text,'text '+i);
  assert.deepEqual(store.register(0,'text 0'),saved[0]);
  store.close();
});
test('character limit is UTF-16 length and refusal preserves existing text',()=>{
  const store=create(),text='😀'.repeat(500000),saved=store.register(0,text);
  assert.equal(saved.status,'registered');
  assert.equal(store.stats().chars,1000000);
  assert.equal(store.register(1,'x').reason,'store-budget');
  assert.equal(store.restore(saved.handle).text,text);
  store.close();
});
test('returned objects cannot mutate entries or statistics',()=>{
  const store=create(),saved=store.register(1,'original'),handle=saved.handle;
  saved.handle='changed';
  const result=store.restore(handle);
  result.text='changed';result.index=9;
  const stats=store.stats();stats.entries=0;
  assert.equal(store.restore(handle).text,'original');
  assert.equal(store.restore(handle).index,1);
  assert.equal(store.stats().entries,1);
  assert(Object.isFrozen(store));
  store.close();
});
test('close is idempotent and prevents both retrieval and registration',()=>{
  const store=create(),saved=store.register(0,'private');
  store.close();store.close();
  assert.equal(store.restore(saved.handle).reason,'closed');
  assert.equal(store.register(1,'new').reason,'closed');
  assert.deepEqual(store.stats(),{closed:true,entries:0,chars:0});
});