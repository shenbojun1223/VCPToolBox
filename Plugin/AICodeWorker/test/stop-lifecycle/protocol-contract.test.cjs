'use strict';
const test=require('node:test'),a=require('node:assert/strict');
const fixture=require('./protocol-fixture.cjs');
test('real helper contract: version completion plus confirmed Windows tree stop',async()=>{
 const f=fixture();await f.p.start();a.equal(f.p._versionIdentity,null);
 const result=await f.p.stop();a.equal(result.confirmed,true);
 a.equal(f.p.child,null);a.equal(f.p.codexIdentity,null);
 const kills=f.calls.filter(c=>c.type==='mock-taskkill');
 a.equal(kills.length,1);a.equal(kills[0].pid,101);a.equal(kills[0].timeout,1000);
 a.equal(f.calls.filter(c=>c.type==='mock-signal').length,0);
});

test('real helper contract: taskkill failure retains ownership',async()=>{
 const f=fixture();await f.p.start();const identity=f.p.codexIdentity;
 f.cfg.taskkillFailure=true;
 await a.rejects(f.p.stop(),e=>e.code==='CODEX_STOP_UNCONFIRMED');
 a.equal(f.p.child,f.children.get(101));a.equal(f.p.codexIdentity,identity);
 f.cfg.taskkillFailure=false;await f.p.stop();
});

test('real helper contract: identity mismatch does not signal reused PID',async()=>{
 const f=fixture();await f.p.start();const saved=f.p.codexIdentity;
 f.identities.set(101,{pid:101,startTime:'reused-process'});
 await a.rejects(f.p.stop(),e=>e.code==='CODEX_STOP_UNCONFIRMED');
 a.equal(f.calls.length,0);a.equal(f.p.codexIdentity,saved);
});

test('real helper contract: missing current identity does not signal main',async()=>{
 const f=fixture();await f.p.start();f.cfg.identityMissing=101;
 await a.rejects(f.p.stop(),e=>e.code==='CODEX_STOP_UNCONFIRMED');
 a.equal(f.calls.length,0);a.ok(f.p.child);
});

test('real helper contract: exited root is not a tree completion proof',async()=>{
 const f=fixture();await f.p.start();f.exit(101);
 await a.rejects(f.p.stop(),e=>e.code==='CODEX_STOP_UNCONFIRMED');
 a.equal(f.calls.length,0);a.ok(f.p.child);
});

test('real helper contract: successful tree command but surviving root times out',async()=>{
 const f=fixture();await f.p.start();f.cfg.rootSurvives=true;
 const at=Date.now();
 await a.rejects(f.p.stop(),e=>e.code==='CODEX_STOP_UNCONFIRMED');
 a.ok(Date.now()-at<3000);a.ok(f.p.child);a.equal(f.p._stopPromise,null);
 f.cfg.rootSurvives=false;await f.p.stop();
});

test('real helper contract: version timeout graceful exit preserves timeout result',async()=>{
 const f=fixture({manualProbe:true});
 const observed=a.rejects(f.p._readVersion(),e=>e.code==='CODEX_VERSION_TIMEOUT');
 f.fire();await observed;
 a.equal(f.p._versionChild,null);a.equal(f.p._versionIdentity,null);
 a.equal(f.calls.filter(c=>c.type==='mock-signal').length,1);
 a.equal((await f.p.stop()).confirmed,true);
});

test('real helper contract: forced version termination must set a subprocess timeout',async()=>{
 const f=fixture({manualProbe:true,probeGraceful:false});
 const observed=a.rejects(f.p._readVersion(),e=>e.code==='CODEX_VERSION_TIMEOUT');
 f.fire();await observed;
 const kill=f.calls.find(c=>c.type==='mock-taskkill');
 a.ok(kill);a.equal(kill.pid,102);
 a.ok(Number.isFinite(kill.timeout)&&kill.timeout>0,
  'VERSION_FORCE_KILL_HAS_NO_SUBPROCESS_TIMEOUT');
 a.equal(f.p._versionIdentity,null);
});