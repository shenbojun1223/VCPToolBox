// modules/vcpLoop/toolPayloadTruncator.js
// 超大工具回执循环内截断：超过阈值的回执文本被替换为"头部+提示行+尾部"，
// 完整原文异步落盘到 DebugLog/toolPayloads/<日期>/，供模型或人工按需取回。
// 仅影响工具循环回填给上游的 payload，不影响 RAG 刷新输入与客户端展示。

const fs = require('fs').promises;
const path = require('path');

const positiveInt = (name, fallback) => {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const MAX_CHARS = positiveInt('VCP_TOOLPAYLOAD_MAX_CHARS', 30000);
const requestedHead = positiveInt('VCP_TOOLPAYLOAD_HEAD_CHARS', 8000);
const HEAD_CHARS = Math.min(requestedHead, Math.max(1, MAX_CHARS - 1));
const TAIL_CHARS = Math.min(
  positiveInt('VCP_TOOLPAYLOAD_TAIL_CHARS', 4000),
  Math.max(0, MAX_CHARS - HEAD_CHARS)
);

let sequence = 0;

function truncateText(text, toolNames) {
  if (typeof text !== 'string' || text.length <= MAX_CHARS) return text;

  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const stamp = `${date}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}-${String(now.getMilliseconds()).padStart(3, '0')}`;
  const safeTool = (toolNames.length ? toolNames.join('_') : 'unknown-tool')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 100);
  const file = `${stamp}_${safeTool}_${process.pid}_${sequence++}.txt`;
  const dir = path.resolve(process.cwd(), 'DebugLog', 'toolPayloads', date);
  const filePath = path.join(dir, file);
  const bytes = Buffer.byteLength(text, 'utf8');

  // 异步落盘，不阻塞工具循环；失败仅告警，截断结果仍然生效。
  fs.mkdir(dir, { recursive: true })
    .then(() => fs.writeFile(filePath, text, { encoding: 'utf8', flag: 'wx' }))
    .catch(error => console.warn(
      `[VCP ToolPayload] Full payload write failed; truncated payload retained: ${error.message}`
    ));

  return `${text.slice(0, HEAD_CHARS)}\n` +
    `[超大工具回执已截断（原文 ${text.length} 字符 / ${bytes} 字节）；完整原文: ${filePath}；如需未截断细节可用 FileOperator ReadFile 读取该文件]\n` +
    `${TAIL_CHARS ? text.slice(-TAIL_CHARS) : ''}`;
}

function truncateToolPayload(payload, options = {}) {
  if (options.exempt) return payload;
  const toolNames = [...new Set((options.toolNames || []).filter(Boolean).map(String))];
  if (typeof payload === 'string') return truncateText(payload, toolNames);
  if (!Array.isArray(payload)) return payload;
  return payload.map(part =>
    part && part.type === 'text' && typeof part.text === 'string'
      ? { ...part, text: truncateText(part.text, toolNames) }
      : part
  );
}

module.exports = { truncateToolPayload };