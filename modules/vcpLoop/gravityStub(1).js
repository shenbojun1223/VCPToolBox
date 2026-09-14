// modules/vcpLoop/gravityStub.js
// GravityStub V2：融合 TagMemo 浪潮动力学与 RiverMemo 水文流态的组装期可逆折叠机制
// 核心原则：
// 1. 纯内存动态投影，发往上游前执行，100% 不修改底层磁盘物理 history.json。
// 2. 纯数学自包含实现 Gram-Schmidt 正交残差分解与香农熵动态 Beta 门控，零重度外部数据库耦合。
// 3. 吸收 RiverMemo 水文地形自适应感知 (Regime Detection) 与 Gram-Schmidt 残差正交保护。

// 门禁默认参数
const TOKEN_WATERMARK_CHARS = 32000; // 预估约 8K~10K tokens 以上才激活
const IMMUNE_HEAD_COUNT = 1;         // System Prompt 绝对免疫
const IMMUNE_TAIL_TURNS = 2;         // 最近 2 轮（约 4 条消息）绝对免疫
const INTRINSIC_RESIDUAL_CORE_RATIO = 0.65; // 内生残差 >= 0.65 视为独特参数，触发 Core Boost 豁免

// ═══════════════════════════════════════════════════
// 纯数学与几何动力学算子 (自包含，微秒级收敛)
// ═══════════════════════════════════════════════════

function dotProduct(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let sum = 0;
  for (let i = 0; i < vecA.length; i++) sum += vecA[i] * vecB[i];
  return sum;
}

function magnitude(vec) {
  return Math.sqrt(dotProduct(vec, vec));
}

function normalize(vec) {
  const mag = magnitude(vec);
  if (mag < 1e-12) return new Float32Array(vec.length);
  const res = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) res[i] = vec[i] / mag;
  return res;
}

function cosineSimilarity(vecA, vecB) {
  const normA = magnitude(vecA);
  const normB = magnitude(vecB);
  if (normA < 1e-12 || normB < 1e-12) return 0;
  return dotProduct(vecA, vecB) / (normA * normB);
}

/**
 * Modified Gram-Schmidt 正交投影分解
 * 计算 targetVector 在 basisVectors 张成的子空间上的投影，并求出其内生残差 (Intrinsic Residual)
 * @param {Float32Array|Array<number>} targetVector - 待分解向量 (历史消息)
 * @param {Array<Float32Array>} basisVectors - 基底向量集合 (探针焦点)
 * @returns {{ residualRatio: number, residual: Float32Array }}
 */
function decomposeResidual(targetVector, basisVectors) {
  const dim = targetVector.length;
  const initialMag = magnitude(targetVector);
  if (initialMag < 1e-12 || !basisVectors || basisVectors.length === 0) {
    return { residualRatio: 1.0, residual: new Float32Array(targetVector) };
  }

  // 构建正交基
  const orthoBasis = [];
  for (const b of basisVectors) {
    let v = new Float32Array(b);
    for (const u of orthoBasis) {
      const dot = dotProduct(v, u);
      for (let d = 0; d < dim; d++) v[d] -= dot * u[d];
    }
    const mag = magnitude(v);
    if (mag > 1e-6) {
      for (let d = 0; d < dim; d++) v[d] /= mag;
      orthoBasis.push(v);
    }
  }

  // 计算 targetVector 在子空间上的投影 P = Σ <target, u_i> * u_i
  const projection = new Float32Array(dim);
  for (const u of orthoBasis) {
    const coeff = dotProduct(targetVector, u);
    for (let d = 0; d < dim; d++) projection[d] += coeff * u[d];
  }

  // 残差 R = target - P
  const residual = new Float32Array(dim);
  for (let d = 0; d < dim; d++) residual[d] = targetVector[d] - projection[d];

  const resMag = magnitude(residual);
  const residualRatio = resMag / initialMag; // 越接近 1.0 说明越含有基底无法解释的独特参数

  return { residualRatio, residual };
}

/**
 * 香农熵与水文流态分析 (RiverMemo Regime & Dynamic Beta)
 */
function analyzeHydrologicalRegime(probeVector, candidateVectors) {
  if (!candidateVectors || candidateVectors.length === 0) {
    return { regime: 'balanced', dynamicBeta: 0.50, entropy: 0.5 };
  }

  const sims = candidateVectors.map(vec => Math.max(0, cosineSimilarity(probeVector, vec)));
  const sum = sims.reduce((a, b) => a + b, 0);

  let entropy = 0;
  if (sum > 1e-12) {
    const probs = sims.map(s => s / sum);
    for (const p of probs) {
      if (p > 1e-9) entropy -= p * Math.log2(p);
    }
    const maxEntropy = Math.log2(candidateVectors.length);
    if (maxEntropy > 0) entropy = entropy / maxEntropy;
  } else {
    entropy = 0;
  }

  const logicDepth = 1.0 - entropy; // 熵低 -> 聚焦高
  const resonance = entropy;        // 熵高 -> 共振广

  let regime = 'balanced';
  if (entropy < 0.35 && logicDepth > 0.65) {
    regime = 'dense';   // 聚焦高、报错集中 -> 收紧河道加速冲刷
  } else if (entropy > 0.75 || resonance > 0.70) {
    regime = 'sparse';  // 探索分散、线索少 -> 拓宽河道容忍旧上下文
  }

  // β = σ(L · log(1 + R) - S · noise_penalty)
  const noisePenalty = regime === 'dense' ? 0.05 : 0.20;
  const rawScore = logicDepth * Math.log(1 + resonance) - 0.1 * noisePenalty;
  const sigmoid = 1 / (1 + Math.exp(-rawScore));
  const dynamicBeta = 0.38 + sigmoid * (0.68 - 0.38);

  return { regime, dynamicBeta, entropy, logicDepth, resonance };
}

// ═══════════════════════════════════════════════════
// 文本提取与存根卡片构建
// ═══════════════════════════════════════════════════

function extractUserIntentAnchor(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user' && typeof msg.content === 'string') {
      if (!msg.content.includes('<!-- VCP_TOOL_PAYLOAD -->') &&
          !msg.content.includes('[系统提示:]')) {
        return msg.content.slice(0, 1500);
      }
    }
  }
  return '';
}

function extractLatestToolPayloadSlice(payload) {
  if (typeof payload === 'string') return payload.slice(0, 2000);
  if (Array.isArray(payload)) {
    const textParts = payload
      .filter(p => p && p.type === 'text' && typeof p.text === 'string')
      .map(p => p.text)
      .join('\n');
    return textParts.slice(0, 2000);
  }
  return '';
}

function estimateTotalChars(messages) {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') total += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p && typeof p.text === 'string') total += p.text.length;
      }
    }
  }
  return total;
}

function buildGravityStubCard(msg, index, regime, residualRatio, similarity) {
  const role = msg.role || 'unknown';
  let charLen = 0;
  let snippet = '';

  if (typeof msg.content === 'string') {
    charLen = msg.content.length;
    snippet = msg.content.trim().slice(0, 80).replace(/\r?\n/g, ' ');
  } else if (Array.isArray(msg.content)) {
    const texts = msg.content.filter(p => p && typeof p.text === 'string').map(p => p.text);
    charLen = texts.reduce((acc, cur) => acc + cur.length, 0);
    snippet = texts.join(' ').trim().slice(0, 80).replace(/\r?\n/g, ' ');
  }

  return {
    role: msg.role,
    content: `<!-- VCP_GRAVITY_STUB -->\n` +
      `[上下文引力存根 #Block_${index} | 角色: ${role} | 原始规模: ${charLen} 字符]\n` +
      `- 摘要线索: "${snippet}..."\n` +
      `- 水文流态: ${regime} | 残差比率: ${residualRatio.toFixed(3)} | 语义引力: ${similarity.toFixed(3)}\n` +
      `[注: 因偏离当前排查焦点且低信息残差，已在本次工具组装中安全降级；任务收口或焦点回溯时将动态唤醒还原]`
  };
}

// ═══════════════════════════════════════════════════
// 核心投影拦截入口 (在 Handler 发送前一刻调用)
// ═══════════════════════════════════════════════════

async function projectGravityStub(messages, options = {}) {
  const {
    pluginManager,
    latestPayload = '',
    recursionDepth = 0,
    debugMode = false
  } = options;

  if (!Array.isArray(messages) || messages.length <= 6) return messages;
  if (recursionDepth < 1) return messages;

  const totalChars = estimateTotalChars(messages);
  if (totalChars < TOKEN_WATERMARK_CHARS) return messages;

  let bridge = options.contextBridge;
  if (!bridge && pluginManager) {
    const ragPlugin = pluginManager.messagePreprocessors?.get?.('RAGDiaryPlugin');
    if (ragPlugin && typeof ragPlugin.getContextBridge === 'function') {
      bridge = ragPlugin.getContextBridge();
    }
  }

  if (!bridge || typeof bridge.embedText !== 'function') {
    return messages;
  }

  const startTime = Date.now();

  try {
    const userIntent = extractUserIntentAnchor(messages);
    const toolSlice = extractLatestToolPayloadSlice(latestPayload);
    const probeText = typeof bridge.sanitize === 'function'
      ? bridge.sanitize(`[Task Goal]: ${userIntent}\n[Current Tool Focus]: ${toolSlice}`, 'user')
      : `[Task Goal]: ${userIntent}\n[Current Tool Focus]: ${toolSlice}`;

    const probeVectorRaw = await bridge.embedText(probeText);
    if (!probeVectorRaw) return messages;
    const probeVector = new Float32Array(probeVectorRaw);

    const headImmuneEnd = Math.min(IMMUNE_HEAD_COUNT, messages.length);
    const tailImmuneStart = Math.max(headImmuneEnd, messages.length - (IMMUNE_TAIL_TURNS * 2));

    const candidateIndices = [];
    const candidateVectors = [];

    for (let i = headImmuneEnd; i < tailImmuneStart; i++) {
      const msg = messages[i];
      if (typeof msg.content === 'string' && msg.content.includes('<!-- VCP_TOOL_PAYLOAD -->')) {
        continue;
      }

      let text = '';
      if (typeof msg.content === 'string') text = msg.content;
      else if (Array.isArray(msg.content)) {
        text = msg.content.filter(p => p && typeof p.text === 'string').map(p => p.text).join('\n');
      }

      if (text.length < 200) continue;

      let vecRaw = typeof bridge.getEmbeddingFromCache === 'function'
        ? bridge.getEmbeddingFromCache(text)
        : null;

      if (!vecRaw) {
        const snippet = typeof bridge.sanitize === 'function'
          ? bridge.sanitize(text.slice(0, 1000), msg.role)
          : text.slice(0, 1000);
        vecRaw = await bridge.embedText(snippet);
      }

      if (vecRaw) {
        candidateIndices.push(i);
        candidateVectors.push(new Float32Array(vecRaw));
      }
    }

    if (candidateVectors.length === 0) return messages;

    const { regime, dynamicBeta } = analyzeHydrologicalRegime(probeVector, candidateVectors);
    const basisVectors = [probeVector];
    const projectedMessages = messages.slice(); // 纯内存浅拷贝
    let stubbedCount = 0;
    let savedChars = 0;

    for (let k = 0; k < candidateIndices.length; k++) {
      const msgIndex = candidateIndices[k];
      const targetVec = candidateVectors[k];
      const origMsg = messages[msgIndex];

      const sim = cosineSimilarity(probeVector, targetVec);
      const { residualRatio } = decomposeResidual(targetVec, basisVectors);

      // 豁免保护：高语义相关 或 高内生残差（含独特技术参数）
      const isExempt = (sim >= dynamicBeta) || (residualRatio >= INTRINSIC_RESIDUAL_CORE_RATIO);

      if (!isExempt) {
        const stubCard = buildGravityStubCard(origMsg, msgIndex, regime, residualRatio, sim);
        const originalLen = typeof origMsg.content === 'string'
          ? origMsg.content.length
          : JSON.stringify(origMsg.content).length;

        projectedMessages[msgIndex] = stubCard;
        stubbedCount++;
        savedChars += (originalLen - stubCard.content.length);
      }
    }

    const elapsed = Date.now() - startTime;
    if (debugMode || stubbedCount > 0) {
      console.log(
        `[GravityStub] 引力场组装完成 (${elapsed}ms): ` +
        `地形=${regime}, β=${dynamicBeta.toFixed(3)}, 候选=${candidateIndices.length}, ` +
        `存根=${stubbedCount}块, 节约字符=${savedChars}`
      );
    }

    return projectedMessages;
  } catch (err) {
    console.warn(`[GravityStub] 组装异常，安全回退原文: ${err.message}`);
    return messages;
  }
}

module.exports = {
  projectGravityStub,
  decomposeResidual,
  analyzeHydrologicalRegime,
  buildGravityStubCard,
  cosineSimilarity
};