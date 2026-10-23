'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { HubNetworkClient } = require('./hubNetworkClient');
const required = ['version', 'endpoint', 'hubId', 'deviceId', 'tokenFile', 'journalPath', 'mappingPath'];
const optional = ['caFile', 'pathPrefix', 'localProjectId', 'globalProjectId', 'target',
    'ttlMs', 'pollMs', 'checkpointMs', 'safetyMs', 'drainMs'];
const check = ok => { if (!ok) throw Error('AUTO_CONFIG_INVALID'); };
function fields(value, keys, extra = []) {
    check(value && typeof value === 'object' && !Array.isArray(value) &&
        keys.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => [...keys, ...extra].includes(k)));
}
function absolute(value) {
    check(typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) !== path.parse(path.resolve(value)).root);
    return path.resolve(value);
}
function textFile(filename, maximum) {
    const file = absolute(filename), stat = fs.lstatSync(file);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maximum);
    const bytes = fs.readFileSync(file);
    check(bytes.length <= maximum && Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes));
    return bytes.toString('utf8').replace(/^\uFEFF/, '');
}
// Only called by the trusted host. Secrets must live outside source repositories; no automatic scan or fallback.
function loadAutoResumeConfig(filename) {
    if (filename === undefined || filename === null || filename === '') return null;
    try {
        const config = JSON.parse(textFile(filename, 64 * 1024));
        fields(config, required, optional); check(config.version === 1);
        check(Object.hasOwn(config, 'localProjectId') !== Object.hasOwn(config, 'globalProjectId'));
        const local = config.localProjectId;
        if (local !== undefined) check(typeof local === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(local) && !Object.hasOwn(config, 'target'));
        else {
            check(typeof config.globalProjectId === 'string' && /^g_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(config.globalProjectId));
            fields(config.target, ['root', 'workspaceAlias'], ['workspaceId', 'subpath']);
            absolute(config.target.root);
            check(typeof config.target.workspaceAlias === 'string' && config.target.workspaceAlias.trim());
            check(config.target.workspaceId === undefined || config.target.workspaceId === null || typeof config.target.workspaceId === 'string');
            check(config.target.subpath === undefined || typeof config.target.subpath === 'string');
        }
        const journalPath = absolute(config.journalPath), mappingPath = absolute(config.mappingPath);
        check((process.platform === 'win32' ? journalPath.toLowerCase() !== mappingPath.toLowerCase() : journalPath !== mappingPath));
        const numbers = {};
        for (const k of ['ttlMs', 'pollMs', 'checkpointMs', 'safetyMs', 'drainMs']) {
            if (Object.hasOwn(config, k)) {
                check(Number.isSafeInteger(config[k]) && config[k] >= 0);
                numbers[k] = config[k];
            }
        }
        const ttl = numbers.ttlMs ?? 60000, poll = numbers.pollMs ?? 250, safety = numbers.safetyMs ?? 250;
        check(ttl >= 1000 && ttl <= 300000 && poll >= 10 && poll < ttl / 2 && safety < ttl / 2 &&
            (numbers.drainMs === undefined || numbers.drainMs > 0));
        const token = textFile(config.tokenFile, 4096).trim();
        const client = new HubNetworkClient(config.endpoint, {
            token, hubId: config.hubId, deviceId: config.deviceId, pathPrefix: config.pathPrefix ?? '',
            ...(config.caFile === undefined ? {} : { ca: textFile(config.caFile, 256 * 1024) }),
        });
        return { client, journalPath, mappingPath, ...numbers,
            ...(local !== undefined ? { localProjectId: local } : { globalProjectId: config.globalProjectId, target: config.target }) };
    } catch {
        // Never leak JSON, bearer, file paths, PEM bytes or filesystem errors through host/plugin logs.
        throw Object.assign(new Error('AUTO_CONFIG_INVALID'), { code: 'AUTO_CONFIG_INVALID' });
    }
}
module.exports = { loadAutoResumeConfig };