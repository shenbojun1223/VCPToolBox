'use strict';

// Thin adapter over the EXISTING VexusIndex projection implementation.
// The caller lends an existing index of the same dimension. No index creation,
// database access, embeddings, JS projection fallback, or folding decisions.
function createGravityNativeGeometry(index, dimension) {
  if (!Number.isInteger(dimension) || dimension < 1 || dimension > 4096)
    throw new RangeError('Invalid geometry dimension');

  function vectorCopy(input) {
    if ((!Array.isArray(input) && !(input instanceof Float32Array) &&
         !(input instanceof Float64Array)) || input.length !== dimension) return null;
    const output = new Float32Array(dimension);
    let energy = 0;
    for (let i = 0; i < dimension; i++) {
      if (typeof input[i] !== 'number' || !Number.isFinite(input[i])) return null;
      output[i] = input[i];
      if (!Number.isFinite(output[i])) return null;
      energy += output[i] * output[i];
    }
    return energy > 1e-20 && Number.isFinite(energy) ? output : null;
  }
  function energyOf(input) {
    let energy = 0;
    for (const value of input) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return NaN;
      energy += value * value;
    }
    return energy;
  }
  function unavailable(reason) {
    return {status:'unavailable', reason, foldEligible:false};
  }
  function measureResidual(target, contextBasis, options = {}) {
    try {
      if (options.signal?.aborted) return unavailable('aborted');
      if (!index || typeof index.computeOrthogonalProjection !== 'function')
        return unavailable('native-unavailable');
      if (!Array.isArray(contextBasis) || contextBasis.length < 1 ||
          contextBasis.length > 8) return unavailable('basis-budget');
      const query = vectorCopy(target);
      if (!query) return unavailable('invalid-target');
      const flat = new Float32Array(dimension * contextBasis.length);
      for (let i = 0; i < contextBasis.length; i++) {
        const basis = vectorCopy(contextBasis[i]);
        if (!basis) return unavailable('invalid-basis');
        flat.set(basis, i * dimension);
      }
      const originalEnergy = energyOf(query);
      // The native operation is synchronous: cancellation cannot preempt it.
      const result = index.computeOrthogonalProjection(query, flat, contextBasis.length);
      if (options.signal?.aborted) return unavailable('aborted');
      const projection = result?.projection, residual = result?.residual;
      if (!Array.isArray(projection) || !Array.isArray(residual) ||
          projection.length !== dimension || residual.length !== dimension)
        return unavailable('invalid-native-output');
      const projectedEnergy = energyOf(projection), residualEnergy = energyOf(residual);
      if (!Number.isFinite(projectedEnergy) || !Number.isFinite(residualEnergy))
        return unavailable('invalid-native-output');

      // Validate returned decomposition, not the semantic safety of omission.
      let reconstructionError = 0, innerProduct = 0;
      for (let i = 0; i < dimension; i++) {
        const delta = projection[i] + residual[i] - query[i];
        reconstructionError += delta * delta;
        innerProduct += projection[i] * residual[i];
      }
      const relativeEnergyError =
        Math.abs(projectedEnergy + residualEnergy - originalEnergy) / originalEnergy;
      if (reconstructionError / originalEnergy > 1e-8 ||
          Math.abs(innerProduct) / originalEnergy > 1e-5 ||
          relativeEnergyError > 1e-5)
        return unavailable('invalid-decomposition');

      return {
        status:'measured',
        backend:'vexus-computeOrthogonalProjection',
        basisCount:contextBasis.length,
        residualEnergyRatio:Math.max(0, Math.min(1, residualEnergy / originalEnergy)),
        explainedEnergyRatio:Math.max(0, Math.min(1, projectedEnergy / originalEnergy)),
        foldEligible:false
      };
    } catch {
      return unavailable('native-error');
    }
  }
  return Object.freeze({measureResidual});
}

module.exports = {createGravityNativeGeometry};