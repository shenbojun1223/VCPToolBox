"use strict";

const http = require("http");
const { spawn } = require("child_process");
const readline = require("readline");

const PORT = 8318;
const HOST = "127.0.0.1";
const CODEX_BIN = "C:\\Users\\Administrator\\.vscode\\extensions\\openai.chatgpt-26.707.91948-win32-x64\\bin\\windows-x86_64\\codex.exe";
const WORK_DIR = "C:\\VCP\\VCPToolBox";

class CodexAppServerBridge {
    constructor() {
        this.child = null;
        this.rl = null;
        this.reqId = 0;
        this.pendingRequests = new Map();
        this.activeStreams = new Map();
        this.ready = false;
        this.initPromise = null;
    }

    async ensureReady() {
        if (this.ready && this.child && !this.child.killed) return;
        if (this.initPromise) return this.initPromise;

        this.initPromise = this._startProcess();
        try {
            await this.initPromise;
        } finally {
            this.initPromise = null;
        }
    }

    _startProcess() {
        return new Promise((resolve, reject) => {
            console.log("[Bridge] 正在唤起官方 codex.exe app-server --stdio...");
            this.child = spawn(CODEX_BIN, ["app-server", "--stdio"], {
                cwd: WORK_DIR,
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
                env: process.env
            });

            this.rl = readline.createInterface({ input: this.child.stdout });

            this.rl.on("line", (line) => {
                const raw = line.trim();
                if (!raw) return;
                try {
                    const msg = JSON.parse(raw);
                    this._handleMessage(msg);
                } catch (e) {
                    console.error("[Bridge] 解析 JSONL 失败:", e.message);
                }
            });

            this.child.stderr.on("data", (d) => {
                // console.log("[Codex Stderr]", d.toString());
            });

            this.child.on("close", (code) => {
                console.warn(`[Bridge] codex.exe 进程退出，代码: ${code}`);
                this.ready = false;
                for (const { reject } of this.pendingRequests.values()) {
                    reject(new Error("Codex process closed"));
                }
                this.pendingRequests.clear();
            });

            this._sendRpc("initialize", {
                clientInfo: { name: "vcp-codex-native-bridge", version: "1.0.0" },
                capabilities: { experimentalApi: true }
            }).then(() => {
                this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");
                this.ready = true;
                console.log("[Bridge] 官方 Codex 握手就绪！");
                resolve();
            }).catch(err => {
                this.ready = false;
                reject(err);
            });
        });
    }

    _sendRpc(method, params) {
        const id = ++this.reqId;
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject, method });
            this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        });
    }

    _handleMessage(msg) {
        if (msg.id && this.pendingRequests.has(msg.id)) {
            const { resolve, reject } = this.pendingRequests.get(msg.id);
            this.pendingRequests.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message || "RPC Error"));
            else resolve(msg.result);
            return;
        }

        const method = msg.method;
        const params = msg.params || {};

        if (method === "item/agentMessage/delta") {
            const delta = params.delta || "";
            for (const streamContext of this.activeStreams.values()) {
                streamContext.onDelta(delta);
            }
        } else if (method === "turn/completed") {
            for (const [tId, streamContext] of this.activeStreams.entries()) {
                streamContext.onCompleted(params);
                this.activeStreams.delete(tId);
            }
        }
    }

    async chatCompletion(messages, stream, res, effort = "xhigh") {
        await this.ensureReady();

        let fullPrompt = "";
        for (const m of messages) {
            const role = (m.role || "user").toUpperCase();
            const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
            fullPrompt += `[${role}]\n${content}\n\n`;
        }

        console.log(`[Bridge] 收到请求，模式: ${stream ? "stream" : "sync"}，推理档位: ${effort}`);
        const threadResult = await this._sendRpc("thread/start", {
            cwd: WORK_DIR,
            ephemeral: true,
            sandbox: "read-only",
            approvalPolicy: "never"
        });

        const threadId = threadResult?.thread?.id;
        if (!threadId) throw new Error("未能创建 Codex 线程");

        const msgId = "chatcmpl-" + Date.now();
        const created = Math.floor(Date.now() / 1000);

        if (stream) {
            res.writeHead(200, {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive"
            });

            this.activeStreams.set(threadId, {
                onDelta: (delta) => {
                    const chunk = {
                        id: msgId,
                        object: "chat.completion.chunk",
                        created,
                        model: "gpt-5.6-sol",
                        choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
                    };
                    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                },
                onCompleted: () => {
                    const endChunk = {
                        id: msgId,
                        object: "chat.completion.chunk",
                        created,
                        model: "gpt-5.6-sol",
                        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
                    };
                    res.write(`data: ${JSON.stringify(endChunk)}\n\n`);
                    res.write("data: [DONE]\n\n");
                    res.end();
                    console.log(`[Bridge] 流式请求完成: ${threadId}`);
                }
            });

            await this._sendRpc("turn/start", {
                threadId,
                input: [{ type: "text", text: fullPrompt }],
                effort: effort
            });
        } else {
            let fullReply = "";
            return new Promise(async (resolve, reject) => {
                this.activeStreams.set(threadId, {
                    onDelta: (delta) => { fullReply += delta; },
                    onCompleted: () => {
                        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                        res.end(JSON.stringify({
                            id: msgId,
                            object: "chat.completion",
                            created,
                            model: "gpt-5.6-sol",
                            choices: [{
                                index: 0,
                                message: { role: "assistant", content: fullReply },
                                finish_reason: "stop"
                            }]
                        }));
                        console.log(`[Bridge] 非流式请求完成: ${threadId}, 响应字数: ${fullReply.length}`);
                        resolve();
                    }
                });

                try {
                    await this._sendRpc("turn/start", {
                        threadId,
                        input: [{ type: "text", text: fullPrompt }],
                        effort: effort
                    });
                } catch (e) {
                    this.activeStreams.delete(threadId);
                    reject(e);
                }
            });
        }
    }
}

const bridge = new CodexAppServerBridge();

const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === "OPTIONS") {
        res.writeHead(200);
        return res.end();
    }

    if (req.url === "/v1/models" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
            object: "list",
            data: [
                { id: "gpt-5.6-sol", object: "model", created: 1770000000, owned_by: "openai" },
                { id: "gpt-5.6-sol-xhigh", object: "model", created: 1770000000, owned_by: "openai" },
                { id: "gpt-5.6-sol-high", object: "model", created: 1770000000, owned_by: "openai" }
            ]
        }));
    }

    if (req.url === "/v1/chat/completions" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", async () => {
            try {
                const data = JSON.parse(body || "{}");
                const messages = data.messages || [];
                const stream = Boolean(data.stream);
                const model = data.model || "gpt-5.6-sol";
                let effort = "xhigh";
                if (model.includes("high") && !model.includes("xhigh")) effort = "high";
                if (model.includes("medium")) effort = "medium";
                if (model.includes("low")) effort = "low";

                await bridge.chatCompletion(messages, stream, res, effort);
            } catch (err) {
                console.error("[Server Error]", err);
                if (!res.headersSent) {
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: { message: err.message } }));
                }
            }
        });
        return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Not Found" } }));
});

server.listen(PORT, HOST, () => {
    console.log(`[CodexNativeBridge] 极简原生直通网关已启动: http://${HOST}:${PORT}`);
});