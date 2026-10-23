'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { HubNetworkClient } = require('./hubNetworkClient');
const { check, fields, identifier, integer } = require('./hubNetworkProtocol');

function absolute(value) {
    check(typeof value === 'string' && path.isAbsolute(value));
    const resolved = path.resolve(value);
    check(resolved !== path.parse(resolved).root);
    return resolved;
}
function textFile(filename, maximum) {
    const file = absolute(filename), stat = fs.lstatSync(file);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maximum);
    const bytes = fs.readFileSync(file);
    check(bytes.length <= maximum && Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes));
    return bytes.toString('utf8').replace(/^\uFEFF/, '');
}
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;

// Trusted host configuration, never tool arguments or renderer input.
// publish.allProjects is an explicit data-sharing decision for this Forge DB.
// Config construction does not start network, timers, migrations or leases.
function loadCatalogConfig(filename) {
    if (filename === undefined || filename === null || filename === '') return null;
    try {
        const configPath = absolute(filename);
        const config = JSON.parse(textFile(configPath, 64 * 1024));
        fields(config, ['version', 'endpoint', 'hubId', 'deviceId', 'tokenFile', 'read'],
            ['caFile', 'pathPrefix', 'publish']);
        check(config.version === 1 && typeof config.read === 'boolean');
        const tokenFile = absolute(config.tokenFile);
        const caFile = config.caFile === undefined ? null : absolute(config.caFile);
        let publish = null;
        if (config.publish !== undefined) {
            fields(config.publish, ['sourceId', 'journalPath', 'allProjects'],
                ['intervalMs', 'engineeringDetails', 'codeSnapshots']);
            check(config.publish.allProjects === true);
            if (Object.hasOwn(config.publish, 'engineeringDetails')) {
                check(typeof config.publish.engineeringDetails === 'boolean');
            }
            if (Object.hasOwn(config.publish, 'codeSnapshots')) {
                check(typeof config.publish.codeSnapshots === 'boolean');
                check(!config.publish.codeSnapshots || config.publish.engineeringDetails === true);
            }
            identifier(config.publish.sourceId);
            const journalPath = absolute(config.publish.journalPath);
            const intervalMs = config.publish.intervalMs === undefined ? 5000 : config.publish.intervalMs;
            integer(intervalMs, 100, 300000);
            const protectedPaths = [configPath, tokenFile, caFile].filter(Boolean);
            check(!protectedPaths.some(file => pathKey(file) === pathKey(journalPath)));
            const parent = fs.lstatSync(path.dirname(journalPath));
            check(parent.isDirectory() && !parent.isSymbolicLink());
            // Existing journals may not alias configuration or credential files.
            try {
                const journal = fs.lstatSync(journalPath);
                check(journal.isFile() && !journal.isSymbolicLink() && journal.nlink === 1);
                const real = pathKey(fs.realpathSync(journalPath));
                check(!protectedPaths.some(file => real === pathKey(fs.realpathSync(file))));
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
            publish = { sourceId: config.publish.sourceId, journalPath, allProjects: true, intervalMs,
                ...(Object.hasOwn(config.publish, 'engineeringDetails')
                    ? { engineeringDetails: config.publish.engineeringDetails } : {}),
                ...(Object.hasOwn(config.publish, 'codeSnapshots')
                    ? { codeSnapshots: config.publish.codeSnapshots } : {}) };
        }
        check(config.read || publish !== null);
        const client = new HubNetworkClient(config.endpoint, {
            token: textFile(tokenFile, 4096).trim(),
            hubId: config.hubId, deviceId: config.deviceId, pathPrefix: config.pathPrefix ?? '',
            ...(caFile === null ? {} : { ca: textFile(caFile, 256 * 1024) }),
        });
        return { client, read: config.read, publish };
    } catch {
        // Do not return credential bytes, configuration JSON or filesystem paths.
        throw Object.assign(new Error('CATALOG_CONFIG_INVALID'), { code: 'CATALOG_CONFIG_INVALID' });
    }
}
module.exports = { loadCatalogConfig };