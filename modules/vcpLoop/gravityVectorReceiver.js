'use strict';
const { createHash } = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');
const HASH = /^[a-f0-9]{64}$/;

// Internal correlation only, never authentication. One receiver per tool round.
// No global state, network, history mutation, or promotion of unknown provenance.
function createGravityVectorReceiver({ userText, toolResultsText } = {}) {
  let closed = false, rejected = false, packet = null, accepted = 0, attempts = 0;
  const validText = text => typeof text === 'string' && text.trim().length > 0 &&
    text.length <= 1000000;
  const usable = validText(userText) && validText(toolResultsText);
  const bindings = usable ? {
    userRawHash:hash(userText), toolResultsRawHash:hash(toolResultsText)
  } : null;
  function copyVector(value) {
    if (!Array.isArray(value) || !value.length || value.length > 4096) return null;
    let energy = 0;
    for (const n of value) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return null;
      energy += n * n;
    }
    return Number.isFinite(energy) && energy > 1e-20 ? value.slice() : null;
  }
  function reject() { rejected = true; packet = null; }
  function accept(value) {
    if (closed || rejected || !usable) return;
    try {
      if (++attempts > 16) { reject(); return; }
      if (!value || value.version !== 'rag-refresh-vectors-v1' ||
          value.source !== 'current-refresh' || value.provenance !== 'unknown' ||
          value.foldEligible !== false ||
          value.bindings?.userRawHash !== bindings.userRawHash ||
          value.bindings?.toolResultsRawHash !== bindings.toolResultsRawHash ||
          value.goal?.transform !== 'sanitizeForEmbedding:user' ||
          value.payload?.transform !== 'refreshRagBlock:tool-cleanup' ||
          typeof value.goal.textHash !== 'string' || !HASH.test(value.goal.textHash) ||
          typeof value.payload.textHash !== 'string' || !HASH.test(value.payload.textHash)) {
        reject(); return;
      }
      const goal = copyVector(value.goal.vector);
      const payload = copyVector(value.payload.vector);
      if (!goal || !payload || goal.length !== payload.length) { reject(); return; }
      const copySource = (description, textHash, vector) => {
        const unknown = {source:'unknown',spaceVerified:false,foldEligible:false};
        try {
          if (!description ||
              !['generated-single','generated-chunk-merge','fuzzy-reuse'].includes(description.source) ||
              description.textHash !== textHash ||
              description.vectorHash !== hash(JSON.stringify(vector)) ||
              description.dimension !== vector.length) return unknown;
          const count = n => Number.isSafeInteger(n) && n >= 0 && n <= 1000000 ? n : null;
          const model = name => typeof name === 'string' &&
            name.trim().length > 0 && name.length <= 256 ? name : null;
          const fuzzy = description.source === 'fuzzy-reuse';
          const chunkCount = count(description.chunkCount);
          const usableChunks = count(description.usableChunks);
          const fullCoverage = !fuzzy && description.fullCoverage === true &&
            chunkCount !== null && chunkCount > 0 && usableChunks === chunkCount;
          const requestedModel = fuzzy ? null : model(description.requestedModel);
          const responseModel = fuzzy ? null : model(description.responseModel);
          // Acquisition route (generated/cache/pending) is deliberately omitted:
          // it can differ across repeated reads of the same generation evidence.
          return {
            source:description.source, textHash, vectorHash:description.vectorHash,
            dimension:vector.length, chunkCount, usableChunks, fullCoverage,
            modelDeclarationsConsistent:fullCoverage &&
              description.modelDeclarationsConsistent === true &&
              requestedModel !== null && responseModel !== null,
            requestedModel,responseModel,spaceVerified:false,foldEligible:false
          };
        } catch { return unknown; }
      };
      const candidate = {
        version:'rag-refresh-vectors-v1', source:'current-refresh',
        provenance:'unknown', foldEligible:false, bindings:{...bindings},
        goal:{
          vector:goal,textHash:value.goal.textHash,transform:value.goal.transform,
          provenance:copySource(value.goal.provenance,value.goal.textHash,goal)
        },
        payload:{
          vector:payload,textHash:value.payload.textHash,transform:value.payload.transform,
          provenance:copySource(value.payload.provenance,value.payload.textHash,payload)
        }
      };
      // Conflicting repeated diary refreshes must not become last-writer-wins.
      if (packet && JSON.stringify(packet) !== JSON.stringify(candidate)) {
        reject(); return;
      }
      packet = candidate;
      accepted++;
    } catch { reject(); }
  }
  function finish() {
    if (closed) return {status:'closed', packet:null};
    closed = true;
    const result = packet;
    packet = null;
    return {
      status:!usable ? 'unavailable' : rejected ? 'rejected' :
        result ? 'received-unverified' : 'not-received',
      accepted, packet:result
    };
  }
  return Object.freeze({accept, finish});
}
module.exports = { createGravityVectorReceiver };