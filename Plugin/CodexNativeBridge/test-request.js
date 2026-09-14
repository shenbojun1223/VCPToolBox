"use strict";

const http = require("http");

const data = JSON.stringify({
    model: "gpt-5.6-sol-xhigh",
    messages: [
        { role: "user", content: "请用简短一句话说明你是通过什么原生通道完成推理的。" }
    ],
    stream: false
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
    let resBody = "";
    res.on("data", chunk => resBody += chunk);
    res.on("end", () => {
        console.log("STATUS:", res.statusCode);
        console.log("BODY:", resBody);
    });
});

req.on("error", (e) => {
    console.error("ERROR:", e.message);
});

req.write(data);
req.end();