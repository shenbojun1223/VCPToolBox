'use strict';
// Reads existing logs and database metadata only. No HTTP or model calls.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const files=['chat-msg_1788871090453_assistant_up96gl6-204606_441-f7b5.json','chat-msg_1788871701065_assistant_blatszc-204928_405-70ab.json'];
const text=c=>typeof c==='string'?c:JSON.stringify(c);
const lcp=(a,b)=>{let n=0;while(n<Math.min(a.length,b.length)&&a[n]===b[n])n++;return n};
const strip=s=>s.replace(/<!-- VCP_RAG_BLOCK_START[\s\S]*?<!-- VCP_RAG_BLOCK_END -->/g,'[RAG_BLOCK]');
for(const file of files){
 const rows=JSON.parse(fs.readFileSync(path.join(root,'DebugLog/chat/2026-09-08',file),'utf8'));
 const out=[];
 for(let k=1;k<rows.length;k++){
  const a=rows[k-1].request.messages,b=rows[k].request.messages;
  const x=text(a[0].content),y=text(b[0].content),n=lcp(x,y);
  const open=x.lastIndexOf('<!-- VCP_RAG_BLOCK_START',n),close=x.lastIndexOf('<!-- VCP_RAG_BLOCK_END',n);
  const nonSystemChanges=[];
  for(let j=1;j<Math.min(a.length,b.length);j++)if(a[j].role!=='system'&&JSON.stringify(a[j])!==JSON.stringify(b[j]))nonSystemChanges.push(j);
  out.push({round:k,systemCharsBefore:x.length,systemCharsAfter:y.length,systemCommonPrefixUtf16:n,
   firstDifferenceWithinRag:open>=0&&open>close,systemEqualAfterRemovingRag:strip(x)===strip(y),
   nonSystemChanges,
   lastLoggedMessageMatchesOwnResponse:a.at(-1)?.role==='assistant'&&a.at(-1)?.content===rows[k-1].response?.content});
 }
 console.log(JSON.stringify({file,model:rows[0].request.model,comparisons:out}));
}
const dbPath='C:\\Users\\Administrator\\AppData\\Roaming\\new-api-electron\\data\\new-api.db';
if(fs.existsSync(dbPath)){
 const Database=require('better-sqlite3');
 const db=new Database(dbPath,{readonly:true,fileMustExist:true,timeout:1000});
 try{
  db.pragma('query_only=ON');
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('logs','usage_logs','consumption_logs')").all();
  for(const {name}of tables){
   const columns=db.prepare('PRAGMA table_info("'+name+'")').all().map(c=>({name:c.name,type:c.type}));
   console.log(JSON.stringify({database:'new-api',table:name,columns}));
  }
 }finally{db.close()}
}else console.log(JSON.stringify({database:'new-api',exists:false}));