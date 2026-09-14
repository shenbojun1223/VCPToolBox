'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {VexusIndex} = require('../rust-vexus-lite');
const {createGravityNativeGeometry:create} =
  require('../modules/vcpLoop/gravityNativeGeometry');

// Empty isolated index, no production data or database.
const native = new VexusIndex(3,16);
const adapter = create(native,3);
test('actual native geometry decomposes independent, redundant and opposite directions',()=>{
  const cases = [
    {target:[0,1,0],basis:[[1,0,0]],ratio:1},
    {target:[1,0,0],basis:[[1,0,0]],ratio:0},
    {target:[-1,0,0],basis:[[1,0,0]],ratio:0},
    {target:[1,1,1],basis:[[1,0,0],[2,0,0]],ratio:2/3},
    {target:[1,1,1],basis:[[1,0,0],[0,1,0],[0,0,1]],ratio:0}
  ];
  for(const c of cases) {
    const snapshot=JSON.stringify(c);
    const r=adapter.measureResidual(c.target,c.basis);
    assert.equal(r.status,'measured');
    assert(Math.abs(r.residualEnergyRatio-c.ratio)<1e-6);
    assert.equal(r.foldEligible,false);
    assert.equal(JSON.stringify(c),snapshot);
  }
});
test('malformed and oversized inputs rejected before native invocation',()=>{
  let calls=0;
  const spy=create({computeOrthogonalProjection(){calls++;throw Error();}},3);
  for(const target of [[1,0], [NaN,0,1], [0,0,0], ['1',0,0], [1e100,0,0]])
    assert.equal(spy.measureResidual(target,[[1,0,0]]).status,'unavailable');
  for(const basis of [[],new Array(9).fill([1,0,0]),[[0,0,0]],[[1,0]]])
    assert.equal(spy.measureResidual([1,0,0],basis).status,'unavailable');
  assert.equal(calls,0);
});
test('missing native method and native failure fail open',()=>{
  assert.equal(create({},3).measureResidual([1,0,0],[[1,0,0]]).reason,'native-unavailable');
  const bad=create({computeOrthogonalProjection(){throw Error('private');}},3);
  const r=bad.measureResidual([1,0,0],[[1,0,0]]);
  assert.equal(r.reason,'native-error');assert(!JSON.stringify(r).includes('private'));
});
test('corrupt decomposition is not accepted as semantic evidence',()=>{
  for(const output of [
    null,
    {projection:[NaN,0,0],residual:[0,0,0]},
    {projection:[0,0,0],residual:[0,0,0]},
    {projection:[0.5,0,0],residual:[0.5,0,0]}
  ]) {
    const a=create({computeOrthogonalProjection(){return output;}},3);
    assert.equal(a.measureResidual([1,0,0],[[1,0,0]]).status,'unavailable');
  }
});
test('native receives detached copies and reports contain no vectors',()=>{
  const target=new Float32Array([1,0,0]),basis=new Float64Array([1,0,0]);
  let retained;
  const a=create({computeOrthogonalProjection(q,b,n){
    retained={q,b};return native.computeOrthogonalProjection(q,b,n);
  }},3);
  const r=a.measureResidual(target,[basis]);
  retained.q[0]=9;retained.b[0]=9;
  assert.equal(target[0],1);assert.equal(basis[0],1);
  assert.equal(r.status,'measured');assert(!('projection' in r));assert(!('residual' in r));
});
test('abort skips native operation and invalid configured dimension rejected',()=>{
  let calls=0;
  const a=create({computeOrthogonalProjection(){calls++;}},3);
  assert.equal(a.measureResidual([1,0,0],[[1,0,0]],{
    signal:AbortSignal.abort()
  }).reason,'aborted');
  assert.equal(calls,0);
  for(const dim of [0,-1,4097,1.5,NaN]) assert.throws(()=>create(native,dim));
});
test('mismatched borrowed native index dimension fails open',()=>{
  const a=create(native,2);
  assert.equal(a.measureResidual([1,0],[[1,0]]).reason,'native-error');
});