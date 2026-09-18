'use strict';
// Execute the REAL termination helper in a VM with ALL OS/process operations mocked.
const test=require('node:test'),a=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const crypto=require('node:crypto'),vm=require('node:vm');
const protocolFile=path.join(__dirname,'../../appserver/protocol.js');
const protocolSource=fs.readFileSync(protocolFile,'utf8');
const candidateSource=fs.readFileSync(path.join(__dirname,'../../appserver/codexAppServerProcess.js'),'utf8');

function fixture(cfg={}){
 const calls=[],timers=new Map(),children=new Map(),live=new Set(),identities=new Map();
 for(const pid of [101,102]){
  const c=Object.assign(new EventEmitter(),{pid,exitCode:null,signalCode:null,stdout:new EventEmitter()});
  c.kill=signal=>{
   calls.push({type:'mock-signal',pid,signal});
   if(pid!==102)throw Error('ROOT_ONLY_SIGNAL_FOR_MAIN_FORBIDDEN');
   if(cfg.probeGraceful!==false)exit(pid);
   return true;
  };
  children.set(pid,c);identities.set(pid,{pid,startTime:'mock-start-'+pid});
 }
 function exit(pid){
  live.delete(pid);const c=children.get(pid);c.exitCode=0;c.emit('exit',0,null);c.emit('close',0,null);
 }
 function command(program,args,options={}){
  if(program==='powershell.exe'){
   const script=args[args.indexOf('-Command')+1];
   const match=String(script).match(/Get-Process -Id (\d+)/);
   a.ok(match,'ONLY_IDENTITY_INSPECTION_ALLOWED');
   const pid=Number(match[1]);
   if(!live.has(pid)||cfg.identityMissing===pid)return {status:1,stdout:''};
   const identity=identities.get(pid);
   return {status:0,stdout:JSON.stringify({Pid:pid,StartTime:identity.startTime})};
  }
  if(program==='taskkill'){
   a.deepEqual(Array.from(args),['/PID',String(args[1]),'/T','/F']);
   const pid=Number(args[1]);a.ok(children.has(pid));
   calls.push({type:'mock-taskkill',pid,timeout:options.timeout??null});
   if(cfg.taskkillFailure)return {status:1};
   if(!cfg.rootSurvives)exit(pid);
   return {status:0};
  }
  throw Error('REAL_COMMAND_FORBIDDEN');
 }
 const protocolModule={exports:{}};
 const fakeFs=new Proxy({}, {get(){return ()=>{throw Error('PROTOCOL_DISK_ACCESS_FORBIDDEN');};}});
 const protocolDependencies={crypto,fs:fakeFs,os,path,child_process:{spawnSync:command}};
 new vm.Script(protocolSource,{filename:protocolFile}).runInNewContext({
  module:protocolModule,Buffer,setTimeout,clearTimeout,
  process:{platform:'win32',env:{},kill(pid,signal){
   a.equal(signal,0,'ONLY_LIVENESS_QUERY_ALLOWED');
   if(live.has(Number(pid)))return true;
   const e=Error('mock gone');e.code='ESRCH';throw e;
  }},
  require(name){a.ok(Object.hasOwn(protocolDependencies,name));return protocolDependencies[name];}
 },{timeout:2000});
 const protocol=protocolModule.exports;
 class Connection extends EventEmitter{
  constructor(){super();this.closed=false;}
  close(){this.closed=true;this.emit('closed',{});}
  request(){return Promise.resolve({});}
  _write(){return true;}
 }
 const dependencies={
    "./frameTransport": require("../../appserver/frameTransport"),
  events:{EventEmitter},path,
  child_process:{spawn(bin,args){
   const pid=args.includes('--version')?102:101;
   live.add(pid);
   if(pid===102&&!cfg.manualProbe)queueMicrotask(()=>{
    children.get(pid).stdout.emit('data','codex-cli mock\n');exit(pid);
   });
   return children.get(pid);
  }},
  './protocol':protocol,'./jsonLineRpcConnection':{JsonLineRpcConnection:Connection}
 };
 const module={exports:{}};
 new vm.Script(candidateSource,{filename:'isolated-stop-candidate.js'}).runInNewContext({
  module,process:{env:{},cwd:()=>'/mock'},Buffer,
  require(name){a.ok(Object.hasOwn(dependencies,name));return dependencies[name];},
  setTimeout(fn){const key={};timers.set(key,fn);return key;},
  clearTimeout(key){timers.delete(key);}
 },{timeout:2000});
 const p=new module.exports.CodexAppServerProcess({codexBin:'mock-only'});
 return {p,cfg,calls,identities,live,children,exit,protocol,
  fire(){for(const [key,fn] of [...timers]){timers.delete(key);fn();}}};
}


module.exports=fixture;
