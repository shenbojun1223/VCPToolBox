'use strict';

// modules/vcpToolForbiddenReceipt.js
// PRODUCER-SIDE overlay helper (production path: <VCPRoot>/modules/
// vcpToolForbiddenReceipt.js). It is NOT part of the frozen snapshot: it is added
// by the candidate overlay and is only ever invoked when an explicit local control
// header is present, so an ordinary request is byte-for-byte unaffected.
//
// It implements the local half of the opt-in, non-stream inner tool-forbidden
// consumption receipt (protocol version `aicw-tfr/1`, see
// docs/toolloop-marker-receipt-handoff.md). Two entry points are used by the
// patched handler pair:
//
//   * beginVcpToolForbiddenReceipt(req, body) - called at the ChatCompletion
//     handler entry BEFORE history sanitising and BEFORE the frozen
//     consumeVcpToolUseForbiddenPlaceholder() runs. It reads the local control
//     header `x-aicw-tfr-control`, strictly validates the bound run/turn/nonce/
//     model, and recomputes the canonical digest of the ENTRY messages with the
//     identical key-order independent projection the outer side uses. The control
//     metadata never enters the model `messages` and is never forwarded upstream
//     (the handler builds its upstream headers explicitly).
//
//   * emitVcpToolForbiddenReceipt(res, facts) - called at the final effective
//     non-stream response, immediately before res.send(). It force-overwrites the
//     reserved response header `x-aicw-tfr-receipt` (so an upstream header of the
//     same name can never survive) with either the true receipt or a fixed
//     `rejected:<code>` token. A receipt is only produced from facts this request
//     really observed: marker consumed, forbidden branch taken, tool parsing
//     skipped, zero tools executed.
//
// No credential, no key and no raw body are ever read into, logged by or required
// by this helper.

const crypto = require('crypto');

const RECEIPT_VERSION = 'aicw-tfr/1';
const CONTROL_HEADER = 'x-aicw-tfr-control';
const RECEIPT_HEADER = 'x-aicw-tfr-receipt';
const PRODUCER_ID = 'vcp-nonstream-handler';
const MAX_HEADER_CHARS = 2048;

const RUN_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MODEL_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// MUST stay identical to toolloop/live/receipt.js stableStringify(): the two
// implementations are compared against each other by the acceptance test instead of
// being assumed equal.
function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

function canonicalMessagesDigest(messages) {
  return sha256(stableStringify(messages));
}

// Presence and value of the ONE reserved control key. The lookup never picks a
// "first" value: a header map carrying the same reserved key under more than one
// case-variant name is ambiguous and is refused instead of being resolved, and a
// present-but-null / undefined / array / object / number value is NEVER laundered
// into an absent header. Only "no own entry at all" means protocol off.
function readControlHeader(req) {
  if (!req || !isPlainObject(req.headers)) return { present: false, ambiguous: false, value: null };
  let present = false;
  let ambiguous = false;
  let value = null;
  for (const [name, entry] of Object.entries(req.headers)) {
    if (String(name).toLowerCase() !== CONTROL_HEADER) continue;
    if (present) { ambiguous = true; break; }
    present = true;
    value = entry;
  }
  return { present, ambiguous, value };
}

function invalid(code) {
  return { active: true, valid: false, code, v: null, runId: null, turn: null, nonce: null, model: null, digest: null, markerConsumed: false, backendModel: null };
}

function beginVcpToolForbiddenReceipt(req, body) {
  const controlHeader = readControlHeader(req);
  // The protocol is OFF only when the reserved control key has NO own entry at all.
  // A present key is an explicit opt-in and is never silently turned into "protocol
  // off": null / undefined / array / object / number values are refused by type and
  // duplicate case-variant names of the same reserved key are refused as ambiguous -
  // neither is ever resolved to a first element. An explicitly empty string stays an
  // illegal opt-in (control_empty).
  if (!controlHeader.present) return null;   // protocol off
  if (controlHeader.ambiguous) return invalid('control_ambiguous');
  const raw = controlHeader.value;
  if (typeof raw !== 'string') return invalid('control_type');
  if (raw.length === 0) return invalid('control_empty');
  if (raw.length > MAX_HEADER_CHARS) return invalid('control_length');
  let control;
  try {
    control = JSON.parse(raw);
  } catch (_) {
    return invalid('control_json');
  }
  if (!isPlainObject(control)) return invalid('control_shape');
  if (control.v !== RECEIPT_VERSION) return invalid('control_version');
  if (typeof control.runId !== 'string' || !RUN_ID_RE.test(control.runId)) return invalid('control_run_shape');
  if (control.turn !== 1 && control.turn !== 2) return invalid('control_turn_shape');
  if (typeof control.nonce !== 'string' || !NONCE_RE.test(control.nonce)) return invalid('control_nonce_shape');
  if (typeof control.model !== 'string' || !MODEL_RE.test(control.model)) return invalid('control_model_shape');
  if (typeof control.digest !== 'string' || !DIGEST_RE.test(control.digest)) return invalid('control_digest_shape');
  if (!isPlainObject(body) || !Array.isArray(body.messages) || body.messages.length === 0) return invalid('control_body_shape');
  // The bound logical model is verified against the REAL inbound body model, never
  // trusted from the client control field. A trusted local redirect may legitimately
  // change the model that is dispatched later; the entry identity stays the one the
  // outer side bound, and the dispatched model is recorded separately (backendModel).
  if (typeof body.model !== 'string' || body.model !== control.model) return invalid('control_model_mismatch');
  // Non-stream only: the opt-in protocol requires an EXPLICIT `stream: false`;
  // anything else is refused instead of being silently downgraded.
  if (body.stream !== false) return invalid('control_stream_not_false');
  const digest = canonicalMessagesDigest(body.messages);
  if (digest !== control.digest) return invalid('control_digest_mismatch');
  return {
    active: true,
    valid: true,
    code: null,
    v: RECEIPT_VERSION,
    runId: control.runId,
    turn: control.turn,
    nonce: control.nonce,
    model: control.model,
    digest,
    markerConsumed: false,
    backendModel: null
  };
}

function buildReceiptValue({ binding, markerConsumed, toolForbidden, toolParsingSkipped, toolsExecuted, responseText, backendModel }) {
  if (!isPlainObject(binding) || binding.active !== true) return { ok: false, code: 'no_binding' };
  if (binding.valid !== true) return { ok: false, code: binding.code || 'control_invalid' };
  if (markerConsumed !== true) return { ok: false, code: 'marker_not_consumed' };
  if (toolForbidden !== true) return { ok: false, code: 'tool_not_forbidden' };
  if (toolParsingSkipped !== true) return { ok: false, code: 'parse_not_skipped' };
  if (toolsExecuted !== 0) return { ok: false, code: 'tools_executed' };
  const payload = {
    v: RECEIPT_VERSION,
    runId: binding.runId,
    turn: binding.turn,
    nonce: binding.nonce,
    model: binding.model,
    digest: binding.digest,
    markerConsumed: true,
    toolForbidden: true,
    toolParsingSkipped: true,
    toolsExecuted: 0,
    producer: PRODUCER_ID,
    responseDigest: sha256(typeof responseText === 'string' ? responseText : '')
  };
  // The ACTUAL dispatched backend identity is recorded only when a trusted local
  // redirect / semantic route really changed it (never equal to the bound entry
  // model), so the client control value can never be laundered into a backend
  // identity claim. A fact that is PRESENT but wrongly shaped is a REFUSAL: it is
  // never dropped back into "equal to the entry model".
  if (backendModel !== null && backendModel !== undefined) {
    if (typeof backendModel !== 'string' || !MODEL_RE.test(backendModel)) return { ok: false, code: 'backend_model_shape' };
    if (backendModel !== binding.model) payload.backendModel = backendModel;
  }
  const value = JSON.stringify(payload);
  if (value.length > MAX_HEADER_CHARS) return { ok: false, code: 'receipt_length' };
  return { ok: true, code: null, value };
}

// Explicitly overwrites the reserved namespace on every emission (valid receipt or
// a fixed `rejected:<code>` token): a caller can never be left with a value that
// did not come from this function.
function emitVcpToolForbiddenReceipt(res, facts) {
  const binding = facts ? facts.binding : null;
  if (!isPlainObject(binding) || binding.active !== true) return false;
  const built = buildReceiptValue(facts || {});
  if (res && typeof res.setHeader === 'function') {
    res.setHeader(RECEIPT_HEADER, built.ok ? built.value : 'rejected:' + (built.code || 'receipt_refused'));
  }
  return built.ok === true;
}

module.exports = {
  RECEIPT_VERSION,
  CONTROL_HEADER,
  RECEIPT_HEADER,
  PRODUCER_ID,
  MAX_HEADER_CHARS,
  sha256,
  stableStringify,
  canonicalMessagesDigest,
  beginVcpToolForbiddenReceipt,
  buildReceiptValue,
  emitVcpToolForbiddenReceipt
};