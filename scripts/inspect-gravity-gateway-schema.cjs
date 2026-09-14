'use strict';
// Metadata-only inspection. Never read channel keys, tokens or user tables.
const Database = require('better-sqlite3');
const db = new Database(
  'C:\\Users\\Administrator\\AppData\\Roaming\\new-api-electron\\data\\new-api.db',
  {readonly:true,fileMustExist:true,timeout:1000}
);
try {
  db.pragma('query_only = ON');
  for (const table of ['channels','abilities']) {
    const columns = db.prepare('PRAGMA table_info("' + table + '")').all();
    console.log(JSON.stringify({table,columns:columns.map(c=>({
      name:c.name,type:c.type
    }))}));
  }
} finally {
  db.close();
}