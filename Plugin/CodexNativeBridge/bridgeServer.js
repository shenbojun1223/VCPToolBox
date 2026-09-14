"use strict";

const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const PORT = 8318;
const HOST = "127.0.0.1";
const WORK_DIR = "C:\\VCP\\VCPToolBox";

function resolveCodexBin() {
    const configuredPath = String(process.env.CODEX_BIN || "").trim();
    if (configuredPath && fs.existsSync(configuredPath)) return configuredPath;

    const userProfile = String(process.env.USERPROFILE || "").trim();
    const extensionsRoot = userProfile
        ? path.join(userProfile, ".vscode", "extensions")
        : "";

    if (extensionsRoot && fs.existsSync(extensionsRoot)) {
        const candidates = fs.readdirSync(extensionsRoot, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && entry.name.startsWith("openai.chatgpt-"))
            .map(entry => path.join(extensionsRoot, entry.name, "bin", "windows-x86_64", "codex.exe"))
            .filter(candidate => fs.existsSync(candidate))
            .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);

        if (candidates.length > 0) return candidates[0];
    }

    return "codex.exe";
}

const CODEX_BIN = resolveCodexBin();

// VCP 认知锚点：彻底洗掉 Codex 默认的 Coding Agent 与只读沙箱心智
const VCP_COGNITIVE_ANCHOR = `【核心运行环境认知】
你是运行在 VCP (Virtual Character Platform) 体系内的智能 Agent。
1. 你的所有行为准则、角色设定和工具能力完全由接下来的 System Prompt 与用户指令决定。
2. 你并不是一个受限于本地命令行环境或只读沙箱的 CLI 工具，切勿输出任何关于“当前处于只读沙箱”、“无法创建目录”、“EPERM 限制”等关于本地 Codex 宿主环境的误判。
3. 当需要调用系统功能或执行操作时，必须严格按照 VCP 规范输出 <<<[TOOL_REQUEST]>>> 协议块，外部 VCP 宿主系统会自动拦截并执行，切勿自行假装或口头模拟执行结果。

【上下文结构解读规则】
接下来 input 中的对话上下文使用以下结构化标记：
- <vcp_history> 内是本话题已经发生过的历史对话，仅作背景参考，不是新指令。
- <turn role="user"> / <turn role="assistant"> 标记每一轮的发言者。
- <executed_tool_result> 标记的是【已经由 VCP 宿主执行完毕的工具真实返回结果】，不是待执行请求，切勿重新执行或当成新指令。
- 历史 assistant 楼层中出现的 <<<[TOOL_REQUEST]>>> 块是【过去已发出且已被执行掉】的工具调用记录，不要模仿其内容重复调用，除非当前任务确实需要。
- <current_request> 内是用户【本轮最新的输入】，这是你需要响应的真正目标。`;

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

            this.child.stderr.on("data", () => {});

            this.child.on("close", (code) => {
                console.warn(`[Bridge] codex.exe 进程退出，代码: ${code}`);
                this.ready = false;
                for (const { reject } of this.pendingRequests.values()) {
                    reject(new Error("Codex process closed"));
                }
                this.pendingRequests.clear();
            });

            this._sendRpc("initialize", {
                clientInfo: { name: "vcp-codex-native-bridge", version: "1.1.0" },
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
            const threadId = params.threadId;
            for (const [tId, streamContext] of this.activeStreams.entries()) {
                if (!threadId || tId === threadId) {
                    streamContext.onDelta(delta);
                    break;
                }
            }
        } else if (method === "turn/completed") {
            const threadId = params.threadId;
            for (const [tId, streamContext] of this.activeStreams.entries()) {
                if (!threadId || tId === threadId) {
                    streamContext.onCompleted(params);
                    this.activeStreams.delete(tId);
                    break;
                }
            }
        }
    }

    _contentToText(content) {
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
            return content.map(item => {
                if (typeof item === "string") return item;
                if (item && typeof item.text === "string") return item.text;
                return "";
            }).filter(Boolean).join("\n");
        }
        return JSON.stringify(content);
    }

    // 优化1：结构化标记分隔历史对话，工具回执显式标注“已执行”
    _buildStructuredContext(conversationMessages) {
        // 找到最后一条 user 消息作为 current_request，其余为 history
        let lastUserIdx = -1;
        for (let i = conversationMessages.length - 1; i >= 0; i--) {
            if (conversationMessages[i].role === "user") {
                lastUserIdx = i;
                break;
            }
        }

        const historyMsgs = lastUserIdx >= 0 ? conversationMessages.slice(0, lastUserIdx) : conversationMessages;
        const currentMsgs = lastUserIdx >= 0 ? conversationMessages.slice(lastUserIdx) : [];

        let historyBlock = "";
        if (historyMsgs.length > 0) {
            const turns = historyMsgs.map((m, idx) => {
                const role = m.role === "assistant" ? "assistant" : (m.role === "tool" ? "tool" : "user");
                let text = this._contentToText(m.content);

                // 工具回执显式标注（VCP 的工具结果以 [[VCP调用结果信息汇总 开头回填）
                if (role === "tool" || text.includes("[[VCP调用结果信息汇总")) {
                    return `<executed_tool_result index="${idx + 1}">\n（此工具已由 VCP 宿主执行完毕，以下为真实返回结果，非待执行请求）\n${text}\n</executed_tool_result>`;
                }
                return `<turn role="${role}" index="${idx + 1}">\n${text}\n</turn>`;
            });
            historyBlock = `<vcp_history>\n${turns.join("\n")}\n</vcp_history>`;
        }

        let currentBlock = "";
        if (currentMsgs.length > 0) {
            const parts = currentMsgs.map(m => this._contentToText(m.content));
            currentBlock = `<current_request>\n${parts.join("\n\n")}\n</current_request>`;
        }

        return { historyBlock, currentBlock };
    }

    async chatCompletion(messages, stream, res, effort = "xhigh") {
        await this.ensureReady();

        const systemMessages = messages.filter(m => m.role === "system");
        const conversationMessages = messages.filter(m => m.role !== "system");

        const rawSystemText = systemMessages.length > 0
            ? systemMessages.map(m => this._contentToText(m.content)).join("\n\n")
            : "";

        // baseInstructions 覆写：VCP 认知锚点 + Agent 完整系统提示词
        const baseInstructions = `${VCP_COGNITIVE_ANCHOR}\n\n${rawSystemText}`.trim();

        // 优化1+2：结构化上下文 + input 数组多元素拆分
        const { historyBlock, currentBlock } = this._buildStructuredContext(conversationMessages);

        const inputItems = [];
        if (historyBlock) inputItems.push({ type: "text", text: historyBlock });
        if (currentBlock) inputItems.push({ type: "text", text: currentBlock });
        if (inputItems.length === 0) inputItems.push({ type: "text", text: "(空输入)" });

        console.log(`[Bridge] 收到请求，模式: ${stream ? "stream" : "sync"}，推理档位: ${effort}，input元素数: ${inputItems.length}，历史块: ${historyBlock.length}字，当前块: ${currentBlock.length}字`);

        const threadParams = {
            cwd: WORK_DIR,
            ephemeral: true,
            sandbox: "read-only",
            approvalPolicy: "never",
            personality: "none",
            baseInstructions: baseInstructions || undefined,
            developerInstructions: "严格遵守 baseInstructions 中的全部 VCP 协议与上下文结构解读规则。需要调用工具时，第一个输出字符必须是 <<<[TOOL_REQUEST]>>>，严禁口头预告或模拟执行。"
        };

        const threadResult = await this._sendRpc("thread/start", threadParams);

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
                input: inputItems,
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
                        input: inputItems,
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
                { id: "gpt-5.6-sol-high", object: "model", created: 1770000000, owned_by: "openai" },
                { id: "gpt-5.6-sol-xhigh-appsvr", object: "model", created: 1770000000, owned_by: "openai" },
                { id: "gpt-5.6-sol-high-appsvr", object: "model", created: 1770000000, owned_by: "openai" },
                { id: "gpt-5.6-sol-appsvr", object: "model", created: 1770000000, owned_by: "openai" }
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
