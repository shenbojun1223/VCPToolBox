'use strict';
const {performance} = require('node:perf_hooks');
const {createHash} = require('node:crypto');
const {createGravityVectorReceiver} = require('./gravityVectorReceiver');
const {scoreGravityVerifiedShadow} = require('./gravityVerifiedShadow');
const hash = text => createHash('sha256').update(text).digest('hex');
const PROTOCOL = /VCP|TOOL_REQUEST|END_TOOL_REQUEST|Flowlock::|OneRing|系统提示|元思维|元思考|上下文语义折叠|本层摘要/;
const DETAIL = /[0-9`{}]|https?:|file:|[\\/]|\b[A-Z][A-Z_]{2,}\b|端口|路径|配置|密码|密钥|必须|禁止|不得|务必|截止|约定|决策|结论|注意|风险|不能|不要|不应|\b(?:must|never|do not)\b/i;

// Request selection and correlation, not authentication or folding authority.
// Dependencies are internal server options, NEVER read from messages or packets.
// No resolver/native index is manufactured. Missing evidence keeps all originals.
// Initially string-content requests only; multimodal requests fail open unchanged.
function analyzeGravityRequestShadow(messages, options = {}) {
  const start = performance.now();
  const report = {
    version:'request-contract-shadow-v1',mode:'shadow',status:'skipped',reason:'',
    totalChars:0,eligible:0,protected:0,cacheHits:0,cacheMisses:0,
    wouldStub:0,potentialChars:0,candidates:[],scores:[],
    spaceVerified:false,foldEligible:false,elapsedMs:0
  };
  const expired = () => options.signal?.aborted || performance.now()-start > 15;
  const finish = reason => {
    report.reason = reason;
    report.elapsedMs = Number((performance.now()-start).toFixed(3));
    return report;
  };
  const discard = reason => {
    report.status = 'skipped'; report.scores = [];
    return finish(reason);
  };
  try {
    if (expired()) return finish('time-budget-or-abort');
    if (!Array.isArray(messages) || messages.length < 7 || messages.length > 256)
      return finish('message-budget');
    if (!Number.isInteger(options.recursionDepth) || options.recursionDepth < 0)
      return finish('not-tool-loop');
    for (const m of messages) {
      if (!m || !['system','user','assistant','tool'].includes(m.role) ||
          typeof m.content !== 'string') return finish('unsupported-message');
      report.totalChars += m.content.length;
      if (report.totalChars > 1000000) return finish('character-budget');
    }
    if (report.totalChars < 32000) return finish('below-watermark');
    // Reuse the handler/RAG definition of a real user, including notification stripping.
    const {findLastRealUserMessage} = require('../messageProcessor');
    const anchor = findLastRealUserMessage(messages);
    if (anchor.index < 0) return finish('missing-user-anchor');
    const previous = findLastRealUserMessage(messages.slice(0,anchor.index));
    const immuneStart = Math.min(previous.index < 0 ? anchor.index : previous.index,
      messages.length-4);
    const last = messages[messages.length-1];
    if (typeof options.latestPayload !== 'string' ||
        !options.latestPayload.startsWith('<!-- VCP_TOOL_PAYLOAD -->') ||
        anchor.index >= messages.length-1 ||
        !['user','tool'].includes(last.role) || last.content !== options.latestPayload)
      return finish('missing-payload-anchor');
    const raw = options.gravityRawToolResults;
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 1000000)
      return finish('missing-raw-payload-binding');
    const handoff = options.gravityHandoff;
    if (handoff?.status !== 'received-unverified' || !handoff.packet)
      return finish('handoff-unverified');
    // Validate again at consumption, against CURRENT request and raw tool result.
    // latestPayload may be truncated; it is bound separately to the final message.
    const receiver = createGravityVectorReceiver({
      userText:anchor.rawContent,toolResultsText:raw
    });
    receiver.accept(handoff.packet);
    const received = receiver.finish();
    if (received.status !== 'received-unverified') return finish('handoff-binding-mismatch');
    const packet = received.packet;
    const dependencies = options.gravityShadowDependencies;
    if (typeof dependencies?.resolveEvidence !== 'function')
      return finish('missing-space-evidence');
    if (expired()) return discard('time-budget-or-abort');
    const rag = options.pluginManager?.messagePreprocessors?.get?.('RAGDiaryPlugin');
    const bridge = options.contextBridge ||
      (typeof rag?.getContextBridge === 'function' ? rag.getContextBridge() : null);
    if (typeof bridge?.getEmbeddingRecordFromCache !== 'function')
      return finish('missing-provenance-cache');
    const candidates = [];
    let reads = 0;
    for (let index=0; index<messages.length; index++) {
      if (expired()) return discard('time-budget-or-abort');
      const m = messages[index], text = m.content;
      if (index >= immuneStart || m.role !== 'assistant' ||
          m.tool_calls || m.function_call || m.tool_call_id ||
          PROTOCOL.test(text) || DETAIL.test(text) || text.length < 400) {
        report.protected++; continue;
      }
      report.eligible++;
      if (++reads > 62) return discard('vector-budget');
      const record = bridge.getEmbeddingRecordFromCache(text);
      if (record && typeof record.then === 'function') {
        Promise.resolve(record).catch(()=>{});
        return discard('async-provenance-cache');
      }
      if (expired()) return discard('time-budget-or-abort');
      if (!record) { report.cacheMisses++; continue; }
      if (record.textHash !== hash(text.trim()))
        return discard('candidate-binding-mismatch');
      // Detach each cache record before any later cache/resolver call.
      candidates.push({...structuredClone(record),index});
      report.cacheHits++;
    }
    if (!candidates.length) return finish('no-cached-candidates');
    const result = scoreGravityVerifiedShadow({
      goal:packet.goal,payload:packet.payload,candidates,
      resolveEvidence:dependencies.resolveEvidence,
      nativeIndex:dependencies.nativeIndex,signal:options.signal
    });
    // One shared outer deadline, including selection/cache work and native scoring.
    if (expired()) return discard('time-budget-or-abort');
    if (result.status !== 'measured') return discard(result.reason);
    report.status = 'analyzed';
    report.scores = result.scores;
    return finish('conditional-contract-shadow');
  } catch { return discard('request-shadow-error'); }
}
module.exports = {analyzeGravityRequestShadow};