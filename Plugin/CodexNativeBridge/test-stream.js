const http = require('http');

const data = JSON.stringify({
    model: "gpt-5.6-sol-xhigh",
    messages: [
        { role: "user", content: "请输出三个关于时间的精炼比喻。" }
    ],
    stream: true
});

const req = http.request({
    hostname: "127.0.0.1",
    port: 8318,
    path: "/v1/chat/completions",
    method: "POST",
    headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data)
    }
}, (res) => {
    console.log("STREAM_STATUS:", res.statusCode);
    res.on("data", chunk => {
        process.stdout.write(chunk.toString());
    });
    res.on("end", () => {
        console.log("\n[STREAM_ENDED]");
    });
});

req.on("error", (e) => console.error("ERR:", e.message));
req.write(data);
req.end();
