'use strict';

const crypto = require('crypto');

const SCHEMA_VERSION = 2;
const MAX_EVENT_TEXT_CHARS = 8000;
const MAX_TOOL_FIELD_CHARS = 600;

const RAG_BLOCK_REGEX = /<!--\s*VCP_RAG_BLOCK_START\b[\s\S]*?<!--\s*VCP_RAG_BLOCK_END\s*-->/gi;
const TOOL_REQUEST_REGEX = /<<<\[TOOL_REQUEST\]>>>[\s\S]*?<<<\[END_TOOL_REQUEST\]>>>/gi;
const TOOL_RESULT_REGEX = /\[\[VCP调用结果信息汇总:[\s\S]*?VCP调用结果结束\]\]/gi;
const TOOL_SUMMARY_REGEX = /\[本轮工具调用摘要:\][\s\S]*?\[本轮工具调用摘要结束\]/gi;
const META_THOUGHT_REGEX = /————VCP元思维模块————[\s\S]*?————VCP元思考加载结束—————/gi;
const THINKING_BLOCK_REGEX = /<(?:think|thinking|analysis)\b[^>]*>[\s\S]*?<\/(?:think|thinking|analysis)>/gi;

function asText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => part && part.type === 'text' ? String(part.text || '') : '').join('');
    }
    if (content && typeof content.text === 'string') return content.text;
    return '';
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function stripHtmlToVisibleText(text) {
    let value = String(text || '');
    value = value.replace(/<!--(?!--\s*VCP_RAG_BLOCK_START)[\s\S]*?-->/gi, ' ');
    value = value.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
    value = value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
    value = value.replace(/<(?:br|hr)\s*\/?>/gi, '\n');
    value = value.replace(/<img\b[^>]*\balt\s*=\s*(["'])([\s\S]*?)\1[^>]*>/gi, ' $2 ');
    value = value.replace(/<\/(?:p|div|li|tr|section|article|pre|h[1-6])\s*>/gi, '\n');
    value = value.replace(/<[^>]+>/g, ' ');
    return decodeBasicHtmlEntities(value);
}

function redactSensitiveValues(text) {
    return String(text || '')
        .replace(
            /((?:验证码|管理员密码|授权码|访问密码|工具密码|密码)\s*(?:为|是|[:=：])?\s*(?:[`"“”‘’「]|))([^\s,，;；}\]"'」]+)([`"“”‘’」]?)/gi,
            '$1[REDACTED]$3'
        )
        .replace(
            /((?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|authorization)\s*[:=：]\s*)(?:bearer\s+)?[^\s,，;；}\]"']+/gi,
            '$1[REDACTED]'
        )
        .replace(/(authorization\s*:\s*bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]')
        .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, 'Bearer [REDACTED]')
        .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]');
}

function cleanField(value, maxChars = MAX_TOOL_FIELD_CHARS) {
    return redactSensitiveValues(stripHtmlToVisibleText(String(value || '')))
        .replace(/[\r\n]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, maxChars);
}

function extractVcpField(block, fieldName) {
    const expression = new RegExp(
        `${escapeRegExp(fieldName)}\\s*[:：]\\s*「始(?:ESCAPE)?」([\\s\\S]*?)「末(?:ESCAPE)?」`,
        'i'
    );
    const match = String(block || '').match(expression);
    return match ? cleanField(match[1]) : '';
}

function extractLabeledField(block, labels) {
    const expression = new RegExp(
        `(?:^|\\n|\\[)\\s*(?:${labels.map(escapeRegExp).join('|')})\\s*[:：]\\s*([^\\r\\n\\]]+)`,
        'i'
    );
    const match = String(block || '').match(expression);
    return match ? cleanField(match[1]) : '';
}

function extractAllLabeledFields(block, labels) {
    const expression = new RegExp(
        `(?:^|\\n|\\[)\\s*(?:${labels.map(escapeRegExp).join('|')})\\s*[:：]\\s*([^\\r\\n\\]]+)`,
        'gi'
    );
    return [...String(block || '').matchAll(expression)]
        .map(match => cleanField(match[1]))
        .filter(Boolean);
}

function summarizeToolRequest(block) {
    const toolName = extractVcpField(block, 'tool_name')
        || extractLabeledField(block, ['工具名称', 'tool_name'])
        || '未知工具';
    const purpose = extractVcpField(block, 'purpose')
        || extractVcpField(block, 'description')
        || extractVcpField(block, 'query')
        || extractLabeledField(block, ['目的', '用途', '说明', 'purpose', 'description', 'query'])
        || '未提供';
    return `[工具请求：工具=${toolName}；目的=${purpose}]`;
}

function summarizeToolResult(block) {
    const toolName = extractVcpField(block, 'tool_name')
        || extractLabeledField(block, ['工具名称', 'tool_name'])
        || '未知工具';
    const status = extractVcpField(block, 'status')
        || extractLabeledField(block, ['执行状态', '状态', 'status'])
        || '未知';
    const exitCode = extractVcpField(block, 'exit_code')
        || extractVcpField(block, 'exitCode')
        || extractLabeledField(block, ['退出码', '退出状态', 'exit_code', 'exitCode']);
    const conclusion = extractVcpField(block, 'conclusion')
        || extractVcpField(block, 'summary')
        || extractLabeledField(block, ['关键结论', '结果摘要', '结论', 'summary', 'conclusion']);
    const parts = [`工具=${toolName}`, `状态=${status}`];
    if (exitCode) parts.push(`退出码=${exitCode}`);
    if (conclusion) parts.push(`结论=${conclusion}`);
    return `[工具结果：${parts.join('；')}]`;
}

function looksLikePath(value) {
    return /^(?:[A-Za-z]:[\\/]|\\\\|\/|\.\.?[\\/])/.test(value)
        || /[\\/][^\\/]+\.[A-Za-z0-9]{1,12}$/.test(value);
}

function extractArtifactRefs(rawText) {
    const labels = ['artifact_path', 'artifactPath', 'artifact', 'artifact路径', '文件路径', '输出文件', '路径'];
    const values = [
        ...extractAllLabeledFields(rawText, labels),
        ...[...String(rawText || '').matchAll(/(?:artifact_path|artifactPath)\s*[:=]\s*(["']?[^\s,"']+)/gi)].map(match => cleanField(match[1]))
    ];
    const refs = [];
    for (const value of values) {
        const pathValue = value.replace(/^['"]|['"]$/g, '').trim();
        if (!pathValue || !looksLikePath(pathValue) || refs.some(ref => ref.path === pathValue)) continue;
        refs.push({ type: 'path', path: pathValue });
        if (refs.length >= 8) break;
    }
    return refs;
}

function inertVcpFieldDelimiters(text) {
    return String(text || '')
        .replace(/「始(?:ESCAPE)?」/gi, '〔VCP字段起始标记已惰性化〕')
        .replace(/「末(?:ESCAPE)?」/gi, '〔VCP字段结束标记已惰性化〕');
}

function normalizeWhitespace(text) {
    return String(text || '')
        .replace(/\u0000/g, '')
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

function selectSemanticParagraphs(text, maxChars = MAX_EVENT_TEXT_CHARS) {
    const paragraphs = normalizeWhitespace(text).split(/\n{2,}/).map(value => value.trim()).filter(Boolean);
    if (paragraphs.join('\n\n').length <= maxChars) {
        return { text: paragraphs.join('\n\n'), truncation: null };
    }

    const markerPrefix = '[内容已按语义段落选择；省略';
    const semanticPattern = /(结果|结论|完成|失败|错误|状态|路径|文件|用户|助手|请求|回复|关键|注意|confirmed|result|error|status|path)/i;
    const ranked = paragraphs.map((paragraph, index) => {
        let score = semanticPattern.test(paragraph) ? 4 : 0;
        if (index === 0) score += 2;
        if (index === paragraphs.length - 1) score += 1;
        if (paragraph.length < 1200) score += 1;
        return { paragraph, index, score };
    }).sort((left, right) => right.score - left.score || left.index - right.index);

    const selected = [];
    let selectedChars = 0;
    const budget = Math.max(200, maxChars - 160);
    for (const item of ranked) {
        const extra = item.paragraph.length + (selected.length ? 2 : 0);
        if (selectedChars + extra > budget) continue;
        selected.push(item);
        selectedChars += extra;
    }
    if (selected.length === 0) {
        selected.push({ paragraph: paragraphs[0].slice(0, budget), index: 0, score: 0 });
        selectedChars = selected[0].paragraph.length;
    }
    selected.sort((left, right) => left.index - right.index);

    const omittedChars = Math.max(0, paragraphs.reduce((sum, value) => sum + value.length, 0) - selected.reduce((sum, item) => sum + item.paragraph.length, 0));
    const omittedParagraphs = paragraphs.length - selected.length;
    const marker = `${markerPrefix} ${omittedChars} 字符、${omittedParagraphs} 段；选择=语义相关段落]`;
    let result = `${selected.map(item => item.paragraph).join('\n\n')}\n${marker}`;
    if (result.length > maxChars) result = result.slice(0, maxChars - 1).trimEnd() + '…';
    return {
        text: result,
        truncation: {
            applied: true,
            strategy: 'semantic-paragraph-selection',
            originalChars: paragraphs.reduce((sum, value) => sum + value.length, 0),
            omittedChars,
            omittedParagraphs,
            maxChars
        }
    };
}

function hash(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function dedupeRepeatedSummaries(text) {
    const paragraphs = String(text || '').split(/\n{2,}/).map(value => value.trim()).filter(Boolean);
    const seenSummaries = new Set();
    return paragraphs.map(paragraph => {
        return paragraph.split(/\n+/).map(line => line.trim()).filter(Boolean).filter(line => {
            if (!/^\[(?:工具请求|工具结果)：/i.test(line)) return true;
            const key = line.replace(/\s+/g, ' ');
            if (seenSummaries.has(key)) return false;
            seenSummaries.add(key);
            return true;
        }).join('\n');
    }).filter(Boolean).join('\n\n');
}

function normalizeText(rawContent) {
    let raw = asText(rawContent).replace(/\u0000/g, '');
    if (!raw.trim()) return { text: '', artifactRefs: [], truncation: null, kind: 'empty' };

    const artifactRefs = extractArtifactRefs(raw);
    let hadRequest = false;
    let hadResult = false;
    let text = raw.replace(RAG_BLOCK_REGEX, '\n');
    text = text.replace(TOOL_REQUEST_REGEX, block => {
        hadRequest = true;
        return `\n${summarizeToolRequest(block)}\n`;
    });
    text = text.replace(TOOL_RESULT_REGEX, block => {
        hadResult = true;
        return `\n${summarizeToolResult(block)}\n`;
    });
    text = text.replace(TOOL_SUMMARY_REGEX, '\n');
    text = text.replace(/<!--\s*VCP_TOOL_PAYLOAD\s*-->[\s\S]*$/gi, '\n');
    text = text.replace(/近期客观时间线（OneRingMemo[\s\S]*?(?:以上是过往记忆区)[^\r\n]*/gi, '\n');
    text = text.replace(/近期客观时间线\s*\(OneRingMemo[\s\S]*?(?:以上是过往记忆区)[^\r\n]*/gi, '\n');
    text = text.replace(META_THOUGHT_REGEX, '\n');
    text = text.replace(THINKING_BLOCK_REGEX, '\n');
    text = text.replace(/VCP系统工具列表：[\s\S]*?(?=\[本信息由VCPChat客户端注入\]|<<<\[TOOL_REQUEST\]>>>|\[\[VCP调用结果信息汇总:|\[工具请求：|\[工具结果：|$)/gi, '\n');
    text = text.replace(/data:(?:image|audio|video)\/[^;,\s]+;base64,[A-Za-z0-9+/=\r\n]+/gi, '[Base64媒体已省略]');
    text = text.replace(/```[\s\S]*?```/g, block => (
        block.length > 1200 ? `\n[长代码或日志块已省略；原始${block.length}字符]\n` : block
    ));
    text = stripHtmlToVisibleText(text);
    // 完整工具块已在前面结构化；此处只处理散落在普通正文或协议示例中的
    // VCP 字段边界，使归档文本保持语义但不再具有可执行协议形态。
    text = inertVcpFieldDelimiters(text);
    text = redactSensitiveValues(text);
    text = text.replace(/\[OneRing通知:[^\]]*\]/g, ' ');
    text = dedupeRepeatedSummaries(normalizeWhitespace(text));

    if (!text || text === '[工具载荷已省略]') {
        return { text: '', artifactRefs, truncation: null, kind: 'empty' };
    }

    const selected = selectSemanticParagraphs(text);
    const kind = hadRequest && hadResult ? 'tool_exchange' : hadRequest ? 'tool_request' : hadResult ? 'tool_result' : 'message';
    return { ...selected, artifactRefs, kind };
}

function actorName(row, role) {
    const explicit = String(row.senderName || '').trim();
    if (explicit) return explicit;
    if (role === 'assistant') return 'assistant';
    if (role === 'user') return 'user';
    return role || 'unknown';
}

function normalizeMessageRow(row) {
    if (!row || typeof row !== 'object') return null;
    const role = String(row.role || 'unknown').trim() || 'unknown';
    const occurredAt = row.timestamp == null ? '' : String(row.timestamp);
    const normalized = normalizeText(row.content);
    if (!normalized.text) return null;
    const eventId = row.id == null ? hash(JSON.stringify({ role, senderName: row.senderName || '', frontendSource: row.frontendSource || '', occurredAt, text: normalized.text })).slice(0, 24) : String(row.id);
    const actor = { name: actorName(row, role), role };
    const origin = { frontendSource: row.frontendSource == null ? null : String(row.frontendSource) };
    const contentHash = hash(normalized.text);
    const eventUid = hash(JSON.stringify({ eventId, occurredAt, role, actor, origin, contentHash }));
    const event = {
        schemaVersion: SCHEMA_VERSION,
        eventId,
        eventUid,
        occurredAt,
        role,
        actor,
        origin,
        kind: normalized.kind,
        text: normalized.text,
        artifactRefs: normalized.artifactRefs,
        contentHash
    };
    if (normalized.truncation) event.truncation = normalized.truncation;
    return event;
}

function eventDedupeKey(event) {
    return hash(JSON.stringify({
        occurredAt: event?.occurredAt || '',
        role: event?.role || '',
        actor: event?.actor || null,
        origin: event?.origin || null,
        kind: event?.kind || '',
        text: event?.text || ''
    }));
}

function dedupeCanonicalEvents(events) {
    const seen = new Set();
    const result = [];
    for (const event of Array.isArray(events) ? events : []) {
        const key = eventDedupeKey(event);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(event);
    }
    return result;
}

function containsSensitiveMarker(value) {
    return /\[REDACTED\]|(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret)\s*[:=：]|(?:验证码|授权码|密码)\s*(?:为|是|[:=：])/i.test(String(value || ''));
}

module.exports = {
    SCHEMA_VERSION,
    MAX_EVENT_TEXT_CHARS,
    asText,
    normalizeText,
    normalizeMessageRow,
    dedupeCanonicalEvents,
    eventDedupeKey,
    containsSensitiveMarker,
    redactSensitiveValues,
    selectSemanticParagraphs
};
