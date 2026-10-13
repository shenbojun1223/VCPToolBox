'use strict';
// modules/vcpLoop/rollKeeper.js
// 轮数保真器（rollKeeper）：补“低 token 高轮数”监控真空。
//   黄灯：递归深度逼近 maxRecursion 时，向消息数组注入一次 system 状态简报请求。
//   重复失败预警：同一工具同一参数连续失败达到阈值时，注入一次强指令（停止重试、报告阻塞）。
// 全部判据均为确定性计算，不引入任何 LLM 调用、不改变既有 token 水位与熔断收口。

const crypto = require('crypto');

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

function buildYellowContent(recursionDepth, maxRecursion) {
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

function buildRepeatContent(name, repeatThreshold) {
  return [
    '[系统·轮数保真器·重复失败预警] 工具 "' + name + '" 已使用完全相同参数连续失败 ' + repeatThreshold + ' 次。',
    '请立即停止对该调用的重试，不要再以相同参数重复调用同一工具；',
    '改为用一段自然语言报告阻塞点：说明失败的工具、观测到的错误表现、已尝试过的规避方案，',
    '以及需要用户提供的新输入或替代路径。'
  ].join('\n');
}

function createRollKeeper({ maxRecursion, yellowLightOffset = 4, repeatThreshold = 3 } = {}) {
  if (!Number.isInteger(maxRecursion) || maxRecursion <= 0) {
    throw new TypeError('rollKeeper: maxRecursion must be a positive integer.');
  }
  if (!Number.isInteger(yellowLightOffset) || yellowLightOffset < 0) {
    throw new TypeError('rollKeeper: yellowLightOffset must be a non-negative integer.');
  }
  if (!Number.isInteger(repeatThreshold) || repeatThreshold <= 0) {
    throw new TypeError('rollKeeper: repeatThreshold must be a positive integer.');
  }

  const yellowLightThreshold = maxRecursion - yellowLightOffset;

  let yellowLightSent = false;
  let repeatSent = false;
  let lastFingerprint = null;
  // 最近一次失败所属的工具名，仅用于生成提示文案（不参与判据计算）。
  let lastFingerprintName = null;
  let failureCount = 0;

  function evaluate({ recursionDepth } = {}) {
    // 优先级：repeat > yellow。每次 evaluate 至多返回一条注入。
    if (!repeatSent && failureCount >= repeatThreshold) {
      repeatSent = true;
      return { kind: 'repeat', content: buildRepeatContent(lastFingerprintName, repeatThreshold) };
    }

    if (!yellowLightSent && Number.isFinite(recursionDepth) && recursionDepth >= yellowLightThreshold) {
      yellowLightSent = true;
      return { kind: 'yellow', content: buildYellowContent(recursionDepth, maxRecursion) };
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
    repeatSent = false;
    lastFingerprint = null;
    lastFingerprintName = null;
    failureCount = 0;
  }

  return { evaluate, record, reset };
}

module.exports = { createRollKeeper };
