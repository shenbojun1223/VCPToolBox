'use strict';
// Offline comparison only; emits counts, never prompt or diary text.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const files=['chat-msg_1788871090453_assistant_up96gl6-204606_441-f7b5.json','chat-msg_1788871701065_assistant_blatszc-204928_405-70ab.json'];
function blocks(s){
 return [...s.matchAll(/<!-- VCP_RAG_BLOCK_START\s+(\{[\s\S]*?\})\s+-->([\s\S]*?)<!-- VCP_RAG_BLOCK_END -->/g)].map(m=>{
  const meta=JSON.parse(m[1]);
  const body=m[2],lines=body.split(/\r?\n/).filter(s=>s.trim());
  const sources=[...body.matchAll(/\[路径:\s*([^\]\r\n]+)\]/g)].map(x=>x[1]);
  return {key:meta.dbName,metadata:m[1],body,lines,sources};
 });
}
const sameSet=(a,b)=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
for(const file of files){
 const rows=JSON.parse(fs.readFileSync(path.join(root,'DebugLog/chat/2026-09-08',file),'utf8'));
 const out=[];
 for(let i=1;i<rows.length;i++){
  const a=blocks(rows[i-1].request.messages[0].content),b=blocks(rows[i].request.messages[0].content);
  for(let j=0;j<b.length;j++){
   const x=a[j],y=b[j];if(!x||x.key!==y.key){out.push({round:i,block:j,comparable:false});continue}
   const xs=new Set(x.lines),ys=new Set(y.lines);
   out.push({round:i,block:j,metadataChanged:x.metadata!==y.metadata,bodyChanged:x.body!==y.body,
    sameNonblankLineMultiset:sameSet(x.lines,y.lines),
    previousSources:x.sources.length,currentSources:y.sources.length,
    sameSourceMultiset:x.sources.length>0&&sameSet(x.sources,y.sources),
    sameSourceOrder:x.sources.length>0&&JSON.stringify(x.sources)===JSON.stringify(y.sources),
    removedSources:x.sources.filter(s=>!y.sources.includes(s)).length,
    addedSources:y.sources.filter(s=>!x.sources.includes(s)).length,
    removedUniqueLines:[...xs].filter(s=>!ys.has(s)).length,
    addedUniqueLines:[...ys].filter(s=>!xs.has(s)).length});
  }
 }
 console.log(JSON.stringify({file,comparisons:out}));
}