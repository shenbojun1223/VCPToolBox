'use strict';
// Offline comparison only. Existing native projection and public cosine.
// No network, database, production configuration, threshold tuning or folding.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {VexusIndex} = require('../rust-vexus-lite');
const {cosineSimilarity} = require('../EmbeddingUtils');
const dir = path.join(__dirname,'gravity-real-selection-20260908');
const manifest = JSON.parse(fs.readFileSync(path.join(dir,'started.json')));
const replay = JSON.parse(fs.readFileSync(path.join(dir,'replay-result-v2.json')));
const vectors = new Map(manifest.inputs.map(p=>{
  const record = JSON.parse(fs.readFileSync(path.join(dir,'vector-'+p.index+'.json')));
  assert.equal(record.textHash,p.textHash);
  return [p.index,record.vector];
}));
const goalIndex = manifest.inputs.find(p=>p.kind==='goal').index;
const goal = vectors.get(goalIndex);
const dimension = goal.length;
const native = new VexusIndex(dimension,16);
const energy = v=>v.reduce((n,x)=>n+x*x,0);
const residuals = new Map();
for(const [index,vector] of vectors) {
  assert.equal(vector.length,dimension);
  assert(vector.every(Number.isFinite) && energy(vector)>0);
  const input = new Float32Array(vector);
  const result = native.computeOrthogonalProjection(
    input,new Float32Array(goal),1);
  const {projection,residual} = result;
  assert(Array.isArray(projection) && Array.isArray(residual));
  assert.equal(residual.length,dimension);
  assert.equal(projection.length,dimension);
  assert([...projection,...residual].every(Number.isFinite));
  const originalEnergy = energy(input);
  let reconstruction = 0, orthogonality = 0;
  for(let i=0;i<dimension;i++) {
    reconstruction += (projection[i]+residual[i]-input[i])**2;
    orthogonality += projection[i]*residual[i];
  }
  assert(reconstruction/originalEnergy<1e-8);
  assert(Math.abs(orthogonality)/originalEnergy<1e-5);
  assert(Math.abs(energy(projection)+energy(residual)-originalEnergy)/originalEnergy<1e-5);
  residuals.set(index,{vector:residual,ratio:energy(residual)/originalEnergy});
}
for(const row of replay.rows) {
  const current = residuals.get(row.latestReceipt);
  console.log(JSON.stringify({
    round:row.round,latestReceipt:row.latestReceipt,
    scores:row.scores.map(s=>{
      const old = residuals.get(s.index);
      return {
        index:s.index,
        originalPayloadCosine:cosineSimilarity(
          vectors.get(s.index),vectors.get(row.latestReceipt)),
        goalRemovedCosine:old.ratio>1e-6 && current.ratio>1e-6
          ? cosineSimilarity(old.vector,current.vector) : null,
        residualEnergyRatio:old.ratio
      };
    }),
    selectionApplied:false
  }));
}
console.log(JSON.stringify({
  backend:'VexusIndex.computeOrthogonalProjection',
  cosineBackend:'EmbeddingUtils.cosineSimilarity',
  nativeDecompositionsChecked:residuals.size,
  newEmbeddingRequests:0,actualSavedChars:0,
  caveat:'Goal includes original OneRing notification; removing this axis is not proof of task relevance or safe omission.'
}));