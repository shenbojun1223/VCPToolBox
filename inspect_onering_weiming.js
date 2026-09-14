'use strict';

const Database = require('better-sqlite3');
const dbPath = 'C:\\VCP\\VCPToolBox\\Plugin\\OneRing\\data\\微明.db';
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const stats = db.prepare(`
  SELECT COUNT(*) AS count,
         MIN(timestamp) AS firstTimestamp,
         MAX(timestamp) AS lastTimestamp
  FROM messages
  WHERE agentName = ?
`).get('微明');

const rows = db.prepare(`
  SELECT id, role, senderName, frontendSource, timestamp,
         LENGTH(content) AS contentLength,
         SUBSTR(REPLACE(REPLACE(content, CHAR(13), ' '), CHAR(10), ' '), 1, 1200) AS snippet
  FROM messages
  WHERE agentName = ?
    AND timestamp > ?
  ORDER BY timestamp ASC, id ASC
`).all('微明', '2026-08-20 14:54:02');

const targetPattern = /A股|投研|research-core|板块|社媒|PIT|Lucy|投研助手/i;
const matched = rows.filter(row => targetPattern.test(row.snippet));

const postTurns = db.prepare(`
  SELECT turnId, frontendSource, status, requestBlockCount,
         requestTotalBlockCount, createdAt, updatedAt,
         completedAt, abortedAt, responseMessageId
  FROM postTurns
  WHERE agentName = ?
  ORDER BY updatedAt DESC
  LIMIT 30
`).all('微明');

console.log(JSON.stringify({
  dbPath,
  stats,
  rowsAfterMemo: rows.length,
  matched,
  recentMetadata: rows.map(row => ({
    id: row.id,
    role: row.role,
    senderName: row.senderName,
    frontendSource: row.frontendSource,
    timestamp: row.timestamp,
    contentLength: row.contentLength,
    snippet: row.snippet.slice(0, 240)
  })),
  postTurns
}, null, 2));

db.close();