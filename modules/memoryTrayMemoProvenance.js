'use strict';

const { randomUUID } = require('node:crypto');
const provenance = Symbol('memory-tray-memo');
const issued = new WeakMap();

// Enumerable Symbols survive the pipeline's object spreads, but not JSON.
// Neither a matching text prefix nor a client-supplied property grants access.
function issueTrayMemo(agentName) {
    const capability = Object.freeze({});
    const entry = Object.freeze({
        agentName,
        marker: `[[VCP_TRAY_MEMO:${randomUUID()}]]`
    });
    issued.set(capability, entry);
    return { capability, ...entry };
}

function attachTrayMemo(message, ticket) {
    if (ticket) message[provenance] = ticket.capability;
    return message;
}

function getTrayMemo(message) {
    if (message?.role !== 'user') return null;
    return issued.get(message[provenance]) || null;
}

function clearTrayMemo(message) {
    delete message[provenance];
    return message;
}

module.exports = { issueTrayMemo, attachTrayMemo, getTrayMemo, clearTrayMemo };