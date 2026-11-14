'use strict';

// Offline evaluator only. No server, KBM, network client or production singleton.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const ROOT = path.resolve(__dirname, '..');
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const labelsBytes = fs.readFileSync(path.join(ROOT, 'tests/fixtures/pchuf-relevance-labels-20261107.json'));
const fixture = JSON.parse(labelsBytes);
const base = path.join(ROOT, 'operations/pchuf-shadow-20261107-02');
const reportBytes = fs.readFileSync(path.join(base, 'report.json'));
const report = JSON.parse(reportBytes);
const source = fs.readFileSync(path.join(ROOT, 'Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js'), 'utf8');
assert.equal(sha(reportBytes), fixture.reportSha256);
assert.equal(sha(source), fixture.sourceSha256);
assert.equal(report.status, 'completed');
assert.equal(report.factIntegrityVerified, true);
assert.deepEqual(report.calls, { embedding: 1, jev: 2 });
const records = new Map(fixture.candidates.map(x => [x.id, x]));
assert.equal(records.size, fixture.candidates.length);
const union = [...new Set(report.cases.flatMap(c => c.stages.beforeTruncate.map(x => x.chunkId)))].sort((a, b) => a - b);
assert.deepEqual([...records.keys()].sort((a, b) => a - b), union);

const anchor = 'finalResultsForBroadcast = finalResultsForBroadcast.filter(r => {';
const start = source.indexOf(anchor);
assert(start >= 0 && source.indexOf(anchor, start + 1) < 0);
const end = source.indexOf('});', start) + 3;
assert(end > start);
const filter = vm.runInNewContext(
    '(function(finalResultsForBroadcast,truncateThreshold){' +
    source.slice(start, end) + ';return finalResultsForBroadcast;})', {}, { timeout: 1000 });
const fa = source.indexOf('    _fuseIndependentRankings(');
const fb = source.indexOf('    async _rerankRAGCandidatesWithRiverMemo(', fa);
assert(fa >= 0 && fb > fa);
const fuser = vm.runInNewContext('({' + source.slice(fa, fb) + '})', {}, { timeout: 1000 });
const ids = rows => Array.from(rows, x => x.chunkId);
const clean = row => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null));
const actualFilter = rows => Array.from(filter(rows, 0.35));
const meta = new Map();
const db = new Database(path.join(base, 'store/knowledge_base.sqlite'), {
    readonly: true, fileMustExist: true
});
try {
    const get = db.prepare('SELECT c.id,f.path,c.content FROM chunks c JOIN files f ON f.id=c.file_id WHERE c.id=?');
    for (const id of union) {
        const row = get.get(id);
        assert(row && typeof row.content === 'string');
        assert.equal(sha(row.content), records.get(id).sha256, 'SNAPSHOT_CONTENT_DRIFT_' + id);
        meta.set(id, { path: row.path, utf16Units: row.content.length,
            utf8Bytes: Buffer.byteLength(row.content) });
    }
} finally {
    db.close();
}
const category = (id, name) => {
    const result = records.get(id)?.labels[name];
    assert(Object.hasOwn(fixture.categories, result), 'UNKNOWN_LABEL');
    return result;
};
const strictUseful = x => x === 'D' || x === 'B';
const broadUseful = x => strictUseful(x) || x === 'T';
function scoredCase(name) {
    const c = report.cases.find(x => x.label === name);
    if (!c) throw new Error('UNSCORED_QUERY_NO_REUSABLE_SCORES');
    assert.equal(c.query, fixture.originalCases[name].query);
    return c;
}
function stats(rows, name, pool) {
    const counts = { D: 0, B: 0, T: 0, N: 0, W: 0 };
    let utf16Units = 0, utf8Bytes = 0, timeUtf16Units = 0;
    for (const row of rows) {
        counts[category(row.chunkId, name)]++;
        const size = meta.get(row.chunkId);
        utf16Units += size.utf16Units;
        utf8Bytes += size.utf8Bytes;
        if (row.source === 'time') timeUtf16Units += size.utf16Units;
    }
    const strictPoolCount = pool.filter(x => strictUseful(category(x.chunkId, name))).length;
    const broadPoolCount = pool.filter(x => broadUseful(category(x.chunkId, name))).length;
    return {
        ids: ids(rows), count: rows.length, categories: counts,
        strictUseful: counts.D + counts.B,
        strictUsefulInPool: strictPoolCount,
        broadUseful: counts.D + counts.B + counts.T,
        broadUsefulInPool: broadPoolCount,
        strictCoverageWithinSavedPool: strictPoolCount ? (counts.D + counts.B) / strictPoolCount : null,
        utf16Units, utf8Bytes, timeUtf16Units,
        timeShareOfRawUtf16: utf16Units ? timeUtf16Units / utf16Units : null
    };
}
const cases = report.cases.map(entry => {
    const c = scoredCase(entry.label), name = c.label, pool = c.stages.beforeTruncate;
    for (const row of pool) assert.equal(row.path, meta.get(row.chunkId).path);
    const legacy = actualFilter(pool);
    assert.deepEqual(ids(legacy), ids(c.stages.final));
    const fused = Array.from(fuser._fuseIndependentRankings(
        c.stages.riverReturned.map(clean), c.stages.jevReturned.map(clean), c.alpha, c.dynamicK));
    assert.deepEqual(ids(fused), ids(c.stages.fusedTopK));
    fused.forEach((x, i) => assert(Math.abs(x.rrf_score - c.stages.fusedTopK[i].rrf_score) < 1e-12));
    const retained = pool.filter(x => Number.isFinite(x.score) && x.score >= 0.35);
    const reference = pool.filter(x => strictUseful(category(x.chunkId, name)));
    return {
        label: name,
        queryCompleteness: name === 'short-question' ? 'incomplete_exploratory' : 'complete',
        policies: {
            legacy035: stats(legacy, name, pool),
            retainedScore035: stats(retained, name, pool),
            noTerminalFilter: stats(pool, name, pool),
            labelReferenceNotAlgorithm: stats(reference, name, pool)
        },
        retainedToLegacyRawSizeRatio:
            stats(retained, name, pool).utf16Units / stats(legacy, name, pool).utf16Units,
        usefulLabeledUnionRowsAbsentFromPool: union.filter(id =>
            strictUseful(category(id, name)) && !pool.some(x => x.chunkId === id))
    };
});

// Mechanism-only synthetic controls. These are not real query evaluations.
assert.equal(actualFilter([
    { rerank_score: 0.34, score: 0.8 },
    { rerank_score: 0.33, score: 0.8 },
    { rerank_score: 0.33, score: 0.8 }
]).length, 0);
assert.equal(actualFilter([
    { rerank_score: 0.9, score: 0.1 },
    { rerank_score: 0.1, score: 0.1 }
]).length, 1);
assert.equal(actualFilter([{ rerank_score: null, score: 0.6, source: 'time' }]).length, 1);
for (const control of fixture.unscoredControls) {
    for (const id of control.positiveIds) assert(records.has(id));
    assert.throws(() => scoredCase(control.id), /UNSCORED_QUERY_NO_REUSABLE_SCORES/);
}
const full = cases.find(x => x.label === 'full-question');
assert.equal(full.policies.legacy035.strictUseful, 0);
assert.equal(full.policies.legacy035.broadUseful, 1);
assert.equal(full.policies.retainedScore035.strictUseful, 2);
assert.equal(full.policies.retainedScore035.categories.W, 1);
assert.deepEqual(full.policies.labelReferenceNotAlgorithm.ids, [1191, 1242]);

console.log(JSON.stringify({
    schema: 'pchuf-labelled-pool-assessment-v1',
    reportSha256: sha(reportBytes), labelsSha256: sha(labelsBytes), sourceSha256: sha(source),
    annotationStatus: fixture.annotationStatus,
    snapshotContentHashesVerified: union.length,
    productionFusionAndFilterMatchedSavedCases: cases.length,
    newEmbeddingCalls: 0, newJevCalls: 0, productionWrites: 0,
    volumeUnit: 'raw snapshot chunk UTF16 code units / UTF8 bytes; not tokens or final formatted prompt',
    cases,
    controls: {
        syntheticMechanismAssertions: 3,
        labelOnlyQueries: fixture.unscoredControls.map(c => ({
            id: c.id, expectedPositiveIdsWithinFixedUnion: c.positiveIds,
            scoreReuseRejected: true, modelQualityEvaluation: 'not_run'
        }))
    },
    verdict: 'Simple retained-score substitution is not accepted; independent admission quality remains untested.',
    limits: fixture.limitations
}, null, 2));