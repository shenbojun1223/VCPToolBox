"use strict";

const fs = require("node:fs");
const { spawn } = require("node:child_process");

const [action, ...args] = process.argv.slice(2);

function numberArg(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function writeRepeated(stream, byte, totalBytes) {
    const chunk = Buffer.alloc(Math.min(4096, totalBytes), byte);
    let remaining = totalBytes;
    while (remaining > 0) {
        const length = Math.min(chunk.length, remaining);
        stream.write(chunk.subarray(0, length));
        remaining -= length;
    }
}

switch (action) {
    case "report": {
        const envNames = String(args[0] || "").split(",").filter(Boolean);
        const env = Object.fromEntries(envNames.map(name => [name, process.env[name] ?? null]));
        process.stdout.write(`${JSON.stringify({ cwd: process.cwd(), env, argv: args.slice(1) })}\n`);
        break;
    }
    case "emit":
        process.stdout.write(String(args[0] || ""));
        process.stderr.write(String(args[1] || ""));
        break;
    case "bytes":
        if (args[2]) fs.writeFileSync(args[2], String(process.pid), "utf8");
        writeRepeated(process.stdout, 0x78, numberArg(args[0]));
        writeRepeated(process.stderr, 0x79, numberArg(args[1]));
        if (args[2]) setInterval(() => {}, 1000);
        break;
    case "delay":
        setTimeout(() => process.stdout.write(String(args[1] || "done")), numberArg(args[0]));
        break;
    case "hang":
        if (args[0]) fs.writeFileSync(args[0], String(process.pid), "utf8");
        setInterval(() => {}, 1000);
        break;
    case "start-markers":
        if (args[0]) fs.writeFileSync(args[0], "started", "utf8");
        if (args[1]) fs.writeFileSync(args[1], String(process.pid), "utf8");
        break;
    case "tree-hang": {
        const [parentPidMarker, descendantPidMarker] = args;
        fs.writeFileSync(parentPidMarker, String(process.pid), "utf8");
        const descendant = spawn(process.execPath, [__filename, "hang", descendantPidMarker], {
            stdio: "ignore",
            windowsHide: true
        });
        descendant.once("error", () => { process.exitCode = 70; });
        setInterval(() => {}, 1000);
        break;
    }
    case "exit":
        process.exitCode = numberArg(args[0], 1) || 1;
        process.stderr.write(String(args[1] || "fixture failure"));
        break;
    case "marker":
        fs.writeFileSync(args[0], String(args[1] || "marker"), "utf8");
        break;
    case "sequence": {
        const [markerPath, label, delayMs] = args;
        fs.appendFileSync(markerPath, `start:${label}\n`, "utf8");
        setTimeout(() => {
            fs.appendFileSync(markerPath, `end:${label}\n`, "utf8");
        }, numberArg(delayMs));
        break;
    }
    default:
        process.stderr.write("unknown fixture action");
        process.exitCode = 64;
}
