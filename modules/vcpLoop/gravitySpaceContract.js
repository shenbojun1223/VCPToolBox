'use strict';
const {createHash} = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
const name = value => typeof value === 'string' &&
  value.trim() === value && value.length > 0 && value.length <= 256;

// Pure admission gate, NOT a provider discovery or attestation mechanism.
// resolveEvidence must be supplied by trusted server code, never messages/RAG.
// Evidence must be bound at generation time to this exact text/vector pair.
// Matching model names, dimensions, endpoints, or caller spaceVerified flags
// are deliberately insufficient. No resolver is installed by this module.
function assessGravitySpace(records, {resolveEvidence, isExpired = () => false} = {}) {
  const reject = reason => ({
    status:'unavailable', reason, spaceVerified:false, foldEligible:false
  });
  try {
    if (isExpired()) return reject('time-budget-or-abort');
    if (!Array.isArray(records) || records.length < 2 || records.length > 64)
      return reject('record-budget');
    if (typeof resolveEvidence !== 'function') return reject('missing-space-evidence');
    const checked = [];
    for (const record of records) {
      if (isExpired()) return reject('time-budget-or-abort');
      const vector = record?.vector, p = record?.provenance;
      if ((!Array.isArray(vector) && !(vector instanceof Float32Array) &&
          !(vector instanceof Float64Array)) || vector.length < 1 || vector.length > 4096)
        return reject('invalid-vector');
      let energy = 0;
      for (const n of vector) {
        if (typeof n !== 'number' || !Number.isFinite(n)) return reject('invalid-vector');
        energy += n * n;
      }
      if (!Number.isFinite(energy) || energy <= 1e-20) return reject('invalid-vector');
      if (typeof record.textHash !== 'string' || !HASH.test(record.textHash) ||
          !p || p.textHash !== record.textHash ||
          p.vectorHash !== hash(JSON.stringify(Array.from(vector))) ||
          p.dimension !== vector.length) return reject('binding-mismatch');
      if (!['generated-single','generated-chunk-merge'].includes(p.source) ||
          p.fullCoverage !== true || !Number.isSafeInteger(p.chunkCount) ||
          p.chunkCount < 1 || p.chunkCount > 1000000 ||
          p.usableChunks !== p.chunkCount ||
          (p.source === 'generated-single' && p.chunkCount !== 1) ||
          (p.source === 'generated-chunk-merge' && p.chunkCount < 2) ||
          p.modelDeclarationsConsistent !== true ||
          !name(p.requestedModel) || !name(p.responseModel))
        return reject('incomplete-generation');
      // Copy scalars before calling external code; no vectors are lent.
      checked.push({
        textHash:record.textHash, vectorHash:p.vectorHash, dimension:vector.length,
        source:p.source, chunkCount:p.chunkCount,
        requestedModel:p.requestedModel, responseModel:p.responseModel
      });
    }
    let identity = null;
    for (const binding of checked) {
      if (isExpired()) return reject('time-budget-or-abort');
      const e = resolveEvidence(Object.freeze({...binding}));
      // Contain rejected promises even when the synchronous call exhausted
      // the deadline. Cancellation cannot preempt the resolver itself.
      if (e && typeof e.then === 'function') {
        Promise.resolve(e).catch(() => {});
        return reject(isExpired() ? 'time-budget-or-abort' : 'async-space-evidence');
      }
      if (isExpired()) return reject('time-budget-or-abort');
      if (!e || e.schema !== 'gravity-space-evidence-v1' ||
          e.textHash !== binding.textHash || e.vectorHash !== binding.vectorHash ||
          e.dimension !== binding.dimension ||
          e.requestedModel !== binding.requestedModel ||
          e.responseModel !== binding.responseModel ||
          e.source !== binding.source || e.chunkCount !== binding.chunkCount ||
          e.allChunksAttested !== true ||
          !name(e.spaceId) || !name(e.encoderRevision) ||
          !name(e.encodingProfile) || !name(e.compositionProfile))
        return reject('invalid-space-evidence');
      // Profiles must explicitly describe task/prefix/truncation/projection and
      // composition semantics. A raw+chunk-mean mixture is not assumed compatible.
      const key = JSON.stringify([
        e.spaceId,e.encoderRevision,e.encodingProfile,e.compositionProfile,e.dimension
      ]);
      if (identity !== null && key !== identity) return reject('space-mismatch');
      identity = key;
    }
    // Contract match is conditional on resolver trust, not empirical verification.
    // Do not leak deployment IDs, hashes, model names, or vectors into reports.
    return {
      status:'compatible', reason:'trusted-contract-match',
      evidenceBasis:'server-resolver', count:checked.length,
      dimension:checked[0].dimension, spaceVerified:false, foldEligible:false
    };
  } catch {
    return reject('space-contract-error');
  }
}
module.exports = {assessGravitySpace};