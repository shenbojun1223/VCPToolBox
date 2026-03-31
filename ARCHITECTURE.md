# VCP ToolBox — Architecture Document / 架构文档

> **Bilingual Edition · 双语版**
> English section first, Chinese section follows / 英文部分在前，中文部分在后

---

# PART I — ENGLISH

---

## 1. Project Purpose and Overview

### What is VCP ToolBox?

**VCP (Variable & Command Protocol) ToolBox** is an open-source AI middleware platform that acts as a semantic bridge between user frontends, large language models (LLMs), and hundreds of specialized tool plugins. It was designed to solve three fundamental fractures in conventional AI systems:

| Problem | Conventional AI | VCP Solution |
|---|---|---|
| Fragmented context | Discord bot can't know what web session discussed | Unified distributed identity across endpoints |
| Mechanical tool invocation | AI follows JSON schemas blindly | Semantic intent understanding — AI knows *why* to combine tools |
| Amnesiac memory | Context window = total memory | TagMemo V6 neuromorphic memory + AgentDream consolidation |

### Core Capabilities

1. **Semantic-driven plugin orchestration** — AI selects and chains 300+ plugins by understanding intent, not just matching schemas.
2. **Persistent, distributed identity** — A single AI "soul" can operate simultaneously across web, desktop, and API clients.
3. **Biologically-inspired memory** — TagMemo V6 uses leaky integrate-and-fire (LIF) spiking neural networks for associative recall; AgentDream consolidates memories while the agent is "sleeping."
4. **Distributed compute** — GPU farms, file servers, and remote terminals register as nodes and receive tool-routed tasks automatically.
5. **Full OpenAI compatibility** — Exposes a `/v1/chat/completions` endpoint so any OpenAI-compatible client works out of the box.
6. **Real-time monitoring** — Web-based admin panel provides live metrics, configuration editing, vector DB management, and RAG parameter tuning.

### Technology Stack

| Layer | Technology |
|---|---|
| Primary runtime | Node.js + Express |
| Vector DB core | Rust (USearch / HNSW algorithm) |
| Persistent storage | SQLite (WAL mode) |
| Real-time messaging | WebSocket |
| Plugin scripting | Node.js, Python, Shell |
| Frontend (Admin) | Vanilla JS + HTML |
| Deployment | Docker / docker-compose or bare-metal |

---

## 2. Directory Structure

```
VCPToolBox/
│
├── server.js                     # Application entry point; HTTP server lifecycle
├── Plugin.js                     # Plugin orchestration engine (3000+ lines)
├── WebSocketServer.js            # Distributed real-time communication hub
├── KnowledgeBaseManager.js       # Vector DB + RAG pipeline (3000+ lines)
├── EPAModule.js                  # Semantic space decomposition (EPA)
├── ResidualPyramid.js            # Multi-level semantic energy extraction
├── EmbeddingUtils.js             # Batch embedding API calls + retry logic
├── modelRedirectHandler.js       # Model name routing / aliasing
├── vcpInfoHandler.js             # Tool result formatting and broadcasting
├── diary-semantic-classifier.js  # Diary entry semantic classification
├── diary-tag-batch-processor.js  # Batch tag processing utilities
├── TextChunker.js                # Intelligent text chunking for embeddings
├── WorkerPool.js                 # Thread worker pool management
├── ResultDeduplicator.js         # Deduplication of tool results
│
├── modules/                      # Core request-handling sub-modules
│   ├── chatCompletionHandler.js  # /v1/chat/completions — main chat logic
│   ├── messageProcessor.js       # Variable/placeholder resolution engine
│   ├── agentManager.js           # Agent lifecycle and registration
│   ├── roleDivider.js            # Context branching via role markers
│   ├── vcpLoop/                  # VCP tool invocation loop
│   │   ├── toolCallParser.js     # Parses <<<[TOOL_REQUEST]>>> blocks
│   │   └── toolExecutor.js       # Routes parsed calls to Plugin.js
│   └── handlers/                 # Stream / non-stream response logic
│
├── routes/                       # HTTP route definitions
│   ├── adminPanelRoutes.js       # System monitor, config CRUD, agent mgmt
│   ├── dailyNotesRoutes.js       # Knowledge base file CRUD
│   ├── forumApi.js               # Multi-agent forum operations
│   └── taskScheduler.js          # Async cron task scheduling
│
├── Plugin/                       # Plugin ecosystem (100+ subdirectories)
│   ├── DailyNote*/               # Journal read/write/search plugins
│   ├── AgentDream/               # Memory consolidation + dream system
│   ├── LightMemo/                # Active in-context memory retrieval
│   ├── RAGDiaryPlugin/           # Passive RAG injection into prompts
│   ├── FluxGen/, DoubaoGen/      # Image generation plugins
│   ├── SunoGen/, GrokVideo/      # Audio / video synthesis
│   ├── VSearch/                  # VCP proprietary web search
│   ├── ChromeBridge/             # Browser automation + screenshots
│   ├── FileOperator/             # AI-optimized file editor
│   ├── CodeSearcher/             # Distributed Rust code search
│   ├── ScheduleManager/          # Calendar + task scheduling
│   ├── VCPForum*/                # Multi-agent forum ecosystem (5 plugins)
│   ├── AgentAssistant/           # Inter-agent delegation
│   ├── MCPO/                     # MCP protocol adapter
│   └── [90+ more plugins]
│
├── Agent/                        # Agent personality definition files
│   ├── Nova.txt                  # Example agent: Nova
│   ├── Coco.txt                  # Example agent: Coco
│   └── [custom agents...]
│
├── TVStxt/                       # Template Variable System text modules
│   └── *.txt                     # Reusable prompt fragments ({{VarXxx}})
│
├── AdminPanel/                   # Web-based admin dashboard
│   ├── index.html                # Main panel shell
│   ├── login.html                # Authentication page
│   └── js/                       # Panel JS modules (monitor, RAG tuner, etc.)
│
├── dailynote/                    # Knowledge base root (agent memories)
│   ├── ExampleMaid/              # Example agent memory structure
│   ├── VCP开发/                  # VCP development notes
│   ├── 前思维簇/                  # Pre-cognition thought cluster
│   ├── 逻辑推理簇/                # Logical reasoning cluster
│   └── 反思簇/                   # Reflection cluster
│
├── docs/                         # Extended documentation
│   ├── ARCHITECTURE.md           # (legacy) architecture notes
│   ├── API_ROUTES.md             # Route reference
│   ├── CONFIGURATION.md          # Config deep-dive
│   ├── DISTRIBUTED_ARCHITECTURE.md
│   └── CONTEXT_BRIDGE.md
│
├── rust-vexus-lite/              # Rust vector index engine (HNSW)
├── VCPChrome/                    # Browser extension (Manifest V3)
├── SillyTavernSub/               # SillyTavern sub-integration
├── OpenWebUISub/                 # OpenWebUI sub-integration
├── image/                        # Cached generated images + emoji packs
│
├── config.env.example            # Master configuration template (150+ options)
├── agent_map.json.example        # Agent alias → file mapping template
├── ModelRedirect.json.example    # Model name remapping template
├── toolApprovalConfig.json       # Tool authorization matrix
├── toolbox_map.json              # Plugin discovery map
├── rag_params.json               # Live RAG parameter overrides
├── package.json                  # Node.js dependencies + scripts
├── docker-compose.yml            # Container orchestration
├── Dockerfile                    # Container image definition
├── requirements.txt              # Python dependencies
├── pyproject.toml / poetry.lock  # Python project metadata
└── start_server.bat / update.bat # Windows helper scripts
```

---

## 3. Core Modules and Their Responsibilities

### 3.1 `server.js` — Application Entry Point

- Bootstraps the Express HTTP server (default port `6005`).
- Registers all route groups: chat completions, admin panel, daily notes, forum, file/image serving.
- Initialises WebSocketServer, Plugin subsystem, and KnowledgeBaseManager.
- Enforces API key authentication on all routes.
- Applies IP blacklisting and rate limiting middleware.
- Manages global HTTP connection pool (up to 10,000 keep-alive sockets) with LIFO scheduling to maximise socket reuse.
- Cleans up timed-out requests automatically.

### 3.2 `Plugin.js` — Plugin Orchestration Engine

- Scans `/Plugin/*/plugin-manifest.json` at startup to discover all plugins.
- Validates each manifest against the schema and classifies plugins by type:
  - `static` — returns a fixed string; no subprocess.
  - `synchronous` — spawns a child process per call; waits for result.
  - `asynchronous` — spawns and returns immediately; result delivered later.
  - `service` — long-running daemon imported as a Node.js module.
  - `messagePreprocessor` — intercepts and transforms messages before LLM sees them.
  - `hybridservice` — combines service + distributed delegation.
- Dynamically injects available tool descriptions into system prompts so the LLM knows what it can invoke.
- Routes calls to either local subprocess execution (STDIO protocol) or remote distributed nodes (WebSocket).
- Implements subprocess lifecycle management: timeouts, error capture, graceful termination.

### 3.3 `WebSocketServer.js` — Distributed Communication Hub

- Multiplexes five client categories over a single WebSocket server:
  - `VCPLog` — real-time log streaming to admin panel.
  - `VCPInfo` — structured tool-call info broadcasting.
  - `DistributedServer` — remote plugin node registration and job routing.
  - `ChromeControl` — commands to the VCPChrome browser extension.
  - `AdminPanel` — bidirectional admin dashboard communication.
- Authenticates connections using the `VCP_Key` secret.
- Tracks promise callbacks so async tool results are matched back to waiting requests.
- Handles node registration: remote servers announce their plugins; Plugin.js marks those capabilities as available.

### 3.4 `KnowledgeBaseManager.js` — Vector DB & RAG Pipeline

- Watches `/dailynote/**` via Chokidar for file additions, modifications, and deletions.
- On change: reads file → hashes content → chunks text (configurable size/overlap) → calls embedding API (batched, with exponential-backoff retry) → upserts into SQLite metadata table → refreshes USearch HNSW index.
- Maintains one vector index per diary directory plus a global tag index.
- Unloads idle indices after 2 hours to reclaim memory.
- Exposes `semanticSearch(query, diaryName, k)` used by RAG injection plugins.
- Maintains a co-occurrence matrix for topology-aware memory traversal.
- Supports 10 tunable RAG parameters (adjustable live from admin panel without restart).

### 3.5 `EPAModule.js` — Semantic Space Decomposition

- Performs K-Means clustering on the tag embedding vectors of a diary.
- Applies weighted PCA to find principal semantic axes.
- Uses Gram-Schmidt orthogonalisation to produce an orthonormal basis.
- Outputs three scalar scores per query:
  - `logicDepth` — how deeply analytical the query is.
  - `worldviewGating` — how broad or specific the worldview scope is.
  - `resonance` — emotional/motivational energy of the query.
- These scores feed into the TagMemo V6 spike-propagation step to tune retrieval.

### 3.6 `ResidualPyramid.js` — Multi-Level Semantic Decomposition

- Takes a query embedding and decomposes it across three abstraction levels using Gram-Schmidt projection.
- Level 1 captures the dominant concept; Level 2 the residual after removing Level 1; Level 3 the remaining nuance.
- Prevents over-fitting to high-frequency concept clusters.
- Results are weighted and combined to produce a richer search vector.

### 3.7 `modules/chatCompletionHandler.js` — Chat API Logic

- Implements the `/v1/chat/completions` endpoint (OpenAI-compatible).
- Calls `messageProcessor.js` to resolve all `{{Variable}}` and `[[DiaryName::RAG]]` placeholders.
- Optionally calls `roleDivider.js` to split messages across role boundaries.
- Runs message preprocessor plugins in configured order.
- Maintains a **VCP tool loop** (default max 5 iterations):
  1. Sends messages + tools description to upstream LLM.
  2. Streams response; detects `<<<[TOOL_REQUEST]>>>` blocks.
  3. Parses each block with `toolCallParser.js`.
  4. Executes each tool with `toolExecutor.js`.
  5. Appends tool results to context; loops until no more tool requests.
- Supports both streaming (SSE) and non-streaming response modes.
- Broadcasts final answer to WebSocket listeners (`VCPInfo`, `VCPLog`).

### 3.8 `modules/messageProcessor.js` — Variable Resolution Engine

- Resolves placeholder tokens inside system/user messages before they reach the LLM.
- Supported placeholder types:

| Syntax | Resolves to |
|---|---|
| `{{Date}}` / `{{Time}}` | Current date/time |
| `{{AgentName}}` | Contents of `/Agent/AgentName.txt` |
| `{{VarXxxxx}}` | Contents of `/TVStxt/Xxxxx.txt` |
| `[[DiaryName::RAG]]` | Semantically retrieved diary entries |
| `[[DiaryName::Group]]` | All entries from a diary group |

- Performs recursive resolution (a variable can reference other variables).
- Detects and breaks circular dependencies.
- Enforces privilege levels to prevent user-controlled messages from injecting system-level variables.

### 3.9 `modules/roleDivider.js` — Context Branching

- Parses special role-boundary markers embedded in messages:
  - `<<<[ROLE_DIVIDE_SYSTEM]>>>` — splits off a system-only instruction block.
  - `<<<[ROLE_DIVIDE_USER]>>>` — content becomes a user message.
  - `<<<[ROLE_DIVIDE_ASSISTANT]>>>` — pre-fills an assistant turn.
- Enables sophisticated context surgery: parallel reasoning branches, forced assistant "warm start," and multi-persona conversations.

### 3.10 `modelRedirectHandler.js` — Model Name Routing

- Reads `ModelRedirect.json` at runtime.
- Translates public-facing model names (e.g., `gpt-4o`) to the actual backend identifiers required by the configured API endpoint.
- Supports separate whitelists for chat, image, and embedding models.
- Enables switching the underlying model provider without changing client configuration.

### 3.11 `vcpInfoHandler.js` — Tool Result Formatting

- Standardises tool call results into the format expected by the VCP loop context.
- Strips binary payloads (Base64 images) before injecting into text context.
- Broadcasts structured `VCPInfo` events to WebSocket subscribers (admin panel, log viewer).

---

## 4. Data Flow and Component Interactions

### 4.1 Chat Request Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│  Client (VCPChat / SillyTavern / any OpenAI-compatible UI)       │
└─────────────────────────────┬───────────────────────────────────┘
                              │  POST /v1/chat/completions
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  server.js                                                       │
│  • Validates API key                                             │
│  • Rate limit check                                              │
│  • Forwards to chatCompletionHandler                             │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  messageProcessor.js                                             │
│  • Resolves {{Variables}}, {{AgentDefs}}, [[RAG]] placeholders   │
│  • Calls KnowledgeBaseManager for semantic search snippets       │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  roleDivider.js (optional)                                       │
│  • Splits context on role-boundary markers                       │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  messagePreprocessor plugins (ordered pipeline)                  │
│  • Can add/remove/transform messages before LLM sees them        │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Upstream LLM API  (OpenAI / Claude / Gemini / local)            │
│  • Receives fully resolved messages + tool descriptions          │
│  • Returns streamed or buffered response                         │
└─────────────────────────────┬───────────────────────────────────┘
                              │
          ┌───────────────────▼──────────────────────┐
          │       VCP Tool Loop (max N iterations)    │
          │                                           │
          │  Parse <<<[TOOL_REQUEST]>>> blocks         │
          │              │                            │
          │              ▼                            │
          │  toolExecutor.js → Plugin.js              │
          │    ┌─────────────────────────────┐        │
          │    │ Local plugin?               │        │
          │    │  → spawn child process      │        │
          │    │  → STDIO JSON protocol      │        │
          │    │                             │        │
          │    │ Distributed plugin?         │        │
          │    │  → WebSocketServer          │        │
          │    │  → remote node executes     │        │
          │    │  → result callback          │        │
          │    └─────────────────────────────┘        │
          │              │                            │
          │  Append result to context                 │
          │  Loop until no more tool requests         │
          └───────────────────┬──────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Response delivered to client (SSE stream or JSON body)          │
│  + broadcast to WebSocket subscribers (VCPLog, AdminPanel)       │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Knowledge Base Sync Pipeline

```
User edits /dailynote/<Agent>/<file>.txt
           │
           ▼  (Chokidar file watcher)
KnowledgeBaseManager.onFileChange()
           │
           ├─ Hash content → skip if unchanged
           ├─ TextChunker.js → split into token-bounded chunks
           ├─ EmbeddingUtils.js → batch embed chunks via API
           ├─ SQLite upsert (metadata + chunk text)
           └─ USearch HNSW index refresh
                       │
                       ▼
           WebSocket broadcast → AdminPanel updates UI
                       │
                       ▼
           Next RAG query uses fresh vectors (no restart needed)
```

### 4.3 Distributed Plugin Execution

```
chatCompletionHandler detects tool request
           │
           ▼
Plugin.js checks plugin manifest
  isDistributed: false → spawn local child process
  isDistributed: true  → WebSocketServer.sendToNode(nodeId, job)
                                   │
                              Remote node receives job
                              executes local plugin
                              returns JSON result
                                   │
                         WebSocketServer resolves Promise
                                   │
                         toolExecutor gets result
                         injects into context
```

---

## 5. Key Configuration Files

### 5.1 `config.env` (from `config.env.example`)

The master configuration file. Copy `config.env.example` to `config.env` and fill in values.

| Category | Key Examples | Purpose |
|---|---|---|
| **API Access** | `Key`, `API_Key`, `API_URL` | Inbound auth key, upstream LLM API key, upstream LLM base URL |
| **Specialised Keys** | `Image_Key`, `File_Key`, `VCP_Key`, `AdminPassword` | Auth for image/file endpoints, WebSocket, admin panel |
| **Server** | `Port` (default 6005) | Listening port |
| **Tool Loop** | `MaxVCPLoopStream`, `MaxVCPLoopNonStream` | Max tool-call iterations (default 5 each) |
| **Role Divider** | `EnableRoleDivider`, `RoleDividerSystem` | Enable context branching, marker text |
| **Knowledge Base** | `KNOWLEDGEBASE_ROOT_PATH`, `VECTORDB_DIMENSION` | Diary root path, embedding vector dimension (default 3072) |
| **RAG Tuning** | `RAG_BETA_DynamicInflation`, EPA weights | Live-tunable retrieval parameters |
| **Model Routing** | `ChinaModel1`, `WhitelistImageModel` | Model alias definitions, whitelist overrides |
| **Directories** | `AGENT_DIR_PATH`, `TVSTXT_DIR_PATH` | Custom paths for agent/TVS files |
| **Debug** | `DebugMode`, `CHAT_LOG_ENABLED` | Verbose logging, full request/response disk logging |

### 5.2 `agent_map.json`

Maps short agent aliases to their definition `.txt` files. Example:
```json
{
  "Nova": "Agent/Nova.txt",
  "Coco": "Agent/Coco.txt"
}
```
Reference in prompts as `{{Nova}}` or `{{Coco}}`.

### 5.3 `ModelRedirect.json`

Maps publicly visible model names to the actual identifiers sent to the upstream API:
```json
{
  "gpt-4o": "claude-opus-4-5",
  "gpt-4-turbo": "deepseek-chat"
}
```
Clients use familiar names; the backend can be swapped transparently.

### 5.4 `toolApprovalConfig.json`

Defines which tool invocations require human approval before execution. Supports per-tool and per-command granularity. Default approval timeout: 5 minutes. Administrators review and approve via the admin panel.

### 5.5 `toolbox_map.json`

A plugin discovery index. Normally auto-generated. Can be hand-edited to force-include or exclude specific plugins.

### 5.6 `rag_params.json`

Live-overrides for the 10 RAG tuning parameters without editing `config.env`. Changes are applied at query time without a server restart.

### 5.7 `docker-compose.yml`

Container orchestration. Mounts `/dailynote`, `/Plugin`, `/Agent`, and `/image` as volumes so data persists across container rebuilds. Exposes port 6005. References the `Dockerfile` for image build.

### 5.8 `plugin-manifest.json` (per-plugin)

Each plugin directory must contain this manifest. Key fields:

| Field | Description |
|---|---|
| `name` | Internal identifier (unique) |
| `displayName` | Human-readable name shown in admin panel |
| `pluginType` | `static` \| `synchronous` \| `asynchronous` \| `service` \| `messagePreprocessor` \| `hybridservice` |
| `entryPoint` | Relative path to main script + runtime (node/python/sh) |
| `communication` | `stdio` or `direct` |
| `capabilities` | Array of tool definitions (name, description, parameters) |
| `configSchema` | JSON Schema for plugin-specific config values |

---

## 6. Extension Points

VCP ToolBox is designed for extensibility. The following are the primary places to add custom functionality safely.

### 6.1 Custom Plugins

**Location:** `/Plugin/<YourPluginName>/`

**Steps:**
1. Create the directory.
2. Write `plugin-manifest.json` (see §5.8).
3. Implement the entry-point script (Node.js, Python, or shell).
4. For `synchronous` / `asynchronous` plugins use the **STDIO JSON protocol**:
   - Input (stdin): `{"commandId": "...", "params": {...}, "config": {...}}`
   - Output (stdout): `{"status": "success", "result": "...", "base64": "..."}`
5. Restart the server — Plugin.js auto-discovers the new plugin.

**Plugin types to choose from:**
- `synchronous` — best for short-lived tools (web search, file read).
- `asynchronous` — best for long-running jobs (video generation).
- `service` — best for persistent state (forum server, WebSocket relay).
- `messagePreprocessor` — best for transforming messages before LLM (content filter, auto-summariser).

### 6.2 Custom Agent Personalities

**Location:** `/Agent/<AgentName>.txt`

Write any system prompt content in plain text. Register the file in `agent_map.json`. Reference it in any system prompt with `{{AgentName}}`. Agents can themselves contain nested `{{Variable}}` references.

### 6.3 Template Variables (TVS)

**Location:** `/TVStxt/<VariableName>.txt`

Any `.txt` file placed here becomes available as `{{VarVariableName}}` in prompts. Useful for reusable prompt fragments, style guides, persona overlays, or policy documents.

### 6.4 Custom Message Preprocessors

Create a plugin with `"pluginType": "messagePreprocessor"`. The plugin receives the full `messages` array before the LLM call and can:
- Add context (e.g., inject current weather).
- Filter sensitive content.
- Reformat or compress long histories.
- Inject structured data (e.g., user profile).

Set execution order in `preprocessor_order.json`.

### 6.5 Knowledge Base Diaries

**Location:** `/dailynote/<DiaryName>/`

Drop any `.txt` or `.md` files into a subdirectory. KnowledgeBaseManager automatically indexes them. Reference in prompts with `[[DiaryName::RAG]]` for semantic retrieval or `[[DiaryName::Group]]` for full-group injection.

### 6.6 Distributed Compute Nodes

Deploy `VCPDistributedServer.js` on any remote machine (GPU server, file server, etc.). On startup it connects to the main VCPToolBox WebSocket and registers its locally-installed plugins. The main server then routes tool calls to it transparently. No code changes to the core are needed.

### 6.7 Model Redirect Rules

Edit `ModelRedirect.json` to add new aliases or redirect existing ones. Changes take effect immediately (file is read on each request).

### 6.8 RAG Parameter Tuning

Edit `rag_params.json` or use the admin panel's RAG Tuner tab. Changes are applied live. Parameters include: dynamic inflation factor, EPA weights, residual pyramid threshold, co-occurrence decay, K values, and score floors.

### 6.9 Tool Approval Policies

Edit `toolApprovalConfig.json` to define which tool calls require human sign-off before execution. Configure per tool name and per command ID.

---

---

# 第二部分 — 中文

---

## 1. 项目目的与概述

### VCP ToolBox 是什么？

**VCP（变量与命令协议，Variable & Command Protocol）ToolBox** 是一款开源 AI 中间件平台，充当用户前端、大型语言模型（LLM）与数百个专用工具插件之间的语义桥梁。它的设计旨在解决传统 AI 系统中三大根本性断层：

| 问题 | 传统 AI | VCP 解决方案 |
|---|---|---|
| 上下文碎片化 | Discord 机器人无法知晓 Web 会话中的讨论内容 | 跨端点统一分布式身份 |
| 工具调用机械化 | AI 仅能盲目遵循 JSON Schema | 语义意图理解——AI 知道*为何*组合工具 |
| 记忆失忆症 | 上下文窗口 = 全部记忆 | TagMemo V6 仿神经形态记忆 + AgentDream 记忆巩固 |

### 核心能力

1. **语义驱动的插件编排** —— AI 通过理解意图（而非仅匹配 Schema）选择并串联 300+ 个插件。
2. **持久化分布式身份** —— 单一 AI "灵魂"可同时在 Web、桌面和 API 客户端上运行。
3. **受生物启发的记忆** —— TagMemo V6 使用泄漏积分-发放（LIF）脉冲神经网络实现联想回忆；AgentDream 在 Agent "睡眠"期间巩固记忆。
4. **分布式计算** —— GPU 服务器农场、文件服务器和远程终端注册为节点，自动接收工具路由任务。
5. **完整 OpenAI 兼容性** —— 暴露 `/v1/chat/completions` 端点，任何 OpenAI 兼容客户端开箱即用。
6. **实时监控** —— 基于 Web 的管理面板提供实时指标、配置编辑、向量数据库管理和 RAG 参数调优。

### 技术栈

| 层次 | 技术 |
|---|---|
| 主运行时 | Node.js + Express |
| 向量数据库核心 | Rust（USearch / HNSW 算法）|
| 持久化存储 | SQLite（WAL 模式）|
| 实时消息传递 | WebSocket |
| 插件脚本 | Node.js、Python、Shell |
| 前端（管理面板）| 原生 JS + HTML |
| 部署方式 | Docker / docker-compose 或裸机部署 |

---

## 2. 目录结构与说明

```
VCPToolBox/
│
├── server.js                     # 应用入口；HTTP 服务器生命周期管理
├── Plugin.js                     # 插件编排引擎（3000+ 行）
├── WebSocketServer.js            # 分布式实时通信中枢
├── KnowledgeBaseManager.js       # 向量数据库 + RAG 管道（3000+ 行）
├── EPAModule.js                  # 语义空间分解（EPA 嵌入投影分析）
├── ResidualPyramid.js            # 多层次语义能量提取
├── EmbeddingUtils.js             # 批量嵌入 API 调用 + 重试逻辑
├── modelRedirectHandler.js       # 模型名称路由 / 别名
├── vcpInfoHandler.js             # 工具结果格式化与广播
├── diary-semantic-classifier.js  # 日记条目语义分类
├── diary-tag-batch-processor.js  # 批量标签处理工具
├── TextChunker.js                # 嵌入用智能文本分块
├── WorkerPool.js                 # 线程工作池管理
├── ResultDeduplicator.js         # 工具结果去重
│
├── modules/                      # 核心请求处理子模块
│   ├── chatCompletionHandler.js  # /v1/chat/completions 主聊天逻辑
│   ├── messageProcessor.js       # 变量/占位符解析引擎
│   ├── agentManager.js           # Agent 生命周期与注册
│   ├── roleDivider.js            # 通过角色标记的上下文分支
│   ├── vcpLoop/                  # VCP 工具调用循环
│   │   ├── toolCallParser.js     # 解析 <<<[TOOL_REQUEST]>>> 块
│   │   └── toolExecutor.js       # 将解析后的调用路由到 Plugin.js
│   └── handlers/                 # 流式/非流式响应逻辑
│
├── routes/                       # HTTP 路由定义
│   ├── adminPanelRoutes.js       # 系统监控、配置 CRUD、Agent 管理
│   ├── dailyNotesRoutes.js       # 知识库文件 CRUD
│   ├── forumApi.js               # 多 Agent 论坛操作
│   └── taskScheduler.js          # 异步定时任务调度
│
├── Plugin/                       # 插件生态（100+ 子目录）
│   ├── DailyNote*/               # 日记读写搜索插件
│   ├── AgentDream/               # 记忆巩固 + 梦境系统
│   ├── LightMemo/                # 活跃上下文记忆检索
│   ├── RAGDiaryPlugin/           # 被动 RAG 注入提示词
│   ├── FluxGen/, DoubaoGen/      # 图像生成插件
│   ├── SunoGen/, GrokVideo/      # 音频/视频合成
│   ├── VSearch/                  # VCP 专有网络搜索
│   ├── ChromeBridge/             # 浏览器自动化 + 截图
│   ├── FileOperator/             # AI 优化的文件编辑器
│   ├── CodeSearcher/             # 分布式 Rust 代码搜索
│   ├── ScheduleManager/          # 日历 + 任务调度
│   ├── VCPForum*/                # 多 Agent 论坛生态（5 个插件）
│   ├── AgentAssistant/           # Agent 间委托
│   ├── MCPO/                     # MCP 协议适配器
│   └── [90+ 更多插件]
│
├── Agent/                        # Agent 人格定义文件
│   ├── Nova.txt                  # 示例 Agent：Nova
│   ├── Coco.txt                  # 示例 Agent：Coco
│   └── [自定义 Agent...]
│
├── TVStxt/                       # 模板变量系统文本模块
│   └── *.txt                     # 可复用提示词片段（{{VarXxx}}）
│
├── AdminPanel/                   # 基于 Web 的管理仪表盘
│   ├── index.html                # 主面板框架
│   ├── login.html                # 认证页面
│   └── js/                       # 面板 JS 模块（监控、RAG 调优器等）
│
├── dailynote/                    # 知识库根目录（Agent 记忆）
│   ├── ExampleMaid/              # 示例 Agent 记忆结构
│   ├── VCP开发/                  # VCP 开发笔记
│   ├── 前思维簇/                  # 前认知思维簇
│   ├── 逻辑推理簇/                # 逻辑推理簇
│   └── 反思簇/                   # 反思簇
│
├── docs/                         # 扩展文档
│   ├── API_ROUTES.md             # 路由参考
│   ├── CONFIGURATION.md          # 配置深度解析
│   ├── DISTRIBUTED_ARCHITECTURE.md # 分布式架构说明
│   └── CONTEXT_BRIDGE.md        # 上下文桥接说明
│
├── rust-vexus-lite/              # Rust 向量索引引擎（HNSW）
├── VCPChrome/                    # 浏览器扩展（Manifest V3）
├── SillyTavernSub/               # SillyTavern 子集成
├── OpenWebUISub/                 # OpenWebUI 子集成
├── image/                        # 缓存的生成图像 + 表情包
│
├── config.env.example            # 主配置模板（150+ 选项）
├── agent_map.json.example        # Agent 别名→文件映射模板
├── ModelRedirect.json.example    # 模型名称重映射模板
├── toolApprovalConfig.json       # 工具授权矩阵
├── toolbox_map.json              # 插件发现地图
├── rag_params.json               # 实时 RAG 参数覆盖
├── package.json                  # Node.js 依赖 + 脚本
├── docker-compose.yml            # 容器编排
├── Dockerfile                    # 容器镜像定义
├── requirements.txt              # Python 依赖
├── pyproject.toml / poetry.lock  # Python 项目元数据
└── start_server.bat / update.bat # Windows 辅助脚本
```

---

## 3. 核心模块与职责

### 3.1 `server.js` — 应用入口点

- 启动 Express HTTP 服务器（默认端口 `6005`）。
- 注册所有路由组：聊天完成、管理面板、日记、论坛、文件/图像服务。
- 初始化 WebSocketServer、Plugin 子系统和 KnowledgeBaseManager。
- 在所有路由上强制执行 API Key 认证。
- 应用 IP 黑名单和速率限制中间件。
- 管理全局 HTTP 连接池（最多 10,000 个 keep-alive 套接字），使用 LIFO 调度以最大化套接字复用。
- 自动清理超时请求。

### 3.2 `Plugin.js` — 插件编排引擎

- 启动时扫描 `/Plugin/*/plugin-manifest.json` 以发现所有插件。
- 根据 Schema 验证每个 manifest 并按类型分类插件：
  - `static` — 返回固定字符串；无子进程。
  - `synchronous` — 每次调用生成子进程；等待结果。
  - `asynchronous` — 生成后立即返回；结果稍后传递。
  - `service` — 以 Node.js 模块形式导入的长期运行守护进程。
  - `messagePreprocessor` — 在 LLM 看到消息之前拦截并转换消息。
  - `hybridservice` — 结合 service + 分布式委托。
- 动态将可用工具描述注入系统提示词，使 LLM 知晓可调用的工具。
- 将调用路由到本地子进程执行（STDIO 协议）或远程分布式节点（WebSocket）。
- 实现子进程生命周期管理：超时、错误捕获、优雅终止。

### 3.3 `WebSocketServer.js` — 分布式通信中枢

- 在单个 WebSocket 服务器上多路复用五类客户端：
  - `VCPLog` — 向管理面板实时流式传输日志。
  - `VCPInfo` — 广播结构化工具调用信息。
  - `DistributedServer` — 远程插件节点注册和任务路由。
  - `ChromeControl` — 向 VCPChrome 浏览器扩展发送命令。
  - `AdminPanel` — 与管理仪表盘双向通信。
- 使用 `VCP_Key` 密钥认证连接。
- 跟踪 Promise 回调，将异步工具结果匹配回等待的请求。
- 处理节点注册：远程服务器声明其插件；Plugin.js 将这些能力标记为可用。

### 3.4 `KnowledgeBaseManager.js` — 向量数据库与 RAG 管道

- 通过 Chokidar 监视 `/dailynote/**` 的文件添加、修改和删除。
- 文件变更时：读取文件 → 哈希内容 → 分块文本（可配置大小/重叠）→ 调用嵌入 API（批量，指数退避重试）→ 更新 SQLite 元数据表 → 刷新 USearch HNSW 索引。
- 每个日记目录维护一个向量索引，另有全局标签索引。
- 2 小时后卸载空闲索引以回收内存。
- 暴露 `semanticSearch(query, diaryName, k)` 供 RAG 注入插件使用。
- 维护共现矩阵以实现拓扑感知记忆遍历。
- 支持 10 个可调 RAG 参数（可从管理面板实时调整，无需重启）。

### 3.5 `EPAModule.js` — 语义空间分解

- 对日记的标签嵌入向量执行 K-Means 聚类。
- 应用加权 PCA 找到主要语义轴。
- 使用 Gram-Schmidt 正交化产生正交规范基。
- 为每个查询输出三个标量分数：
  - `logicDepth` — 查询的分析深度。
  - `worldviewGating` — 世界观范围的宽窄。
  - `resonance` — 查询的情感/动机能量。
- 这些分数进入 TagMemo V6 脉冲传播步骤以调优检索。

### 3.6 `ResidualPyramid.js` — 多层语义分解

- 获取查询嵌入，使用 Gram-Schmidt 投影在三个抽象层次上分解。
- 第 1 层捕获主导概念；第 2 层捕获去除第 1 层后的残差；第 3 层捕获剩余细微差别。
- 防止过拟合到高频概念簇。
- 对结果加权组合以产生更丰富的搜索向量。

### 3.7 `modules/chatCompletionHandler.js` — 聊天 API 逻辑

- 实现 `/v1/chat/completions` 端点（OpenAI 兼容）。
- 调用 `messageProcessor.js` 解析所有 `{{变量}}` 和 `[[日记名::RAG]]` 占位符。
- 可选调用 `roleDivider.js` 跨角色边界拆分消息。
- 按配置顺序运行消息预处理插件。
- 维护 **VCP 工具循环**（默认最多 5 次迭代）：
  1. 将消息 + 工具描述发送给上游 LLM。
  2. 流式传输响应；检测 `<<<[TOOL_REQUEST]>>>` 块。
  3. 用 `toolCallParser.js` 解析每个块。
  4. 用 `toolExecutor.js` 执行每个工具。
  5. 将工具结果追加到上下文；循环直至无更多工具请求。
- 支持流式（SSE）和非流式响应模式。
- 向 WebSocket 监听器（`VCPInfo`、`VCPLog`）广播最终答案。

### 3.8 `modules/messageProcessor.js` — 变量解析引擎

- 在消息到达 LLM 之前解析系统/用户消息中的占位符令牌。
- 支持的占位符类型：

| 语法 | 解析为 |
|---|---|
| `{{Date}}` / `{{Time}}` | 当前日期/时间 |
| `{{AgentName}}` | `/Agent/AgentName.txt` 的内容 |
| `{{VarXxxxx}}` | `/TVStxt/Xxxxx.txt` 的内容 |
| `[[DiaryName::RAG]]` | 语义检索的日记条目 |
| `[[DiaryName::Group]]` | 日记组的所有条目 |

- 执行递归解析（一个变量可以引用其他变量）。
- 检测并打破循环依赖。
- 执行权限级别以防止用户控制的消息注入系统级变量。

### 3.9 `modules/roleDivider.js` — 上下文分支

- 解析嵌入消息中的特殊角色边界标记：
  - `<<<[ROLE_DIVIDE_SYSTEM]>>>` — 拆分出仅系统指令块。
  - `<<<[ROLE_DIVIDE_USER]>>>` — 内容变为用户消息。
  - `<<<[ROLE_DIVIDE_ASSISTANT]>>>` — 预填充助手轮次。
- 支持复杂的上下文手术：并行推理分支、强制助手"热启动"和多角色对话。

### 3.10 `modelRedirectHandler.js` — 模型名称路由

- 在运行时读取 `ModelRedirect.json`。
- 将面向公众的模型名称（如 `gpt-4o`）转换为上游 API 所需的实际后端标识符。
- 支持聊天、图像和嵌入模型的独立白名单。
- 允许在不更改客户端配置的情况下切换底层模型提供商。

### 3.11 `vcpInfoHandler.js` — 工具结果格式化

- 将工具调用结果标准化为 VCP 循环上下文所期望的格式。
- 在注入文本上下文之前剥离二进制负载（Base64 图像）。
- 向 WebSocket 订阅者（管理面板、日志查看器）广播结构化 `VCPInfo` 事件。

---

## 4. 数据流与组件交互

### 4.1 聊天请求生命周期

```
┌─────────────────────────────────────────────────────────────────┐
│  客户端（VCPChat / SillyTavern / 任何 OpenAI 兼容 UI）             │
└─────────────────────────────┬───────────────────────────────────┘
                              │  POST /v1/chat/completions
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  server.js                                                       │
│  • 验证 API Key                                                  │
│  • 速率限制检查                                                   │
│  • 转发至 chatCompletionHandler                                   │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  messageProcessor.js                                             │
│  • 解析 {{变量}}、{{Agent 定义}}、[[RAG]] 占位符                   │
│  • 调用 KnowledgeBaseManager 获取语义搜索片段                     │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  roleDivider.js（可选）                                           │
│  • 在角色边界标记处拆分上下文                                      │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  messagePreprocessor 插件（有序管道）                             │
│  • 在 LLM 看到消息之前可添加/删除/转换消息                         │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  上游 LLM API（OpenAI / Claude / Gemini / 本地模型）              │
│  • 接收完全解析的消息 + 工具描述                                   │
│  • 返回流式或缓冲响应                                             │
└─────────────────────────────┬───────────────────────────────────┘
                              │
          ┌───────────────────▼──────────────────────┐
          │       VCP 工具循环（最多 N 次迭代）         │
          │                                           │
          │  解析 <<<[TOOL_REQUEST]>>> 块              │
          │              │                            │
          │              ▼                            │
          │  toolExecutor.js → Plugin.js              │
          │    ┌─────────────────────────────┐        │
          │    │ 本地插件？                   │        │
          │    │  → 生成子进程                │        │
          │    │  → STDIO JSON 协议           │        │
          │    │                             │        │
          │    │ 分布式插件？                 │        │
          │    │  → WebSocketServer          │        │
          │    │  → 远程节点执行              │        │
          │    │  → 结果回调                 │        │
          │    └─────────────────────────────┘        │
          │              │                            │
          │  将结果追加到上下文                         │
          │  循环直至无更多工具请求                      │
          └───────────────────┬──────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  响应传递给客户端（SSE 流或 JSON 体）                              │
│  + 广播至 WebSocket 订阅者（VCPLog、AdminPanel）                  │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 知识库同步管道

```
用户编辑 /dailynote/<Agent>/<文件>.txt
           │
           ▼  （Chokidar 文件监视器）
KnowledgeBaseManager.onFileChange()
           │
           ├─ 哈希内容 → 未变更则跳过
           ├─ TextChunker.js → 拆分为令牌边界块
           ├─ EmbeddingUtils.js → 通过 API 批量嵌入块
           ├─ SQLite 更新插入（元数据 + 块文本）
           └─ USearch HNSW 索引刷新
                       │
                       ▼
           WebSocket 广播 → AdminPanel 更新 UI
                       │
                       ▼
           下次 RAG 查询使用最新向量（无需重启）
```

### 4.3 分布式插件执行

```
chatCompletionHandler 检测到工具请求
           │
           ▼
Plugin.js 检查插件 manifest
  isDistributed: false → 生成本地子进程
  isDistributed: true  → WebSocketServer.sendToNode(nodeId, 任务)
                                   │
                              远程节点接收任务
                              执行本地插件
                              返回 JSON 结果
                                   │
                         WebSocketServer 解析 Promise
                                   │
                         toolExecutor 获取结果
                         注入上下文
```

---

## 5. 关键配置文件与可自定义项

### 5.1 `config.env`（来自 `config.env.example`）

主配置文件。将 `config.env.example` 复制为 `config.env` 并填入值。

| 类别 | 示例键名 | 用途 |
|---|---|---|
| **API 访问** | `Key`、`API_Key`、`API_URL` | 入站认证密钥、上游 LLM API 密钥、上游 LLM 基础 URL |
| **专用密钥** | `Image_Key`、`File_Key`、`VCP_Key`、`AdminPassword` | 图像/文件端点、WebSocket、管理面板的认证 |
| **服务器** | `Port`（默认 6005）| 监听端口 |
| **工具循环** | `MaxVCPLoopStream`、`MaxVCPLoopNonStream` | 最大工具调用迭代次数（各默认 5）|
| **角色分割器** | `EnableRoleDivider`、`RoleDividerSystem` | 启用上下文分支、标记文本 |
| **知识库** | `KNOWLEDGEBASE_ROOT_PATH`、`VECTORDB_DIMENSION` | 日记根路径、嵌入向量维度（默认 3072）|
| **RAG 调优** | `RAG_BETA_DynamicInflation`、EPA 权重 | 实时可调检索参数 |
| **模型路由** | `ChinaModel1`、`WhitelistImageModel` | 模型别名定义、白名单覆盖 |
| **目录** | `AGENT_DIR_PATH`、`TVSTXT_DIR_PATH` | Agent/TVS 文件的自定义路径 |
| **调试** | `DebugMode`、`CHAT_LOG_ENABLED` | 详细日志记录、完整请求/响应磁盘日志 |

### 5.2 `agent_map.json`

将简短 Agent 别名映射到其定义 `.txt` 文件。示例：
```json
{
  "Nova": "Agent/Nova.txt",
  "Coco": "Agent/Coco.txt"
}
```
在提示词中以 `{{Nova}}` 或 `{{Coco}}` 引用。

### 5.3 `ModelRedirect.json`

将公开可见的模型名称映射到发送给上游 API 的实际标识符：
```json
{
  "gpt-4o": "claude-opus-4-5",
  "gpt-4-turbo": "deepseek-chat"
}
```
客户端使用熟悉的名称；后端可透明切换。

### 5.4 `toolApprovalConfig.json`

定义哪些工具调用在执行前需要人工审批。支持按工具和按命令粒度配置。默认审批超时：5 分钟。管理员通过管理面板审核并批准。

### 5.5 `toolbox_map.json`

插件发现索引。通常自动生成。可手动编辑以强制包含或排除特定插件。

### 5.6 `rag_params.json`

不修改 `config.env` 即可对 10 个 RAG 调优参数进行实时覆盖。更改在查询时应用，无需服务器重启。

### 5.7 `docker-compose.yml`

容器编排。将 `/dailynote`、`/Plugin`、`/Agent` 和 `/image` 挂载为卷，以便数据在容器重建后持久保存。暴露端口 6005。引用 `Dockerfile` 进行镜像构建。

### 5.8 `plugin-manifest.json`（每个插件）

每个插件目录必须包含此 manifest。关键字段：

| 字段 | 描述 |
|---|---|
| `name` | 内部标识符（唯一）|
| `displayName` | 管理面板中显示的人类可读名称 |
| `pluginType` | `static` \| `synchronous` \| `asynchronous` \| `service` \| `messagePreprocessor` \| `hybridservice` |
| `entryPoint` | 主脚本的相对路径 + 运行时（node/python/sh）|
| `communication` | `stdio` 或 `direct` |
| `capabilities` | 工具定义数组（名称、描述、参数）|
| `configSchema` | 插件特定配置值的 JSON Schema |

---

## 6. 扩展点

VCP ToolBox 为可扩展性而设计。以下是安全添加自定义功能的主要位置。

### 6.1 自定义插件

**位置：** `/Plugin/<你的插件名>/`

**步骤：**
1. 创建目录。
2. 编写 `plugin-manifest.json`（参见 §5.8）。
3. 实现入口脚本（Node.js、Python 或 Shell）。
4. 对于 `synchronous` / `asynchronous` 插件，使用 **STDIO JSON 协议**：
   - 输入（stdin）：`{"commandId": "...", "params": {...}, "config": {...}}`
   - 输出（stdout）：`{"status": "success", "result": "...", "base64": "..."}`
5. 重启服务器——Plugin.js 自动发现新插件。

**可选择的插件类型：**
- `synchronous` —— 最适合短暂工具（网络搜索、文件读取）。
- `asynchronous` —— 最适合长时间运行的任务（视频生成）。
- `service` —— 最适合持久状态（论坛服务器、WebSocket 中继）。
- `messagePreprocessor` —— 最适合在 LLM 之前转换消息（内容过滤器、自动摘要器）。

### 6.2 自定义 Agent 人格

**位置：** `/Agent/<AgentName>.txt`

用纯文本编写任何系统提示内容。在 `agent_map.json` 中注册文件。在任何系统提示中以 `{{AgentName}}` 引用。Agent 本身可以包含嵌套的 `{{变量}}` 引用。

### 6.3 模板变量（TVS）

**位置：** `/TVStxt/<VariableName>.txt`

放置在此处的任何 `.txt` 文件都可以在提示词中以 `{{VarVariableName}}` 使用。适用于可复用提示词片段、风格指南、人格叠加或政策文档。

### 6.4 自定义消息预处理器

创建一个 `"pluginType": "messagePreprocessor"` 的插件。插件在 LLM 调用之前接收完整的 `messages` 数组，并可以：
- 添加上下文（例如注入当前天气）。
- 过滤敏感内容。
- 重新格式化或压缩长历史记录。
- 注入结构化数据（例如用户资料）。

在 `preprocessor_order.json` 中设置执行顺序。

### 6.5 知识库日记

**位置：** `/dailynote/<DiaryName>/`

将任何 `.txt` 或 `.md` 文件放入子目录。KnowledgeBaseManager 自动为其建立索引。在提示词中以 `[[DiaryName::RAG]]` 引用以进行语义检索，或以 `[[DiaryName::Group]]` 引用以注入完整组。

### 6.6 分布式计算节点

在任何远程机器（GPU 服务器、文件服务器等）上部署 `VCPDistributedServer.js`。启动时它连接到主 VCPToolBox WebSocket 并注册其本地安装的插件。主服务器随后透明地将工具调用路由到该节点。无需对核心代码进行任何更改。

### 6.7 模型重定向规则

编辑 `ModelRedirect.json` 以添加新别名或重定向现有别名。更改立即生效（每次请求时读取文件）。

### 6.8 RAG 参数调优

编辑 `rag_params.json` 或使用管理面板的 RAG 调优器选项卡。更改实时应用。参数包括：动态膨胀因子、EPA 权重、残差金字塔阈值、共现衰减、K 值和分数下限。

### 6.9 工具审批策略

编辑 `toolApprovalConfig.json` 以定义哪些工具调用在执行前需要人工确认。按工具名称和命令 ID 进行配置。

---

## 附录：TagMemo V6 记忆架构简述

TagMemo V6 是 VCP 的旗舰记忆系统，结合了多种神经科学启发的技术：

| 组件 | 作用 |
|---|---|
| **EPA（嵌入投影分析）** | 将查询映射到语义维度空间（逻辑深度、世界观门控、共鸣）|
| **残差金字塔** | 多层次语义分解，防止主导概念遮蔽细节 |
| **LIF 脉冲模型** | 泄漏积分-发放神经模型，通过共现拓扑传播激活 |
| **共现矩阵** | 发现通过拓扑联系的相关记忆 |
| **动态参数** | 无需重启即可在 Web 面板中调整 |
| **性能指标** | 100k 标签 0.7ms 搜索，RAG 检索 < 1 秒 |

## 附录：AgentDream 记忆巩固

AgentDream 在 Agent "睡眠"期间运行，使用三波架构：

| 波次 | 时间范围 | 功能 |
|---|---|---|
| 近期涟漪 | 0-30 天 | 处理最新记忆 |
| 中期回响 | 7-90 天 | 整合中期记忆 |
| 深层潮汐 | > 90 天 | 处理长期核心记忆 |

所有记忆修改均需管理员审核，以防止幻觉导致的记忆污染。

---

*Document generated: 2026-03-31*
*文档生成日期：2026-03-31*
