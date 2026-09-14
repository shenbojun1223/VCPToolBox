"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const pluginManager = require("../Plugin");

test("manifest hot reload keeps resident service and hybrid runtimes alive", () => {
  const originalPlugins = pluginManager.plugins;
  const originalPreprocessors = pluginManager.messagePreprocessors;
  const originalServices = pluginManager.serviceModules;

  const serviceOnly = { shutdown() {} };
  const hybrid = { shutdown() {}, processMessages() {} };
  const preprocessorOnly = { shutdown() {}, processMessages() {} };
  const distributedPreprocessor = { shutdown() {}, processMessages() {} };

  pluginManager.plugins = new Map([
    ["service-only", { isDistributed: false }],
    ["hybrid", { isDistributed: false }],
    ["preprocessor-only", { isDistributed: false }],
    ["distributed", { isDistributed: true }],
  ]);
  pluginManager.messagePreprocessors = new Map([
    ["hybrid", hybrid],
    ["preprocessor-only", preprocessorOnly],
    ["distributed", distributedPreprocessor],
  ]);
  pluginManager.serviceModules = new Map([
    ["service-only", { module: serviceOnly }],
    ["hybrid", { module: hybrid }],
  ]);

  try {
    const modules = pluginManager._collectHotReloadShutdownModules();
    assert.deepEqual([...modules], [preprocessorOnly]);
    assert.equal(modules.has(serviceOnly), false);
    assert.equal(modules.has(hybrid), false);
    assert.equal(modules.has(distributedPreprocessor), false);
  } finally {
    pluginManager.plugins = originalPlugins;
    pluginManager.messagePreprocessors = originalPreprocessors;
    pluginManager.serviceModules = originalServices;
  }
});