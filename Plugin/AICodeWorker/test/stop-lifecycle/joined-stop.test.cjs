'use strict';
// Join the real candidate Sidecar, Codex process class and termination helper.
// OS/process operations remain the audited mocks; there is no live service.
const test=require('node:test'),a=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createHarness}=require('./harness.cjs');
const source=fs.readFileSync(path.join(__dirname,'../../appserver/sidecarServer.js'),'utf8');
const {fixture:upperFixture,defer,tick}=createHarness(source);
const lowerFixture=require('./protocol-fixture.cjs');

async function setup(){
 const upper=upperFixture(),lower=lowerFixture();
 await lower.p.start();
 upper.s.codex=lower.p;
 upper.s.state.codexPid=lower.p.codexPid;
 upper.s.state.codexProcessIdentity=lower.p.codexIdentity;
 lower.p.on('protocolError',e=>upper.s._handleProtocolError(e));
 lower.p.once('closed',info=>upper.s._handleCodexClosed(info));
 return {...upper,lower};
}

test('three layers: fatal transport closes once and releases jobs only after tree proof',async()=>{
 const {s,add,lower,meta}=await setup(),jobs=[add(),add()];
 const done=s._handleProtocolError({code:'INVALID_JSON'});
 a.equal(s.activeJobs.size,2);a.equal(lower.calls.length,0);
 for(const j of jobs)a.equal(meta.get(j.paths.metaPath).state,'running');
 await done;
 a.equal(lower.calls.filter(x=>x.type==='mock-taskkill').length,1);
 a.equal(lower.live.has(101),false);a.equal(lower.p.child,null);
 a.equal(s.activeJobs.size,0);a.equal(s.state.stopFault.causeCode,'INVALID_JSON');
});

test('three layers: tree kill rejection preserves owner then authenticated shutdown can retry',async()=>{
 const {s,add,lower,log}=await setup(),job=add();
 lower.cfg.taskkillFailure=true;
 await a.rejects(s._handleProtocolError({code:'WRITE_FAILED'}),e=>e.code==='CODEX_STOP_UNCONFIRMED');
 a.equal(s.activeJobs.get(job.jobId),job);a.ok(lower.p.child);a.equal(job.terminal,false);
 a.ok(!log.includes('unlink'));
 lower.cfg.taskkillFailure=false;
 await s.shutdown();
 a.equal(s.activeJobs.size,0);a.equal(s.state.status,'closed');
 a.equal(lower.calls.filter(x=>x.type==='mock-taskkill').length,2);
});

test('three layers: reused PID cannot be terminated or released',async()=>{
 const {s,add,lower,log}=await setup(),job=add(),identity=lower.p.codexIdentity;
 lower.identities.set(101,{pid:101,startTime:'different-start'});
 await a.rejects(s.shutdown(),e=>e.code==='CODEX_STOP_UNCONFIRMED');
 a.equal(lower.calls.length,0);a.equal(lower.p.codexIdentity,identity);
 a.equal(s.activeJobs.get(job.jobId),job);a.ok(!log.includes('unlink'));
});

test('three layers: ordinary failed turn leaves other jobs and process alive',async()=>{
 const {s,add,completed,lower}=await setup(),one=add(),two=add();
 await completed(one,'failed');
 a.equal(s.activeJobs.get(two.jobId),two);a.equal(s.state.status,'ready');
 a.ok(lower.live.has(101));a.equal(lower.calls.length,0);
 await s.shutdown();
});

test('three layers: write validation still owns its slot after Codex tree is gone',async()=>{
 const {s,h,add,completed,lower,log}=await setup(),job=add('write');
 h.validation=defer();completed(job);await tick();
 await a.rejects(s.shutdown(),e=>e.code==='SIDECAR_RESOURCES_UNCONFIRMED');
 a.equal(lower.p.child,null);a.equal(job.finalizing,true);a.equal(s.activeJobs.get(job.jobId),job);
 a.ok(!log.includes('unlink'));a.ok(!log.includes('commit'));
 h.validation.resolve({passed:true});
 await job.eventChain;await s.shutdown();
 a.ok(job.candidateResult);a.equal(s.activeJobs.size,0);
 a.equal(lower.calls.filter(x=>x.type==='mock-taskkill').length,1);
});

test('asynchronous shutdown dispatch contains throwing error observers',async()=>{
 const {s,h}=upperFixture();
 h.stop=async()=>{throw {code:'CODEX_STOP_UNCONFIRMED'};};
 s.on('protocolError',()=>{throw Error('SYNTHETIC_OBSERVER_FAILURE');});
 const answer=await s._dispatch('shutdown',{});
 a.equal(answer.accepted,true);a.equal(answer.confirmed,undefined);
 await tick();await tick();
 a.equal(s.state.status,'degraded');
 a.equal(s.stopFailed,true);
});