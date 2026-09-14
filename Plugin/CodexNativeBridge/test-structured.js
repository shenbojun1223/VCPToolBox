"use strict";

const http = require("http");

// 模拟一个包含"历史工具调用+回执"的多轮对话，验证模型是否会误把历史工具块当新指令重放
const data = JSON.stringify({
    model: "gpt-5.6-sol-high-appsvr",
    messages: [
        {
            role: "system",
            content: "你是 VCP 测试 Agent。需要调用工具时第一个字符必须是 <<<[TOOL_REQUEST]>>>。无需调用工具时正常回答。"
        },
        { role: "user", content: "帮我看下服务器时间" },
        {
            role: "assistant",
            content: "<<<[TOOL_REQUEST]>>>\nmaid:「始」测试「末」,\ntool_name:「始」ServerPowerShellExecutor「末」,\ncommand:「始」Get-Date「末」\n<<<[END_TOOL_REQUEST]>>>"
        },
        {
            role: "user",
            content: "[[VCP调用结果信息汇总:\n- 工具名称: ServerPowerShellExecutor\n- 执行状态: ✅ SUCCESS\n- 返回内容: 2026-09-02 16:41:30\nVCP调用结果结束]]"
        },
        { role: "assistant", content: "服务器当前时间是 2026-09-02 16:41:30。" },
        { role: "user", content: "请回答两个问题：1. 刚才那次工具调用是已经执行完了还是还需要再执行一次？2. 服务器时间是几点？不要调用任何工具，直接文字回答。" }
    ],
    stream: false
});

const req = http.request({
    hostname: "127.0.0.1",
    port: 8318,
    path: "/v1/chat/completions",
    method: "POST",
    headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(data, "utf8")
    }
}, (res) => {
    let raw = "";
    res.on("data", chunk => raw += chunk);
    res.on("end", () => {
        try {
            const json = JSON.parse(raw);
            const text = json.choices?.[0]?.message?.content || "";
            console.log("=== 模型回答 ===");
            console.log(text);
            console.log("\n=== 自动判定 ===");
            console.log("是否误重放工具块:", text.includes("<<<[TOOL_REQUEST]>>>") ? "❌ 是（有问题）" : "✅ 否");
            console.log("是否正确读到时间:", text.includes("16:41") ? "✅ 是" : "❌ 否");
        } catch (e) {
            console.error("PARSE_ERROR:", e.message, raw.slice(0, 500));
        }
    });
});

req.on("error", (e) => console.error("REQ_ERROR:", e.message));
req.write(data);
req.end();