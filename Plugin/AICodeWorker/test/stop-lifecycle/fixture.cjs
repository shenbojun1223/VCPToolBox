"use strict";
const test = require("node:test"), a = require("node:assert/strict");
const { EventEmitter: EE } = require("node:events");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const filename = path.join(__dirname, "../../appserver/codexAppServerProcess.js");
const source = fs.readFileSync(filename, "utf8");
const OK = { terminated: true, confirmed: true, treeTermination: "confirmed" };
const NO = { confirmed: false, treeTermination: "unconfirmed" }, PRIVATE = "SYNTHETIC_PRIVATE";
class SidecarError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}
function child(pid) {
  return Object.assign(new EE(), { pid, exitCode: null, signalCode: null, stdout: new EE(),
    kill() { throw Error("Forbidden real process operation"); } });
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function rejects(promise, code = "CODEX_STOP_UNCONFIRMED") {
  return a.rejects(promise, e => {
    a.ok(e instanceof SidecarError); a.equal(e.code, code);
    a.ok(!JSON.stringify([e.message, e.details]).includes(PRIVATE)); return true;
  });
}
function fixture(cfg = {}) {
  const main = child(101), probe = child(102), calls = [], ids = [], spawns = [], events = [], timers = new Map();
  const identities = new Map([101, 102, 202, 303].map(pid => [pid, { pid, startTime: "saved-" + pid }]));
  class Connection extends EE {
    constructor() { super(); this.closed = false; this.count = 0; }
    close() {
      this.count++;
      if (cfg.close) return cfg.close(this);
      this.closed = true; this.emit("closed", {});
    }
    request() { return cfg.init ? cfg.init() : Promise.resolve({}); }
    _write() { return true; }
  }
  const dependencies = {
    "./frameTransport": require("../../appserver/frameTransport"),
    events: { EventEmitter: EE }, path,
    child_process: { spawn(bin, args) {
      spawns.push(args);
      if (cfg.spawnError) throw Error(PRIVATE);
      if (!args.includes("--version")) return main;
      if (!cfg.manual) queueMicrotask(() => {
        probe.stdout.emit("data", "codex-cli mock\n"); probe.exitCode = 0; probe.emit("close", 0);
      });
      return probe;
    } },
    "./jsonLineRpcConnection": { JsonLineRpcConnection: Connection },
    "./protocol": { SidecarError,
      getProcessIdentity(pid) { ids.push(pid); return cfg.identity ? cfg.identity(pid) : identities.get(pid); },
      async terminateOwnedChild(c, options) {
        calls.push({ c, options });
        a.equal(options.requireProcessTree, c !== probe);
        a.equal(options.forceConfirmationTimeoutMs, 1000);
        a.ok([250, 750].includes(options.gracefulTimeoutMs));
        return cfg.terminate ? cfg.terminate(c) : OK;
      }
    }
  };
  const module = { exports: {} };
  new vm.Script(source, { filename }).runInNewContext({
    module, process: { env: {}, cwd: () => "/mock" },
    require(name) { a.ok(Object.hasOwn(dependencies, name), "Forbidden dependency"); return dependencies[name]; },
    setTimeout(fn) { const key = {}; timers.set(key, fn); return key; },
    clearTimeout(key) { timers.delete(key); }
  });
  const p = new module.exports.CodexAppServerProcess({ codexBin: "mock-only" }), connection = new Connection();
  p.on("closed", info => events.push(info));
  return { p, main, probe, connection, cfg, calls, ids, spawns, events, identities,
    attach() {
      Object.assign(p, { child: main, codexPid: 101, codexIdentity: identities.get(101), connection, started: true });
      connection.once("closed", info => p._onClosed(info));
    },
    fire() { for (const [key, fn] of [...timers]) { timers.delete(key); fn(); } }
  };
}
function retained(f) {
  a.equal(f.p.child, f.main); a.equal(f.p.codexPid, 101);
  a.equal(f.p.codexIdentity, f.identities.get(101)); a.equal(f.p.connection, f.connection);
  a.equal(f.p.stopping, false); a.equal(f.p._stopPromise, null);
}

module.exports={test,a,EE,SidecarError,fixture,retained,rejects,child,deferred,tick,OK,NO,PRIVATE};
