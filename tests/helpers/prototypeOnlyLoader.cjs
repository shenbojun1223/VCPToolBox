'use strict';

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const originalLoad = Module._load;
const offlineAxios = {
    post() {
        throw new Error('Network calls are disabled by prototypeOnlyLoader');
    }
};
Module._load = function loadOfflineDependencies(request, parent, isMain) {
    if (request === 'axios') return offlineAxios;
    return originalLoad.call(this, request, parent, isMain);
};

function exportPrototype(relativePath, className) {
    const filename = require.resolve(path.resolve(__dirname, '..', '..', relativePath));
    const source = fs.readFileSync(filename, 'utf8');
    const singletonExport = 'module.exports = new ' + className + '();';
    const prototypeExport = 'module.exports = ' + className + '.prototype;';
    const occurrences = source.split(singletonExport).length - 1;
    if (occurrences !== 1) {
        throw new Error('Expected one singleton export in ' + relativePath);
    }

    const isolatedModule = new Module(filename, module);
    isolatedModule.filename = filename;
    isolatedModule.paths = Module._nodeModulePaths(path.dirname(filename));
    require.cache[filename] = isolatedModule;
    try {
        isolatedModule._compile(source.replace(singletonExport, prototypeExport), filename);
    } catch (error) {
        delete require.cache[filename];
        throw error;
    }
}

function exportRagPrototype() {
    const filename = require.resolve(path.resolve(
        __dirname, '..', '..', 'Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js'));
    const source = fs.readFileSync(filename, 'utf8');
    const classStart = source.indexOf("const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'Asia/Shanghai';");
    const singletonExport = 'module.exports = new RAGDiaryPlugin();';
    if (classStart < 0 || source.split(singletonExport).length - 1 !== 1) {
        throw new Error('Could not isolate the RAGDiaryPlugin class definition');
    }

    const classSource = source.slice(classStart).replace(
        singletonExport, 'module.exports = RAGDiaryPlugin.prototype;');
    const isolatedModule = new Module(filename, module);
    isolatedModule.filename = filename;
    isolatedModule.paths = Module._nodeModulePaths(path.dirname(filename));
    const prelude = [
        "const axios = require('axios');",
        "const fs = require('node:fs').promises;",
        "const path = require('node:path');",
        "const chokidar = { watch() { throw new Error('watchers are disabled in isolated tests'); } };",
        "const crypto = require('node:crypto');",
        "const dotenv = { config() {} };",
        "const TimeExpressionParser = require('./TimeExpressionParser.js');",
        'class MetaThinkingManager {}',
        'class SemanticGroupManager {}',
        'class AIMemoHandler {}',
        'class ContextVectorManager {}',
        'class FoldingStore {}',
        "const CacheManager = require('./CacheManager.js');",
        'class TDBPlaceholderProcessor {}',
        'class DirectDiaryTextProcessor {}',
        'const MessageContentUtils = {};',
        'class TextSanitizer {}',
        "const VectorMathUtils = require('./VectorMathUtils.js');",
        'const AttachmentMemoUtils = {};',
        "const RAGResultFormatter = require('./RAGResultFormatter.js');",
        "const GroupPresentationOrder = require('./GroupPresentationOrder.js');",
        "const BM25QueryOptimizer = require('./BM25QueryOptimizer.js');",
        'const chunkText = () => [];',
        "const getEmbeddingsBatch = async () => { throw new Error('embeddings are disabled in isolated tests'); };",
        'const findLastRealUserMessage = () => null;',
        'const isBetaSystemUserText = () => false;',
        'const isSystemNotificationText = () => false;',
        "const dayjs = require('dayjs');",
        "dayjs.extend(require('dayjs/plugin/utc'));",
        "dayjs.extend(require('dayjs/plugin/timezone'));"
    ].join('\n') + '\n';
    isolatedModule._compile(prelude + classSource, filename);
    const prototype = isolatedModule.exports;
    prototype.cacheManager = new (isolatedModule.require('./CacheManager.js'))();
    prototype.rerankConfig = {};
    prototype.queryCacheEnabled = true;
    prototype.timeParser = new (isolatedModule.require('./TimeExpressionParser.js'))();
    prototype.groupPresentationOrder = new (isolatedModule.require('./GroupPresentationOrder.js'))();
    prototype.directDiaryTextProcessor = {
        getBM25Mode(modifiers) {
            if (typeof modifiers !== 'string') return null;
            if (/::BM25\+(?:\d*\.?\d+)?(?=$|::|[^\d.])/i.test(modifiers)) return 'body';
            if (/::BM25(?:\d*\.?\d+)?(?=$|::|[^\d.])/i.test(modifiers)) return 'tag';
            return null;
        }
    };
    require.cache[filename] = isolatedModule;
}

// Tests get method prototypes without reading plugin config or constructing singletons.
exportPrototype('KnowledgeBaseManager.js', 'KnowledgeBaseManager');
exportRagPrototype();
