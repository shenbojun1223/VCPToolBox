'use strict';
// Main-agent acceptance tests. Only the recovered, reviewed VM fixture is used.
const {test,a,SidecarError,fixture,retained,rejects,child,deferred,tick,OK,NO,PRIVATE}=require('./fixture.cjs');

test('actual version probe success clears identities before main stop',async()=>{
 const f=fixture();
 a.equal(await f.p._readVersion(),'codex-cli mock');
 a.equal(f.p._versionChild,null);a.equal(f.p._versionIdentity,null);a.equal(f.p._stopTargets.size,0);
 f.attach();a.equal((await f.p.stop()).confirmed,true);
 a.equal(f.calls.length,1);a.equal(f.calls[0].c,f.main);
});

test('normal start runs real version method then initializes and stops',async()=>{
 const f=fixture();a.equal(await f.p.start(),f.p);
 a.equal(f.spawns.length,2);a.equal(f.p.started,true);
 a.equal(f.p._versionIdentity,null);
 a.equal((await f.p.stop()).confirmed,true);
 a.equal(f.p.child,null);a.equal(f.p._stopTargets.size,0);
});

test('probe nonzero close clears only completed probe ownership',async()=>{
 const f=fixture({manual:true});
 const observed=rejects(f.p._readVersion(),'CODEX_VERSION_FAILED');
 f.probe.exitCode=2;f.probe.emit('close',2);
 await observed;
 a.equal(f.p._versionChild,null);a.equal(f.p._versionIdentity,null);
 a.equal(f.p._stopTargets.size,0);a.equal(f.calls.length,0);
});

test('probe synchronous spawn failure allows retry without ownership',async()=>{
 const f=fixture({spawnError:true});
 await rejects(f.p.start(),'CODEX_VERSION_SPAWN_FAILED');
 a.equal(f.p._versionChild,null);a.equal(f.p._versionIdentity,null);a.equal(f.p._starting,null);
 f.cfg.spawnError=false;
 await f.p.start();await f.p.stop();
});

test('probe error event then close cleans the same probe',async()=>{
 const f=fixture({manual:true});
 const observed=rejects(f.p._readVersion(),'CODEX_VERSION_SPAWN_FAILED');
 f.probe.emit('error',Error(PRIVATE));
 await observed;a.equal(f.p._versionChild,f.probe);
 f.probe.exitCode=-2;f.probe.emit('close',-2);
 a.equal(f.p._versionChild,null);a.equal(f.p._versionIdentity,null);
 await f.p.stop();
});

test('probe timeout with confirmed termination rejects timeout but releases probe',async()=>{
 const f=fixture({manual:true});
 const observed=rejects(f.p._readVersion(),'CODEX_VERSION_TIMEOUT');
 f.fire();await observed;
 a.equal(f.calls.length,1);a.equal(f.calls[0].options.requireProcessTree,false);
 a.equal(f.p._versionChild,null);a.equal(f.p._versionIdentity,null);
 a.equal((await f.p.stop()).confirmed,true);
});

for(const throws of [false,true])test('probe timeout retains and retries: '+(throws?'exception':'unconfirmed'),async()=>{
 const f=fixture({manual:true,terminate:()=>{if(throws)throw Error(PRIVATE);return NO;}});
 const observed=rejects(f.p._readVersion(),'CODEX_VERSION_TIMEOUT');
 f.fire();await observed;
 a.equal(f.p._versionChild,f.probe);a.equal(f.p._versionIdentity,f.identities.get(102));
 a.equal(f.p._stopTargets.size,1);
 await rejects(f.p.start(),'CODEX_START_BLOCKED');
 f.cfg.terminate=()=>OK;
 a.equal((await f.p.stop()).confirmed,true);
 a.equal(f.p._versionIdentity,null);a.equal(f.calls.length,2);
});

test('stop waits for the existing probe timeout termination without duplicate kill',async()=>{
 const d=deferred(),f=fixture({manual:true,terminate:()=>d.promise});
 const observed=rejects(f.p._readVersion(),'CODEX_VERSION_TIMEOUT');
 f.fire();await tick();a.equal(f.calls.length,1);
 const stopped=f.p.stop();let settled=false;stopped.then(()=>{settled=true;});
 await tick();a.equal(f.calls.length,1);a.equal(settled,false);
 d.resolve(OK);await observed;a.equal((await stopped).confirmed,true);
 a.equal(f.calls.length,1);a.equal(f.p._versionIdentity,null);
});

test('stop during active probe prevents main process launch',async()=>{
 const f=fixture({manual:true});
 const observed=rejects(f.p.start(),'CODEX_VERSION_STOPPED');
 const stopped=f.p.stop();await stopped;await observed;
 a.equal(f.spawns.length,1);a.ok(f.spawns[0].includes('--version'));
 a.equal(f.p.child,null);a.equal(f.p._starting,null);
});

test('stop just after probe close prevents main launch',async()=>{
 const f=fixture({manual:true});
 const observed=rejects(f.p.start(),'CODEX_START_ABORTED');
 f.probe.exitCode=0;f.probe.emit('close',0);
 const stopped=f.p.stop();await stopped;await observed;
 a.equal(f.spawns.length,1);a.equal(f.p._versionIdentity,null);
});

test('unconfirmed stop blocks cleanup after a simple await',async()=>{
 const f=fixture({terminate:()=>NO});f.attach();
 let cleaned=false;
 const caller=(async()=>{await f.p.stop();cleaned=true;})();
 await rejects(caller);a.equal(cleaned,false);retained(f);
});

test('connection close error does not skip either fixed target; retry closes transport',async()=>{
 const f=fixture({close:()=>{throw Error(PRIVATE);}});f.attach();
 await rejects(f.p.stop({childOverride:child(202)}),'CODEX_STOP_FAILED');
 a.deepEqual(f.calls.map(x=>x.c.pid),[101,202]);
 a.equal(f.p.child,null);a.equal(f.p.connection,f.connection);
 a.equal(f.p._stopTargets.size,0);
 await rejects(f.p.start(),'CODEX_START_BLOCKED');a.equal(f.spawns.length,0);
 f.cfg.close=undefined;
 a.equal((await f.p.stop()).confirmed,true);a.equal(f.p.connection,null);
 a.equal(f.calls.length,2);
});

for(const throws of [false,true])test('one target failure does not skip another: '+throws,async()=>{
 const f=fixture({terminate:c=>{if(c.pid===101){if(throws)throw Error(PRIVATE);return NO;}return OK;}});
 f.attach();const extra=child(202);
 await rejects(f.p.stop({childOverride:extra}),throws?'CODEX_STOP_FAILED':'CODEX_STOP_UNCONFIRMED');
 a.deepEqual(f.calls.map(x=>x.c.pid),[101,202]);retained(f);
 a.equal(f.p._stopTargets.has(extra),false);
 f.cfg.terminate=()=>OK;await f.p.stop();
 a.deepEqual(f.calls.map(x=>x.c.pid),[101,202,101]);
});

test('late override remains owned and requires a bounded next attempt',async()=>{
 const d=deferred(),f=fixture({terminate:()=>d.promise});f.attach();
 const first=f.p.stop();const rejected=rejects(first);
 await tick();
 const late=child(202);a.equal(f.p.stop({childOverride:late}),first);
 d.resolve(OK);await rejected;
 a.equal(f.calls.length,1);a.equal(f.p._stopTargets.has(late),true);
 f.cfg.terminate=()=>OK;await f.p.stop();a.equal(f.calls.length,2);
});

test('override saved identity is not recaptured on retry',async()=>{
 const f=fixture({terminate:()=>NO}),extra=child(202);
 await rejects(f.p.stop({childOverride:extra}));
 const saved=f.calls[0].options.identity;
 f.cfg.identity=()=>({pid:202,startTime:'different-process'});
 f.cfg.terminate=()=>OK;
 await f.p.stop();
 a.equal(f.calls[1].options.identity,saved);a.deepEqual(f.ids,[202]);
});

test('already-exited main is not promoted to a tree proof by mock success',async()=>{
 const f=fixture();f.attach();f.main.exitCode=0;
 await rejects(f.p.stop());retained(f);
});

test('missing main launch identity is retained and not refreshed',async()=>{
 const f=fixture();f.attach();f.p.codexIdentity=null;
 await rejects(f.p.stop());
 a.equal(f.p.child,f.main);a.equal(f.p.codexPid,101);a.deepEqual(f.ids,[]);
});

test('empty ownership succeeds; orphaned identity does not',async()=>{
 const f=fixture();a.equal((await f.p.stop()).confirmed,true);
 for(const field of ['codexPid','codexIdentity','_versionIdentity']){
  const g=fixture(),value=field==='codexPid'?101:g.identities.get(101);
  g.p[field]=value;
  await rejects(g.p.stop());a.equal(g.p[field],value);a.equal(g.calls.length,0);
 }
});

test('start initialization failure preserves evidence when cleanup is unconfirmed',async()=>{
 const f=fixture({init:()=>Promise.reject(new SidecarError('MOCK_INIT_FAILED','mock')),terminate:()=>NO});
 await rejects(f.p.start());a.equal(f.p.child,f.main);a.equal(f.p._starting,null);
 a.equal(f.p.codexIdentity,f.identities.get(101));
 const before=f.spawns.length;
 await rejects(f.p.start(),'CODEX_START_BLOCKED');a.equal(f.spawns.length,before);
 f.cfg.terminate=()=>OK;await f.p.stop();
});

test('successful start-failure cleanup preserves original safe error',async()=>{
 const f=fixture({init:()=>Promise.reject(new SidecarError('MOCK_INIT_FAILED','mock'))});
 await rejects(f.p.start(),'MOCK_INIT_FAILED');
 a.equal(f.p.child,null);a.equal(f.p.connection,null);a.equal(f.p._starting,null);
});

test('stop while initialization is pending cannot later mark started',async()=>{
 const d=deferred(),f=fixture({init:()=>d.promise});
 const observed=rejects(f.p.start(),'CODEX_START_ABORTED');
 await tick();a.equal(f.spawns.length,2);
 await f.p.stop();d.resolve({});await observed;
 a.equal(f.p.started,false);a.equal(f.p.child,null);
});

test('reentrant duplicate override is not terminated again',async()=>{
 const d=deferred(),extra=child(202),f=fixture({terminate:c=>c===extra?d.promise:OK});f.attach();
 const first=f.p.stop({childOverride:extra});await tick();
 a.equal(f.calls.length,2);a.equal(f.p.stop({childOverride:f.main}),first);
 d.resolve(OK);await first;await f.p.stop();a.equal(f.calls.length,2);
});

test('throwing closed listener does not skip termination',async()=>{
 const f=fixture();f.attach();f.p.on('closed',()=>{throw Error(PRIVATE);});
 await rejects(f.p.stop(),'CODEX_STOP_FAILED');
 a.equal(f.calls.length,1);a.equal(f.p.child,null);
 await f.p.stop();a.equal(f.p.connection,null);
});

test('start with a pending start attempt rejects rather than spawning twice',async()=>{
 const f=fixture({manual:true});
 const first=f.p.start();
 await rejects(f.p.start(),'CODEX_START_BLOCKED');a.equal(f.spawns.length,1);
 f.probe.exitCode=0;f.probe.emit('close',0);
 await first;await f.p.stop();
});