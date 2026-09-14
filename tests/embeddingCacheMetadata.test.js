'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const CacheManager = require('../Plugin/RAGDiaryPlugin/CacheManager');
function make(maxSize=2) {
  const cache=new CacheManager();
  cache.createCache('embedding',{maxSize,ttl:1000});
  return cache;
}
test('legacy get returns original value; metadata read counts only once',()=>{
  const c=make(),v=[1,0];
  c.set('embedding','a',v,{source:'generated',binding:{hash:'fixture'}});
  assert.strictEqual(c.get('embedding','a'),v);
  const before=c.getStats('embedding');
  const r=c.getWithMetadata('embedding','a');
  assert.strictEqual(r.value,v);
  assert.equal(r.metadata.source,'generated');
  assert.equal(c.getStats('embedding').hits,before.hits+1);
});
test('metadata detached on both write and read',()=>{
  const c=make(),m={binding:{hash:'original'}};
  c.set('embedding','a',[1,0],m);
  m.binding.hash='changed';
  const r=c.getWithMetadata('embedding','a');
  assert.equal(r.metadata.binding.hash,'original');
  r.metadata.binding.hash='changed again';
  assert.equal(c.getWithMetadata('embedding','a').metadata.binding.hash,'original');
});
test('overwrite without metadata does not retain old provenance',()=>{
  const c=make(),v=[0,1];
  c.set('embedding','a',[1,0],{source:'generated'});
  c.set('embedding','a',v);
  assert.strictEqual(c.getWithMetadata('embedding','a').value,v);
  assert.equal(c.getWithMetadata('embedding','a').metadata,null);
});
test('expiry removes value and metadata together',()=>{
  const c=make();
  c.set('embedding','a',[1,0],{source:'generated'});
  c.caches.get('embedding').data.get('a').timestamp=Date.now()-2000;
  assert.equal(c.getWithMetadata('embedding','a'),null);
  assert.equal(c.caches.get('embedding').data.has('a'),false);
  assert.equal(c.getStats('embedding').misses,1);
});
test('eviction and clear leave no independent provenance records',()=>{
  const c=make(1);
  c.set('embedding','a',[1,0],{source:'generated'});
  c.set('embedding','b',[0,1],{source:'fuzzy'});
  assert.equal(c.getWithMetadata('embedding','a'),null);
  assert.equal(c.getWithMetadata('embedding','b').metadata.source,'fuzzy');
  c.clear('embedding');
  assert.equal(c.getWithMetadata('embedding','b'),null);
});
test('legacy entries and uncloneable metadata remain unknown',()=>{
  const c=make();
  c.caches.get('embedding').data.set('old',{value:[1,0],timestamp:Date.now()});
  assert.equal(c.getWithMetadata('embedding','old').metadata,null);
  c.set('embedding','bad',[0,1],{callback(){}});
  assert.equal(c.getWithMetadata('embedding','bad').metadata,null);
  assert.deepEqual(c.get('embedding','bad'),[0,1]);
});
test('unknown cache and missing key return null',()=>{
  const c=make();
  assert.equal(c.getWithMetadata('absent','a'),null);
  assert.equal(c.getWithMetadata('embedding','a'),null);
});