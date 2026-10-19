'use strict';
const net = require('node:net');
const { DEFAULT_LIMITS } = require('./projectBundle');

class NetworkError extends Error {
    constructor(code) { super(code); this.name = 'NetworkError'; this.code = code; }
}
function check(ok, code = 'INVALID_ARGUMENT') { if (!ok) throw new NetworkError(code); }
function identifier(value) {
    check(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value));
    return value;
}
function hash(value) { check(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)); return value; }
function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
    check(Number.isSafeInteger(value) && value >= min && value <= max); return value;
}
function fields(value, required, optional = []) {
    check(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_BODY');
    check(required.every(k => Object.hasOwn(value, k)) &&
        Object.keys(value).every(k => required.includes(k) || optional.includes(k)), 'INVALID_BODY');
    return value;
}
function loopback(host) { return host === '127.0.0.1' || host === '::1'; }
function origin(value) {
    check(typeof value === 'string');
    let url;
    try { url = new URL(value); } catch { throw new NetworkError('INVALID_ARGUMENT'); }
    check(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
        !url.search && !url.hash && url.pathname === '/', 'UNSAFE_ENDPOINT');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    check(url.protocol === 'https:' || (net.isIP(host) && loopback(host)), 'TLS_REQUIRED');
    return url;
}
function bearer(value) {
    check(typeof value === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(value));
    return value;
}
const DEFAULTS = Object.freeze({
    maxBundleBytes: DEFAULT_LIMITS.maxBundleBytes, maxJsonBytes: 16 * 1024,
    maxResponseBytes: 64 * 1024, maxInflight: 4, maxConnections: 16,
    requestMs: 15000, maxReceipts: 8192,
});
function limits(overrides = {}) {
    check(overrides && typeof overrides === 'object' && !Array.isArray(overrides));
    const result = { ...DEFAULTS };
    for (const [key, value] of Object.entries(overrides)) {
        check(Object.hasOwn(result, key));
        integer(value, key === 'requestMs' ? 100 : key === 'maxResponseBytes' ? 128 : 1, DEFAULTS[key]);
        result[key] = value;
    }
    return Object.freeze(result);
}
const SAFE_CODES = new Set([
    'INVALID_ARGUMENT', 'INVALID_BODY', 'INVALID_JSON', 'INVALID_HEADERS', 'UNAUTHENTICATED',
    'FORBIDDEN', 'NOT_FOUND', 'METHOD_NOT_ALLOWED', 'BODY_TOO_LARGE', 'BAD_LENGTH',
    'REQUEST_TIMEOUT', 'BUSY', 'UNSUPPORTED_MEDIA', 'CONTENT_NOT_FOUND', 'CONTENT_REQUIRED',
    'CONTENT_BINDING', 'HUB_MISMATCH', 'UPLOAD_REQUIRED', 'CAPACITY_EXCEEDED', 'LIMIT_EXCEEDED',
    'CORRUPT_CONTENT', 'CORRUPT_BLOB', 'INVALID_BUNDLE', 'HASH_MISMATCH', 'UNSAFE_PATH',
    'DANGLING_REFERENCE', 'OPEN_CAPTURE', 'STALE_LEASE', 'LEASE_EXPIRED', 'LEASE_BUSY',
    'STALE_REQUEST', 'REQUEST_CONFLICT', 'REVISION_CONFLICT', 'CLOCK_ROLLBACK', 'COUNTER_EXHAUSTED',
]);
function safeCode(error) { return SAFE_CODES.has(error?.code) ? error.code : 'INTERNAL'; }
function status(code) {
    if (code === 'UNAUTHENTICATED') return 401;
    if (code === 'FORBIDDEN') return 403;
    if (code === 'NOT_FOUND' || code === 'CONTENT_NOT_FOUND') return 404;
    if (code === 'METHOD_NOT_ALLOWED') return 405;
    if (code === 'BODY_TOO_LARGE' || code === 'LIMIT_EXCEEDED') return 413;
    if (code === 'REQUEST_TIMEOUT') return 408;
    if (code === 'BUSY' || code === 'CAPACITY_EXCEEDED') return 429;
    if (code === 'INTERNAL' || code === 'CORRUPT_CONTENT' || code === 'CORRUPT_BLOB') return 500;
    if (/LEASE|CONFLICT|STALE|UPLOAD_REQUIRED|CLOCK_ROLLBACK/.test(code)) return 409;
    return 400;
}
module.exports = { NetworkError, check, identifier, hash, integer, fields, loopback, origin, bearer, limits, safeCode, status };