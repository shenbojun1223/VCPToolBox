'use strict';
const {createHash} = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');

// Exact live cache lookup only. No fuzzy search, generation, text-index updates,
// folding-store access, or promotion of legacy metadata to trusted evidence.
function readGravityCacheRecord(cacheManager, text) {
  try {
    if (typeof text !== 'string' || !text.trim() || text.length > 1000000 ||
        typeof cacheManager?.getWithMetadata !== 'function') return null;
    const normalized = text.trim();
    const entry = cacheManager.getWithMetadata('embedding',
      cacheManager.generateKey({text:normalized}));
    const raw = entry?.value, p = entry?.metadata;
    if ((!Array.isArray(raw) && !(raw instanceof Float32Array) &&
         !(raw instanceof Float64Array)) || !raw.length || raw.length > 4096)
      return null;
    const vector = Array.from(raw);
    let energy = 0;
    for (const n of vector) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return null;
      energy += n*n;
    }
    const textHash = hash(normalized);
    if (!Number.isFinite(energy) || energy <= 1e-20 ||
        p?.schema !== 'embedding-generation-metadata-v1' ||
        !['generated-single','generated-chunk-merge'].includes(p.source) ||
        p.textHash !== textHash || p.vectorHash !== hash(JSON.stringify(vector)) ||
        p.dimension !== vector.length || p.fullCoverage !== true ||
        p.modelDeclarationsConsistent !== true) return null;
    return {textHash,vector,provenance:{
      source:p.source,textHash,vectorHash:p.vectorHash,dimension:p.dimension,
      chunkCount:p.chunkCount,usableChunks:p.usableChunks,fullCoverage:p.fullCoverage,
      modelDeclarationsConsistent:p.modelDeclarationsConsistent,
      requestedModel:p.requestedModel,responseModel:p.responseModel,
      spaceVerified:false,foldEligible:false
    }};
  } catch { return null; }
}
module.exports = {readGravityCacheRecord};