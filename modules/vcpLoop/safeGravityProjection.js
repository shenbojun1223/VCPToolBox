
'use strict';
// Safety boundary for an optional optimization. Disabled unless explicitly enabled.
// The timeout bounds asynchronous waits, not synchronous CPU execution.
const PROTECTED_TEXT = /VCP_|TOOL_REQUEST|END_TOOL_REQUEST|VCP调用|Flowlock::|系统提示|元思维|元思考/;

// Conservative admission budget; reject exotic objects, getters and oversized data
// BEFORE cloning. These limits bound work, not elapsed wall-clock time.
function withinBudget(value) {
  let chars = 0, nodes = 0;
  const seen = new WeakSet();
  function visit(item, depth) {
    if (++nodes > 12000 || depth > 16) return false;
    if (typeof item === 'string') {
      chars += item.length;
      return chars <= 1000000;
    }
    if (item === null || item === undefined ||
        typeof item === 'boolean' || typeof item === 'number') return true;
    if (typeof item !== 'object' || seen.has(item)) return false;
    const proto = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && proto !== Object.prototype && proto !== null) return false;
    seen.add(item);
    for (const key in item) {
      if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
      chars += key.length;
      if (chars > 1000000) return false;
      const desc = Object.getOwnPropertyDescriptor(item, key);
      if (!desc || !Object.prototype.hasOwnProperty.call(desc, 'value')) return false;
      if (!visit(desc.value, depth + 1)) return false;
    }
    return true;
  }
  return visit(value, 0);
}

async function safeGravityProjection(messages, options = {}) {
  let timer;
  try {
    if (!Array.isArray(messages)) return messages;
    const enabled = options.enabled === undefined
      ? process.env.VCP_GRAVITY_ENABLED === 'true' : options.enabled === true;
    const shadow = options.shadow === undefined
      ? process.env.VCP_GRAVITY_SHADOW === 'true' : options.shadow === true;
    // Explicit enabled:false remains an unconditional off switch.
    if (options.enabled === false || (!enabled && !shadow) || options.signal?.aborted) return messages;
    if (messages.length > 256 || !withinBudget(messages)) return messages;
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.min(100, options.timeoutMs)) : 50;
    const load = options.loadProjector || (() => require('./gravityStub.js').projectGravityStub);
    const project = load();
    if (typeof project !== 'function') return messages;
    // A timed-out or buggy projector must not mutate the original loop history.
    const input = structuredClone(messages);
    const work = Promise.resolve().then(() => project(input, options));
    const expiry = new Promise(resolve => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const returned = await Promise.race([work, expiry]);
    // Shadow output is never forwarded, even if a replacement projector changes it.
    if (shadow || options.signal?.aborted) return messages;
    if (!Array.isArray(returned) || returned.length !== messages.length ||
        !withinBudget(returned)) return messages;
    // Detach a successful result too: a projector may retain its own references.
    const result = structuredClone(returned);
    // Optimization may only alter plain assistant text; metadata must survive.
    for (let i = 0; i < result.length; i++) {
      const before = messages[i], after = result[i];
      if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return messages;
      const { content: a, ...metaA } = before;
      const { content: b, ...metaB } = after;
      if (JSON.stringify(metaA) !== JSON.stringify(metaB)) return messages;
      const protectedMessage = before.role !== 'assistant' ||
        typeof a !== 'string' || before.tool_calls || before.function_call ||
        before.tool_call_id || (typeof a === 'string' && PROTECTED_TEXT.test(a)) ||
        i >= messages.length - 4;
      if (protectedMessage && JSON.stringify(a) !== JSON.stringify(b)) return messages;
      if (!protectedMessage && typeof b !== 'string') return messages;
    }
    return result;
  } catch {
    return messages;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
module.exports = { safeGravityProjection };
