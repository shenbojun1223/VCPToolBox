'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {runTests}=require('./worker-prefix.cjs');
test('recovered Worker scenarios 01 through 12',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../../appserver/sidecarServer.js'),'utf8');
 const count=await runTests(source);
 assert.equal(count,12);
});
