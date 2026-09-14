'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dir = 'C:/VCP/VCPToolBox/DebugLog/chat/2026-09-10';
console.log('READ_ONLY_AUDIT_BEGIN');
const names = fs.readdirSync(dir).filter(n => /^chat-msg_178901(1159629|1291501|1314342)_/.test(n));
console.log(JSON.stringify({matchedFiles:names.length}));
for (const name of names) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir,name),'utf8').replace(/^\uFEFF/,''));
    const records = Array.isArray(parsed) ? parsed : [parsed];
    const ms = records[0]?.request?.messages;
    if (!Array.isArray(ms)) { console.log(JSON.stringify({name,keys:Object.keys(records[0] || {})})); continue; }
    const text = c => typeof c === 'string' ? c : JSON.stringify(c) || '';
    const sys = ms.filter(m=>m.role==='system').map(m=>text(m.content)).join('\n');
    const users = ms.filter(m=>m.role==='user');
    const rag = [...sys.matchAll(/<!-- VCP_RAG_BLOCK_START (.*?) -->([\s\S]*?)<!-- VCP_RAG_BLOCK_END -->/g)].map(m=>({
      db:JSON.parse(m[1]).dbName,k:JSON.parse(m[1]).k,chars:m[2].length,
      hash:crypto.createHash('sha256').update(m[2]).digest('hex'),
      paths:[...m[2].matchAll(/file:\/\/\/[^\]\r\n]+/g)].map(x=>x[0])
    }));
    console.log(JSON.stringify({name,topic:sys.match(/topic_\d+/)?.[0],calls:records.length,lastUser:text(users.at(-1)?.content).slice(0,420),rag}));
  } catch(e) {console.log(JSON.stringify({name,error:e.message}));}
}
const log='C:/Users/Administrator/.pm2/logs/vcp-main-out.log';
const fd=fs.openSync(log,'r');
const size=fs.fstatSync(fd).size;
const buf=Buffer.alloc(Math.min(size,8000000));
fs.readSync(fd,buf,0,buf.length,size-buf.length);
fs.closeSync(fd);
const rows=buf.toString('utf8').split(/\r?\n/).filter(l=>l.startsWith('[WebSocketServer]') && l.includes('"type":"RAG_RETRIEVAL_DETAILS","dbName":"赞妮')).slice(-12);
console.log(JSON.stringify({retrievalEvents:rows.length,readBytes:buf.length}));
for(const l of rows) {
  try {
    const e=JSON.parse(l.slice(l.indexOf('{"type"')));
    console.log(JSON.stringify({prefix:l.slice(0,65),db:e.dbName,queryTail:String(e.query).slice(-700),keys:Object.keys(e)}));
  } catch(e) {console.log(JSON.stringify({parseError:e.message,chars:l.length}));}
}
console.log('READ_ONLY_AUDIT_END');