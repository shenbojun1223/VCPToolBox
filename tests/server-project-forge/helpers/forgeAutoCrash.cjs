'use strict';
const path = require('node:path');
const plugin = path.resolve(__dirname, '../../../Plugin/ServerProjectForge');
const { ProjectStore } = require(path.join(plugin, 'store'));
const { HubNetworkClient } = require(path.join(plugin, 'hubNetworkClient'));
const { ProjectAutoResume } = require(path.join(plugin, 'projectAutoResume'));
(async () => {
    const config = JSON.parse(process.env.PF_SYNTHETIC_CRASH);
    delete process.env.PF_SYNTHETIC_CRASH; // Synthetic credentials are never logged or persisted by this helper.
    const client = new HubNetworkClient(config.baseUrl, {
        token: config.token, deviceId: config.side, hubId: config.hubId,
    });
    const store = new ProjectStore(path.join(config.root, config.side + '.db'));
    const controller = new ProjectAutoResume(store, {
        client, journalPath: path.join(config.root, config.side + '-journal.db'),
        mappingPath: path.join(config.root, config.side + '-mapping.db'),
        ...(config.side === 'A' ? { localProjectId: config.localProjectId } : {
            globalProjectId: config.globalProjectId, target: config.target,
        }),
        ttlMs: 10000, pollMs: 1000, checkpointMs: 0, safetyMs: 100,
        _testHook: event => { if (event === config.event) process.exit(73); },
    });
    const status = await controller.start();
    if (!status.writable) throw Object.assign(Error(), { code: status.error || 'NOT_WRITABLE' });
    await controller.tick();
    await controller.stop(); store.close();
    throw Object.assign(Error(), { code: 'CRASH_POINT_NOT_REACHED' });
})().catch(error => {
    console.error(/^[A-Z_]+$/.test(error.code || '') ? error.code : 'CRASH_HELPER_FAILED');
    process.exitCode = 1;
});