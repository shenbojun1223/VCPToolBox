"use strict";

const FINAL_ACK_IDENTITY_FIELDS = ["sessionId", "attemptId", "nonce"];
const LEGACY_WIRE_PROTOCOL_VERSION = "1.1";
const LEGACY_PLUGIN_VERSION = "1.1.0";
const LEGACY_MOBILE_COMPAT_VERSION = "1.0.0";
const WIRE_PROTOCOL_VERSION = "1.2";
const STRICT_PLUGIN_VERSION = "1.2.0";
const WIRE_14_PROTOCOL_VERSION = "1.4";
const EXPECTED_PLUGIN_VERSION = "1.4.0";
const SUPPORTED_WIRE_PROTOCOL_VERSIONS = new Set([
  LEGACY_WIRE_PROTOCOL_VERSION,
  WIRE_PROTOCOL_VERSION,
  WIRE_14_PROTOCOL_VERSION,
]);
const WIRE_14_PHASES = new Set([
  "owner_metadata",
  "topic_metadata",
  "messages",
]);

function parseJsonWithoutDuplicateKeys(text) {
  if (typeof text !== "string") {
    const error = new Error("JSON frame must be text");
    error.code = "PROTOCOL_INVALID";
    throw error;
  }
  let offset = 0;
  const fail = (message, code = "PROTOCOL_INVALID") => {
    const error = new Error(`${message} at byte ${offset}`);
    error.code = code;
    throw error;
  };
  const skipWhitespace = () => {
    while (/\s/.test(text[offset] || "")) offset += 1;
  };
  const scanString = () => {
    if (text[offset] !== '"') fail("expected JSON string");
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      const code = text.charCodeAt(offset);
      if (code === 0x22) {
        offset += 1;
        return JSON.parse(text.slice(start, offset));
      }
      if (code < 0x20) fail("unescaped control character in JSON string");
      if (code === 0x5c) {
        offset += 1;
        const escape = text[offset];
        if (!'"\\/bfnrtu'.includes(escape || "")) {
          fail("invalid JSON escape");
        }
        if (escape === "u") {
          const hex = text.slice(offset + 1, offset + 5);
          if (!/^[a-f0-9]{4}$/i.test(hex)) fail("invalid Unicode escape");
          offset += 4;
        }
      }
      offset += 1;
    }
    fail("unterminated JSON string");
  };
  const scanValue = () => {
    skipWhitespace();
    const current = text[offset];
    if (current === "{") {
      offset += 1;
      skipWhitespace();
      const keys = new Set();
      if (text[offset] === "}") {
        offset += 1;
        return;
      }
      while (offset < text.length) {
        const key = scanString();
        if (keys.has(key)) {
          fail(`duplicate JSON object key ${JSON.stringify(key)}`, "PROTOCOL_DUPLICATE_KEY");
        }
        keys.add(key);
        skipWhitespace();
        if (text[offset] !== ":") fail("expected ':' after JSON object key");
        offset += 1;
        scanValue();
        skipWhitespace();
        if (text[offset] === "}") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") fail("expected ',' in JSON object");
        offset += 1;
        skipWhitespace();
      }
      fail("unterminated JSON object");
    }
    if (current === "[") {
      offset += 1;
      skipWhitespace();
      if (text[offset] === "]") {
        offset += 1;
        return;
      }
      while (offset < text.length) {
        scanValue();
        skipWhitespace();
        if (text[offset] === "]") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") fail("expected ',' in JSON array");
        offset += 1;
      }
      fail("unterminated JSON array");
    }
    if (current === '"') {
      scanString();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, offset)) {
        offset += literal.length;
        return;
      }
    }
    const match = text.slice(offset).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!match) fail("invalid JSON value");
    offset += match[0].length;
  };

  scanValue();
  skipWhitespace();
  if (offset !== text.length) fail("unexpected trailing JSON data");
  return JSON.parse(text);
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    const error = new Error(`${field} must be a non-empty string`);
    error.code = "PROTOCOL_INVALID";
    throw error;
  }
  return value;
}

function resolveWireProtocol(payload) {
  const protocolVersion = payload?.protocolVersion === undefined
    ? LEGACY_WIRE_PROTOCOL_VERSION
    : requireNonEmptyString(
      payload.protocolVersion,
      "VERSION_CHECK.protocolVersion",
    );
  if (!SUPPORTED_WIRE_PROTOCOL_VERSIONS.has(protocolVersion)) {
    const error = new Error(
      `wire protocol mismatch: supported ${LEGACY_WIRE_PROTOCOL_VERSION}, ${WIRE_PROTOCOL_VERSION}, or ${WIRE_14_PROTOCOL_VERSION}, received ${protocolVersion}`,
    );
    error.code = "PROTOCOL_MISMATCH";
    throw error;
  }
  return protocolVersion;
}

function createVersionAck(payload, pluginVersion) {
  if (!payload || payload.type !== "VERSION_CHECK") {
    const error = new Error("expected VERSION_CHECK");
    error.code = "VERSION_CHECK_INVALID";
    throw error;
  }
  requireNonEmptyString(payload.mobileVersion, "VERSION_CHECK.mobileVersion");
  const protocolVersion = resolveWireProtocol(payload);
  if (pluginVersion !== EXPECTED_PLUGIN_VERSION) {
    const error = new Error(
      `plugin package mismatch: expected ${EXPECTED_PLUGIN_VERSION}, received ${pluginVersion}`,
    );
    error.code = "PLUGIN_VERSION_MISMATCH";
    throw error;
  }
  if (protocolVersion === LEGACY_WIRE_PROTOCOL_VERSION) {
    return {
      type: "VERSION_ACK",
      version: LEGACY_MOBILE_COMPAT_VERSION,
      pluginVersion: LEGACY_PLUGIN_VERSION,
      protocolVersion: LEGACY_WIRE_PROTOCOL_VERSION,
    };
  }
  if (protocolVersion === WIRE_PROTOCOL_VERSION) {
    return {
      type: "VERSION_ACK",
      version: STRICT_PLUGIN_VERSION,
      pluginVersion: STRICT_PLUGIN_VERSION,
      protocolVersion: WIRE_PROTOCOL_VERSION,
    };
  }
  return {
    type: "VERSION_ACK",
    pluginVersion,
    protocolVersion: WIRE_14_PROTOCOL_VERSION,
  };
}

function requireExactKeys(payload, fields, label) {
  const expected = new Set(fields);
  const actual = Object.keys(payload);
  if (
    actual.length !== expected.size ||
    actual.some((field) => !expected.has(field))
  ) {
    const error = new Error(`${label} has unexpected or missing fields`);
    error.code = "PROTOCOL_INVALID";
    throw error;
  }
}

/**
 * Wire 1.4 deliberately uses exact request shapes and compound identities.
 * Older negotiated connections keep their existing permissive frame contract.
 */
function validateSyncRequestFrame(payload, protocolVersion) {
  if (protocolVersion !== WIRE_14_PROTOCOL_VERSION) return payload;

  switch (payload.type) {
    case "VERSION_CHECK":
      requireExactKeys(
        payload,
        ["type", "mobileVersion", "protocolVersion"],
        payload.type,
      );
      break;
    case "PHASE_START":
      requireExactKeys(payload, ["type", "phase"], payload.type);
      if (!WIRE_14_PHASES.has(payload.phase)) {
        const error = new Error(
          "phase must be owner_metadata, topic_metadata or messages",
        );
        error.code = "PROTOCOL_INVALID";
        throw error;
      }
      break;
    case "PHASE_COMPLETED":
      requireExactKeys(
        payload,
        payload.phase === "messages"
          ? ["type", "phase", "sessionId", "attemptId", "nonce"]
          : ["type", "phase"],
        payload.type,
      );
      if (!WIRE_14_PHASES.has(payload.phase)) {
        const error = new Error(
          "phase must be owner_metadata, topic_metadata or messages",
        );
        error.code = "PROTOCOL_INVALID";
        throw error;
      }
      if (
        payload.phase === "messages" &&
        (!Number.isSafeInteger(payload.sessionId) ||
          !Number.isSafeInteger(payload.attemptId) ||
          typeof payload.nonce !== "string" ||
          payload.nonce.length === 0)
      ) {
        const error = new Error(
          "messages PHASE_COMPLETED requires sessionId, attemptId and nonce",
        );
        error.code = "PROTOCOL_INVALID";
        throw error;
      }
      break;
    case "SYNC_MANIFEST_REQUEST":
      if (!["owner", "topic", "avatar"].includes(payload.manifestType)) {
        const error = new Error("Invalid manifestType");
        error.code = "PROTOCOL_INVALID";
        throw error;
      }
      requireExactKeys(
        payload,
        payload.manifestType === "topic"
          ? ["type", "manifestType", "items", "targetedOwners"]
          : ["type", "manifestType", "items"],
        payload.type,
      );
      break;
    case "SYNC_TOPIC_DIFF_REQUEST":
    case "SYNC_MESSAGE_DIFF_REQUEST":
      requireExactKeys(payload, ["type", "topics"], payload.type);
      break;
    case "SYNC_ENTITY_DELETE": {
      const fields = {
        owner: ["type", "targetType", "ownerType", "ownerId", "deletedAt"],
        topic: [
          "type",
          "targetType",
          "ownerType",
          "ownerId",
          "topicId",
          "deletedAt",
        ],
        avatar: ["type", "targetType", "ownerType", "ownerId", "deletedAt"],
        message: [
          "type",
          "targetType",
          "ownerType",
          "ownerId",
          "topicId",
          "msgId",
          "deletedAt",
        ],
      }[payload.targetType];
      if (!fields) {
        const error = new Error("Invalid delete targetType");
        error.code = "PROTOCOL_INVALID";
        throw error;
      }
      requireExactKeys(payload, fields, payload.type);
      break;
    }
    case "SYNC_ERROR":
      requireExactKeys(payload, ["type", "error"], payload.type);
      break;
    default:
      break;
  }
  return payload;
}

function resolveDeleteTimestamp(value, protocolVersion, now = Date.now) {
  const legacy = protocolVersion === LEGACY_WIRE_PROTOCOL_VERSION;
  const resolved = value === undefined && legacy ? now() : value;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    const error = new Error(
      legacy
        ? "SYNC_ENTITY_DELETE.deletedAt must be a non-negative integer when provided"
        : "SYNC_ENTITY_DELETE.deletedAt is required and must be a non-negative integer",
    );
    error.code = "SYNC_DELETE_INVALID";
    throw error;
  }
  return resolved;
}

/**
 * 构造阶段确认帧。
 *
 * 最终 messages 阶段必须原样回显移动端提供的会话身份；字段缺失时不伪造
 * 默认值，让移动端的精确 ACK 门禁保持 fail-closed。
 */
function createPhaseAck(payload, { echoFinalIdentity = false } = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  const ack = {
    type: "PHASE_ACK",
    phase: source.phase || "owner_metadata",
  };

  if (echoFinalIdentity) {
    for (const field of FINAL_ACK_IDENTITY_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(source, field)) {
        ack[field] = source[field];
      }
    }
  }

  return ack;
}

module.exports = {
  EXPECTED_PLUGIN_VERSION,
  LEGACY_MOBILE_COMPAT_VERSION,
  LEGACY_PLUGIN_VERSION,
  LEGACY_WIRE_PROTOCOL_VERSION,
  STRICT_PLUGIN_VERSION,
  WIRE_PROTOCOL_VERSION,
  WIRE_14_PROTOCOL_VERSION,
  createPhaseAck,
  createVersionAck,
  parseJsonWithoutDuplicateKeys,
  resolveDeleteTimestamp,
  resolveWireProtocol,
  validateSyncRequestFrame,
};
