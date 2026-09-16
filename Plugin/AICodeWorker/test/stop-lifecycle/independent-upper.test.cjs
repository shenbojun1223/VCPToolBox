'use strict';
// Independent upper-layer acceptance. Every process, file write and Codex call is mocked.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {createHarness}=require('./harness.cjs');
const source=fs.readFileSync(path.join(__dirname,'../../appserver/sidecarServer.js'),'utf8');
const {fixture,defer,tick}=createHarness(source);

test('two live jobs retain ownership until the shared stop is confirmed',async()=>{
 const {s,h,add,meta,log}=fixture(),d=defer();
 const jobs=[add(),add()];h.stop=()=>d.promise;
 const done=s._handleProtocolError({code:'PROTOCOL_BUFFER_OVERFLOW'});
 await tick();
 assert.equal(s.activeJobs.size,2);
 for(const job of jobs){
  assert.equal(job.terminal,false);
  assert.equal(meta.get(job.paths.metaPath).state,'running');
 }
 assert.throws(()=>s._assertCodexAvailable(),{code:'SIDECAR_NOT_READY'});
 d.resolve({confirmed:true});await done;
 assert.equal(s.activeJobs.size,0);
 assert.equal(log.filter(x=>x==='stop').length,1);
 assert.equal(log.filter(x=>x.startsWith('terminal:')).length,2);
 assert.ok(!log.includes('unlink'));
});

for(const code of ['PROTOCOL_BUFFER_OVERFLOW','INVALID_JSON','INVALID_MESSAGE','UNKNOWN_RESPONSE_ID','WRITE_FAILED']){
 test('actual JSONL error code is preserved: '+code,async()=>{
  const {s,add}=fixture(),job=add();
  await s._handleProtocolError({code,message:'SYNTHETIC_SECRET',details:{token:'SYNTHETIC_SECRET'}});
  assert.equal(s.state.stopFault.causeCode,code,'SPECIFIC_JSONL_CAUSE_LOST');
  assert.equal(job.stopFault.causeCode,code);
  assert.ok(!JSON.stringify(s.state.stopFault).includes('SYNTHETIC_SECRET'));
  assert.ok(!JSON.stringify(job.stopFault).includes('SYNTHETIC_SECRET'));
 });
}

test('unknown error does not leak arbitrary code or message',async()=>{
 const {s,add}=fixture(),job=add();
 await s._handleProtocolError({code:'SYNTHETIC_SECRET',message:'SYNTHETIC_SECRET'});
 assert.equal(s.state.stopFault.causeCode,'CODEX_PROTOCOL_ERROR');
 assert.ok(!JSON.stringify(job.stopFault).includes('SYNTHETIC_SECRET'));
});

test('ordinary model turn failure does not stop another active job',async()=>{
 const {s,add,completed,meta,log}=fixture(),one=add(),two=add();
 await completed(one,'failed');
 assert.equal(meta.get(one.paths.metaPath).state,'failed');
 assert.equal(s.activeJobs.get(two.jobId),two);
 assert.equal(s.state.status,'ready');
 assert.ok(!log.includes('stop'));assert.ok(!s.stopGate);
});

test('transport closed with unconfirmed stop retains jobs and state',async()=>{
 const {s,h,add,meta,log}=fixture(),job=add();
 h.stop=async()=>{throw {code:'CODEX_STOP_UNCONFIRMED'};};
 await assert.rejects(s._handleCodexClosed(),{code:'CODEX_STOP_UNCONFIRMED'});
 assert.equal(s.activeJobs.get(job.jobId),job);
 assert.equal(meta.get(job.paths.metaPath).state,'running');
 assert.equal(job.terminal,false);assert.equal(s.state.status,'degraded');
 assert.ok(!log.includes('unlink'));assert.ok(!log.includes('close-server'));
});

test('synchronous stop exception is contained and still records safe failure',async()=>{
 const {s,h,add,log}=fixture(),job=add();
 h.stop=()=>{throw Error('SYNTHETIC_SECRET');};
 await assert.rejects(s._handleProtocolError({code:'INVALID_JSON'}),{code:'CODEX_STOP_FAILED'});
 assert.equal(s.activeJobs.get(job.jobId),job);
 assert.ok(!JSON.stringify(s.state.stopFault).includes('SYNTHETIC_SECRET'));
 assert.ok(!log.includes('unlink'));
});

test('state/diagnostic write failures and observers cannot skip stopping',async()=>{
 const {s,h,add,log}=fixture();add();h.diagnosticFailure=true;
 s.on('protocolError',()=>{throw Error('SYNTHETIC_SECRET');});
 await s._handleProtocolError({code:'PROTOCOL_BUFFER_OVERFLOW'});
 assert.equal(log.filter(x=>x==='stop').length,1);
 assert.equal(s.activeJobs.size,0);
});

test('shutdown failure retries the same ownership without early state deletion',async()=>{
 const {s,h,add,log}=fixture(),job=add(),d=defer();
 h.stop=()=>d.promise;
 const first=s.shutdown();assert.equal(s.shutdown(),first);
 await tick();assert.ok(!log.includes('unlink'));assert.equal(job.terminal,false);
 d.reject({code:'CODEX_STOP_UNCONFIRMED'});
 await assert.rejects(first,{code:'CODEX_STOP_UNCONFIRMED'});await tick();
 assert.equal(s.activeJobs.size,1);
 h.stop=async()=>({confirmed:true});await s.shutdown();
 assert.equal(log.filter(x=>x==='stop').length,2);
 assert.ok(log.indexOf('unlink')>log.findIndex(x=>x.startsWith('terminal:')));
});

test('already-entered terminal meta write is held behind a later fatal stop',async()=>{
 const {s,h,add,meta}=fixture(),job=add(),writing=defer(),stopping=defer();
 h.beforeWrite=next=>next.state==='failed'?writing.promise:undefined;
 const originalFinish=s._finishJob(job,'failed',1,'SAMPLE_FAILURE');
 await tick();
 h.stop=()=>stopping.promise;
 const stopped=s._handleProtocolError({code:'PROTOCOL_BUFFER_OVERFLOW'});
 writing.resolve();await tick();
 assert.equal(job.terminal,false);assert.equal(meta.get(job.paths.metaPath).state,'running');
 assert.equal(s.activeJobs.size,1);
 stopping.resolve({confirmed:true});
 await Promise.all([originalFinish,stopped]);assert.equal(s.activeJobs.size,0);
});

test('Codex tree stop does not cover Sidecar validation children',async()=>{
 const {s,add,log}=fixture(),job=add('patch');
 let kills=0;
 job.gitChildren.add({exitCode:null,signalCode:null,kill(){kills++;return true;}});
 await assert.rejects(s.shutdown(),{code:'SIDECAR_RESOURCES_UNCONFIRMED'});
 assert.equal(s.activeJobs.get(job.jobId),job);
 assert.equal(kills,0);assert.equal(job.gitChildren.size,1);
 assert.ok(!log.includes('remove-artifact'));assert.ok(!log.includes('unlink'));
});

test('baseline monitor false result is not discarded during fatal cleanup',async()=>{
 const {s,add,log}=fixture(),job=add('patch');
 const monitor={close:async()=>false};job.baselineMonitor=monitor;
 await assert.rejects(s.shutdown(),{code:'SIDECAR_RESOURCES_UNCONFIRMED'});
 assert.equal(job.baselineMonitor,monitor);
 assert.equal(s.activeJobs.get(job.jobId),job);
 assert.ok(!log.includes('remove-artifact'));assert.ok(!log.includes('unlink'));
});

test('baseline monitor throw does not discard ownership',async()=>{
 const {s,add,log}=fixture(),job=add('patch');
 const monitor={close:async()=>{throw Error('SYNTHETIC_SECRET');}};
 job.baselineMonitor=monitor;
 await assert.rejects(s.shutdown(),{code:'SIDECAR_RESOURCES_UNCONFIRMED'});
 assert.equal(job.baselineMonitor,monitor);
 assert.equal(s.activeJobs.get(job.jobId),job);
 assert.ok(!log.includes('unlink'));
});

test('missing Codex object cannot erase a recorded live Codex owner',async()=>{
 const {s,add,log}=fixture(),job=add();
 s.state.codexPid=87654;
 s.state.codexProcessIdentity={pid:87654,startTime:'synthetic-start'};
 s.codex=null;
 await assert.rejects(s.shutdown(),{code:'CODEX_STOP_UNCONFIRMED'});
 assert.equal(s.activeJobs.get(job.jobId),job);
 assert.ok(!log.includes('unlink'),'STATE_DELETED_WITHOUT_OWNERSHIP_PROOF');
});

test('setup still running remains owned if resource drain expires',async()=>{
 const {s,add,log}=fixture(),job=add('write'),setup=defer();
 job.setupDone=setup.promise;
 await assert.rejects(s.shutdown(),{code:'SIDECAR_RESOURCES_UNCONFIRMED'});
 assert.equal(job.terminal,false);assert.equal(s.activeJobs.get(job.jobId),job);
 assert.ok(!log.includes('unlink'));
 setup.resolve();await tick();await s.shutdown();
 assert.equal(s.activeJobs.size,0);
});