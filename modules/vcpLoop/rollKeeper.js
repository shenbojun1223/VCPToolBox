'use strict';
// modules/vcpLoop/rollKeeper.js
// 轮数保真器（rollKeeper）：补“低 token 高轮数”监控真空。
//   黄灯：递归深度逼近 maxRecursion 时，向消息数组注入一次 system 状态简报请求。
//   Token 黄灯：循环内文本上下文估算达到软预算阈值时，注入一次收拢任务提醒。
//   重复失败硬暂停：同一工具同一参数连续失败达到阈值时，返回 repeat_halt 停止本循环。
// 全部判据均为确定性计算，不引入任何 LLM 调用、不改变既有 token 水位与熔断收口。
// Token 计数基于本地文本估算（finalContextStore.countTokensForText），
// 仅作参考口径，不是上游实测用量，也不是模型窗口的证明。

const crypto = require('crypto');
const { countTokensForText } = require('../finalContextStore.js');

// 递归排序对象 key 的稳定序列化：保证 { a: 1, b: 2 } 与 { b: 2, a: 1 } 指纹一致。
function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys
    .map((key) => JSON.stringify(key) + ':' + stableStringify(value[key]))
    .join(',') + '}';
}

function fingerprintOf(name, args) {
  return crypto
    .createHash('sha256')
    .update(String(name) + '\0' + stableStringify(args))
    .digest('hex');
}

// 仅提取可安全视为文本的部分：string content 与数组里 type=text 的 text。
// 换行连接后一次性交给 countTokensForText；base64/图片等非文本部分绝不参与计数。
function extractTextFromMessages(messages) {
  if (!Array.isArray(messages)) return '';
  const chunks = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const content = message.content;
    if (typeof content === 'string') {
      chunks.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && part.type === 'text' && typeof part.text === 'string') {
          chunks.push(part.text);
        }
      }
    }
  }
  return chunks.join('\n');
}

function buildDepthYellowContent(recursionDepth, maxRecursion) {
  return [
    '[系统·轮数保真器·黄灯] 递归深度已接近上限（' + recursionDepth + '/' + maxRecursion + '）。',
    '请在继续调用任何工具之前，先用简短自然语言把当前状态外化给自己，明确写出：',
    '1. 目标：本轮任务的最终目标是什么；',
    '2. 已完成：已经确证完成的步骤；',
    '3. 未决：尚未确认或仍存在不确定的部分；',
    '4. 下一步：接下来最小、必要的一步是什么。',
    '完成上述简报后，再决定是否仍需调用工具。'
  ].join('\n');
}

function buildTokenYellowContent(tokenCount, threshold, tokenBudget, tokenYellowRatio) {
  const percent = Math.round(tokenYellowRatio * 100);
  return [
    '[系统·轮数保真器·Token 黄灯] 当前循环消息文本估算约 ' + tokenCount + ' tokens，已达到软预算阈值 ' + threshold + '（软预算 ' + tokenBudget + ' tokens 的 ' + percent + '%）。',
    '说明：这是本地文本上下文估算（cl100k_base 参考分词口径，分词器不可用时回退启发式），不是上游实测用量，也不代表所有上游按同一口径计费，更不是模型窗口的证明；附件与多模态内容未计入。',
    '请在继续调用任何工具之前，先用简短自然语言把当前状态外化给自己：',
    '1. 目标：本轮任务的最终目标是什么；',
    '2. 已完成：已经确证完成的步骤；',
    '3. 未决：尚未确认或仍存在不确定的部分；',
    '4. 下一步：接下来最小、必要的一步是什么。',
    '并开始收拢任务：优先收敛未决项或给出明确的完成/受阻结论，不再无边界地扩张新工作。'
  ].join('\n');
}

function buildRepeatHaltContent(name, repeatThreshold) {
  return [
    '[系统·轮数保真器·重复失败硬暂停] 工具 "' + name + '" 已使用完全相同参数连续失败 ' + repeatThreshold + ' 次。',
    '本轮工具循环已停止，不再重试该调用；任务尚未完成。',
    '请改为用一段自然语言报告阻塞点：说明失败的工具、观测到的错误表现、已尝试过的规避方案，',
    '以及需要用户提供的新输入或替代路径；待用户检查阻塞原因并确认后再继续。'
  ].join('\n');
}

function createRollKeeper({
  maxRecursion,
  yellowLightOffset = 4,
  repeatThreshold = 3,
  tokenBudget = 0,
  tokenYellowRatio = 0.9
} = {}) {
  if (!Number.isInteger(maxRecursion) || maxRecursion <= 0) {
    throw new TypeError('rollKeeper: maxRecursion must be a positive integer.');
  }
  if (!Number.isInteger(yellowLightOffset) || yellowLightOffset < 0) {
    throw new TypeError('rollKeeper: yellowLightOffset must be a non-negative integer.');
  }
  if (!Number.isInteger(repeatThreshold) || repeatThreshold <= 0) {
    throw new TypeError('rollKeeper: repeatThreshold must be a positive integer.');
  }
  if (typeof tokenBudget !== 'number' || !Number.isFinite(tokenBudget) || tokenBudget < 0) {
    throw new TypeError('rollKeeper: tokenBudget must be a finite non-negative number.');
  }
  if (typeof tokenYellowRatio !== 'number' || !Number.isFinite(tokenYellowRatio) ||
      tokenYellowRatio <= 0 || tokenYellowRatio > 1) {
    throw new TypeError('rollKeeper: tokenYellowRatio must be a finite number in (0, 1].');
  }

  const yellowLightThreshold = maxRecursion - yellowLightOffset;
  // tokenBudget=0 表示禁用 token 黄灯；否则阈值为 ceil(budget * ratio)。
  const tokenYellowThreshold = tokenBudget > 0 ? Math.ceil(tokenBudget * tokenYellowRatio) : null;

  let yellowLightSent = false;
  let tokenYellowSent = false;
  let repeatSent = false;
  let lastFingerprint = null;
  // 最近一次失败所属的工具名，仅用于生成提示文案（不参与判据计算）。
  let lastFingerprintName = null;
  let failureCount = 0;

  // 优先级：repeat_halt > token_yellow > depth_yellow。每次 evaluate 至多返回一条。
  function evaluate({ recursionDepth, messages } = {}) {
    if (!repeatSent && failureCount >= repeatThreshold) {
      repeatSent = true;
      return { kind: 'repeat_halt', content: buildRepeatHaltContent(lastFingerprintName, repeatThreshold) };
    }

    if (!tokenYellowSent && tokenYellowThreshold !== null) {
      const { tokenCount } = countTokensForText(extractTextFromMessages(messages));
      if (tokenCount >= tokenYellowThreshold) {
        tokenYellowSent = true;
        return {
          kind: 'token_yellow',
          content: buildTokenYellowContent(tokenCount, tokenYellowThreshold, tokenBudget, tokenYellowRatio)
        };
      }
    }

    if (!yellowLightSent && Number.isFinite(recursionDepth) && recursionDepth >= yellowLightThreshold) {
      yellowLightSent = true;
      return { kind: 'depth_yellow', content: buildDepthYellowContent(recursionDepth, maxRecursion) };
    }

    return { kind: null, content: null };
  }

  function record({ name, args, success } = {}) {
    const fingerprint = fingerprintOf(name, args);

    if (success) {
      // 出现 success：失败计数与已发标志重置（指纹仍更新，作为新的连续基线）。
      lastFingerprint = fingerprint;
      lastFingerprintName = name;
      failureCount = 0;
      repeatSent = false;
      return;
    }

    if (fingerprint === lastFingerprint) {
      failureCount += 1;
    } else {
      // 指纹变化：开始一条新的连续失败序列，已发标志重置。
      lastFingerprint = fingerprint;
      lastFingerprintName = name;
      failureCount = 1;
      repeatSent = false;
    }
  }

  function reset() {
    yellowLightSent = false;
    tokenYellowSent = false;
    repeatSent = false;
    lastFingerprint = null;
    lastFingerprintName = null;
    failureCount = 0;
  }

  return { evaluate, record, reset };
}

module.exports = { createRollKeeper };
