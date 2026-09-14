'use strict';
const {createGravityRequestLifecycle} = require('./gravityRequestLifecycle');

// ISOLATED prototype. No production imports, network or exposed restoration tool.
// Explicit indices test mechanics, NOT semantic omission authority.
// project(indices, currentFullHistory) and expand(handles, currentFullHistory)
// must receive original history, never the preceding projected output.
// Omitting history preserves the previous snapshot API for existing fixtures.
const PROTOCOL = /VCP|TOOL_REQUEST|END_TOOL_REQUEST|Flowlock::|OneRing|系统提示|元思维|元思考|上下文语义折叠|本层摘要/;
const DETAIL = /[0-9`{}]|https?:|file:|[\\/]|\b[A-Z][A-Z_]{2,}\b|端口|路径|配置|密码|密钥|必须|禁止|不得|务必|截止|约定|决策|结论|注意|风险|不能|不要|不应|\b(?:must|never|do not)\b/i;
function createGravityReversibleSession(messages, options = {}) {
  let originals = [], closed = false, generation = null, loopStart = null;
  const owner = createGravityRequestLifecycle(options);
  const pinned = new Set();
  const fail = reason => ({status:'unavailable',reason});
  function close() {
    closed = true; owner.close(); pinned.clear(); originals = [];
  }
  function invalidate(reason) {
    owner.observe([]); pinned.clear(); originals = []; generation = null;
    return fail(reason);
  }
  function sync(current) {
    if (closed || owner.stats().closed) { close(); return fail('closed'); }
    try {
      if (!Array.isArray(current) || current.length < 7 || current.length > 256)
        return invalidate('message-budget');
      let chars = 0;
      const copy = [];
      for (const m of current) {
        if (!m || Object.getPrototypeOf(m) !== Object.prototype)
          return invalidate('unsupported-message');
        const d = Object.getOwnPropertyDescriptors(m);
        if (Reflect.ownKeys(d).length !== 2 || !d.role || !d.content ||
            !Object.hasOwn(d.role,'value') || !Object.hasOwn(d.content,'value') ||
            !['system','user','assistant','tool'].includes(d.role.value) ||
            typeof d.content.value !== 'string')
          return invalidate('unsupported-message');
        if (d.content.value.includes('[VCP_GRAVITY_STUB'))
          return invalidate('projected-history');
        chars += d.content.value.length;
        if (chars > 1000000) return invalidate('character-budget');
        copy.push({role:d.role.value,content:d.content.value});
      }
      const users = copy.flatMap((m,i) =>
        m.role === 'user' && !PROTOCOL.test(m.content) ? [i] : []);
      if (!users.length) return invalidate('missing-user-anchor');
      const state = owner.observe(copy);
      if (state.status !== 'ready') {
        pinned.clear(); originals = []; return state;
      }
      if (generation !== state.generation) pinned.clear();
      generation = state.generation;
      originals = copy;
      // Never make messages originating within this loop eligible as it grows.
      if (loopStart === null) loopStart = users[users.length-1];
      const immuneStart = Math.min(loopStart,
        users.length > 1 ? users[users.length-2] : users[0], copy.length-4);
      return {status:'ready',immuneStart};
    } catch { return invalidate('session-error'); }
  }
  const copyOriginals = () => originals.map(m => ({...m}));
  function project(indices, current = originals) {
    const state = sync(current);
    if (state.status !== 'ready') return {...state,messages:current};
    try {
      if (!Array.isArray(indices) || indices.length > 64 ||
          indices.some(i => !Number.isInteger(i) || i < 0 || i >= originals.length) ||
          new Set(indices).size !== indices.length) return fail('invalid-candidates');
      const selected = indices.filter(i => i < state.immuneStart && !pinned.has(i) &&
        originals[i].role === 'assistant' && originals[i].content.length >= 400 &&
        !PROTOCOL.test(originals[i].content) && !DETAIL.test(originals[i].content));
      const saved = owner.register(originals,selected);
      if (saved.status !== 'registered')
        return {...saved,messages:copyOriginals()};
      const output = copyOriginals(), stubs = [];
      for (const entry of saved.handles) {
        const text = originals[entry.index].content;
        // A literal excerpt is a clue, not an inferred summary.
        const clue = text.slice(0,48).replace(/[\r\n\t]/g,' ');
        const stub = '[VCP_GRAVITY_STUB handle=' + entry.handle +
          '; originalChars=' + text.length + '; clue=' + JSON.stringify(clue) +
          '; omitted text is NOT a summary; isolated restoration API only]';
        if (stub.length >= text.length) continue;
        output[entry.index].content = stub;
        stubs.push({...entry});
      }
      const originalChars = originals.reduce((n,m) => n+m.content.length,0);
      const projectedChars = output.reduce((n,m) => n+m.content.length,0);
      return {status:'projected',mode:'isolated',messages:output,stubs,
        foldEligible:false,metrics:{unit:'utf16-code-units',originalChars,
          projectedChars,savedChars:originalChars-projectedChars}};
    } catch {
      return {status:'projected',mode:'isolated',messages:copyOriginals(),
        stubs:[],foldEligible:false};
    }
  }
  function expand(requested, current = originals) {
    const state = sync(current);
    if (state.status !== 'ready') return state;
    const result = owner.restore(originals,requested);
    if (result.status !== 'restored') return result;
    // restore validates the entire batch before any pin is added.
    for (const entry of result.restored) pinned.add(entry.index);
    return {status:'expanded',restored:result.restored};
  }
  const initial = sync(messages);
  if (initial.status !== 'ready') { close(); return fail(initial.reason); }
  return Object.freeze({status:'ready',project,expand,close});
}
module.exports = {createGravityReversibleSession};