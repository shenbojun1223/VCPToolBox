'use strict';
const {randomBytes} = require('node:crypto');

// Request-local restoration primitive. NOT a tool, projector or global registry.
// Store only original plain text; caller must enforce message protection,
// request membership and authorization before registration or restoration.
// Never register content already replaced by a summary as if it were original.
// No disk, network, embedding, eviction or production handler integration.
function createGravityOriginalStore() {
  const entries = new Map();
  const byIndex = new Map();
  let closed = false, chars = 0;

  function register(index, text) {
    try {
      if (closed) return {status:'unavailable',reason:'closed'};
      if (!Number.isInteger(index) || index < 0 || index > 255 ||
          typeof text !== 'string' || text.length === 0 || text.length > 1000000)
        return {status:'unavailable',reason:'invalid-input'};
      const existing = byIndex.get(index);
      if (existing) {
        const entry = entries.get(existing);
        if (entry.text !== text)
          return {status:'unavailable',reason:'index-conflict'};
        return {status:'registered',handle:existing,index,chars:text.length};
      }
      // Never evict a live handle to admit another original.
      if (entries.size >= 64 || chars + text.length > 1000000)
        return {status:'unavailable',reason:'store-budget'};
      const handle = 'gs1_' + randomBytes(24).toString('hex');
      if (entries.has(handle))
        return {status:'unavailable',reason:'handle-collision'};
      entries.set(handle,{index,text});
      byIndex.set(index,handle);
      chars += text.length;
      return {status:'registered',handle,index,chars:text.length};
    } catch {
      return {status:'unavailable',reason:'store-error'};
    }
  }
  function restore(handle) {
    if (closed) return {status:'unavailable',reason:'closed'};
    if (typeof handle !== 'string' || !/^gs1_[a-f0-9]{48}$/.test(handle))
      return {status:'unavailable',reason:'unknown-handle'};
    const entry = entries.get(handle);
    if (!entry) return {status:'unavailable',reason:'unknown-handle'};
    // New result object and immutable JS strings; no internal mutable reference.
    return {status:'restored',index:entry.index,text:entry.text};
  }
  function close() {
    closed = true;
    entries.clear();
    byIndex.clear();
    chars = 0;
    // Drops owned references, not a promise of physical memory zeroization.
  }
  function stats() {
    return {closed,entries:entries.size,chars};
  }
  return Object.freeze({register,restore,close,stats});
}
module.exports = {createGravityOriginalStore};