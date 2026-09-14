'use strict';
// Read-only, model-scoped configuration snapshot, NOT request attribution.
// No channel keys, token records, headers or override bodies are selected.
const Database = require('better-sqlite3');
const db = new Database(
  'C:\\Users\\Administrator\\AppData\\Roaming\\new-api-electron\\data\\new-api.db',
  {readonly:true,fileMustExist:true,timeout:1000}
);
const models = [
  'gemini-embedding-2',
  'huibao/gemini-embedding-2',
  'google/gemini-embedding-2-preview'
];
const safeModel = s => typeof s === 'string' &&
  /^[a-zA-Z0-9._:/-]{1,160}$/.test(s) ? s : '[unrecognized-value-withheld]';
try {
  db.pragma('query_only = ON');
  const query = db.prepare(`
    SELECT a.model, a.channel_id, a.enabled, a.priority, a.weight,
      c.type, c.status, c.model_mapping,
      CASE WHEN length(trim(coalesce(c.param_override,''))) > 0
        AND trim(c.param_override) NOT IN ('{}','null') THEN 1 ELSE 0 END AS has_param_override,
      CASE WHEN length(trim(coalesce(c.header_override,''))) > 0
        AND trim(c.header_override) NOT IN ('{}','null') THEN 1 ELSE 0 END AS has_header_override
    FROM abilities a LEFT JOIN channels c ON c.id = a.channel_id
    WHERE a.model = ?
    LIMIT 101
  `);
  db.transaction(() => {
    for (const model of models) {
      const rows = query.all(model);
      const variants = new Map();
      for (const row of rows.slice(0,100)) {
        let mappedModel = model, mappingStatus = 'none';
        if (row.model_mapping && row.model_mapping.trim() !== '') {
          try {
            const mapping = JSON.parse(row.model_mapping);
            if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping))
              mappingStatus = 'unrecognized';
            else if (Object.prototype.hasOwnProperty.call(mapping,model)) {
              mappedModel = safeModel(mapping[model]);
              mappingStatus = 'explicit';
            } else mappingStatus = 'no-exact-entry';
          } catch { mappingStatus = 'unparsed'; }
        }
        const result = {
          channelId:row.channel_id, enabled:row.enabled,
          channelStatus:row.status, channelType:row.type,
          priority:row.priority, weight:row.weight,
          mappedModel,mappingStatus,
          hasParamOverride:!!row.has_param_override,
          hasHeaderOverride:!!row.has_header_override
        };
        const key = JSON.stringify(result);
        const previous = variants.get(key);
        if (previous) previous.abilityRows++;
        else variants.set(key,{...result,abilityRows:1});
      }
      console.log(JSON.stringify({
        model,truncated:rows.length > 100,variants:[...variants.values()],
        scope:'all-groups; caller-token-group-and-runtime-selection-unverified'
      }));
    }
  })();
} finally {
  db.close();
}