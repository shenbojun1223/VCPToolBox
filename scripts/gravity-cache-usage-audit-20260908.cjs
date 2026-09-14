'use strict';
const Database=require('better-sqlite3');
const db=new Database('C:\\Users\\Administrator\\AppData\\Roaming\\new-api-electron\\data\\new-api.db',{readonly:true,fileMustExist:true,timeout:1000});
try{
 db.pragma('query_only=ON');
 const from=Math.floor(Date.parse('2026-09-08T20:38:00+08:00')/1000);
 const to=Math.floor(Date.parse('2026-09-08T20:52:00+08:00')/1000);
 const rows=db.prepare('SELECT id,created_at,type,model_name,prompt_tokens,completion_tokens,use_time,is_stream,other FROM logs WHERE created_at BETWEEN ? AND ? AND model_name IN (?,?) ORDER BY id LIMIT 80')
 .all(from,to,'gpt-6-astra-high','gemini-3.8-flash-medium');
 function metrics(v,p='',out={},depth=0){
  if(!v||typeof v!=='object'||depth>6)return out;
  for(const [k,x]of Object.entries(v)){
   const key=p?p+'.'+k:k;
   if(typeof x==='number'&&/cache|cached|token|quota|ratio/i.test(k))out[key]=x;
   else if(x&&typeof x==='object'&&!Array.isArray(x))metrics(x,key,out,depth+1);
  }
  return out;
 }
 console.log(JSON.stringify({window:'2026-09-08 20:38–20:52 +08:00',rows:rows.length,limit:80,matching:'time and model only; not yet request-level correlated'}));
 for(const r of rows){
  let other;try{other=JSON.parse(r.other||'{}')}catch{}
  console.log(JSON.stringify({id:r.id,time:new Date(r.created_at*1000).toISOString(),type:r.type,model:r.model_name,
   promptTokens:r.prompt_tokens,completionTokens:r.completion_tokens,useTime:r.use_time,stream:r.is_stream,
   usageMetadata:metrics(other),otherParseable:!!other}));
 }
 if(!rows.length){
  const bounds=db.prepare('SELECT MIN(created_at) AS earliest, MAX(created_at) AS latest, COUNT(*) AS rows FROM logs').get();
  console.log(JSON.stringify({logCoverage:bounds}));
 }
}finally{db.close()}