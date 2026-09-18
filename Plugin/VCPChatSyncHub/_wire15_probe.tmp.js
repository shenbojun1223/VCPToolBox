const p = require("./protocol.js");
const show = (k, v) => console.log("PROBE|" + k + "|" + v);

const q15 = { type: "VERSION_CHECK", versions: [ { component: "mobile_app", version: "1.1.6" }, { component: "wire", version: "1.5" } ] };
try {
  show("isWire15", p.isWire15VersionCheck(q15));
  show("resolveWire", p.resolveWireProtocol(q15));
  const r = p.negotiateWire15VersionCheck(q15, { desktopPluginVersion: "2.0.0", backendMode: "legacy" });
  show("ack", JSON.stringify(r.ack));
  show("peer", JSON.stringify(r.peer));
  p.validateSyncRequestFrame(q15, "1.5");
  show("frameValid", "true");
} catch (e) { show("q15err", e.code + ":" + e.message); }

try {
  show("flat14ack", JSON.stringify(p.createVersionAck({ type: "VERSION_CHECK", protocolVersion: "1.4", mobileVersion: "vcpchat-desktop-sync-1.4" }, "2.0.0")));
} catch (e) { show("flat14err", e.code + ":" + e.message); }

try {
  p.createVersionAck(q15, "2.0.0");
  show("guard15", "FAILED_NO_THROW");
} catch (e) { show("guard15", "OK:" + e.code); }

const neg = (n, q) => { try { p.negotiateWire15VersionCheck(q, { desktopPluginVersion: "2.0.0", backendMode: "legacy" }); show(n, "PASS_UNEXPECTED"); } catch (e) { show(n, e.code); } };
neg("neg_three", { type: "VERSION_CHECK", versions: [{component:"mobile_app",version:"1.1.6"},{component:"wire",version:"1.5"},{component:"os",version:"ios"}] });
neg("neg_extrakey", { type: "VERSION_CHECK", versions: [{component:"mobile_app",version:"1.1.6",build:"123"},{component:"wire",version:"1.5"}] });
neg("neg_wire16", { type: "VERSION_CHECK", versions: [{component:"mobile_app",version:"1.1.6"},{component:"wire",version:"1.6"}] });
neg("neg_missing_app", { type: "VERSION_CHECK", versions: [{component:"wire",version:"1.5"},{component:"desktop_plugin",version:"2.0.0"}] });
neg("neg_dupe", { type: "VERSION_CHECK", versions: [{component:"wire",version:"1.5"},{component:"wire",version:"1.5"}] });
neg("neg_mode_bad", { type: "VERSION_CHECK", versions: [{component:"mobile_app",version:"1.1.6"},{component:"wire",version:"1.5"}] });