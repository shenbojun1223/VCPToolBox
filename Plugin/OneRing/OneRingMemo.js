'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./OneRingDB.js');

const MEMO_TRIGGER_REGEX = /\[\[OneRingMemo::([^:\]\r\n]+?)\]\]/g;
const DEFAULT_CONFIG = Object.freeze({
    enabled: true,
    autoGenerate: false,
    updateIntervalMinutes: 360,
    timelineDays: 3,
    fallbackMessageCount: 30,
    model: '',
    maxContextTokens: 32000,
    maxOutputTokens: 2000
});

let projectBasePath = '';
let runtimeConfig = {};
const generationLocks = new Map();
const generationStatuses = new Map();

function createGenerationStatus(agentName, reason) {
    return {
        agentName,
        running: true,
        phase: 'preparing',
        phaseLabel: '准备摘要源数据',
        completed: 0,
        total: 1,
        mergeRound: 0,
        reason,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        finishedAt: null,
        error: null
    };
}

function updateGenerationStatus(agentName, patch) {
    const current = generationStatuses.get(agentName) || createGenerationStatus(agentName, patch.reason || 'manual');
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    generationStatuses.set(agentName, next);
    return next;
}

function getGenerationStatus(agentName) {
    const status = generationStatuses.get(agentName);
    return status ? { ...status } : {
        agentName,
        running: false,
        phase: 'idle',
        phaseLabel: '空闲',
        completed: 0,
        total: 0,
        mergeRound: 0,
        reason: null,
        startedAt: null,
        updatedAt: null,
        finishedAt: null,
        error: null
    };
}

function isGenerating(agentName) {
    return generationLocks.has(agentName);
}

function normalizePositiveInteger(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function normalizeConfig(raw = {}) {
    return {
        enabled: raw.enabled !== false,
        autoGenerate: raw.autoGenerate === true,
        updateIntervalMinutes: normalizePositiveInteger(raw.updateIntervalMinutes, DEFAULT_CONFIG.updateIntervalMinutes, 1, 525600),
        timelineDays: normalizePositiveInteger(raw.timelineDays, DEFAULT_CONFIG.timelineDays, 1, 7),
        fallbackMessageCount: normalizePositiveInteger(raw.fallbackMessageCount, DEFAULT_CONFIG.fallbackMessageCount, 1, 1000),
        model: String(raw.model || '').trim(),
        maxContextTokens: normalizePositiveInteger(raw.maxContextTokens, DEFAULT_CONFIG.maxContextTokens, 1024, 1000000),
        maxOutputTokens: normalizePositiveInteger(raw.maxOutputTokens, DEFAULT_CONFIG.maxOutputTokens, 128, 100000)
    };
}

function configure(options = {}) {
    projectBasePath = options.projectBasePath || projectBasePath;
    runtimeConfig = options.runtimeConfig || runtimeConfig;
}

function getStoreDir() {
    return path.join(projectBasePath || path.join(__dirname, '..', '..'), 'Plugin', 'OneRing', 'memo');
}

function safeAgentFileName(agentName) {
    return encodeURIComponent(String(agentName || '').trim()).replace(/%/g, '_');
}

function getMemoPath(agentName) {
    return path.join(getStoreDir(), `${safeAgentFileName(agentName)}.json`);
}

function readMemo(agentName) {
    try {
        const value = JSON.parse(fs.readFileSync(getMemoPath(agentName), 'utf8'));
        return value && typeof value.summary === 'string' ? value : null;
    } catch (error) {
        if (error.code !== 'ENOENT') console.warn(`[OneRingMemo] Failed to read memo for "${agentName}":`, error.message);
        return null;
    }
}

function writeMemo(agentName, memo) {
    const dir = getStoreDir();
    fs.mkdirSync(dir, { recursive: true });
    const target = getMemoPath(agentName);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(memo, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, target);
    return memo;
}

function updateMemoText(agentName, summary) {
    if (isGenerating(agentName)) {
        const error = new Error(`Agent "${agentName}" 的摘要正在生成，完成前禁止人工覆写`);
        error.code = 'MEMO_GENERATION_IN_PROGRESS';
        throw error;
    }
    const previous = readMemo(agentName) || {};
    return writeMemo(agentName, {
        ...previous,
        agentName,
        summary: String(summary || ''),
        editedAt: new Date().toISOString(),
        source: 'manual'
    });
}

function listAgentNames() {
    const names = new Set();
    const dataDir = path.join(projectBasePath || path.join(__dirname, '..', '..'), 'Plugin', 'OneRing', 'data');
    try {
        for (const file of fs.readdirSync(dataDir)) {
            if (file.toLowerCase().endsWith('.db')) names.add(file.slice(0, -3));
        }
    } catch (error) {
        if (error.code !== 'ENOENT') console.warn('[OneRingMemo] Failed to list OneRing databases:', error.message);
    }
    try {
        for (const file of fs.readdirSync(getStoreDir())) {
            if (!file.toLowerCase().endsWith('.json')) continue;
            const memo = JSON.parse(fs.readFileSync(path.join(getStoreDir(), file), 'utf8'));
            if (memo?.agentName) names.add(String(memo.agentName));
        }
    } catch (error) {
        if (error.code !== 'ENOENT') console.warn('[OneRingMemo] Failed to list memo files:', error.message);
    }
    return [...names].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function extractTextParts(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(part => part?.type === 'text' ? part.text || '' : '').join('');
    if (content && typeof content.text === 'string') return content.text;
    return '';
}

function replaceLastMemoInContent(content, triggerText, replacement) {
    const replaceLast = text => {
        const index = text.lastIndexOf(triggerText);
        return index < 0 ? text : text.slice(0, index) + replacement + text.slice(index + triggerText.length);
    };
    if (typeof content === 'string') return replaceLast(content);
    if (Array.isArray(content)) {
        const result = content.map(part => ({ ...part }));
        for (let index = result.length - 1; index >= 0; index--) {
            if (result[index]?.type === 'text' && typeof result[index].text === 'string' && result[index].text.includes(triggerText)) {
                result[index].text = replaceLast(result[index].text);
                break;
            }
        }
        return result;
    }
    if (content && typeof content.text === 'string') return { ...content, text: replaceLast(content.text) };
    return content;
}

function injectMemo(messages) {
    if (!Array.isArray(messages)) return messages;
    let selected = null;
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (!message || message.role !== 'system') break;
        const text = extractTextParts(message.content);
        const matches = [...text.matchAll(new RegExp(MEMO_TRIGGER_REGEX.source, MEMO_TRIGGER_REGEX.flags))];
        if (matches.length > 0) selected = { index, match: matches[matches.length - 1] };
    }
    if (!selected) return messages;

    const agentName = selected.match[1].trim();
    const memo = readMemo(agentName);
    const replacement = memo?.summary?.trim() || '';
    const result = [...messages];
    result[selected.index] = {
        ...result[selected.index],
        content: replaceLastMemoInContent(result[selected.index].content, selected.match[0], replacement)
    };
    return result;
}

function formatLocalCutoff(days) {
    const cutoff = new Date(Date.now() - days * 86400000);
    const pad = value => String(value).padStart(2, '0');
    return `${cutoff.getFullYear()}-${pad(cutoff.getMonth() + 1)}-${pad(cutoff.getDate())} ${pad(cutoff.getHours())}:${pad(cutoff.getMinutes())}:${pad(cutoff.getSeconds())}`;
}

function selectSourceMessages(agentName, memoConfig) {
    const connection = db.getDb(agentName, projectBasePath);
    const cutoff = formatLocalCutoff(memoConfig.timelineDays);
    let rows = connection.prepare(
        `SELECT id, role, senderName, frontendSource, content, timestamp
         FROM messages WHERE agentName=? AND timestamp>=?
         ORDER BY timestamp ASC, id ASC`
    ).all(agentName, cutoff);

    if (rows.length < memoConfig.fallbackMessageCount) {
        rows = connection.prepare(
            `SELECT * FROM (
                SELECT id, role, senderName, frontendSource, content, timestamp
                FROM messages WHERE agentName=?
                ORDER BY timestamp DESC, id DESC LIMIT ?
             ) ORDER BY timestamp ASC, id ASC`
        ).all(agentName, memoConfig.fallbackMessageCount);
    }
    return rows;
}

const MEMO_MAX_NORMALIZED_MESSAGE_CHARS = 8000;
const MEMO_RAG_BLOCK_REGEX = /<!--\s*VCP_RAG_BLOCK_START\b[\s\S]*?<!--\s*VCP_RAG_BLOCK_END\s*-->/gi;
const MEMO_TOOL_REQUEST_REGEX = /<<<\[TOOL_REQUEST\]>>>[\s\S]*?<<<\[END_TOOL_REQUEST\]>>>/g;
const MEMO_TOOL_RESULT_REGEX = /\[\[VCP调用结果信息汇总:[\s\S]*?VCP调用结果结束\]\]/g;
const MEMO_TOOL_SUMMARY_REGEX = /\[本轮工具调用摘要:\][\s\S]*?\[本轮工具调用摘要结束\]/g;

function extractVcpField(block, fieldName) {
    const expression = new RegExp(
        `${fieldName}\\s*:\\s*「始(?:ESCAPE)?」([\\s\\S]*?)「末(?:ESCAPE)?」`,
        'i'
    );
    const match = String(block || '').match(expression);
    return match ? match[1].replace(/\s+/g, ' ').trim() : '';
}

function summarizeToolRequestBlock(block) {
    const toolName = extractVcpField(block, 'tool_name') || '未知工具';
    const command = extractVcpField(block, 'command');
    const commandSuffix = command
        ? `；指令=${command.slice(0, 120)}${command.length > 120 ? '…' : ''}`
        : '';
    return `\n[工具调用：${toolName}${commandSuffix}]\n`;
}

function summarizeToolResultBlock(block) {
    const names = [...String(block || '').matchAll(/工具名称:\s*([^\r\n]+)/g)]
        .map(match => match[1].trim())
        .filter(Boolean);
    const statuses = [...String(block || '').matchAll(/执行状态:\s*([^\r\n]+)/g)]
        .map(match => match[1].trim())
        .filter(Boolean);
    const uniqueNames = [...new Set(names)].slice(0, 4);
    const uniqueStatuses = [...new Set(statuses)].slice(0, 4);
    return `\n[工具结果：${uniqueNames.join(', ') || '未知工具'}；状态=${uniqueStatuses.join(', ') || '未知'}]\n`;
}

function decodeBasicHtmlEntities(text) {
    return String(text || '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&')
        .replace(/&#x([0-9a-f]+);/gi, (match, value) => {
            const codePoint = parseInt(value, 16);
            return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
                ? String.fromCodePoint(codePoint)
                : ' ';
        })
        .replace(/&#(\d+);/g, (match, value) => {
            const codePoint = parseInt(value, 10);
            return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
                ? String.fromCodePoint(codePoint)
                : ' ';
        });
}

function redactMemoSecrets(text) {
    return String(text || '')
        .replace(
            /((?:验证码|管理员密码|授权码|访问密码|工具密码|密码)\s*(?:为|是|[:=：])?\s*(?:[`"'“”‘’]|「始」)?\s*)\d{4,12}(\s*(?:[`"'“”‘’]|「末」)?)/gi,
            '$1[REDACTED]$2'
        )
        .replace(/((?:tool_password|AdminPassword|API_Key)\s*[:=：]\s*)[^\s,，;；}\]"']+/gi, '$1[REDACTED]')
        .replace(/(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+\/=-]+/gi, '$1[REDACTED]');
}

function normalizeMemoContent(rawContent) {
    let text = String(rawContent || '').replace(/\u0000/g, '');
    if (!text.trim()) return '';

    text = text.replace(MEMO_RAG_BLOCK_REGEX, '\n');
    text = text.replace(MEMO_TOOL_REQUEST_REGEX, summarizeToolRequestBlock);
    text = text.replace(MEMO_TOOL_RESULT_REGEX, summarizeToolResultBlock);
    text = text.replace(MEMO_TOOL_SUMMARY_REGEX, '\n');
    text = text.replace(
        /<!--\s*VCP_TOOL_PAYLOAD\s*-->[\s\S]*$/gi,
        '\n[工具载荷已省略]\n'
    );
    text = text.replace(
        /近期客观时间线（OneRingMemo[\s\S]*?(?:以上是过往记忆区)[^\r\n]*/g,
        '\n'
    );
    text = text.replace(
        /————VCP元思维模块————[\s\S]*?————VCP元思考加载结束—————/g,
        '\n'
    );
    text = text.replace(
        /VCP系统工具列表：[\s\S]*?(?=\[本信息由VCPChat客户端注入\]|$)/g,
        '\n'
    );
    text = text.replace(
        /data:(?:image|audio|video)\/[^;,\s]+;base64,[A-Za-z0-9+/=\r\n]+/gi,
        '[Base64媒体已省略]'
    );
    text = text.replace(/```[\s\S]*?```/g, block => (
        block.length > 1200
            ? `\n[长代码或日志块已省略，原始${block.length}字符]\n`
            : block
    ));
    text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
    text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
    text = text.replace(/<[^>]+>/g, ' ');
    text = decodeBasicHtmlEntities(text);
    text = redactMemoSecrets(text);
    text = text.replace(/\[OneRing通知:[^\]]*\]/g, ' ');
    text = text
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();

    if (!text || text === '[工具载荷已省略]') return '';

    if (text.length > MEMO_MAX_NORMALIZED_MESSAGE_CHARS) {
        const headLength = 5000;
        const tailLength = 2400;
        text = `${text.slice(0, headLength)}\n[中间协议、日志或重复内容已裁剪]\n${text.slice(-tailLength)}`;
    }

    return text;
}

function formatTimelineRows(rows, agentName) {
    const events = [];
    const seen = new Set();

    for (const row of rows) {
        const content = normalizeMemoContent(row.content);
        if (!content) continue;

        const dedupeKey = `${row.role}\u0000${content}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        events.push(JSON.stringify({
            eventTimestamp: row.timestamp,
            role: row.role,
            sender: row.senderName || (row.role === 'assistant' ? agentName : '用户'),
            frontendSource: row.frontendSource || null,
            content
        }));
    }

    // 空行是 splitByTokenBudget() 的事件边界，避免大输入按固定字符数
    // 从单个 JSON 事件中间切开，使 eventTimestamp 与 content 失去绑定。
    return events.join('\n\n');
}

function estimateTokens(text) {
    const value = String(text || '');
    if (!value) return 0;

    // 中文、日文与韩文通常比英文/代码拥有更高的 token 密度。
    // 原先统一按 3 字符/token 会严重低估中文时间线，使超大输入被误判为单段。
    const cjkMatches = value.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g);
    const cjkChars = cjkMatches ? cjkMatches.length : 0;
    const otherChars = value.length - cjkChars;
    return Math.ceil(cjkChars * 1.1 + otherChars / 3.4);
}

function splitByTokenBudget(text, tokenBudget) {
    if (estimateTokens(text) <= tokenBudget) return [text];
    const paragraphs = text.split(/\n{2,}/);
    const chunks = [];
    let current = '';
    for (const paragraph of paragraphs) {
        if (estimateTokens(paragraph) > tokenBudget) {
            if (current) chunks.push(current);
            const charBudget = Math.max(1000, tokenBudget * 3);
            for (let offset = 0; offset < paragraph.length; offset += charBudget) {
                chunks.push(paragraph.slice(offset, offset + charBudget));
            }
            current = '';
            continue;
        }
        const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
        if (current && estimateTokens(candidate) > tokenBudget) {
            chunks.push(current);
            current = paragraph;
        } else {
            current = candidate;
        }
    }
    if (current) chunks.push(current);
    return chunks.filter(Boolean);
}

const MEMO_COMPLETION_SENTINEL = '[[ONERING_MEMO_COMPLETE]]';

function extractAuthoritativeInputDates(input) {
    const value = String(input || '');
    const eventDates = [...value.matchAll(/"eventTimestamp":"(20\d{2}-\d{2}-\d{2})/g)]
        .map(match => match[1]);
    if (eventDates.length > 0) return [...new Set(eventDates)].sort();

    const summaryDates = [...value.matchAll(/^(20\d{2}-\d{2}-\d{2})\s*$/gm)]
        .map(match => match[1]);
    return [...new Set(summaryDates)].sort();
}

function extractSummaryHeadingDates(output) {
    return [...new Set(
        [...String(output || '').matchAll(/^(20\d{2}-\d{2}-\d{2})\s*$/gm)]
            .map(match => match[1])
    )].sort();
}

async function callSummaryModel(model, systemPrompt, input, memoConfig) {
    // OneRingMemo summarizes archived conversation text. Historical protocol
    // markers must remain inert data, so this internal task bypasses the normal
    // Agent/RAG/OneRing chat preprocessing route.
    const apiUrl = String(runtimeConfig.API_URL || process.env.API_URL || '').trim().replace(/\/+$/, '');
    const apiKey = runtimeConfig.API_Key || process.env.API_Key || '';
    if (!apiUrl || !apiKey) throw new Error('API_URL 或 API_Key 未配置，无法直接调用摘要模型');
    if (!model) throw new Error('OneRingMemo 摘要模型未配置');

    const { default: fetch } = await import('node-fetch');
    const baseMaxTokens = Math.max(128, Number(memoConfig.maxOutputTokens) || 2000);
    const requiredDates = extractAuthoritativeInputDates(input);
    const maxAttempts = 3;
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const requestMaxTokens = Math.min(16000, baseMaxTokens * Math.pow(2, attempt));
        let response;
        let text = '';

        try {
            response = await fetch(`${apiUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    Authorization: `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model,
                    stream: false,
                    max_tokens: requestMaxTokens,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: input }
                    ]
                })
            });
            text = await response.text();
        } catch (error) {
            lastError = new Error(`摘要模型网络请求失败: ${error.message}`);
            if (attempt + 1 < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
                continue;
            }
            throw lastError;
        }

        if (!response.ok) {
            lastError = new Error(`摘要模型返回 ${response.status}: ${text.slice(0, 500)}`);
            const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
            if (retryable && attempt + 1 < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
                continue;
            }
            throw lastError;
        }

        let payload;
        try {
            payload = JSON.parse(text);
        } catch (error) {
            lastError = new Error(`摘要模型返回了无效 JSON: ${error.message}`);
            if (attempt + 1 < maxAttempts) continue;
            throw lastError;
        }

        const choice = payload?.choices?.[0];
        const output = choice?.message?.content;
        const finishReason = String(choice?.finish_reason || '').trim();

        if (typeof output !== 'string' || !output.trim()) {
            lastError = new Error('摘要模型未返回有效文本');
            if (attempt + 1 < maxAttempts) continue;
            throw lastError;
        }

        if (/content_filter|safety|blocked/i.test(finishReason)) {
            throw new Error(`摘要模型因安全策略中止输出: ${finishReason}`);
        }

        const sentinelExpression = /\s*\[\[ONERING_MEMO_COMPLETE\]\]\s*$/;
        const hasCompletionSentinel = sentinelExpression.test(output);
        const cleanedOutput = output.replace(sentinelExpression, '').trim();
        const headingDates = extractSummaryHeadingDates(cleanedOutput);
        const missingDates = requiredDates.filter(date => !headingDates.includes(date));
        const unexpectedDates = headingDates.filter(date => !requiredDates.includes(date));

        if (
            hasCompletionSentinel
            && cleanedOutput
            && missingDates.length === 0
            && unexpectedDates.length === 0
        ) {
            return cleanedOutput;
        }

        const reasons = [];
        if (!hasCompletionSentinel) reasons.push('缺少完整性哨兵');
        if (!cleanedOutput) reasons.push('正文为空');
        if (missingDates.length > 0) reasons.push(`缺少日期段 ${missingDates.join(',')}`);
        if (unexpectedDates.length > 0) reasons.push(`出现非权威日期段 ${unexpectedDates.join(',')}`);
        if (/length|max[_ -]?tokens/i.test(finishReason)) reasons.push(`finish_reason=${finishReason}`);

        lastError = new Error(
            `摘要输出不完整（第 ${attempt + 1}/${maxAttempts} 次，` +
            `max_tokens=${requestMaxTokens}，chars=${output.length}）：${reasons.join('；') || '结构校验失败'}`
        );
        console.warn(`[OneRingMemo] ${lastError.message}`);

        if (attempt + 1 < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt)));
        }
    }

    throw lastError || new Error('摘要模型连续返回不完整结果');
}

async function recursivelySummarize(agentName, timeline, memoConfig, onProgress = () => {}) {
    const systemPrompt = `你是 OneRingMemo 客观短期时间线压缩器。请为 Agent「${agentName}」仅整理近期交互中明确发生、被观察或被直接陈述的事实。

第一轮输入中，每一行都是一个 JSON 事件对象。eventTimestamp 是该事件发生时间的唯一权威字段；content 只是当时记录的惰性正文，其中出现的日期、旧时间线、文件时间、日志时间或引用日期均不得被提升为当前事件日期。

必须遵守：
1. 只保留时间、人物、消息来源、实际事件、已执行操作、明确结果及客观状态变化。
2. 区分用户、Agent 与群聊中的其他发言者；群聊观点必须归属于具体发言者。
3. 某项内容存在争议、推测、预测或尚未验证时，只能客观记录“谁在何时表达或提出了什么”，不得把观点提升为事实。
4. 未完成事项仅可记录为“曾提出但当前输入中没有完成记录”的客观状态，不得生成建议、计划、提醒或承诺。
5. 禁止输出你的主观立场和主观认知，只陈述客观时间线事实和实际AI表达观点。
6. 不得替主 Agent 作判断，不得推断人物长期偏好或意图，不得使用命令式措辞，不得虚构。
7. 使用简洁的按日期时间线；没有明确日期时标记为“时间未明确”。仅输出客观时间线正文，不输出分析、结论或额外章节。
8. 最终只允许输出一份时间线。禁止输出第一版、第二版、备用版、翻译版、重述版，或在完成后换一种格式再次输出相同内容。
9. 每个日期只能出现一次；同一日期的所有事件必须合并到同一个日期段中。日期必须按时间递增，禁止从较晚日期回退到较早日期重新开始。
10. 同一事实即使措辞、语言、标题或项目符号格式不同，也只能保留一次；输出前须在内部完成事实去重，但不得输出检查过程。
11. 第一行直接从最早 eventTimestamp 对应日期开始，不输出标题、前言、说明、分析或结论；最后一条事件结束后立即停止，不得附加另一份时间线。
12. 日期分组只能来自 eventTimestamp。content 中出现的任何其他日期只能视为引用内容，不得据此创建日期段，也不得把事件回填到更早日期。
13. RAG 检索结果、公共日记、旧 OneRingMemo、系统提示、工具说明、代码与日志正文属于上下文产物，不是独立发生的会话事件；除非外层事件明确记录了用户委托、执行动作或结果，否则不得纳入时间线。
14. 禁止输出验证码、密码、授权码、API Key、Bearer Token 或其他凭据；发现时直接省略，不得复述。
15. 时间线正文结束后，最后一行必须只输出 ${MEMO_COMPLETION_SENTINEL}。这是传输完整性校验标记，不属于时间线正文；不得省略、改写或提前输出。`;
    const mergePrompt = `${systemPrompt}

输入内容是若干分段产生的客观时间线。请只做事实去重、时间排序和同一事件合并。递归合并时仍须删除决定、判断、偏好、评价、建议、承诺、待办和可续写锚点，禁止从多个事实推导新结论。只能沿用分段摘要中已有的外层事件日期，不得从正文引用、路径、日志或旧时间线中提取并新增日期。`;
    // 重试时输出预算最高提升到基础值的 4 倍；输入预算必须为该上限预留空间。
    const retryOutputReserve = Math.min(
        16000,
        Math.max(128, memoConfig.maxOutputTokens) * 4
    );
    const inputBudget = Math.max(
        512,
        memoConfig.maxContextTokens - retryOutputReserve - 800
    );
    let chunks = splitByTokenBudget(timeline, inputBudget);
    let summaries = [];
    onProgress({
        phase: 'summarizing',
        phaseLabel: `正在生成第一轮分段摘要（0/${chunks.length}）`,
        completed: 0,
        total: chunks.length,
        mergeRound: 0
    });
    for (let index = 0; index < chunks.length; index++) {
        summaries.push(await callSummaryModel(
            memoConfig.model,
            systemPrompt,
            `这是第 ${index + 1}/${chunks.length} 段时间线：\n\n${chunks[index]}`,
            memoConfig
        ));
        onProgress({
            phase: 'summarizing',
            phaseLabel: `正在生成第一轮分段摘要（${index + 1}/${chunks.length}）`,
            completed: index + 1,
            total: chunks.length,
            mergeRound: 0
        });
    }
    let mergeRound = 0;
    while (summaries.length > 1 || estimateTokens(summaries[0] || '') > inputBudget) {
        mergeRound++;
        const mergedInput = summaries.map((summary, index) => `【分段摘要 ${index + 1}】\n${summary}`).join('\n\n');
        const mergeChunks = splitByTokenBudget(mergedInput, inputBudget);
        const next = [];
        onProgress({
            phase: 'merging',
            phaseLabel: `正在进行第 ${mergeRound} 轮递归合并（0/${mergeChunks.length}）`,
            completed: 0,
            total: mergeChunks.length,
            mergeRound
        });
        for (let index = 0; index < mergeChunks.length; index++) {
            next.push(await callSummaryModel(memoConfig.model, mergePrompt, mergeChunks[index], memoConfig));
            onProgress({
                phase: 'merging',
                phaseLabel: `正在进行第 ${mergeRound} 轮递归合并（${index + 1}/${mergeChunks.length}）`,
                completed: index + 1,
                total: mergeChunks.length,
                mergeRound
            });
        }
        if (next.length === summaries.length && next.join('').length >= summaries.join('').length) {
            return callSummaryModel(memoConfig.model, mergePrompt, mergedInput.slice(0, inputBudget * 3), memoConfig);
        }
        summaries = next;
    }
    return summaries[0] || '';
}

async function generateMemo(agentName, rawConfig, reason = 'manual') {
    const memoConfig = normalizeConfig(rawConfig);
    if (!memoConfig.enabled) throw new Error('OneRingMemo 已禁用');
    if (generationLocks.has(agentName)) {
        const error = new Error(`Agent "${agentName}" 的摘要生成任务已在运行`);
        error.code = 'MEMO_GENERATION_IN_PROGRESS';
        throw error;
    }

    generationStatuses.set(agentName, createGenerationStatus(agentName, reason));
    const task = (async () => {
        const rows = selectSourceMessages(agentName, memoConfig);
        if (rows.length === 0) throw new Error(`Agent "${agentName}" 暂无可总结的 OneRing 消息`);
        updateGenerationStatus(agentName, {
            phase: 'summarizing',
            phaseLabel: `已读取 ${rows.length} 条源消息，准备分段摘要`
        });
        const summary = await recursivelySummarize(
            agentName,
            formatTimelineRows(rows, agentName),
            memoConfig,
            progress => updateGenerationStatus(agentName, progress)
        );
        updateGenerationStatus(agentName, {
            phase: 'writing',
            phaseLabel: '摘要合并完成，正在原子写入',
            completed: 0,
            total: 1
        });
        const memo = writeMemo(agentName, {
            agentName,
            summary,
            generatedAt: new Date().toISOString(),
            editedAt: null,
            source: reason,
            model: memoConfig.model,
            timelineDays: memoConfig.timelineDays,
            fallbackMessageCount: memoConfig.fallbackMessageCount,
            sourceMessageCount: rows.length,
            sourceFirstTimestamp: rows[0]?.timestamp || null,
            sourceLastTimestamp: rows[rows.length - 1]?.timestamp || null
        });
        updateGenerationStatus(agentName, {
            running: false,
            phase: 'completed',
            phaseLabel: '摘要生成完成',
            completed: 1,
            total: 1,
            finishedAt: new Date().toISOString()
        });
        return memo;
    })().catch(error => {
        updateGenerationStatus(agentName, {
            running: false,
            phase: 'failed',
            phaseLabel: '摘要生成失败',
            finishedAt: new Date().toISOString(),
            error: error.message
        });
        throw error;
    }).finally(() => generationLocks.delete(agentName));

    generationLocks.set(agentName, task);
    return task;
}

function startGeneration(agentName, rawConfig, reason = 'manual') {
    if (isGenerating(agentName)) {
        return { accepted: false, status: getGenerationStatus(agentName) };
    }
    const task = generateMemo(agentName, rawConfig, reason);
    task.catch(error => {
        console.warn(`[OneRingMemo] Background generation failed for "${agentName}":`, error.message);
    });
    return { accepted: true, status: getGenerationStatus(agentName) };
}

function scheduleAutoGenerate(agentName, rawConfig) {
    const memoConfig = normalizeConfig(rawConfig);
    if (!memoConfig.enabled || !memoConfig.autoGenerate || !memoConfig.model || generationLocks.has(agentName)) return;
    const memo = readMemo(agentName);
    const lastSuccess = Date.parse(memo?.generatedAt || memo?.editedAt || '');
    if (Number.isFinite(lastSuccess) && Date.now() - lastSuccess < memoConfig.updateIntervalMinutes * 60000) return;
    setImmediate(() => {
        generateMemo(agentName, memoConfig, 'auto').catch(error => {
            console.warn(`[OneRingMemo] Auto generation failed for "${agentName}":`, error.message);
        });
    });
}

module.exports = {
    DEFAULT_CONFIG,
    normalizeConfig,
    configure,
    injectMemo,
    readMemo,
    updateMemoText,
    listAgentNames,
    generateMemo,
    startGeneration,
    getGenerationStatus,
    isGenerating,
    scheduleAutoGenerate
};