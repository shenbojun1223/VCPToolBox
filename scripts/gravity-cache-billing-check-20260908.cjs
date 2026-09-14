'use strict';
const Database=require('better-sqlite3');
const db=new Database('C:\\Users\\Administrator\\AppData\\Roaming\\new-api-electron\\data\\new-api.db',{readonly:true,fileMustExist:true,timeout:1000});
try {
 db.pragma('query_only=ON');
 for(const [model,start,end] of [
  ['gpt-6-astra-high','20:38:00','20:46:07'],
  ['gemini-3.8-flash-medium','20:48:30','20:49:29']
 ]){
  const epoch=t=>Date.parse('2026-09-08T'+t+'+08:00')/1000;
  const rows=db.prepare('SELECT id,prompt_tokens,completion_tokens,quota,other FROM logs WHERE type=2 AND model_name=? AND created_at BETWEEN ? AND ? ORDER BY id').all(model,epoch(start),epoch(end));
  const out={model,window:start+'–'+end,matching:'time/model/count only; no request-id binding',rows:rows.length,promptTokens:0,cacheTokens:0,positiveCacheRows:0,quotaMatchesNoCacheDiscountFormula:0,cacheRatios:[],hits:[]};
  for(const r of rows){
   const o=JSON.parse(r.other||'{}');
   out.promptTokens+=r.prompt_tokens;
   out.cacheTokens+=Number(o.cache_tokens||0);
   if(!out.cacheRatios.includes(o.cache_ratio))out.cacheRatios.push(o.cache_ratio);
   const nominal=(r.prompt_tokens+r.completion_tokens*o.completion_ratio)*o.model_ratio*o.group_ratio;
   if(Number.isFinite(nominal)&&Math.abs(nominal-r.quota)<=1)out.quotaMatchesNoCacheDiscountFormula++;
   if(o.cache_tokens>0){out.positiveCacheRows++;out.hits.push({id:r.id,promptTokens:r.prompt_tokens,cacheTokens:o.cache_tokens,quota:r.quota,nominalQuota:nominal})}
  }
  console.log(JSON.stringify(out));
 }
}finally{db.close()}