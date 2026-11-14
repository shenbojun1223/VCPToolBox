'use strict';

// Trusted local diagnostic. Does not import or start the production server.
// Usage: node scripts/diagnose-rag-shadow-pchuf.cjs prepare|run <isolated-run-directory>
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const dotenv = require('dotenv');
const ROOT = path.resolve(__dirname, '..');
const [mode, directory] = process.argv.slice(2);
assert(['prepare', 'smoke', 'run'].includes(mode) && directory, 'mode and directory required');
const RUN = path.resolve(directory);
const operations = path.join(ROOT, 'operations') + path.sep;
assert(RUN.startsWith(operations) && RUN !== ROOT, 'run must be a dedicated operations subdirectory');
const env = {
    ...dotenv.parse(fs.readFileSync(path.join(ROOT, 'Plugin/RAGDiaryPlugin/config.env'))),
    ...dotenv.parse(fs.readFileSync(path.join(ROOT, 'config.env')))
};
const productionDb = path.resolve(env.KNOWLEDGEBASE_STORE_PATH || path.join(ROOT, 'VectorStore'),
    'knowledge_base.sqlite');
const STORE = path.join(RUN, 'store');
const snapshotDb = path.join(STORE, 'knowledge_base.sqlite');
const NOTES = path.join(RUN, 'no-file-scan');
assert(snapshotDb !== productionDb);
const sourcePath = path.join(ROOT, 'Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const paramsText = fs.readFileSync(path.join(ROOT, 'rag_params.json'), 'utf8');
const params = JSON.parse(paramsText);
const scopes = ['赞妮的日常', '赞妮的知识', '赞妮的任务'];
const modifiers = '::Jev+::Time::Group::RiverMemo::Truncate0.35';
const directSource = fs.readFileSync(path.join(ROOT,
    'Plugin/RAGDiaryPlugin/DirectDiaryTextProcessor.js'), 'utf8');
const bmStart = directSource.indexOf('    getBM25Mode(modifiers) {');
const bmEnd = directSource.indexOf('    hasBM25Modifier(', bmStart);
assert(bmStart >= 0 && bmEnd > bmStart, 'BM25 parser boundaries changed');
const directParser = vm.runInNewContext('({' + directSource.slice(bmStart, bmEnd) + '})', {},
    { timeout: 1000 });
assert.equal(directParser.getBM25Mode(modifiers), null);
const questions = ['我们能不能像类似于claude bridge',
    '我们能不能像类似于claude bridge一样，做一个antigravity bridge？',
    '请求已被用户中止'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fingerprints = { ragSource: hash(source), ragParams: hash(paramsText),
    kbSource: hash(fs.readFileSync(path.join(ROOT, 'KnowledgeBaseManager.js'))) };
const emit = obj => process.stdout.write(JSON.stringify(obj) + '\n');
const save = (name, obj) => {
    const file = path.join(RUN, name);
    fs.writeFileSync(file + '.tmp', JSON.stringify(obj, null, 2));
    fs.renameSync(file + '.tmp', file);
};
// Production modules may log queries or response bodies; this child suppresses those
// logs entirely. All durable diagnostic fields below use explicit projections.
console.log = console.warn = console.error = () => {};
let phase = 'start';
let kb = null;
const calls = { embedding: 0, jev: 0 };
const report = {
    schema: 'pchuf-rag-shadow-v1', mode, startedAt: new Date().toISOString(),
    originalIncidentReplay: false, fingerprints, sourceDatabase: productionDb,
    snapshotDatabase: snapshotDb, scopes,
    differences: [
        'Current consistent database snapshot, including notes added since the incident.',
        'Runs real _processRAGPlaceholder, KBM and native River/external ranking; not full processMessages.',
        'Historical K=6/7 supplied as controlled inputs, not recomputed.',
        'Full-question vector uses current 0.7/0.3 configuration with prior cancellation text.',
        'History supplemental vector uses the prior short question; not recovered historical segment bytes.',
        'No Core anchors, explicit time range or prior diary-prefix exclusions; Group must be empty.',
        'Reports native returned pools, not all internal ANN candidates.',
        'Formatting and query caches bypassed; filtering/dedup/fusion functions remain real.',
        'Time continuity adds up to 3 K-external records; final dedup and Truncate apply to the combined set.',
        'Writable working copy: schema init and SQL-derived ANN restoration occur only inside RUN.',
        'Restored ANN generations/neighborhoods may differ from historical resident indices.',
        'Shared fusion rows retain River score; external-only rows retain ANN score; Time uses query cosine.',
        'Separate no-network smoke uses stored chunk vectors and synthetic external scores.',
        'BM25 absence verified by the unchanged production getBM25Mode parser.',
        'TagWeight fixed to historical log value 0.459 rather than dynamically recomputed.'
    ],
    calls, cases: []
};

function inventory(file) {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
        const marks = scopes.map(() => '?').join(',');
        const digest = crypto.createHash('sha256');
        for (const row of db.prepare(`SELECT c.id,f.path,f.diary_name,c.chunk_index,c.content,c.vector
            FROM chunks c JOIN files f ON f.id=c.file_id
            WHERE f.diary_name IN (${marks}) ORDER BY c.id`).iterate(...scopes)) {
            digest.update(JSON.stringify([row.id, row.path, row.diary_name,
                row.chunk_index, row.content]));
            if (row.vector) digest.update(row.vector);
        }
        return {
            scopedFactsDigest: digest.digest('hex'),
            scopeFiles: db.prepare(`SELECT diary_name,COUNT(*) AS files FROM files
                WHERE diary_name IN (${marks}) GROUP BY diary_name`).all(...scopes),
            dimensions: db.prepare('SELECT length(vector)/4 AS dimension,COUNT(*) AS chunks FROM chunks WHERE vector IS NOT NULL GROUP BY length(vector)').all(),
            targets: db.prepare(`SELECT c.id AS chunkId,f.path,c.chunk_index AS chunkIndex
                FROM chunks c JOIN files f ON f.id=c.file_id
                WHERE f.diary_name IN (${marks}) AND
                (lower(replace(c.content,' ','')) LIKE '%claudebridge%' OR lower(f.path) LIKE '%claudebridge%')
                ORDER BY c.id`).all(...scopes),
            newInvestigationPaths: db.prepare(`SELECT path FROM files WHERE diary_name IN (${marks})
                AND path LIKE '%2026-11-06%' AND (path LIKE '%ClaudeBridge%' OR path LIKE '%JEV%')`).all(...scopes)
        };
    } finally { db.close(); }
}

function assertInventoryStable(expected, current) {
    for (const key of ['scopeFiles', 'dimensions', 'targets', 'newInvestigationPaths']) {
        assert.deepEqual(current[key], expected[key], 'DIAGNOSTIC_SNAPSHOT_DRIFT_' + key);
    }
    if (expected.scopedFactsDigest) {
        assert.equal(current.scopedFactsDigest, expected.scopedFactsDigest,
            'DIAGNOSTIC_SNAPSHOT_FACTS_DRIFT');
    }
}

async function openIsolated() {
    // Environment belongs only to this child. Never initialize the production singleton.
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    process.env.KNOWLEDGEBASE_STORE_PATH = STORE;
    process.env.KNOWLEDGEBASE_ROOT_PATH = NOTES;
    process.env.KNOWLEDGEBASE_FULL_SCAN_ON_STARTUP = 'false';
    process.env.EMBEDDING_AUDIT_LOG_ENABLED = 'false';
    process.env.KNOWLEDGEBASE_PERSIST_DEFAULT = 'false';
    process.env.KNOWLEDGEBASE_PERSIST_FOLDERS = '';
    const Tag = require(path.join(ROOT, 'TagMemoEngine.js'));
    Tag.prototype.initialize = async function () { return true; };
    Tag.prototype.schedulePostStartupDerivedRefresh = () => false;
    for (const name of ['doMatrixRebuild', 'scheduleMatrixRebuildForNewTags']) {
        Tag.prototype[name] = () => { throw new Error('DIAGNOSTIC_DERIVED_REBUILD_FORBIDDEN'); };
    }
    const singleton = require(path.join(ROOT, 'KnowledgeBaseManager.js'));
    assert(singleton.initialized === false, 'unexpected initialized singleton');
    kb = new singleton.constructor({
        storePath: STORE, rootPath: NOTES, fullScanOnStartup: false,
        persistDefault: false, persistFolders: new Set(),
        persistTagIndex: false, tagIndexAllowInitial: false,
        chunkIndexAllowInitial: false, chunkIndexPersistenceMode: 'none',
        nativeRiverQueryFallbackToLegacy: false
    });
    for (const name of ['_startWatcher', '_startRagParamsWatcher', '_startIdleSweep',
        '_startEventLoopWatchdog', '_scheduleIndexSave', '_captureMemoryStage']) kb[name] = () => {};
    kb._cleanupDatabaseOrphansNative = async () => ({ skipped: true });
    for (const name of ['commitIngestionBatch', '_flushPendingFiles', 'forceRebuild']) {
        kb[name] = () => { throw new Error('DIAGNOSTIC_MUTATION_FORBIDDEN'); };
    }
    kb.loadRagParams = async function () { this.ragParams = structuredClone(params); };
    await kb.initialize();
    assert(path.resolve(kb.dbPath) === snapshotDb);
    assert(kb.initialized && !kb.watcher && !kb.ragParamsWatcher && !kb.idleSweepTimer);
    assert(kb.tagMemoEngine._activeArtifactBundle?.artifactSig,
        'compatible persisted Memo artifact required; no rebuild allowed');
    for (const name of scopes) await kb._getOrLoadDiaryIndex(name);
    const groups = JSON.parse(fs.readFileSync(path.join(ROOT,
        'Plugin/RAGDiaryPlugin/semantic_groups.json'), 'utf8'));
    assert(Object.keys(groups.groups || {}).length === 0, 'nonempty Group requires explicit precomputed-vector plan');
    return {
        artifactSig: kb.tagMemoEngine._activeArtifactBundle.artifactSig,
        state: kb.nativeKnowledgeRuntime.storeState(),
        dimension: kb.config.dimension, modelSig: kb.config.modelSig,
        initializedScopes: scopes.slice(), groupCount: 0
    };
}

function ragPrototype() {
    const dayjs = require('dayjs');
    dayjs.extend(require('dayjs/plugin/utc'));
    dayjs.extend(require('dayjs/plugin/timezone'));
    const a = source.indexOf('class RAGDiaryPlugin {');
    const b = source.lastIndexOf('// 导出实例以供 Plugin.js 加载');
    assert(a >= 0 && b > a);
    return vm.runInNewContext(source.slice(a, b) + '\nRAGDiaryPlugin.prototype;', {
        console, process: { env: process.env }, crypto, dayjs,
        path, Buffer, structuredClone, GLOBAL_SIMILARITY_THRESHOLD: 0.6,
        dailyNoteRootPath: NOTES,
        fs: new Proxy({}, { get() { throw new Error('DIAGNOSTIC_RAG_FILE_FALLBACK_FORBIDDEN'); } }),
        TextSanitizer: require(path.join(ROOT, 'Plugin/RAGDiaryPlugin/TextSanitizer.js')),
        MessageContentUtils: require(path.join(ROOT, 'Plugin/RAGDiaryPlugin/MessageContentUtils.js')),
        DEFAULT_TIMEZONE: env.DEFAULT_TIMEZONE || 'Asia/Shanghai',
        VectorMathUtils: require(path.join(ROOT, 'Plugin/RAGDiaryPlugin/VectorMathUtils.js')),
        RAGResultFormatter: require(path.join(ROOT, 'Plugin/RAGDiaryPlugin/RAGResultFormatter.js'))
    }, { timeout: 5000, filename: 'RAG.production-class.shadow.js' });
}

const finite = n => typeof n === 'number' && Number.isFinite(n) ? n : null;
const idOf = x => {
    const id = Number(x.chunkId ?? x.id);
    assert(Number.isSafeInteger(id) && id > 0, 'DIAGNOSTIC_INVALID_CHUNK_ID');
    return id;
};
function rows(list) {
    return Array.from(list || [], (d, i) => ({
        chunkId: idOf(d), path: d.fullPath || d.sourceFile || d.path || null,
        stageRank: i + 1, source: d.source || null,
        score: finite(d.score), originalScore: finite(d.originalScore),
        rerank_score: finite(d.rerank_score), rrf_score: finite(d.rrf_score),
        retrieval_rank: finite(d.retrieval_rank), rerank_rank: finite(d.rerank_rank),
        filterField: d.rerank_score != null ? 'rerank_score' : 'score',
        filterValue: finite(d.rerank_score ?? d.score ?? 0)
    }));
}

async function embeddingBatch() {
    phase = 'embedding';
    assert(calls.embedding === 0);
    assert(env.API_URL && env.API_Key && env.WhitelistEmbeddingModel);
    calls.embedding++;
    save('status.json', { phase, calls, at: new Date().toISOString() });
    const body = { model: env.WhitelistEmbeddingModel, input: questions };
    if (String(env.EMBEDDING_SEND_DIMENSIONS || 'true').toLowerCase() !== 'false')
        body.dimensions = Number(env.VECTORDB_DIMENSION);
    const response = await fetch(env.API_URL.replace(/\/$/, '') + '/v1/embeddings', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.API_Key },
        body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error('DIAGNOSTIC_EMBEDDING_HTTP_' + response.status);
    const data = await response.json();
    const vectors = [];
    for (const row of data.data || []) {
        assert(Number.isInteger(row.index) && row.index >= 0 && row.index < questions.length);
        assert(!vectors[row.index], 'duplicate embedding index');
        assert(Array.isArray(row.embedding) && row.embedding.length === kb.config.dimension);
        assert(row.embedding.every(Number.isFinite));
        vectors[row.index] = row.embedding;
    }
    assert(vectors.length === 3 &&
        Array.from({ length: 3 }, (_, i) => vectors[i]).every(Array.isArray));
    return { vectors, model: typeof data.model === 'string' ? data.model : null };
}

async function runCase(proto, label, index, embeddings, smoke = false) {
    phase = label;
    const record = { label, query: questions[index], dynamicK: index === 0 ? 6 : 7,
        time: new Date().toISOString(), stages: {} };
    if (!smoke) report.cases.push(record);
    const rag = Object.create(proto);
    const weights = params.RAGDiaryPlugin?.mainSearchWeights || [0.7, 0.3];
    const query = index === 0 ? embeddings[0] :
        rag._getWeightedAverageVector([embeddings[1], embeddings[2]], weights);
    rag.ragParams = structuredClone(params);
    rag.ragConfig = {};
    rag.shotgunHistoryEnabled = String(env.RAG_SHOTGUN_HISTORY_ENABLED || 'true').toLowerCase() !== 'false';
    rag.queryCacheEnabled = false;
    rag._generateCacheKey = () => 'isolated-no-cache';
    rag.rerankConfig = {
        useJev: true, multiplier: Number(env.RerankMultiplier) || 2,
        jevPrompt: env.JevRerankPrompt ||
            '请选择最值得用于回答当前查询的记忆。请从逻辑关联、记忆叙事连续性、信息解释力三个层面综合判断；优先保留能直接解释当前问题、补足关键背景或维持人物与事件连续性的内容，压低仅有表面词汇重合、重复、跑题或缺乏上下文价值的内容。',
        jevPrompts: {}
    };
    rag.pushVcpInfo = null;
    // Empty Group and absent BM25 are verified above, not guessed.
    rag.semanticGroups = { detectAndActivateGroups: () => new Map() };
    rag.directDiaryTextProcessor = directParser;
    const view = new Proxy(kb, {
        get(target, prop) {
            if (prop === 'executeNativeRiverQuery') return async (...args) => {
                const r = await target.executeNativeRiverQuery(...args);
                record.stages.riverReturned = rows(r.results);
                assert(r.artifactSig, 'DIAGNOSTIC_RIVER_FALLBACK_FORBIDDEN');
                record.artifactSig = r.artifactSig;
                record.omega = r.omega?.omega ?? null;
                return r;
            };
            if (prop === 'executeExternalRerank') return async (...args) => {
                if (smoke) {
                    const docs = await target.searchKnn(scopes, args[0].vector, args[1].externalK);
                    const r = { results: docs.map(d => ({ ...d, rerank_score: 1 / Math.max(1, docs.length) })) };
                    record.stages.jevReturned = rows(r.results);
                    return r;
                }
                assert(calls.jev < 2, 'JEV budget exceeded');
                calls.jev++;
                save('status.json', { phase, calls, at: new Date().toISOString() });
                const r = await target.executeExternalRerank(...args);
                record.stages.jevReturned = rows(r.results);
                record.jevProbabilitySum = r.results.reduce((s, d) => s + (d.rerank_score || 0), 0);
                return r;
            };
            if (prop === 'deduplicateResults') return async (docs, vector, options) => {
                const before = options?.stage === 'final-output' ? rows(docs) : null;
                const result = await target.deduplicateResults(docs, vector, options);
                if (options?.stage === 'final-output') {
                    record.stages.beforeFinalDedup = before;
                    record.stages.beforeTruncate = rows(result);
                }
                return result;
            };
            const v = target[prop];
            return typeof v === 'function' ? v.bind(target) : v;
        }
    });
    rag.vectorDBManager = view;
    rag._fuseIndependentRankings = function (...args) {
        const result = proto._fuseIndependentRankings.call(this, ...args);
        record.alpha = args[2];
        record.stages.fusedTopK = rows(result);
        return result;
    };
    // Capture stage data without changing the output of formatting or filtering.
    rag.formatGroupRAGResults = () => '';
    const opts = {
        dbName: scopes, modifiers, defaultTagWeight: 0.459,
        queryVector: query, userContent: questions[index], aiContent: index ? questions[2] : '',
        dynamicK: record.dynamicK, timeRanges: [], returnRawResults: true,
        historySegments: index ? [{ vector: embeddings[0] }] : [],
        isFreshTimeConversationStart: true, contextDiaryPrefixes: new Set(),
        requestCache: rag._createRequestCache()
    };
    const result = await kb.withMemoObservationScope(() => rag._processRAGPlaceholder(opts));
    assert(record.stages.jevReturned, 'external failure is not valid JEV comparison');
    assert(record.stages.beforeTruncate && record.stages.fusedTopK &&
        record.stages.riverReturned, 'DIAGNOSTIC_REQUIRED_STAGE_MISSING');
    record.stages.final = rows(result);
    const finalIds = new Set(record.stages.final.map(d => d.chunkId));
    record.decisions = record.stages.beforeTruncate.map(d => ({
        ...d, threshold: 0.35, kept: finalIds.has(d.chunkId),
        scoreProvenance: d.source === 'time' ? 'time-query-cosine' :
            record.stages.riverReturned.some(x => x.chunkId === d.chunkId)
                ? 'river-readout' : 'external-ann',
        retainedScoreWouldPass: d.score != null && d.score >= 0.35
    }));
    record.counterfactuals = {
        sameBeforeTruncatePoolWithoutThreshold: record.stages.beforeTruncate.map(d => d.chunkId),
        sameBeforeTruncatePoolUsingRetainedScoreNotChoice: record.stages.beforeTruncate.filter(d =>
            d.score != null && d.score >= 0.35).map(d => d.chunkId)
    };
    record.summary = {
        riverReturned: record.stages.riverReturned.length,
        jevReturned: record.stages.jevReturned.length,
        fused: record.stages.fusedTopK.length,
        beforeTruncate: record.stages.beforeTruncate.length,
        final: result.length
    };
    if (!smoke) {
        save('report.json', report);
        emit({ phase: label, summary: record.summary, report: path.join(RUN, 'report.json') });
    }
    return record.summary;
}

(async () => {
    if (mode === 'prepare') {
        assert(!fs.existsSync(RUN), 'fresh run directory required');
        fs.mkdirSync(STORE, { recursive: true });
        fs.mkdirSync(NOTES);
        phase = 'snapshot';
        const src = new Database(productionDb, { readonly: true, fileMustExist: true });
        try { await src.backup(snapshotDb); } finally { src.close(); }
        report.snapshotCreatedAt = new Date().toISOString();
        report.inventory = inventory(snapshotDb);
        assert(report.inventory.dimensions.length === 1 &&
            report.inventory.dimensions[0].dimension === Number(env.VECTORDB_DIMENSION));
        phase = 'preflight';
        report.preflight = await openIsolated();
        assertInventoryStable(report.inventory, inventory(snapshotDb));
        // Do not persist arbitrary native storeState objects, just useful safe state.
        delete report.preflight.state;
        report.status = 'preflight_passed_no_network';
        save('preflight.json', report);
        emit({ status: report.status, run: RUN, bytes: fs.statSync(snapshotDb).size,
            scopes: report.inventory.scopeFiles, targetChunks: report.inventory.targets.length,
            artifactSig: report.preflight.artifactSig, calls });
    } else {
        assert(fs.existsSync(path.join(RUN, 'preflight.json')), 'prepare required');
        const pre = JSON.parse(fs.readFileSync(path.join(RUN, 'preflight.json'), 'utf8'));
        assert.deepEqual(pre.fingerprints, fingerprints, 'source/config changed after prepare');
        if (mode === 'run') fs.writeFileSync(path.join(RUN, 'run-once.lock'),
            new Date().toISOString(), { flag: 'wx' });
        report.snapshotCreatedAt = pre.snapshotCreatedAt;
        report.inventory = inventory(snapshotDb);
        assertInventoryStable(pre.inventory, report.inventory);
        report.preflight = await openIsolated();
        assertInventoryStable(report.inventory, inventory(snapshotDb));
        delete report.preflight.state;
        const proto = ragPrototype();
        phase = 'zero-network-smoke';
        const db = new Database(snapshotDb, { readonly: true, fileMustExist: true });
        let smokeVectors;
        try {
            const sample = db.prepare(`SELECT c.vector FROM chunks c JOIN files f ON f.id=c.file_id
                WHERE f.diary_name IN (?,?,?) AND c.vector IS NOT NULL ORDER BY c.id LIMIT 3`).all(...scopes);
            smokeVectors = sample.map(r => Array.from({ length: kb.config.dimension },
                (_, i) => r.vector.readFloatLE(i * 4)));
        } finally { db.close(); }
        assert.equal(smokeVectors.length, 3);
        report.smoke = [
            await runCase(proto, 'smoke-short', 0, smokeVectors, true),
            await runCase(proto, 'smoke-full', 1, smokeVectors, true)
        ];
        assertInventoryStable(report.inventory, inventory(snapshotDb));
        assert.equal(calls.embedding + calls.jev, 0);
        save('smoke.json', { status: 'passed_no_network', cases: report.smoke, calls,
            factsDigest: report.inventory.scopedFactsDigest });
        emit({ phase: 'smoke', status: 'passed_no_network', calls });
        if (mode === 'smoke') return;
        const { vectors, model } = await embeddingBatch();
        report.embeddingResponseModel = model;
        report.queryWeights = params.RAGDiaryPlugin?.mainSearchWeights || [0.7, 0.3];
        await runCase(proto, 'short-question', 0, vectors);
        await runCase(proto, 'full-question', 1, vectors);
        assertInventoryStable(report.inventory, inventory(snapshotDb));
        report.factIntegrityVerified = true;
        report.status = 'completed';
        report.finishedAt = new Date().toISOString();
        save('report.json', report);
        save('status.json', { status: report.status, calls, finishedAt: report.finishedAt });
        emit({ status: report.status, calls, report: path.join(RUN, 'report.json') });
    }
})().catch(error => {
    // Error message is deliberately not persisted: provider bodies can contain secrets.
    const failure = { status: 'failed', phase, errorType: error.name,
        code: /^[A-Z_0-9]+$/.test(error.code || '') ? error.code : null,
        missingBinding: error.name === 'ReferenceError' ?
            (error.message.match(/^([A-Za-z_$][\w$]*) is not defined$/)?.[1] || null) : null,
        diagnosticCode: error.message?.match(/^DIAGNOSTIC_[A-Z_0-9]+$/)?.[0] || null,
        sourceFrame: error.stack?.split('\n').slice(1).map(s => {
            const m = s.match(/at ([A-Za-z_$][\w$.]*)/);
            return m ? m[1] : null;
        }).find(Boolean) || null, calls };
    if (fs.existsSync(RUN)) save('failure.json', failure);
    emit(failure);
    process.exitCode = 1;
}).finally(() => {
    // No KBM shutdown checkpoint publication; only release the isolated native runtime.
    if (kb?.nativeKnowledgeRuntime) kb.nativeKnowledgeRuntime.shutdown();
});