'use strict';

// Request-local adapter, NOT a registered tool or a global restore service.
// Caller supplies the current request's existing store, explicitly opts in,
// and calls close on request completion, disconnect, error or abort.
// No file/log fallback, new store, environment activation or automatic pinning.
function createGravityRestoreAdapter({enabled = false, store = null} = {}) {
  let owner = store;
  let closed = false;
  const unavailable = reason => ({status:'unavailable',reason});

  function restore(args) {
    if (closed) return unavailable('closed');
    if (enabled !== true) return unavailable('disabled');
    try {
      if (!owner || typeof owner.restore !== 'function')
        return unavailable('no-store');
      // Only one own, plain data field. Paths, commands, alternate owners,
      // accessors and extra fields are not accepted as restore arguments.
      if (!args || typeof args !== 'object' ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(args)))
        return unavailable('invalid-arguments');
      const keys = Reflect.ownKeys(args);
      const field = Object.getOwnPropertyDescriptor(args, 'handle');
      if (keys.length !== 1 || keys[0] !== 'handle' || !field ||
          !Object.hasOwn(field, 'value') || typeof field.value !== 'string')
        return unavailable('invalid-arguments');
      if (!/^gs1_[a-f0-9]{48}$/.test(field.value))
        return unavailable('unknown-handle');
      return owner.restore(field.value);
    } catch {
      return unavailable('restore-error');
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    const previous = owner;
    owner = null;
    try { previous?.close(); } catch { /* Never interrupt request cleanup. */ }
  }

  return Object.freeze({restore,close});
}

module.exports = {createGravityRestoreAdapter};