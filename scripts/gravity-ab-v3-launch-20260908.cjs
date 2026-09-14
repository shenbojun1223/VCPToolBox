'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const dir=path.join(__dirname,'gravity-ab-v3-20260908');
const n=Number(process.argv[2]);
if(![1,2].includes(n))throw Error('invalid-pair');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const tests=read(path.join(__dirname,'gravity-ab-v3-local-test-20260908.json'));
if(tests.passed!==16||tests.failed!==0||tests.modelCalls!==0)throw Error('local-tests');
for(const name of ['gravity-ab-pilot-20260908','gravity-ab-recovery-20260908']){
 const prior=read(path.join(__dirname,name,'state.json'));
 if(prior.attempts!==1||prior.completed!==0)throw Error('prior-ledger');
}
const state=read(path.join(dir,'state.json'));
if(state.blocked||state.nextPair!==n||state.attempts>=4)throw Error('unsafe-launch');
if(n===2){
 const review=read(path.join(dir,'pair-1-review.json'));
 if(review.proceed!==true)throw Error('needs-quality-review');
}
const lock=fs.openSync(path.join(dir,`pair-${n}-launch.json`),'wx');
const out=fs.openSync(path.join(dir,`pair-${n}.stdout.log`),'wx');
const err=fs.openSync(path.join(dir,`pair-${n}.stderr.log`),'wx');
const child=spawn(process.execPath,[path.join(__dirname,'gravity-ab-v3-20260908.cjs'),String(n)],
 {cwd:path.resolve(__dirname,'..'),detached:true,windowsHide:true,stdio:['ignore',out,err]});
fs.writeSync(lock,JSON.stringify({pid:child.pid,time:Date.now(),priorAttempts:2,newLimit:4,totalLimit:6}));
fs.closeSync(lock);fs.closeSync(out);fs.closeSync(err);child.unref();
console.log(JSON.stringify({launched:n,pid:child.pid}));