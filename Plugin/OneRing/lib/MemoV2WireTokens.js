'use strict';

const WIRE_CONTRACT_VERSION = 1;
const NEW_THREAD_WIRE_TOKEN = '__NEW_THREAD__';
const NO_ASSIGNEE_WIRE_TOKEN = '__NO_ASSIGNEE__';
const RESERVED_WIRE_TOKENS = new Set([
    NEW_THREAD_WIRE_TOKEN,
    NO_ASSIGNEE_WIRE_TOKEN
]);

function isReservedWireToken(value) {
    return typeof value === 'string' && RESERVED_WIRE_TOKENS.has(value);
}

module.exports = {
    WIRE_CONTRACT_VERSION,
    NEW_THREAD_WIRE_TOKEN,
    NO_ASSIGNEE_WIRE_TOKEN,
    isReservedWireToken
};
