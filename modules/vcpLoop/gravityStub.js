'use strict';
// Cache-only SHADOW implementation. No production folding is enabled here.
// Similarity is a relevance heuristic, NOT evidence that facts can be discarded.
// No network, folding-store writes, global aggregate vectors or retained history.
const { performance } = require('node:perf_hooks');
const PROTOCOL = /VCP_|TOOL_REQUEST|END_TOOL_REQUEST|VCP调用|Flowlock::|系统提示|元思维|元思考/;
const DETAIL = /[0-9`{}]|https?:|file:|[\\/]|\b[A-Z][A-Z_]{2,}\b|端口|路径|配置|密码|密钥|必须|禁止|不得|务必|截止|约定|决策|结论|注意|风险|不能|不要|不应|\b(?:must|never|do not|Must|Never|Do not)\b/;
const MAX_CHARS = 1000000;
const MAX_VECTORS = 64;
const MAX_DIM = 4096;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  // Do not stringify image URLs or other attachments into cache queries.
  return content.filter(p => p && p.type === 'text' && typeof p.text === 'string')
    .map(p => p.text).join('\n');
}
function isRealUser(m) {
  return m && m.role === 'user' && typeof m.content === 'string' &&
    !PROTOCOL.test(m.content);
}
function normalize(v, expectedDim) {
  if (!Array.isArray(v) && !(v instanceof Float32Array) &&
      !(v instanceof Float64Array)) return null;
  if (!v.length || v.length > MAX_DIM || (expectedDim && v.length !== expectedDim)) return null;
  let norm = 0;
  for (const n of v) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    norm += n * n;
  }
  if (!Number.isFinite(norm) || norm <= 1e-20) return null;
  norm = Math.sqrt(norm);
  return Array.from(v, n => n / norm);
}
function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return Math.max(-1, Math.min(1, sum));
}
function getBridge(options) {
  if (options.contextBridge) return options.contextBridge;
  const rag = options.pluginManager?.messagePreprocessors?.get?.('RAGDiaryPlugin');
  return typeof rag?.getContextBridge === 'function' ? rag.getContextBridge() : null;
}

/**
 * Read only exact full texts present in this request (cache itself trims text).
 * Returned indices are hypothetical candidates, never authorization to fold.
 * Threshold 0.35 is an uncalibrated shadow baseline, not EPA/RiverMemo.
 * Work is capped; elapsed checks cannot preempt a synchronous cache getter.
 */
function analyzeGravityStub(messages, options = {}) {
  const start = performance.now();
  const report = {
    version: 'cache-shadow-v1', mode: 'shadow', status: 'skipped',
    reason: '', totalChars: 0, cacheHits: 0, cacheMisses: 0,
    eligible: 0, protected: 0, wouldStub: 0, potentialChars: 0,
    threshold: 0.35, candidates: [], elapsedMs: 0
  };
  const finish = reason => {
    report.reason = reason;
    report.elapsedMs = Number((performance.now() - start).toFixed(3));
    return report;
  };
  const expired = () => options.signal?.aborted || performance.now() - start > 15;
  const discard = reason => {
    report.status = 'skipped';
    report.candidates = [];
    report.wouldStub = 0;
    report.potentialChars = 0;
    return finish(reason);
  };
  try {
    if (options.signal?.aborted) return finish('aborted');
    // Current handoff protocol has no verified provenance. Receiving vectors
    // is NOT permission to analyze/fold with them or retry via ambiguous cache.
    // Retain no packet, hashes or vectors in the diagnostic report.
    if (options.gravityHandoff !== undefined && options.gravityHandoff !== null)
      return finish('handoff-unverified');
    if (!Array.isArray(messages) || messages.length <= 6 || messages.length > 256)
      return finish('message-budget');
    // Both handlers increment depth AFTER the post-tool upstream request.
    // Zero is valid; exact receipt membership below also gates loop context.
    if (!Number.isInteger(options.recursionDepth) || options.recursionDepth < 0)
      return finish('not-tool-loop');
    for (const m of messages) {
      if (!m || typeof m !== 'object') return finish('invalid-message');
      report.totalChars += textOf(m.content).length;
      if (report.totalChars > MAX_CHARS) return finish('character-budget');
    }
    if (report.totalChars < 32000) return finish('below-watermark');

    // Latest ordinary user starts the current loop; everything after it is immune.
    // Also protect the previous real user turn, plus at least the last four messages.
    const users = [];
    for (let i = 0; i < messages.length; i++) if (isRealUser(messages[i])) users.push(i);
    if (!users.length) return finish('missing-user-anchor');
    const anchorIndex = users[users.length - 1];
    const previousTurn = users.length > 1 ? users[users.length - 2] : anchorIndex;
    const immuneStart = Math.min(previousTurn, messages.length - 4);
    const goalText = messages[anchorIndex].content;
    const payloadText = textOf(options.latestPayload);
    // Exact membership prevents an arbitrary external payload from becoming a probe.
    if (!payloadText || !messages.slice(anchorIndex + 1).some(m =>
      (m.role === 'user' || m.role === 'tool') && textOf(m.content) === payloadText))
      return finish('missing-payload-anchor');

    report.cacheInvalid = 0;
    report.cacheErrors = 0;
    report.anchorCache = { goal:'not-read', payload:'not-read' };
    const bridge = getBridge(options);
    if (typeof bridge?.getEmbeddingFromCache !== 'function') return finish('missing-cache');
    let reads = 0;
    const read = (text, dim, anchor) => {
      const state = value => {
        if (anchor) report.anchorCache[anchor] = value;
      };
      if (expired() || reads >= MAX_VECTORS) return null;
      reads++;
      try {
        // Exact key lookup only. A hit does NOT establish vector provenance:
        // the shared cache may contain aliases created by RAG fuzzy reuse.
        const raw = bridge.getEmbeddingFromCache(text);
        if (raw === null || raw === undefined) {
          report.cacheMisses++;
          state('miss');
          return null;
        }
        // The documented cache interface is synchronous. Contain accidentally
        // returned native rejected Promises without awaiting or generating data.
        if (raw instanceof Promise) {
          raw.catch(() => {});
          report.cacheInvalid++;
          state('invalid');
          return null;
        }
        const v = normalize(raw, dim);
        if (!v) {
          report.cacheInvalid++;
          state('invalid');
          return null;
        }
        report.cacheHits++;
        state('hit');
        return v;
      } catch {
        report.cacheErrors++;
        state('error');
        return null;
      }
    };
    const goal = read(goalText, undefined, 'goal');
    // Observe the payload independently even when goal is absent, within the
    // same time/read budgets. No candidate analysis unless BOTH are valid.
    const payload = read(payloadText, goal?.length, 'payload');
    if (expired()) return discard('time-budget-or-abort');
    if (!goal || !payload) return finish('anchor-cache-unavailable');

    for (let i = 0; i < messages.length; i++) {
      if (expired()) return discard('time-budget-or-abort');
      const m = messages[i], text = m.content;
      if (i >= immuneStart || m.role !== 'assistant' || typeof text !== 'string' ||
          m.tool_calls || m.function_call || m.tool_call_id ||
          PROTOCOL.test(text) || DETAIL.test(text) || text.length < 400) {
        report.protected++;
        continue;
      }
      report.eligible++;
      if (reads >= MAX_VECTORS) return discard('vector-budget');
      const v = read(text, goal.length);
      if (!v) continue;
      // Preserve association with either goal OR newest receipt, not just an average.
      const similarity = Math.max(dot(goal, v), dot(payload, v));
      if (similarity < report.threshold) {
        report.candidates.push({ index: i, chars: text.length,
          similarity: Number(similarity.toFixed(4)) });
        report.wouldStub++;
        // An estimate only; no actual stub, retrieval handle or token saving exists yet.
        report.potentialChars += Math.max(0, text.length - 240);
      }
    }
    if (expired()) return discard('time-budget-or-abort');
    report.status = 'analyzed';
    return finish('shadow-only');
  } catch {
    return discard('analysis-error');
  }
}

async function projectGravityStub(messages, options = {}) {
  // Hard release gate: even VCP_GRAVITY_ENABLED=true cannot send stubs in this build.
  let report;
  if (options.gravityHandoff != null && options.gravityRawToolResults !== undefined) {
    try {
      report = require('./gravityRequestShadow').analyzeGravityRequestShadow(messages, options);
    } catch {
      report = {version:'request-contract-shadow-v1',mode:'shadow',status:'skipped',
        reason:'request-shadow-error',scores:[],wouldStub:0,potentialChars:0,
        spaceVerified:false,foldEligible:false};
    }
  } else {
    report = analyzeGravityStub(messages, options);
  }
  // Separate failure boundary: missing metrics module cannot suppress observers
  // or affect the original-message return path. No global DEBUG_MODE required.
  try {
    if (process.env.VCP_GRAVITY_METRICS === 'true')
      require('./gravityShadowMetrics').recordGravityReport(report);
  } catch { /* Optional aggregate diagnostics fail open. */ }
  try {
    if (typeof options.onGravityReport === 'function') {
      const pending = options.onGravityReport(structuredClone(report));
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    }
    if (options.debugMode) console.log('[GravityStub:shadow] ' + JSON.stringify(report));
  } catch { /* Diagnostics must not break continuation. */ }
  return messages;
}

// Experimental request-local selection. NOT called by the production projector.
// Uses real RAG handoffs when supplied; synthetic fixtures only test mechanics.
// Original messages remain caller-owned. Every projection starts from originals.
function createGravityReceiptExperiment({threshold = 0.35} = {}) {
  const {createHash} = require('node:crypto');
  const {createGravityVectorReceiver} = require('./gravityVectorReceiver');
  const Parser = require('./toolCallParser');
  const hash = text => createHash('sha256').update(text).digest('hex');
  const marker = '<!-- VCP_TOOL_PAYLOAD -->';
  const records = new Map();
  let previous = [], closed = false;
  function close() { closed = true; records.clear(); previous = []; }
  function project(messages, options = {}) {
    const keep = reason => ({status:'skipped',reason,messages,scores:[],
      foldEligible:false,mode:'experimental',spaceVerified:false});
    try {
      if (closed || options.signal?.aborted) {
        close(); return keep('closed-or-aborted');
      }
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1 ||
          !Array.isArray(messages) || messages.length > 256 ||
          messages.some(m => !m || typeof m.content !== 'string') ||
          messages.reduce((n,m) => n+m.content.length,0) > MAX_CHARS)
        return keep('unsupported-input');
      // Source code and quoted examples may contain the marker literally.
      // Reject the experiment's actual whole-message stub envelope, not mentions.
      if (messages.some(m => m.role === 'user' &&
          /^<!-- VCP_TOOL_PAYLOAD -->\n\[VCP_GRAVITY_STUB experimental; originalIndex=\d+; callIndex=\d+; originalChars=\d+; not a summary; no production restore tool\]\n/.test(m.content)))
        return keep('projected-input');
      // Ignore changing system/RAG bodies, but invalidate on any other prefix drift.
      const fingerprints = messages.map(m => m.role === 'system' ? 'system' :
        hash(JSON.stringify(m)));
      if (previous.length > fingerprints.length ||
          previous.some((value,i) => value !== fingerprints[i])) records.clear();
      previous = fingerprints;
      const batches = [];
      for (let index=1; index<messages.length; index++) {
        const m = messages[index], call = messages[index-1];
        if (m.role !== 'user' || !m.content.startsWith(marker)) continue;
        const batch = {index,eligible:false};
        batches.push(batch);
        if (call.role !== 'assistant' ||
            [m,call].some(x => Object.keys(x).some(k =>
              !['role','content'].includes(k)))) continue;
        const calls = Parser.parse(call.content);
        if (!calls.length || calls.some(c => c.archery || c.markHistory)) continue;
        let parts;
        try { parts = JSON.parse(m.content.slice(marker.length).trim()); }
        catch { continue; }
        if (!Array.isArray(parts) || !parts.length || parts.some(p =>
            !p || p.type !== 'text' || typeof p.text !== 'string' ||
            Object.keys(p).some(k => !['type','text'].includes(k)))) continue;
        batch.eligible = true;
      }
      const last = messages.length-1, raw = options.gravityRawToolResults;
      if (typeof raw !== 'string' || !raw.trim() ||
          messages[last]?.content !== marker+'\n'+raw ||
          options.latestPayload !== messages[last].content ||
          !batches.some(b => b.index === last && b.eligible))
        return keep('unbound-or-transformed-receipt');
      // Revalidate against this invocation, not a caller-supplied status label.
      const receiver = createGravityVectorReceiver({
        userText:options.userText,toolResultsText:raw
      });
      if (!messages.some(m => m.role === 'user' &&
          m.content === options.userText && !m.content.startsWith(marker)))
        return keep('missing-user-binding');
      receiver.accept(options.gravityHandoff?.packet);
      const received = receiver.finish();
      if (received.status !== 'received-unverified') return keep('missing-bound-vectors');
      const goal = normalize(received.packet.goal.vector);
      const payload = normalize(received.packet.payload.vector,goal?.length);
      if (!goal || !payload) return keep('invalid-vectors');
      // Bound only to the receipt actually transmitted, never raw/truncated aliases.
      if (records.size < 64 || records.has(last))
        records.set(last,{fingerprint:fingerprints[last],vector:payload});
      // Acknowledgements carry execution status, not a new semantic focus.
      // Recognize only the observed exact envelope; errors/unknown outputs are
      // substantive. Never jump over a substantive receipt lacking a vector.
      const acknowledgementOnly = batch => {
        if (!batch.eligible) return false;
        const parts = JSON.parse(messages[batch.index].content.slice(marker.length).trim());
        let hasWriteConfirmation = false;
        const recognized = parts.every(p => {
          const text = p.text.trim();
          if (/^文件(?:编辑|写入)成功(?: \(with validation\))?$/.test(text)) {
            hasWriteConfirmation = true;
            return true;
          }
          const prefix = 'Code Validation Results:';
          if (!text.startsWith(prefix)) return false;
          try {
            const results = JSON.parse(text.slice(prefix.length).trim());
            return Array.isArray(results) && results.length > 0 &&
              results.every(r => r && r.severity === 'warning' &&
                r.message === 'File ignored because outside of base path.');
          } catch { return false; }
        });
        return recognized && hasWriteConfirmation;
      };
      let attention = payload;
      const latestBatch = batches[batches.length-1];
      if (acknowledgementOnly(latestBatch)) {
        const substantive = batches.slice(0,-1).reverse()
          .find(b => !acknowledgementOnly(b));
        const prior = substantive && records.get(substantive.index);
        if (!prior || prior.fingerprint !== fingerprints[substantive.index] ||
            prior.vector.length !== goal.length)
          return keep('missing-substantive-attention');
        attention = prior.vector;
      }
      const recent = new Set(batches.slice(-2).map(b => b.index));
      const output = messages.map(m => ({...m})), scores = [];
      for (const b of batches) {
        if (!b.eligible || recent.has(b.index)) continue;
        const record = records.get(b.index), text = messages[b.index].content;
        if (!record || record.fingerprint !== fingerprints[b.index] ||
            record.vector.length !== goal.length || text.length < 2000) continue;
        const similarity = Math.max(dot(goal,record.vector),dot(attention,record.vector));
        const selected = similarity < threshold;
        scores.push({index:b.index,similarity,selected});
        if (!selected) continue;
        const stub = marker+'\n[VCP_GRAVITY_STUB experimental; originalIndex='+
          b.index+'; callIndex='+(b.index-1)+'; originalChars='+text.length+
          '; not a summary; no production restore tool]\n'+
          text.slice(marker.length,marker.length+600)+'\n[... omitted ...]\n'+text.slice(-400);
        if (stub.length < text.length) output[b.index].content = stub;
      }
      if (options.signal?.aborted) { close(); return keep('aborted'); }
      return {status:'projected',mode:'experimental',messages:output,scores,
        threshold,spaceVerified:false,foldEligible:false,
        unit:'serialized-messages-json-utf16-code-units',
        savedChars:JSON.stringify(messages).length-JSON.stringify(output).length};
    } catch {
      records.clear(); previous = [];
      return keep('experiment-error');
    }
  }
  return Object.freeze({project,close});
}

module.exports = { projectGravityStub, analyzeGravityStub, createGravityReceiptExperiment };