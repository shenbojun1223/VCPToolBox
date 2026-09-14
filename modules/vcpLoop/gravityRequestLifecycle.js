'use strict';
const {isDeepStrictEqual} = require('node:util');
const {createGravityOriginalStore} = require('./gravityOriginalStore');

// Request-local lifecycle owner. NOT installed in production handlers.
// Always returns CURRENT messages unchanged, never experimental stub output.
// Caller lends a response (not IncomingMessage: its close can mean body read).
// History drift invalidates ALL old handles conservatively; append keeps them.
function createGravityRequestLifecycle({signal,response} = {}) {
  let closed = false, snapshot = null, generation = 0;
  let store = createGravityOriginalStore();
  const listeners = [];
  const fail = reason => ({status:'unavailable',reason});
  function close() {
    if (closed) return;
    closed = true;
    store.close(); snapshot = null;
    for (const remove of listeners.splice(0)) {
      try { remove(); } catch { /* Cleanup must not break continuation. */ }
    }
  }
  function reset() {
    store.close(); store = createGravityOriginalStore();
    snapshot = null; generation++;
  }
  // Reject accessors/exotic objects before cloning; include metadata/attachments
  // in the same budget. No JSON stringification that could invoke toJSON.
  function bounded(value) {
    let nodes = 0, chars = 0;
    const seen = new WeakSet();
    function visit(v,depth) {
      if (++nodes > 12000 || depth > 16) return false;
      if (typeof v === 'string') return (chars += v.length) <= 1000000;
      if (v === null || v === undefined || typeof v === 'boolean') return true;
      if (typeof v === 'number') return Number.isFinite(v);
      if (typeof v !== 'object' || seen.has(v)) return false;
      const proto = Object.getPrototypeOf(v);
      if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) return false;
      seen.add(v);
      for (const key of Reflect.ownKeys(v)) {
        if (typeof key !== 'string' || (chars += key.length) > 1000000) return false;
        const d = Object.getOwnPropertyDescriptor(v,key);
        if (!d || !Object.hasOwn(d,'value')) return false;
        if (Array.isArray(v) && key === 'length') continue;
        // structuredClone does not preserve non-enumerable custom properties.
        if (!d.enumerable || !visit(d.value,depth+1)) return false;
      }
      return true;
    }
    return visit(value,0);
  }
  function sync(messages) {
    if (closed) return fail('closed');
    if (signal?.aborted || response?.destroyed || response?.writableEnded) {
      close(); return fail('closed');
    }
    try {
      if (!Array.isArray(messages) || messages.length > 256 || !bounded(messages) ||
          messages.some(m => !m || !['system','user','assistant','tool'].includes(m.role))) {
        reset(); return fail('unsupported-history');
      }
      const current = structuredClone(messages);
      const drift = snapshot !== null &&
        (current.length < snapshot.length ||
          snapshot.some((m,i) => !isDeepStrictEqual(m,current[i])));
      if (drift) reset();
      snapshot = current;
      return {status:'ready',invalidated:drift,generation};
    } catch {
      reset(); return fail('history-error');
    }
  }
  function observe(messages) {
    const state = sync(messages);
    return {...state,messages}; // Exact live identity, including unsupported inputs.
  }
  function register(messages,indices) {
    const state = sync(messages);
    if (state.status !== 'ready') return state;
    if (!Array.isArray(indices) || indices.length > 64 ||
        new Set(indices).size !== indices.length ||
        indices.some(i => !Number.isInteger(i) || i < 0 || i >= snapshot.length))
      return fail('invalid-candidates');
    // Explicit indices are only restoration experiments, not omission authority.
    // No selection policy is introduced here: accept ONLY plain assistant text.
    const handles = [];
    for (const index of indices) {
      const m = snapshot[index];
      if (m.role !== 'assistant' || typeof m.content !== 'string' ||
          Reflect.ownKeys(m).length !== 2) continue;
      const saved = store.register(index,m.content);
      if (saved.status === 'registered') handles.push({index,handle:saved.handle});
    }
    return {status:'registered',handles,generation,foldEligible:false};
  }
  function restore(messages,handles) {
    const state = sync(messages);
    if (state.status !== 'ready') return state;
    if (!Array.isArray(handles) || handles.length < 1 || handles.length > 64 ||
        new Set(handles).size !== handles.length) return fail('invalid-handles');
    const restored = [];
    for (const handle of handles) {
      const entry = store.restore(handle);
      if (entry.status !== 'restored') return fail('unknown-handle');
      const m = snapshot[entry.index];
      if (m?.role !== 'assistant' || m.content !== entry.text) {
        reset(); return fail('history-conflict');
      }
      restored.push({index:entry.index,content:entry.text});
    }
    return {status:'restored',restored,generation,foldEligible:false};
  }
  async function run(work) {
    if (closed) return fail('closed');
    try { return await work(api); }
    finally { close(); } // Normal, thrown, rejected and recursion-limit return.
  }
  const api = Object.freeze({
    observe,register,restore,close,run,
    stats:() => ({...store.stats(),generation})
  });
  try {
    if (signal) {
      const onAbort = () => close();
      signal.addEventListener('abort',onAbort,{once:true});
      listeners.push(() => signal.removeEventListener('abort',onAbort));
    }
    if (response) {
      for (const event of ['close','finish','error']) {
        const callback = () => close();
        response.on(event,callback);
        listeners.push(() => response.removeListener(event,callback));
      }
    }
    if (signal?.aborted || response?.destroyed || response?.writableEnded) close();
  } catch { close(); }
  return api;
}
module.exports = {createGravityRequestLifecycle};