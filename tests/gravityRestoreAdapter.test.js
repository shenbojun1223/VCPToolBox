'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createGravityOriginalStore} = require('../modules/vcpLoop/gravityOriginalStore');
const {createGravityRestoreAdapter} = require('../modules/vcpLoop/gravityRestoreAdapter');

test('restore adapter requires explicit boolean opt-in', () => {
  for (const enabled of [undefined, false, 'true', 1]) {
    let calls = 0;
    const adapter = createGravityRestoreAdapter({
      enabled,store:{restore(){ calls++; throw Error('not allowed'); },close(){}}
    });
    assert.deepEqual(adapter.restore({handle:'gs1_'+'a'.repeat(48)}),
      {status:'unavailable',reason:'disabled'});
    assert.equal(calls,0);
    adapter.close();
  }
});

test('restore adapter refuses missing store', () => {
  const adapter = createGravityRestoreAdapter({enabled:true});
  assert.equal(adapter.restore({handle:'gs1_'+'a'.repeat(48)}).reason,'no-store');
  adapter.close();
  assert.equal(adapter.restore({}).reason,'closed');
});

test('restore adapter only accepts own plain handle data', () => {
  const store = createGravityOriginalStore();
  const saved = store.register(0,'EXACT ORIGINAL');
  const adapter = createGravityRestoreAdapter({enabled:true,store});
  let getterCalls = 0;
  const accessor = Object.defineProperty({},'handle',{
    get(){ getterCalls++; return saved.handle; }
  });
  const invalid = [
    null,undefined,saved.handle,[],{}, {handle:42},
    {handle:saved.handle,path:'C:/private.txt'},
    {handle:saved.handle,command:'do not run'},
    {handle:saved.handle,store},
    Object.create({handle:saved.handle}),accessor,
    {[Symbol('extra')]:true,handle:saved.handle}
  ];
  try {
    for (const args of invalid)
      assert.equal(adapter.restore(args).reason,'invalid-arguments');
    assert.equal(getterCalls,0);
    for (const handle of ['C:/private.txt','',saved.handle+' '])
      assert.equal(adapter.restore({handle}).reason,'unknown-handle');
    const args = Object.assign(Object.create(null),{handle:saved.handle});
    assert.deepEqual(adapter.restore(args),
      {status:'restored',index:0,text:'EXACT ORIGINAL'});
  } finally { adapter.close(); }
});

test('restore adapter stays bound to its owner and releases it', () => {
  const store = createGravityOriginalStore(),peer = createGravityOriginalStore();
  const own = store.register(0,'OWN'),foreign = peer.register(0,'FOREIGN');
  const adapter = createGravityRestoreAdapter({enabled:true,store});
  try {
    assert.equal(adapter.restore({handle:foreign.handle}).reason,'unknown-handle');
    assert.equal(adapter.restore({handle:'gs1_'+'0'.repeat(48)}).reason,'unknown-handle');
    assert.equal(adapter.restore({handle:own.handle}).text,'OWN');
    adapter.close();adapter.close();
    assert.deepEqual(store.stats(),{closed:true,entries:0,chars:0});
    assert.equal(adapter.restore({handle:own.handle}).reason,'closed');
    assert.equal(peer.restore(foreign.handle).text,'FOREIGN');
  } finally { adapter.close();peer.close(); }
});

test('restore adapter respects externally closed store', () => {
  const store = createGravityOriginalStore(),saved = store.register(0,'ORIGINAL');
  const adapter = createGravityRestoreAdapter({enabled:true,store});
  store.close();
  assert.equal(adapter.restore({handle:saved.handle}).reason,'closed');
  adapter.close();
});

test('restore adapter contains lookup and cleanup exceptions', () => {
  let closes = 0;
  const adapter = createGravityRestoreAdapter({enabled:true,store:{
    restore(){ throw Error('private detail'); },
    close(){ closes++; throw Error('cleanup detail'); }
  }});
  assert.deepEqual(adapter.restore({handle:'gs1_'+'a'.repeat(48)}),
    {status:'unavailable',reason:'restore-error'});
  assert.doesNotThrow(()=>adapter.close());
  adapter.close();
  assert.equal(closes,1);
  assert.equal(adapter.restore({}).reason,'closed');
});