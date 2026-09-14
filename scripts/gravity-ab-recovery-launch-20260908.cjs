'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const oldDir=path.join(__dirname,'gravity-ab-pilot-20260908');
const dir=path.join(__dirname,'gravity-ab-recovery-20260908');
const runner=path.join(__dirname,'gravity-ab-recovery-20260908.cjs');
const mode=process.argv[2];
const old=JSON.parse(fs.readFileSync(path.join(oldDir,'state.json'),'utf8'));
const probe=JSON.parse(fs.readFileSync(path.join(oldDir,'detached-probe-done.json'),'utf8'));
if(old.attempts!==1||old.completed!==0||probe.modelCalls!==0)throw Error('unexpected-prior-state');
if(mode==='build'){
 let code=fs.readFileSync(path.join(__dirname,'gravity-ab-pilot-20260908.cjs'),'utf8');
 const replacements=[
 ["const dir=path.join(__dirname,'gravity-ab-pilot-20260908');","const dir=path.join(__dirname,'gravity-ab-recovery-20260908');"],
 ['你将分三轮完成同一审计：阶段1判断已完成和待办；阶段2核对测试及校验原始证据；阶段3完成交接。','你将分两轮完成同一审计：阶段1判断已完成和待办；阶段2核对测试及校验原始证据并交接。'],
 ['最多三次调用，恢复也占后续调用机会。','最多两次调用。阶段1提出的恢复可在阶段2看到；阶段2才提出的恢复将记录为未完成，不追加调用。'],
 ['maxAttempts:6','maxAttempts:4'],
 ["if(![1,2,3].includes(n))","if(![1,2].includes(n))"],
 ["if(state.attempts>=6)","if(state.attempts>=4)"]
 ];
 for(const [a,b]of replacements){if(!code.includes(a))throw Error('patch-anchor-missing');code=code.replace(a,b)}
 code=code.replace("const n=Number(mode);",
 "const prior=read(path.join(__dirname,'gravity-ab-pilot-20260908','state.json')); if(prior.attempts!==1||prior.completed!==0)throw Error('prior-ledger-changed'); const n=Number(mode);");
 fs.writeFileSync(runner,code,{flag:'wx'});
 console.log(JSON.stringify({built:runner,modelCalls:0}));
}else if(['1','2'].includes(mode)){
 const state=JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8'));
 if(state.blocked||state.nextPair!==Number(mode)||state.attempts>=4)throw Error('unsafe-launch');
 const label='pair-'+mode;
 const lock=fs.openSync(path.join(dir,label+'-launch.json'),'wx');
 const out=fs.openSync(path.join(dir,label+'.stdout.log'),'wx');
 const err=fs.openSync(path.join(dir,label+'.stderr.log'),'wx');
 const child=spawn(process.execPath,[runner,mode],{cwd:path.resolve(__dirname,'..'),detached:true,windowsHide:true,stdio:['ignore',out,err]});
 fs.writeSync(lock,JSON.stringify({pid:child.pid,time:Date.now(),priorAttempts:old.attempts,newAttemptLimit:4}));
 fs.closeSync(lock);fs.closeSync(out);fs.closeSync(err);child.unref();
 console.log(JSON.stringify({launched:label,pid:child.pid}));
}else throw Error('invalid-mode');