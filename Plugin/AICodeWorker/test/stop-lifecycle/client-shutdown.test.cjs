'use strict';
// Only client admission/identity logic is real. IPC and process observations are mocked.
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../../appserver/sidecarClient.js'),'utf8');
function fixture(status='degraded'){
 const h={alive:true,identityAvailable:true,statusError:null,statusHook:null};
 const calls=[];
 const saved={pid:71,startTime:'saved-process'};
 let state={schemaVersion:1,instanceId:'mock-instance',pid:71,status,processIdentity:saved,
  endpoint:'mock-endpoint',controlToken:'SYNTHETIC_CONTROL'};
 class SidecarError extends Error{constructor(code,message,details){super(message);this.code=code;this.details=details;}}
 const protocol={
  SidecarError,
  isPidAlive:()=>h.alive,
  getProcessIdentity:()=>h.identityAvailable?(h.currentIdentity||saved):null,
  sameProcessIdentity:(x,y)=>!!x&&!!y&&x.pid===y.pid&&x.startTime===y.startTime,
  validateStateRecord:s=>{if(!s?.instanceId||!s?.endpoint||!s?.controlToken)throw new SidecarError('SIDECAR_STATE_INVALID','mock');return s;},
  projectPatchProtocolProof:()=>({})
 };
 const module={exports:{}};
 const deps={
   "./frameTransport":require("../../appserver/frameTransport"),
  crypto:{},fs:{},net:{},path,child_process:{spawn:()=>{throw Error('REAL_SPAWN_FORBIDDEN');}},
  './protocol':protocol,'./writeRuntimeConfig':{
   APP_SERVER_MAX_CONCURRENCY:3,projectWriteProtocolStatus:()=>({})
  }
 };
 new vm.Script(source,{filename:'isolated-sidecarClient.js'}).runInNewContext({
  module,require:n=>{a.ok(Object.hasOwn(deps,n),'UNKNOWN_IMPORT');return deps[n];},
  process:{platform:'linux',env:{},cwd:()=>'/mock'},setTimeout,clearTimeout,Buffer
 },{timeout:2000});
 const c=Object.create(module.exports.SidecarClient.prototype);
 c.maxConcurrency=3;
 c.stateReader=()=>structuredClone(state);
 c._callWithState=async(s,method)=>{
  calls.push({method,state:s});
  if(method==='ping')return {pong:true,instanceId:s.instanceId};
  if(method==='status'){
   if(h.statusError)throw h.statusError;
   if(h.statusHook)h.statusHook();
   return {instanceId:h.remoteInstance||'mock-instance',maxConcurrency:h.remoteConcurrency??3};
  }
  if(method==='shutdown'){
   if(h.shutdownError)throw h.shutdownError;
   return {accepted:true};
  }
  throw Error('UNEXPECTED_IPC_METHOD');
 };
 return {c,h,calls,saved,setState:s=>{state=s;},getState:()=>state,SidecarError};
}
test('degraded instance retains authenticated shutdown without allowing new work',async()=>{
 const f=fixture();
 a.deepEqual(await f.c.shutdown(),{accepted:true});
 a.deepEqual(f.calls.map(x=>x.method),['status','shutdown']);
 a.equal(f.calls.at(-1).state.controlToken,'SYNTHETIC_CONTROL');
 a.equal(f.calls.at(-1).state.endpoint,'mock-endpoint');
 f.calls.length=0;
 await a.rejects(f.c._requireExisting(),e=>e.code==='SIDECAR_DEGRADED');
 a.equal(f.calls.length,0);
});
test('ready path still uses existing ping/status admission checks',async()=>{
 const f=fixture('ready');await f.c.shutdown();
 a.deepEqual(f.calls.map(x=>x.method),['ping','status','shutdown']);
});
for(const kind of ['dead','missing','mismatch'])test('unverified initial owner rejects: '+kind,async()=>{
 const f=fixture();
 if(kind==='dead')f.h.alive=false;
 if(kind==='missing')f.h.identityAvailable=false;
 if(kind==='mismatch')f.h.currentIdentity={pid:71,startTime:'different'};
 await a.rejects(f.c.shutdown(),e=>e.code==='SIDECAR_STATE_PROCESS_UNVERIFIED');
 a.equal(f.calls.length,0);
});
for(const field of ['instanceId','controlToken','endpoint','processIdentity','status']){
 test('snapshot drift between inspection and shutdown rejects: '+field,async()=>{
  const f=fixture();
  f.h.statusHook=()=>{
   const s=f.getState();
   s[field]=field==='processIdentity'?{pid:71,startTime:'changed'}:field==='status'?'starting':'changed';
  };
  await a.rejects(f.c.shutdown(),e=>e.code==='SIDECAR_INSTANCE_MISMATCH');
  a.deepEqual(f.calls.map(x=>x.method),['status']);
 });
}
test('owner disappears after authenticated status call',async()=>{
 const f=fixture();f.h.statusHook=()=>{f.h.alive=false;};
 await a.rejects(f.c.shutdown(),e=>e.code==='SIDECAR_STATE_PROCESS_UNVERIFIED');
 a.deepEqual(f.calls.map(x=>x.method),['status']);
});
for(const kind of ['instance','concurrency'])test('remote protocol compatibility is not bypassed: '+kind,async()=>{
 const f=fixture();
 if(kind==='instance')f.h.remoteInstance='another';
 else f.h.remoteConcurrency=99;
 await a.rejects(f.c.shutdown(),e=>e.code===(kind==='instance'?'SIDECAR_INSTANCE_MISMATCH':'SIDECAR_CONCURRENCY_MISMATCH'));
 a.deepEqual(f.calls.map(x=>x.method),['status']);
});
test('IPC status failure never falls back to an unchecked shutdown',async()=>{
 const f=fixture();f.h.statusError=new f.SidecarError('SIDECAR_IPC_TIMEOUT','mock');
 await a.rejects(f.c.shutdown(),e=>e.code==='SIDECAR_IPC_TIMEOUT');
 a.deepEqual(f.calls.map(x=>x.method),['status']);
});
test('authenticated shutdown rejection propagates without retry',async()=>{
 const f=fixture();f.h.shutdownError=new f.SidecarError('SIDECAR_IPC_ERROR','mock');
 await a.rejects(f.c.shutdown(),e=>e.code==='SIDECAR_IPC_ERROR');
 a.equal(f.calls.filter(x=>x.method==='shutdown').length,1);
});
test('same instance becoming ready is still a valid explicit shutdown target',async()=>{
 const f=fixture();f.h.statusHook=()=>{f.getState().status='ready';};
 const answer=await f.c.shutdown();a.equal(answer.accepted,true);a.equal(answer.confirmed,undefined);
});