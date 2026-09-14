'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const before = fs.readFileSync(path.join(root, 'config.env.bak-rag-refresh-off-20260909-1425'));
const after = fs.readFileSync(path.join(root, 'config.env'));
const oldText = before.toString('utf8');
const newText = after.toString('utf8');
const oldLines = oldText.match(/^[ \t]*RAGMemoRefresh[ \t]*=.*$/gm) || [];
const newLines = newText.match(/^[ \t]*RAGMemoRefresh[ \t]*=.*$/gm) || [];
const expected = oldText.replace(/^RAGMemoRefresh=true(?=\r?$)/m, 'RAGMemoRefresh=false');
const expectedBytes = Buffer.from(expected, 'utf8');
const normalize = text => text.replace(/\r\n/g, '\n');
const stats = text => ({
  crlf: (text.match(/\r\n/g) || []).length,
  bareLf: (text.match(/(?<!\r)\n/g) || []).length,
  bom: text.charCodeAt(0) === 0xfeff,
  finalNewline: text.endsWith('\n')
});
const unique = oldLines.length === 1 && newLines.length === 1;
const valueCorrect = unique && newLines[0].trim() === 'RAGMemoRefresh=false';
const exact = expectedBytes.equals(after);
const newlineOnly = normalize(expected) === normalize(newText);
console.log(JSON.stringify({
  unique, valueCorrect,
  beforeBytes: before.length, afterBytes: after.length,
  expectedBytes: expectedBytes.length,
  utf8RoundTripBefore: Buffer.from(oldText, 'utf8').equals(before),
  utf8RoundTripAfter: Buffer.from(newText, 'utf8').equals(after),
  exactExpectedBytes: exact,
  expectedEqualAfterLineEndingNormalization: newlineOnly,
  before: stats(oldText), after: stats(newText)
}, null, 2));
process.exitCode = valueCorrect && newlineOnly ? 0 : 1;