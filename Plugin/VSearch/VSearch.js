const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { tavily } = require('@tavily/core');

// --- 1. 初始化与配置加载 ---
const configPath = path.resolve(__dirname, './config.env');
const rootConfigPath = path.resolve(__dirname, '../../config.env');

dotenv.config({ path: configPath });

const {
    VSearchKey: API_KEY,
    VSearchUrl: API_URL,
    VSearchModel: MODEL,
    GrokModel: GROK_MODEL,
    TavilyModel: TAVILY_MODEL,
    SummaryKey: SUMMARY_KEY,
    SummaryUrl: SUMMARY_URL,
    SummaryModel: SUMMARY_MODEL,
    VSearchMaxToken: MAX_TOKENS,
    MaxConcurrent: MAX_CONCURRENT,
    HTTP_PROXY: PROXY,
    KimiSearchUrl: KIMI_SEARCH_URL,
    KimiSearchKey: KIMI_SEARCH_KEY,
    KimiSearchMaxResults: KIMI_SEARCH_MAX_RESULTS,
    KimiSearchIncludeContent: KIMI_SEARCH_INCLUDE_CONTENT,
} = process.env;

const CONCURRENCY = parseInt(MAX_CONCURRENT, 10) || 5;
const TOKENS = parseInt(MAX_TOKENS, 10) || 50000;
const KIMI_MAX_RESULTS = Math.min(Math.max(parseInt(KIMI_SEARCH_MAX_RESULTS, 10) || 5, 1), 20);
const KIMI_INCLUDE_CONTENT = KIMI_SEARCH_INCLUDE_CONTENT === 'true';

// --- 2. 辅助函数 ---
const log = (message) => {
    console.error(`[VSearch] ${new Date().toISOString()}: ${message}`);
};

const sendResponse = (data) => {
    console.log(JSON.stringify(data));
    process.exit(0);
};

const resolveRedirect = async (url) => {
    if (!url || !url.includes('vertexaisearch.cloud.google.com/grounding-api-redirect')) {
        return url;
    }

    let targetUrl = url.trim();
    if (!targetUrl.startsWith('http')) {
        targetUrl = 'https://' + targetUrl;
    }

    try {
        const axiosConfig = {
            maxRedirects: 5,
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            },
            responseType: 'text'
        };

        if (PROXY) {
            axiosConfig.httpsAgent = new HttpsProxyAgent(PROXY);
            axiosConfig.proxy = false;
        }

        const response = await axios.get(targetUrl, axiosConfig);
        const finalUrl = response.request?.res?.responseUrl || targetUrl;
        
        if (finalUrl !== targetUrl && !finalUrl.includes('grounding-api-redirect')) {
            log(`解析成功: ${targetUrl.substring(0, 40)}... -> ${finalUrl}`);
            return finalUrl;
        }

        const body = typeof response.data === 'string' ? response.data : '';
        const metaMatch = body.match(/url=\s*([^"'\s>]+)/i);
        if (metaMatch?.[1]) {
            const resolved = metaMatch[1].replace(/&/g, '&').replace(/["']/g, '');
            if (!resolved.includes('grounding-api-redirect')) {
                return resolved;
            }
        }

        return targetUrl;
    } catch (error) {
        const fallbackUrl = error.request?.res?.responseUrl;
        if (fallbackUrl && fallbackUrl !== targetUrl && !fallbackUrl.includes('grounding-api-redirect')) {
            return fallbackUrl;
        }

        log(`解析失败: ${error.message}`);
        return targetUrl;
    }
};

const getGeminiRelayUrl = () => {
    const raw = (API_URL || '').trim();
    if (!raw) {
        throw new Error('VSearchUrl 未配置。');
    }

    const normalized = raw.replace(/\/+$/, '');
    const relayBase = normalized.replace(/\/v1\/chat\/completions$/i, '');
    return `${relayBase}/v1beta/models/${MODEL}:generateContent`;
};

/**
 * Grounding 模式 (New API Gemini Relay)
 */
const callGroundingMode = async (topic, keyword, showURL = false) => {
    const now = new Date();
    const currentTime = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    const systemPrompt = `你是一个专业的语义搜索助手。当前系统时间: ${currentTime}。
你的任务是根据用户提供的【检索目标主题】和具体的【检索关键词】，从互联网获取最相关、最准确的信息。

行动指南：
1. 意图对齐：深入理解【检索目标主题】，确保搜索结果能直接服务于该主题的研究。
2. 深度检索：利用内置的 googleSearch 工具获取实时信息。
3. 信息精炼：不要简单堆砌搜索结果。请从网页中提取关键事实、核心数据、专家观点或最新进展。
4. 语言风格：专业、客观、精炼。
${showURL ? '5. 严格溯源：每一条重要信息必须附带来源 URL。如果你使用了引用标记（如 [cite: X]），请确保在回复末尾的 [参考来源] 部分列出这些标记对应的完整 URL。' : '5. 节省Token：除非特别重要，否则不需要在正文中列出 URL 链接。'}`;

    const outputRequirements = showURL
        ? '- 包含 [核心发现]、[关键数据/事实] 和 [参考来源] 三部分。'
        : '- 包含 [核心发现] 和 [关键数据/事实] 两部分。';

    const userMessage = `【检索目标主题】：${topic}\n【当前检索关键词】：${keyword}\n\n请调用搜索工具获取最新信息，并按要求结构化输出。`;

    const payload = {
        systemInstruction: {
            parts: [{ text: `${systemPrompt}\n\n输出要求：\n- 针对该关键词，提供一个结构化的总结。\n${outputRequirements}` }]
        },
        contents: [
            {
                role: 'user',
                parts: [{ text: userMessage }]
            }
        ],
        tools: [
            {
                google_search: {}
            }
        ],
        generationConfig: {
            temperature: 0.2,
            maxOutputTokens: TOKENS
        }
    };

    try {
        const relayUrl = getGeminiRelayUrl();
        log(`[Grounding] 正在搜索关键词: "${keyword}"...`);

        const response = await axios.post(relayUrl, payload, {
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 180000,
            proxy: false
        });

        const candidate = response.data?.candidates?.[0];
        const parts = candidate?.content?.parts || [];
        let content = parts
            .map(part => part.text)
            .filter(Boolean)
            .join('\n')
            .trim();

        if (!content) {
            content = '[搜索完成，但未返回可解析的文本内容]';
        }

        try {
            const groundingMetadata = candidate?.groundingMetadata || response.data?.groundingMetadata;
            const vertexUrlRegex = /(?:https?:\/\/)?vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\/[\w\-=]+/g;
            const foundUrls = content.match(vertexUrlRegex) || [];

            const metadataUrls = (groundingMetadata?.groundingChunks || [])
                .map(chunk => chunk?.web?.uri)
                .filter(Boolean);

            const allVertexUrls = [...new Set([...foundUrls, ...metadataUrls])];
            const urlMap = new Map();

            if (allVertexUrls.length > 0) {
                await Promise.all(allVertexUrls.map(async (vUrl) => {
                    const realUrl = await resolveRedirect(vUrl);
                    if (realUrl !== vUrl) {
                        urlMap.set(vUrl, realUrl);
                    }
                }));

                for (const [original, resolved] of urlMap.entries()) {
                    content = content.split(original).join(resolved);
                }
            }

            if (showURL && groundingMetadata?.groundingChunks) {
                const citations = groundingMetadata.groundingChunks
                    .map((chunk, index) => {
                        if (chunk?.web?.uri) {
                            const realUrl = urlMap.get(chunk.web.uri) || chunk.web.uri;
                            const title = chunk.web.title || `Source ${index + 1}`;
                            return `[cite: ${index + 1}] ${title}: ${realUrl}`;
                        }
                        return null;
                    })
                    .filter(Boolean);

                if (citations.length > 0) {
                    content += `\n\n**API 自动引证来源 (已解析真实URL):**\n${citations.join('\n')}`;
                }
            }
        } catch (metaError) {
            log(`解析 groundingMetadata/重定向URL时出错: ${metaError.message}`);
        }

        return content;
    } catch (error) {
        const status = error.response?.status;
        const responseData = error.response?.data;
        const detail = responseData
            ? (typeof responseData === 'string' ? responseData : JSON.stringify(responseData))
            : error.message;

        log(`关键词 "${keyword}" 搜索失败: HTTP ${status || 'N/A'} | ${detail}`);
        return `[搜索失败] 关键词: ${keyword}。错误原因: HTTP ${status || 'N/A'} | ${detail}`;
    }
};

// --- 3. 主逻辑 ---
const callGrokMode = async (topic, keywordList) => {
    const systemPrompt = `你是一个具备实时联网搜索能力的顶级 AI 助手。
你的任务是针对用户提供的【检索目标主题】和一系列【检索关键词】，利用你的内置搜索能力获取最新信息并进行深度总结。
请针对每个关键词进行搜索，并最终产出一份结构化、全景式的研究报告。`;

    const userMessage = `【检索目标主题】：${topic}
【检索关键词列表】：
${keywordList.map((kw, i) => `${i + 1}. ${kw}`).join('\n')}

请针对上述关键词执行联网搜索，并结合研究主题给出深度总结。`;

    const payload = {
        model: GROK_MODEL || "grok-4.20-beta",
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
        ],
        stream: true,
        max_tokens: TOKENS
    };

    try {
        log(`[Grok] 正在执行全量搜索 (关键词数量: ${keywordList.length})...`);
        const response = await axios.post(API_URL, payload, {
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
            responseType: 'stream',
            timeout: 300000,
            proxy: false
        });

        return new Promise((resolve, reject) => {
            let fullContent = '';
            response.data.on('data', chunk => {
                const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const dataStr = line.slice(6);
                        if (dataStr === '[DONE]') continue;
                        try {
                            const json = JSON.parse(dataStr);
                            const content = json.choices[0]?.delta?.content || '';
                            fullContent += content;
                        } catch (e) { }
                    }
                }
            });

            response.data.on('end', () => {
                const cleanedContent = fullContent.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                resolve(cleanedContent);
            });

            response.data.on('error', err => reject(err));
        });
    } catch (error) {
        log(`[Grok] 全量搜索失败: ${error.message}`);
        return `[Grok 搜索失败] 错误原因: ${error.message}`;
    }
};

const pickRandomKey = (keyStr) => {
    if (!keyStr) return null;
    if (keyStr.includes(',')) {
        const keys = keyStr.split(',').map(k => k.trim()).filter(k => k);
        return keys.length > 0 ? keys[Math.floor(Math.random() * keys.length)] : null;
    }
    return keyStr.trim();
};

const callTavilySearch = async (query, tavilyKeyStr) => {
    const apiKey = pickRandomKey(tavilyKeyStr);
    if (!apiKey) {
        throw new Error('TavilyKey 未配置，请在根目录 config.env 中设置 TavilyKey。');
    }

    const tvly = tavily({ apiKey });
    const response = await tvly.search(query, {
        search_depth: 'advanced',
        topic: 'general',
        max_results: 10,
        include_answer: false,
        include_images: false,
    });

    let markdown = '';
    if (response.results && response.results.length > 0) {
        response.results.forEach((item, index) => {
            markdown += `${index + 1}. **[${item.title}](${item.url})**\n`;
            if (item.content) {
                markdown += `   ${item.content}\n\n`;
            }
        });
    } else {
        markdown = '未找到相关搜索结果。\n';
    }
    return markdown;
};

const callTavilyMode = async (topic, keywordList, tavilyKeyStr) => {
    let combinedResults = '';
    try {
        log(`[Tavily] 阶段1/2: 正在并发获取 ${keywordList.length} 个关键词的搜索结果 (直接调用 Tavily API)...`);

        const searchPromises = keywordList.map(async (kw) => {
            try {
                const result = await callTavilySearch(kw, tavilyKeyStr);
                log(`[Tavily] 关键词 "${kw}" 搜索成功`);
                return `### 关键词: ${kw}\n${result}`;
            } catch (e) {
                log(`[Tavily] 关键词 "${kw}" 搜索失败: ${e.message}`);
                return `### 关键词: ${kw}\n[搜索失败]: ${e.message}\n`;
            }
        });

        const allSearchResults = await Promise.all(searchPromises);
        combinedResults = allSearchResults.join('\n---\n');
        log(`[Tavily] 阶段1/2 完成: 搜索结果总长度 ${combinedResults.length} 字符`);
    } catch (searchError) {
        log(`[Tavily] 阶段1 搜索整体失败: ${searchError.message}`);
        return `[Tavily 搜索阶段失败] 错误原因: ${searchError.message}`;
    }

    // === 阶段2: 模型总结 ===
    const summaryKey = SUMMARY_KEY || API_KEY;
    const summaryUrl = SUMMARY_URL || API_URL;
    const summaryModel = SUMMARY_MODEL || TAVILY_MODEL || "claude-sonnet-4-6";

    if (!summaryKey || !summaryUrl) {
        log(`[Tavily] 未配置总结用 LLM API（SummaryKey/SummaryUrl 或 VSearchKey/VSearchUrl），跳过总结阶段，直接返回原始结果`);
        return combinedResults;
    }

    try {
        log(`[Tavily] 阶段2/2: 正在使用 ${summaryModel} 通过 ${summaryUrl} 进行全量总结...`);
        const summaryPayload = {
            model: summaryModel,
            messages: [
                {
                    role: 'system',
                    content: `你是一个顶级信息整合专家。你会收到一份关于多个关键词的原始搜索结果汇总。\n你的任务是结合【研究主题：${topic}】，将这些零散的信息提炼成一份高质量、结构化、具有深度洞察的研究报告。\n请保留重要的 URL 链接，并确保报告逻辑严密。`
                },
                { role: 'user', content: `原始搜索结果汇总如下：\n\n${combinedResults}` }
            ],
            max_tokens: TOKENS
        };

        const summaryAxiosConfig = {
            headers: { 'Authorization': `Bearer ${summaryKey}`, 'Content-Type': 'application/json' },
            timeout: 180000,
            proxy: false
        };

        const summaryResponse = await axios.post(summaryUrl, summaryPayload, summaryAxiosConfig);

        log(`[Tavily] 阶段2/2 完成: 总结成功`);
        return summaryResponse.data.choices[0].message.content;
    } catch (summaryError) {
        const statusCode = summaryError.response?.status || 'N/A';
        const errorDetail = summaryError.response?.data ? JSON.stringify(summaryError.response.data).substring(0, 500) : summaryError.message;
        log(`[Tavily] 阶段2 总结失败 (HTTP ${statusCode}): ${errorDetail}`);
        return `[总结阶段失败 (HTTP ${statusCode}): ${summaryError.message}]\n\n**以下为原始搜索结果（未经整合）：**\n\n${combinedResults}`;
    }
};

/**
 * 单次调用 Kimi Search API
 */
const callKimiSearch = async (query, apiKey, baseUrl, maxResults, includeContent) => {
    const url = baseUrl.endsWith('/search') ? baseUrl : `${baseUrl.replace(/\/$/, '')}/search`;
    try {
        log(`[KimiSearch] 正在搜索: "${query}"...`);
        const response = await axios.post(url, {
            text_query: query,
            limit: maxResults,
            enable_page_crawling: includeContent,
            timeout_seconds: 30
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'X-Msh-Tool-Call-Id': `vsearch-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
            },
            timeout: 180000,
            proxy: false
        });

        const results = response.data.search_results || [];
        if (results.length === 0) {
            return '未找到相关搜索结果。\n';
        }

        let markdown = '';
        results.forEach((item, index) => {
            markdown += `${index + 1}. **${item.title}**\n`;
            markdown += `   URL: ${item.url}\n`;
            if (item.date) markdown += `   Date: ${item.date}\n`;
            if (item.site_name) markdown += `   Source: ${item.site_name}\n`;
            markdown += `   Summary: ${item.snippet}\n`;
            if (item.content) {
                markdown += `\n   ${item.content}\n`;
            }
            markdown += '\n';
        });
        return markdown;
    } catch (error) {
        const status = error.response?.status || 'N/A';
        log(`[KimiSearch] 搜索失败 (HTTP ${status}): ${error.message}`);
        return `[搜索失败] 错误原因: ${error.message}`;
    }
};

/**
 * KimiSearch 模式 (并发搜索 + 可选 LLM 总结)
 */
const callKimiSearchMode = async (topic, keywordList, apiKey, baseUrl, maxResults, includeContent) => {
    // === 阶段1: 并发搜索 ===
    let combinedResults = '';
    try {
        log(`[KimiSearch] 阶段1/2: 正在并发获取 ${keywordList.length} 个关键词的搜索结果...`);
        const searchPromises = keywordList.map(async (kw) => {
            const result = await callKimiSearch(kw, apiKey, baseUrl, maxResults, includeContent);
            log(`[KimiSearch] 关键词 "${kw}" 搜索完成`);
            return `### 关键词: ${kw}\n${result}`;
        });
        const allSearchResults = await Promise.all(searchPromises);
        combinedResults = allSearchResults.join('\n---\n');
        log(`[KimiSearch] 阶段1/2 完成: 搜索结果总长度 ${combinedResults.length} 字符`);
    } catch (searchError) {
        log(`[KimiSearch] 阶段1 搜索整体失败: ${searchError.message}`);
        return `[KimiSearch 搜索阶段失败] 错误原因: ${searchError.message}`;
    }

    // === 阶段2: 模型总结 (如果配置了 LLM API) ===
    const summaryKey = SUMMARY_KEY || API_KEY;
    const summaryUrl = SUMMARY_URL || API_URL;
    const summaryModel = SUMMARY_MODEL || MODEL || "claude-sonnet-4-6";

    if (!summaryKey || !summaryUrl) {
        log(`[KimiSearch] 未配置总结用 LLM API（SummaryKey/SummaryUrl 或 VSearchKey/VSearchUrl），跳过总结阶段，直接返回原始结果`);
        return combinedResults;
    }

    try {
        log(`[KimiSearch] 阶段2/2: 正在使用 ${summaryModel} 通过 ${summaryUrl} 进行全量总结...`);
        const summaryPayload = {
            model: summaryModel,
            messages: [
                {
                    role: 'system',
                    content: `你是一个顶级信息整合专家。你会收到一份关于多个关键词的原始搜索结果汇总。\n你的任务是结合【研究主题：${topic}】，将这些零散的信息提炼成一份高质量、结构化、具有深度洞察的研究报告。\n请保留重要的 URL 链接，并确保报告逻辑严密。`
                },
                { role: 'user', content: `原始搜索结果汇总如下：\n\n${combinedResults}` }
            ],
            max_tokens: TOKENS
        };

        const summaryResponse = await axios.post(summaryUrl, summaryPayload, {
            headers: { 'Authorization': `Bearer ${summaryKey}`, 'Content-Type': 'application/json' },
            timeout: 300000,
            proxy: false
        });

        log(`[KimiSearch] 阶段2/2 完成: 总结成功`);
        return summaryResponse.data.choices[0].message.content;
    } catch (summaryError) {
        const statusCode = summaryError.response?.status || 'N/A';
        const errorDetail = summaryError.response?.data ? JSON.stringify(summaryError.response.data).substring(0, 500) : summaryError.message;
        log(`[KimiSearch] 阶段2 总结失败 (HTTP ${statusCode}): ${errorDetail}`);
        return `[总结阶段失败 (HTTP ${statusCode}): ${summaryError.message}]\n\n**以下为原始搜索结果（未经整合）：**\n\n${combinedResults}`;
    }
};

async function main(request) {
    const { SearchTopic, Keywords, ShowURL, SearchMode = 'kimisearch' } = request;
    const showURL = ShowURL === true || ShowURL === 'true';

    if (!SearchTopic || !Keywords) {
        return sendResponse({ status: "error", error: "缺少必需参数: SearchTopic 或 Keywords。" });
    }

    const keywordList = Keywords.split(/[,\n，]/).map(k => k.trim()).filter(k => k.length > 0);
    if (keywordList.length === 0) {
        return sendResponse({ status: "error", error: "未识别到有效的关键词。" });
    }

    log(`启动 VSearch [模式: ${SearchMode}]。主题: "${SearchTopic}"，关键词数量: ${keywordList.length}`);

    if (SearchMode === 'grok') {
        const result = await callGrokMode(SearchTopic, keywordList);
        return sendResponse({ status: "success", result: `## VSearch 检索报告 [模式: Grok]\n\n**研究主题**: ${SearchTopic}\n\n${result}` });
    }

    if (SearchMode === 'tavily') {
        let tavilyKeyStr = '';
        try {
            const rootEnvContent = await fs.readFile(rootConfigPath, 'utf8');
            const rootEnv = dotenv.parse(rootEnvContent);
            tavilyKeyStr = rootEnv.TavilyKey || '';
        } catch (e) {
            log(`读取根目录配置失败: ${e.message}`);
        }
        if (!tavilyKeyStr) {
            return sendResponse({ status: "error", error: "Tavily 模式需要在根目录 config.env 中配置 TavilyKey。" });
        }
        const result = await callTavilyMode(SearchTopic, keywordList, tavilyKeyStr);
        return sendResponse({ status: "success", result: `## VSearch 检索报告 [模式: Tavily]\n\n**研究主题**: ${SearchTopic}\n\n${result}` });
    }

    if (SearchMode === 'kimisearch') {
        if (!KIMI_SEARCH_KEY) {
            return sendResponse({ status: "error", error: "KimiSearch 模式需要在 config.env 中配置 KimiSearchKey。" });
        }
        if (!KIMI_SEARCH_URL) {
            return sendResponse({ status: "error", error: "KimiSearch 模式需要在 config.env 中配置 KimiSearchUrl。" });
        }
        const result = await callKimiSearchMode(SearchTopic, keywordList, KIMI_SEARCH_KEY, KIMI_SEARCH_URL, KIMI_MAX_RESULTS, KIMI_INCLUDE_CONTENT);
        return sendResponse({ status: "success", result: `## VSearch 检索报告 [模式: KimiSearch]\n\n**研究主题**: ${SearchTopic}\n\n${result}` });
    }

    // Grounding 模式：保持原有的并发分批逻辑
    let allResults = [];
    for (let i = 0; i < keywordList.length; i += CONCURRENCY) {
        const chunk = keywordList.slice(i, i + CONCURRENCY);
        const promises = chunk.map(kw => callGroundingMode(SearchTopic, kw, showURL));
        const results = await Promise.all(promises);
        results.forEach((res, idx) => {
            allResults.push(`### 关键词: ${chunk[idx]}\n${res}\n\n---\n\n`);
        });
    }

    const finalOutput = `## VSearch 检索报告 [模式: Grounding]\n\n**研究主题**: ${SearchTopic}\n\n${allResults.join('')}`;
    sendResponse({ status: "success", result: finalOutput });
}

let inputData = '';
process.stdin.on('data', chunk => { inputData += chunk; });
process.stdin.on('end', () => {
    try {
        if (!inputData) {
            throw new Error("未从 stdin 接收到任何数据。");
        }
        const request = JSON.parse(inputData);
        main(request);
    } catch (e) {
        log(`解析输入JSON时出错: ${e.message}`);
        sendResponse({ status: "error", error: "无法解析来自主服务的输入参数。" });
    }
});