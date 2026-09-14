const fs = require('fs');
try {
  const raw = fs.readFileSync('C:/VCP/VCPToolBox/DebugLog/toolPayloads/2026-09-06/2026-09-06_01-07-27-215_UrlFetch_AnySearch_17676_51.txt', 'utf8');
  const parsed = JSON.parse(raw);
  const content = parsed[1].content;
  console.log('Total content length:', content.length);
  
  // 找“十一、”或“主观能动性”的所有出现位置
  let idx = 0;
  while ((idx = content.indexOf('主观能动性', idx)) !== -1) {
    console.log('Found at:', idx);
    console.log(content.slice(Math.max(0, idx - 100), Math.min(content.length, idx + 800)));
    console.log('-----------------------------------------');
    idx += 5;
  }
} catch (e) {
  console.error(e);
}