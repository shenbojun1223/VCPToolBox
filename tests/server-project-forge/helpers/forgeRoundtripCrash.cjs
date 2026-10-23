'use strict';
const path = require('node:path');
const plugin = path.resolve(__dirname, '../../../Plugin/ServerProjectForge');
const { ProjectStore } = require(path.join(plugin, 'store'));
const { HubNetworkClient } = require(path.join(plugin, 'hubNetworkClient'));
const { ProjectAutoResume } = require(path.join(plugin, 'projectAutoResume'));
(async () => {
    const config = JSON.parse(process.env.PF_ROUNDTRIP_CRASH);
    delete process.env.PF_ROUNDTRIP_CRASH;
    const store = new ProjectStore(path.join(config.root, 'A.db'));
    const client = new HubNetworkClient(config.endpoint, {
        hubId: config.hubId, deviceId: 'A', token: config.token,
    });
    const controller = new ProjectAutoResume(store, {
        client, localProjectId: config.localProjectId,
        journalPath: path.join(config.root, 'A-journal.db'),
        mappingPath: path.join(config.root, 'A-mapping.db'),
        ttlMs: 30000, pollMs: 1000, checkpointMs: 600000, safetyMs: 100,
        _testHook: event => { if (event === config.event) process.exit(73); },
    });
    await controller.start();
    await controller.stop(); store.close();
    throw Object.assign(Error(), { code: 'CRASH_POINT_NOT_REACHED' });
})().catch(error => {
    console.error(/^[A-Z_]+$/.test(error.code || '') ? error.code : 'ROUNDTRIP_HELPER_FAILED');
    process.exitCode = 1;
});