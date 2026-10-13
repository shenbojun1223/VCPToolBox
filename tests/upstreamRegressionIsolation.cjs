'use strict';
// Run existing pure handoff assertions without constructing production managers.
// This preload applies only to messageProcessor; all tested projection code stays real.
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const target = path.resolve(__dirname, '../modules/messageProcessor.js');
const originalLoad = Module._load;
let cached;
Module._load = function (id, parent, isMain) {
  if (Module._resolveFilename(id, parent) !== target) return originalLoad.apply(this, arguments);
  if (cached) return cached;
  const module = { exports: {} };
  const mocks = new Set(['chinese-lunar-calendar', './agentManager.js', './tvsManager.js',
    './toolboxManager.js', './dynamicToolRegistry.js', './sarPromptManager.js', './jevFoldFilter.js']);
  vm.runInNewContext(fs.readFileSync(target, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(target),
    process: { env: {} }, console,
    require(name) {
      if (name === 'path') return path;
      if (name === 'fs') return { promises: {} };
      if (mocks.has(name)) return {};
      throw Error('Unexpected dependency in isolated messageProcessor: ' + name);
    }
  }, { filename: target });
  cached = module.exports;
  return cached;
};
