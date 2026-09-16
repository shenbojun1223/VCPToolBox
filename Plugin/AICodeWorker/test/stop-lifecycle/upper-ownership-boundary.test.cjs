'use strict';
const test=require('node:test'),a=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {createHarness}=require('./harness.cjs');
const source=fs.readFileSync(path.join(__dirname,'../../appserver/sidecarServer.js'),'utf8');
const {fixture}=createHarness(source);
test('empty never-started instance can shut down without a Codex object',async()=>{
 const {s,log}=fixture();s.codex=null;await s.shutdown();
 a.equal(s.state.status,'closed');a.ok(log.includes('unlink'));
});
for(const field of ['codexPid','codexProcessIdentity'])test('orphaned state evidence blocks cleanup: '+field,async()=>{
 const {s,log}=fixture();s.codex=null;s.state[field]=field==='codexPid'?98765:{pid:98765,startTime:'synthetic'};
 await a.rejects(s.shutdown(),{code:'CODEX_STOP_UNCONFIRMED'});
 a.equal(s.state.status,'degraded');a.ok(!log.includes('unlink'));
});
test('active job alone is ownership evidence even without state PID',async()=>{
 const {s,add,log}=fixture();const job=add();s.codex=null;
 await a.rejects(s.shutdown(),{code:'CODEX_STOP_UNCONFIRMED'});
 a.equal(s.activeJobs.get(job.jobId),job);a.equal(job.terminal,false);a.ok(!log.includes('unlink'));
});
test('missing-handle failure can retry only after the owned stop interface is available',async()=>{
 const {s,add,log}=fixture();add();const owned=s.codex;s.codex=null;
 await a.rejects(s.shutdown(),{code:'CODEX_STOP_UNCONFIRMED'});
 s.codex=owned;await s.shutdown();a.equal(s.activeJobs.size,0);
 a.equal(log.filter(x=>x==='stop').length,1);
});
