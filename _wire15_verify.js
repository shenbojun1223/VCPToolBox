const p = require("./Plugin/VCPChatSyncHub/protocol.js");

console.log("=== A. Wire 1.5 happy path ===");
const h15 = { type: "VERSION_CHECK", versions: [
  { component: "mobile_app", version: "1.1.6" },
  { component: "wire", version: "1.5" },
]};
console.log("isWire15VersionCheck:", p.isWire15VersionCheck(h15));
console.log("resolveWireProtocol :", p.resolveWireProtocol(h15));
const r = p.negotiateWire15VersionCheck(h15, { desktopPluginVersion: "2.0.0", backendMode: "legacy" });
console.log("ACK  :", JSON.stringify(r.ack));
console.log("peer :", JSON.stringify(r.peer));

console.log("\n=== B. legacy paths ===");
console.log("wire1.4 flat :", JSON.stringify(p.createVersionAck({ type: "VERSION_CHECK", mobileVersion: "vcpchat-desktop-sync-1.4", protocolVersion: "1.4" }, "2.0.0")));
console.log("wire1.1 bare :", JSON.stringify(p.createVersionAck({ type: "VERSION_CHECK" }, "2.0.0")));
console.log("wire1.2 flat :", JSON.stringify(p.createVersionAck({ type: "VERSION_CHECK", mobileVersion: "1.2.0", protocolVersion: "1.2" }, "2.0.0")));

console.log("\n=== C. fail-closed rejects ===");
const bad = [
  ["dup-component", { type:"VERSION_CHECK", versions:[{component:"wire",version:"1.5"},{component:"wire",version:"1.5"}] }],
  ["extra-key",     { type:"VERSION_CHECK", versions:[{component:"mobile_app",version:"1.1.6",x:1},{component:"wire",version:"1.5"}] }],
  ["wire-1.4",      { type:"VERSION_CHECK", versions:[{component:"mobile_app",version:"1.1.6"},{component:"wire",version:"1.4"}] }],
  ["unknown-comp",  { type:"VERSION_CHECK", versions:[{component:"mobile_app",version:"1.1.6"},{component:"desktop",version:"1.5"}] }],
  ["one-entry",     { type:"VERSION_CHECK", versions:[{component:"wire",version:"1.5"}] }],
];
for (const [name, v] of bad) {
  try { p.negotiateWire15VersionCheck(v, { desktopPluginVersion:"2.0.0", backendMode:"legacy" }); console.log("[FAIL-SHOULD-THROW]", name); }
  catch (e) { console.log("[OK reject]", name, "->", e.code); }
}

console.log("\n=== D. createVersionAck must refuse versions[] ===");
try { p.createVersionAck(h15, "2.0.0"); console.log("[FAIL] versions[] leaked into legacy path"); }
catch (e) { console.log("[OK reject] ->", e.code, "|", e.message); }

console.log("\n=== E. frame validation for 1.5 ===");
try { p.validateSyncRequestFrame(h15, "1.5"); console.log("[OK] VERSION_CHECK 1.5 frame accepted"); }
catch (e) { console.log("[FAIL]", e.code, e.message); }
try { p.validateSyncRequestFrame({ type:"VERSION_CHECK", mobileVersion:"x", protocolVersion:"1.4" }, "1.5"); console.log("[FAIL] legacy fields accepted under 1.5"); }
catch (e) { console.log("[OK reject] legacy fields under 1.5 ->", e.code); }