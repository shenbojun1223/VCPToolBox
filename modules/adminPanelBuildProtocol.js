'use strict';

const { randomUUID } = require('node:crypto');

const MAX_TIMER_MS = 15 * 60 * 1000;
const DEFAULT_TERM_GRACE_MS = 1200;
const DEFAULT_FORCE_WAIT_MS = 3000;
const DEFAULT_TASKKILL_TIMEOUT_MS = 2500;
const DEFAULT_HELPER_KILL_WAIT_MS = 500;
const IPC_SEND_TIMEOUT_MS = 250;
const IPC_RECEIPT_DELIVERY_MS = 250;
const HELPER_REAP_ALLOWANCE_MS = 500;
const RECEIPT_TYPE = 'vcp-admin-panel-build-receipt';
const CANCEL_TYPE = 'vcp-admin-panel-build-cancel';
const PROTOCOL_VERSION = 1;

function boundedTimerMs(value, fallback, minimum = 0) {
    const candidate = Number.isFinite(value) ? value : fallback;
    return Math.max(minimum, Math.min(MAX_TIMER_MS, candidate));
}

function createInvocationId() {
    return randomUUID();
}

function isInvocationId(value) {
    return typeof value === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function createReceipt(invocationId, outcome, work, cleanup) {
    return {
        type: RECEIPT_TYPE,
        version: PROTOCOL_VERSION,
        invocationId,
        outcome,
        work,
        cleanup
    };
}

function validateReceipt(message, expectedInvocationId) {
    if (!message || typeof message !== 'object' || Array.isArray(message) ||
        !isInvocationId(expectedInvocationId) ||
        Object.keys(message).sort().join(',') !== 'cleanup,invocationId,outcome,type,version,work' ||
        message.type !== RECEIPT_TYPE || message.version !== PROTOCOL_VERSION ||
        message.invocationId !== expectedInvocationId ||
        !['completed', 'failed', 'cancelled'].includes(message.outcome) ||
        !['started', 'not_started'].includes(message.work) ||
        !['confirmed', 'not_required', 'unconfirmed'].includes(message.cleanup)) {
        return false;
    }

    if (message.work === 'not_started' && message.cleanup !== 'not_required') return false;
    if (message.outcome === 'cancelled' && message.work !== 'started') return false;
    if (message.outcome === 'completed' && message.cleanup === 'unconfirmed') return false;
    return true;
}

function getProcessTreeCleanupBudgetMs(options = {}) {
    const platform = options.platform || process.platform;
    const termGraceMs = boundedTimerMs(options.termGraceMs, DEFAULT_TERM_GRACE_MS);
    const forceWaitMs = boundedTimerMs(options.forceWaitMs, DEFAULT_FORCE_WAIT_MS);
    if (platform !== 'win32') return termGraceMs + forceWaitMs;

    const taskkillTimeoutMs = boundedTimerMs(
        options.taskkillTimeoutMs, DEFAULT_TASKKILL_TIMEOUT_MS, 1);
    const helperKillWaitMs = boundedTimerMs(
        options.helperKillWaitMs, DEFAULT_HELPER_KILL_WAIT_MS);
    const taskkillWorstCaseMs = taskkillTimeoutMs + (2 * helperKillWaitMs);
    return taskkillWorstCaseMs + termGraceMs + taskkillWorstCaseMs + forceWaitMs;
}

function getControllerCleanupBudgets(options = {}) {
    const innerCleanupMs = getProcessTreeCleanupBudgetMs(
        options.innerProcessTreeOptions || options);
    const outerReapMs = getProcessTreeCleanupBudgetMs(
        options.outerProcessTreeOptions || options);
    const ipcSendMs = boundedTimerMs(options.ipcSendTimeoutMs, IPC_SEND_TIMEOUT_MS, 1);
    const receiptDeliveryMs = boundedTimerMs(
        options.receiptDeliveryMs, IPC_RECEIPT_DELIVERY_MS, 1);
    const helperReapMs = boundedTimerMs(
        options.helperReapAllowanceMs, HELPER_REAP_ALLOWANCE_MS);
    return {
        innerCleanupMs,
        outerReapMs,
        ipcSendMs,
        receiptDeliveryMs,
        helperReapMs,
        cooperativeWaitMs: innerCleanupMs + ipcSendMs + receiptDeliveryMs + helperReapMs
    };
}

module.exports = {
    CANCEL_TYPE,
    DEFAULT_FORCE_WAIT_MS,
    DEFAULT_HELPER_KILL_WAIT_MS,
    DEFAULT_TASKKILL_TIMEOUT_MS,
    DEFAULT_TERM_GRACE_MS,
    HELPER_REAP_ALLOWANCE_MS,
    IPC_RECEIPT_DELIVERY_MS,
    IPC_SEND_TIMEOUT_MS,
    MAX_TIMER_MS,
    PROTOCOL_VERSION,
    RECEIPT_TYPE,
    boundedTimerMs,
    createInvocationId,
    createReceipt,
    getControllerCleanupBudgets,
    getProcessTreeCleanupBudgetMs,
    isInvocationId,
    validateReceipt
};
