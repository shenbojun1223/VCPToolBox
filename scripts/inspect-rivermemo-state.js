'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(__dirname, '..', 'VectorStore', 'knowledge_base.sqlite');
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

function tableExists(name) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1").get(name)
  );
}

const result = {
  dbPath,
  tables: db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%memo%' OR name LIKE '%artifact%') ORDER BY name"
  ).all().map(row => row.name),
  river: [],
  tag: []
};

if (tableExists('rivermemo_artifacts')) {
  result.river = db.prepare(`
    SELECT
      artifact_sig,
      algorithm_version,
      source_v9_artifact_sig,
      model_sig,
      config_hash,
      database_generation,
      status,
      node_count,
      edge_count,
      created_at,
      updated_at,
      published_at,
      error_message
    FROM rivermemo_artifacts
    ORDER BY updated_at DESC
    LIMIT 10
  `).all();
}

if (tableExists('tagmemo_artifacts')) {
  result.tag = db.prepare(`
    SELECT *
    FROM tagmemo_artifacts
    ORDER BY updated_at DESC
    LIMIT 5
  `).all();
}

db.close();
console.log(JSON.stringify(result, null, 2));