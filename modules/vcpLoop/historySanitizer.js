// modules/vcpLoop/historySanitizer.js
//
// 历史上下文净化：剥除历史消息尾部未闭合的 VCP 工具调用残片。
//
// 病灶（2026-09-11 排查结论）：
//   单轮工具递归触及 MaxVCPLoopStream 熔断时，模型输出可能在
//   <<<[TOOL_REQUEST]>>> 之后被物理截断，缺少闭合的
//   <<<[END_TOOL_REQUEST]>>>。这段残片随流式响应透传给前端并落盘进
//   history.json。下一次用户发送“继续”时，残片被重新送入模型，引发
//   Attention 撕裂；同时后端 ToolCallParser 在回溯文本时可能把残片与
//   紧随的新工具块拼成畸形块，导致 FileOperator: Unknown action: undefined
//   之类的幽灵解析。
//
// 职责范围：
//   - 在请求进入 VCP 处理管线的最早阶段，扫描 messages 中的字符串
//     content，剥除未被 END_TOOL_REQUEST 闭合的工具块残片。
//   - 已完整闭合的历史工具块原样保留（它们是任务历史的一部分）。
//
// 安全约束：
//   - 只处理字符串 content，不动包含多模态 parts 的数组。
//   - 只处理“尾部未闭合”块，不从正文中间剥离合法内容。
//   - 若某消息内存在未闭合块，从该块 START 起剥到消息末尾。保守策略：
//     宁可切除该块之后可能存在的少量正文，也不留下残片重新进入循环。

const START_MARKER = '<<<[TOOL_REQUEST]>>>';
const END_MARKER = '<<<[END_TOOL_REQUEST]>>>';

/**
 * 逐标记扫描，判断一段纯文本是否存在未闭合的工具块残片。
 * 兼容一个消息中出现多个完整块后夹一个尾部残片的情况。
 *
 * @param {string} text
 * @returns {{hasUnclosed: boolean, cutIndex: number}}
 */
function inspectToolBlockClosure(text) {
  if (typeof text !== 'string' || !text.includes(START_MARKER)) {
    return { hasUnclosed: false, cutIndex: -1 };
  }

  let cursor = 0;
  let openStart = -1; // 当前未闭合块的 START 位置

  while (cursor < text.length) {
    const nextStart = text.indexOf(START_MARKER, cursor);
    const nextEnd = text.indexOf(END_MARKER, cursor);

    // 两侧都没有更多标记，退出扫描
    if (nextStart === -1 && nextEnd === -1) break;

    // 先遇到 END：它闭合了先前记录的 START
    if (nextEnd !== -1 && (nextStart === -1 || nextEnd < nextStart)) {
      openStart = -1;
      cursor = nextEnd + END_MARKER.length;
      continue;
    }

    // 先遇到 START：仅记录第一个未闭合起点，后续出现的 START 不覆盖它
    if (nextStart !== -1) {
      if (openStart === -1) {
        openStart = nextStart;
      }
      cursor = nextStart + START_MARKER.length;
      continue;
    }
  }

  return openStart === -1
    ? { hasUnclosed: false, cutIndex: -1 }
    : { hasUnclosed: true, cutIndex: openStart };
}

/**
 * 对单个字符串内容做净化。若无需净化，返回原文。
 *
 * @param {string} content
 * @returns {string}
 */
function sanitizeContent(content) {
  if (typeof content !== 'string') return content;
  const { hasUnclosed, cutIndex } = inspectToolBlockClosure(content);
  if (!hasUnclosed || cutIndex < 0) return content;
  return content.slice(0, cutIndex);
}

/**
 * 就地净化 messages 数组中每一条字符串 content。
 *
 * @param {Array} messages
 * @param {{ debugMode?: boolean, onSanitize?: (info: {index:number, role:string, lostChars:number}) => void }} [options]
 * @returns {Array} 与入参同一引用（就地修改）
 */
function sanitizeHistoryMessages(messages, options = {}) {
  if (!Array.isArray(messages)) return messages;
  const { debugMode = false, onSanitize } = options;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg.content !== 'string') continue;
    const original = msg.content;
    const cleaned = sanitizeContent(original);
    if (cleaned !== original) {
      msg.content = cleaned;
      const lostChars = original.length - cleaned.length;
      if (debugMode) {
        console.warn(
          '[HistorySanitizer] Stripped unclosed tool block fragment at messages[' +
          i + '] (role=' + msg.role + '). lost=' + lostChars + ' chars.'
        );
      }
      if (typeof onSanitize === 'function') {
        try {
          onSanitize({ index: i, role: msg.role, lostChars });
        } catch (_) {
          // 回调失败不得中断净化主流程
        }
      }
    }
  }

  return messages;
}

module.exports = {
  inspectToolBlockClosure,
  sanitizeContent,
  sanitizeHistoryMessages
};