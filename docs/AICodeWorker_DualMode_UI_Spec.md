# AICodeWorker 双模态前端架构与实现规范

> **设计者**: 折枝 (VCP Front-end Designer)  
> **版本**: v2.0.0 (Dual-Mode Edition)  
> **状态**: 评审通过 / 待装配接入  
> **适用对象**: 赞妮, Nova, Codex, 架构师  

---

## 1. 架构总览 (Architecture Overview)

AICodeWorker 前端交互采用 **双模态共生体系（Dual-Mode Architecture）**：
1. **全屏独立工作台模态 (Full Tab View)**：面向深度排查、全量 Diff 审查、历史追踪的大屏独立视窗。
2. **伴随抽屉检查器模态 (Inspector Drawer)**：面向日常对话时轻量监视、零遮挡边聊边看、支持 `Esc` 快速闭合的侧滑抽屉。

```
[VCPChat Global App Matrix] ───────► (Click) ──► Top TabBar [⚡ AICodeWorker ✕] (Tab View)
                                                        │ (Single Store Subscribed)
[Global Top-Right Status Ring] ────► (Click) ──► Right Drawer Inspector (380px~520px)
```

---

## 2. 详细交互规格 (Interaction Specs)

### 2.1 入口 A：主页应用矩阵 (App Matrix)
- **图标标识**: 水碧渐变徽标，图标 `⚡`，名称 `代码调度`。
- **行为契约**:
  - 点击检查顶部 TabBar 是否已存在 `id: 'aicodeworker'` 的 Tab。
  - 若已存在，则触发 `TabBar.activate('aicodeworker')`。
  - 若不存在，则动态实例化 Tab 并切换为主视窗。
  - 点击 Tab 上的 `✕` 关闭标签页时，仅卸载视图 DOM，**不得终止后台正在运行的 Job**。

### 2.2 入口 B：右上角常驻任务指示器 (Inspector Trigger)
- **常驻位置**: VCPChat 窗口右上角系统状态区。
- **视觉特征**: 带微光呼吸动效的环形进度与活跃任务计数 `[⚡ 任务监视 (N)]`。
- **行为契约**:
  - 点击自右侧平滑滑出抽屉 (`transform: translateX(0)`)，宽度 380px。
  - 支持快捷键 `Esc` 退出。
  - 提供 `全屏放大 ↗` 按钮，一键切换至 Tab View 并收起抽屉。

---

## 3. 状态管理与数据流 (Store & Event Bus)

两端必须严格订阅全局唯一的 `AICodeWorkerStore` 单例，禁止在抽屉与 Tab 中各自维护独立轮询。

```javascript
// 核心状态模型
export class AICodeWorkerStore extends EventTarget {
  constructor() {
    super();
    this.jobs = new Map(); // jobId -> JobModel
    this.activeJobId = null;
    this.traceMode = 'summary'; // 'summary' | 'events' | 'raw'
  }

  updateJob(jobId, partial) {
    const current = this.jobs.get(jobId) || { id: jobId, logs: [], diff: null, status: 'queued' };
    this.jobs.set(jobId, { ...current, ...partial });
    this.dispatchEvent(new CustomEvent('job-change', { detail: { jobId, job: this.jobs.get(jobId) } }));
  }

  async killJob(jobId) {
    // 调用后端安全终止进程树
    return window.vcpApi.invokeWorkerCommand({ command: 'cancel', jobId });
  }
}
export const workerStore = new AICodeWorkerStore();
```

---

## 4. 视图层级与 Trace 三态流契约

执行轨迹展示统一提供三档过滤，格式如下：
1. **Summary 摘要档**: AI 提炼的关键阶段步骤（门禁通过、依赖扫描、补丁应用）。
2. **Events 事件档**: 树状结构化 JSONL 事件流（命令执行、文件变更 `+x/-y`、语法检查）。
3. **Raw CLI 终端档**: 纯文本终端输出（自动过滤内部思考 token，脱敏保护）。

---

## 5. 安全与进程清理原则 (Task Tree Teardown)
- 前端点击「🛑 安全终止 (Kill PID)」时，严格按当前 Job 的 `workerPid` 发起精准终止，绝不执行全局同名进程查杀。
- 终止请求触发后，UI 进入 `terminating` 状态并开启轮询，直至收到后端的确认清理回执。