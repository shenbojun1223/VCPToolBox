'use strict';
const {performance} = require('node:perf_hooks');
const {assessGravitySpace} = require('./gravitySpaceContract');
const {createGravityNativeGeometry} = require('./gravityNativeGeometry');

// Isolated scoring boundary. Not installed in either production handler.
// Inputs must already be selected/bound to the current request by the caller.
// This module neither authorizes candidate selection nor creates stubs.
// resolveEvidence and nativeIndex are trusted server dependencies, not RAG data.
function scoreGravityVerifiedShadow({goal,payload,candidates,resolveEvidence,
  nativeIndex,signal} = {}) {
  const start = performance.now();
  const unavailable = reason => ({
    status:'unavailable',reason,mode:'shadow',scores:[],
    spaceVerified:false,foldEligible:false
  });
  const expired = () => signal?.aborted || performance.now() - start > 15;
  try {
    if (expired()) return unavailable('time-budget-or-abort');
    if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 62)
      return unavailable('candidate-budget');
    const indices = new Set();
    for (const c of candidates) {
      if (!Number.isInteger(c?.index) || c.index < 0 || c.index > 255 ||
          indices.has(c.index)) return unavailable('invalid-candidate-index');
      indices.add(c.index);
    }
    // Copy BEFORE consulting a resolver, so later mutations cannot substitute
    // different vectors between provenance validation and native measurement.
    const copy = r => ({
      textHash:r?.textHash,
      vector:(Array.isArray(r?.vector) || r?.vector instanceof Float32Array ||
        r?.vector instanceof Float64Array) && r.vector.length <= 4096
        ? Array.from(r.vector) : null,
      provenance:r?.provenance ? {...r.provenance} : null
    });
    const records = [copy(goal),copy(payload),...candidates.map(copy)];
    const ids = candidates.map(c => c.index);
    const contract = assessGravitySpace(records,{resolveEvidence,isExpired:expired});
    if (contract.status !== 'compatible') return unavailable(contract.reason);
    if (expired()) return unavailable('time-budget-or-abort');
    const geometry = createGravityNativeGeometry(nativeIndex,contract.dimension);
    const unit = v => {
      const scale = Math.sqrt(v.reduce((sum,n) => sum+n*n,0));
      return v.map(n => n/scale);
    };
    const goalUnit = unit(records[0].vector), payloadUnit = unit(records[1].vector);
    const cosine = (a,b) => Math.max(-1,Math.min(1,
      a.reduce((sum,n,i) => sum+n*b[i],0)));
    const scores = [];
    for (let i = 2; i < records.length; i++) {
      if (expired()) return unavailable('time-budget-or-abort');
      const target = unit(records[i].vector);
      const result = geometry.measureResidual(target,[goalUnit,payloadUnit],{signal});
      if (result.status !== 'measured') return unavailable(result.reason);
      // Signed association is retained: opposite vectors can have zero residual.
      // Neither quantity is a safe-to-discard predicate.
      scores.push({
        index:ids[i-2],
        goalCosine:cosine(target,goalUnit),
        payloadCosine:cosine(target,payloadUnit),
        residualEnergyRatio:result.residualEnergyRatio,
        foldEligible:false
      });
    }
    if (expired()) return unavailable('time-budget-or-abort');
    return {
      status:'measured',reason:'conditional-contract-shadow',mode:'shadow',
      backend:'vexus-computeOrthogonalProjection',scores,
      spaceVerified:false,foldEligible:false
    };
  } catch {
    return unavailable('shadow-scoring-error');
  }
}
module.exports = {scoreGravityVerifiedShadow};