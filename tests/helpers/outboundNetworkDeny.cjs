'use strict';

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

function isLoopback(hostname) {
    const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function getHostname(input, options) {
    if (input instanceof URL) return input.hostname;
    if (typeof input === 'string') {
        try { return new URL(input).hostname; } catch { return options?.hostname || options?.host; }
    }
    if (input && typeof input === 'object') {
        return input.hostname || input.host || options?.hostname || options?.host;
    }
    return options?.hostname || options?.host;
}

function guardHttp(module, method) {
    const original = module[method];
    module[method] = function guardedRequest(input, options, ...rest) {
        const opts = typeof input === 'string' || input instanceof URL ? options : input;
        const hostname = getHostname(input, opts);
        if (!isLoopback(hostname)) {
            throw new Error('Outbound network is disabled by tests/helpers/outboundNetworkDeny.cjs');
        }
        return Reflect.apply(original, this, [input, options, ...rest]);
    };
}

guardHttp(http, 'request');
guardHttp(http, 'get');
guardHttp(https, 'request');
guardHttp(https, 'get');

for (const method of ['connect', 'createConnection']) {
    const original = net[method];
    net[method] = function guardedConnect(input, options, ...rest) {
        const opts = typeof input === 'object' ? input : options;
        if (opts?.path) return Reflect.apply(original, this, [input, options, ...rest]);
        const hostname = typeof input === 'number'
            ? (typeof options === 'string' ? options : options?.host || options?.hostname)
            : opts?.host || opts?.hostname;
        if (!isLoopback(hostname)) {
            throw new Error('Outbound network is disabled by tests/helpers/outboundNetworkDeny.cjs');
        }
        return Reflect.apply(original, this, [input, options, ...rest]);
    };
}

if (typeof globalThis.fetch === 'function') {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function guardedFetch(input, ...rest) {
        const hostname = getHostname(input);
        if (!isLoopback(hostname)) {
            return Promise.reject(new Error('Outbound network is disabled by tests/helpers/outboundNetworkDeny.cjs'));
        }
        return Reflect.apply(originalFetch, this, [input, ...rest]);
    };
}
