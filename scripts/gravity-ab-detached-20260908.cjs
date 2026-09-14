'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const dir=path.join(__dirname,'gravity-ab-pilot-20260908');
const mode=process.argv[2];
if(mode==='probe-child'){
 fs.writeFileSync(path.join(dir,'detached-probe-start.json'),JSON.stringify({pid:process.pid,time:Date.now()}),{flag:'wx'});
 setTimeout(()=>fs.writeFileSync(path.join(dir,'detached-probe-done.json'),JSON.stringify({pid:process.pid,time:Date.now(),modelCalls:0}),{flag:'wx'}),8000);
}else{
 const probe=mode==='probe';
 if(!probe&&!['1','2'].includes(mode))throw Error('invalid-mode');
 if(!probe&&!fs.existsSync(path.join(dir,'detached-probe-done.json')))throw Error('probe-not-complete');
 const label=probe?'detached-probe':'recovery-pair-'+mode;
 const lock=fs.openSync(path.join(dir,label+'-launch.json'),'wx');
 const out=fs.openSync(path.join(dir,label+'.stdout.log'),'wx');
 const err=fs.openSync(path.join(dir,label+'.stderr.log'),'wx');
 const args=probe?[__filename,'probe-child']:[path.join(__dirname,'gravity-ab-pilot-20260908.cjs'),mode];
 const child=spawn(process.execPath,args,{cwd:path.resolve(__dirname,'..'),detached:true,windowsHide:true,stdio:['ignore',out,err]});
 fs.writeSync(lock,JSON.stringify({pid:child.pid,time:Date.now(),args}));fs.closeSync(lock);fs.closeSync(out);fs.closeSync(err);child.unref();
 console.log(JSON.stringify({launched:label,pid:child.pid,modelCalls:probe?0:'bounded by pilot ledger'}));
}