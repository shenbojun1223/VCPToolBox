'use strict';
// Bounded evidence inspection only. No historical command execution.
const fs = require('node:fs');
const path = require('node:path');
const Parser = require('../modules/vcpLoop/toolCallParser');
const file = path.join(__dirname, '..',
  'DebugLog/chat/2026-09-08/chat-msg_1788836272272_assistant_3y6x2pe-110604_302-6b7a.json');
const rounds = JSON.parse(fs.readFileSync(file, 'utf8'));
const messages = rounds.at(-1).request.messages;
const marker = '<!-- VCP_TOOL_PAYLOAD -->';
const sensitive = /password|secret|api.?key|authorization|bearer|验证码|密钥/i;
function safeLine(line) {
  return sensitive.test(line) ? '[sensitive line omitted]' : line.slice(0, 400);
}
// Reproduce literal excerpt boundaries of the replay, not JSON-decoded offsets.
for (const index of [7, 13, 19]) {
  const text = messages[index].content;
  const start = marker.length + 600, end = text.length - 400;
  const middle = text.slice(start, end);
  const needles = index === 7
    ? ['function sync', 'invalidated', 'function restore', 'history-conflict',
       'store-budget', 'index-conflict']
    : index === 13
      ? ['baseline', 'projected', 'saved', '# tests', '# pass', '# fail',
         'productionTokensMeasured', 'semanticQualityMeasured']
      : ['logicDepth', 'resonance', 'entropy', '_emptyResult'];
  const excerpts = [];
  for (const needle of needles) {
    const offset = middle.indexOf(needle);
    if (offset < 0) continue;
    const left = Math.max(0, offset - 60);
    excerpts.push({needle, originalOffset:start + offset,
      excerpt:safeLine(middle.slice(left, Math.min(middle.length, offset + 230)))});
  }
  console.log(JSON.stringify({kind:'omitted-middle', receiptIndex:index,
    omittedStart:start, omittedEnd:end, excerpts}));
}
// Later assistant prose: exclude parsed command blocks, including their arguments.
// These excerpts locate possible dependencies, not proof of causal reliance.
for (let index = 8; index < messages.length; index += 2) {
  const text = messages[index].content;
  if (messages[index].role !== 'assistant' || typeof text !== 'string') continue;
  const prose = [];
  let cursor = 0, block;
  while ((block = Parser.extractNextToolBlock(text, cursor))) {
    prose.push(text.slice(cursor, block.startIndex));
    cursor = block.nextOffset;
  }
  prose.push(text.slice(cursor));
  const clean = prose.join('\n');
  const matches = clean.split(/\r?\n/).filter(line =>
    /恢复|失效|原文|256|30\.66|17\/17|EPA|残差|阈值|参数/.test(line));
  console.log(JSON.stringify({kind:'later-prose', messageIndex:index,
    excerpts:matches.slice(0, 5).map(safeLine),
    dependencyNotYetEstablished:true}));
}// Fixed fold sets from the verified replay of THIS sample only.
// Inspect each fact when its source is first omitted, never using future turns.
const folds = [[],[],[],[3],[3],[3,7],[3,7,9],[3,7,9],
  [3,7,9,13],[3,7,9,13,15],[3,7,9,13,15,17],[3,7,9,13,15,17,19]];
const probes = [
  {id:'store-entry-limit', receipt:7, needle:'entries.size >= 64'},
  {id:'restore-checks-current-history', receipt:7, needle:'const state = sync(messages);'},
  {id:'sample-baseline-number', receipt:13, needle:'27805'},
  {id:'sample-projected-number', receipt:13, needle:'19279'},
  {id:'targeted-test-count', receipt:13, needle:'# tests 17'},
  {id:'epa-fallback-depth', receipt:19, needle:'logicDepth: 0.5'}
];
function normalize(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/(\d),(?=\d{3}\b)/g, '$1');
}
function visibleText(m) {
  if (typeof m.content !== 'string') return '';
  if (m.role === 'user' && m.content.startsWith(marker)) {
    try {
      const parts = JSON.parse(m.content.slice(marker.length).trim());
      if (Array.isArray(parts)) return normalize(parts.map(p => p.text || '').join('\n'));
    } catch { /* Literal stub or truncated receipt stays literal. */ }
  }
  return normalize(m.content);
}
function locations(ms, needle) {
  return ms.flatMap((m, index) => visibleText(m).includes(needle)
    ? [{index,role:m.role,
        evidenceKind:m.role === 'assistant' ? 'assistant-claim-or-command-not-execution-proof'
          : m.role === 'system' ? 'system-context-not-independent-verification'
          : 'user-or-recorded-receipt'}] : []);
}
const assert = require('node:assert/strict');
const {createGravityOriginalStore} = require('../modules/vcpLoop/gravityOriginalStore');
const originalStore = createGravityOriginalStore();
try {
  console.log('--- first-omission-evidence-audit ---');
  for (const probe of probes) {
    const round = folds.findIndex(set => set.includes(probe.receipt));
    assert(round >= 0);
    const current = rounds[round].request.messages;
    const projection = structuredClone(current);
    for (const index of folds[round]) {
      const text = current[index].content;
      // Replace the same middle as replay; no invented conclusions in this mask.
      projection[index].content = marker + '\n[offline omitted middle]\n' +
        text.slice(marker.length, marker.length + 600) + '\n' + text.slice(-400);
    }
    assert(visibleText(current[probe.receipt]).includes(probe.needle),
      'Probe absent from original receipt: ' + probe.id);
    const originalLocations = locations(current, probe.needle);
    const retainedLocations = locations(projection, probe.needle);
    const saved = originalStore.register(probe.receipt, current[probe.receipt].content);
    assert.equal(saved.status, 'registered');
    const restored = originalStore.restore(saved.handle);
    assert.equal(restored.status, 'restored');
    assert.equal(restored.text, current[probe.receipt].content);
    projection[probe.receipt].content = restored.text;
    assert(locations(projection, probe.needle).some(x => x.index === probe.receipt));
    console.log(JSON.stringify({
      id:probe.id, sourceReceipt:probe.receipt, firstOmittedRound:round,
      originalLocations,retainedLocations,sourceRestoredExactly:true,
      classification:retainedLocations.length
        ? 'literal-or-normalized-match-retained-check-evidence-kind'
        : 'no-literal-match-retained-restoration-needed-for-source-verification',
      semanticEquivalentSearch:false,actualDownstreamNeedProven:false,
      futureMessagesUsed:false,modelRecoveryTested:false
    }));
  }
} finally { originalStore.close(); }