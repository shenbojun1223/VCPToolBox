#!/usr/bin/env node
const { tavily } = require('@tavily/core'); // Using the official Node.js client
const stdin = require('process').stdin;

const DIRECT_MAX_RESULTS = 3;
const DIRECT_MAX_SUBQUERIES = 1;
const MAX_SNIPPET_CHARS = 1200;
const MAX_OUTPUT_CHARS = 10000;

function truncateText(value, maxChars, label = '内容') {
    const text = String(value || '');
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n\n...[${label}已截断；原始长度 ${text.length} 字符]`;
}

/**
 * 将 Tavily 搜索结果格式化为 Markdown
 */
function formatTavilyResults(response) {
    let md = '';
    if (response.answer) {
        md += `### 直接回答\n${truncateText(response.answer, 1500, '直接回答')}\n\n`;
    }

    const results = Array.isArray(response.results)
        ? response.results.slice(0, DIRECT_MAX_RESULTS)
        : [];

    if (results.length > 0) {
        md += `### 搜索结果\n`;
        results.forEach((item, index) => {
            md += `${index + 1}. **[${item.title}](${item.url})**\n`;
            if (item.content) {
                md += `   ${truncateText(item.content, MAX_SNIPPET_CHARS, '单条搜索摘要')}\n\n`;
            }
        });
    } else {
        md += `未找到相关搜索结果。\n`;
    }

    return truncateText(md, MAX_OUTPUT_CHARS, 'TavilySearch 直连输出');
}

async function main() {
    let inputData = '';
    stdin.setEncoding('utf8');

    stdin.on('data', function(chunk) {
        inputData += chunk;
    });

    stdin.on('end', async function() {
        let output = {};

        try {
            if (!inputData.trim()) {
                throw new Error("No input data received from stdin.");
            }

            const data = JSON.parse(inputData);

            const query = data.query;
            const directTavily = data.direct_tavily === true || data.direct_tavily === 'true';
            const allowRawContent = data.allow_raw_content === true || data.allow_raw_content === 'true';
            const topic = data.topic || 'general';
            const searchDepth = data.search_depth || 'basic';
            let maxResults = data.max_results ?? DIRECT_MAX_RESULTS;
            const includeRawContent = data.include_raw_content;
            const country = data.country?.trim().toLowerCase(); // 新增国家来源参数
            const startDate = data.start_date;
            const endDate = data.end_date;
            const time_range = data.time_range;

            if (!directTavily) {
                throw new Error("TavilySearch 是受限直连工具。普通联网检索请使用 VSearch；确需直连时必须显式传 direct_tavily=true。");
            }

            if (!query) {
                throw new Error("Missing required argument: query");
            }

            // Validate and hard-cap max_results
            try {
                maxResults = parseInt(maxResults, 10);
                if (isNaN(maxResults)) maxResults = DIRECT_MAX_RESULTS;
                maxResults = Math.min(Math.max(maxResults, 1), DIRECT_MAX_RESULTS);
            } catch (e) {
                maxResults = DIRECT_MAX_RESULTS;
            }

            let apiKey = process.env.TavilyKey; // Use the correct environment variable name
            if (!apiKey) {
                throw new Error("TavilyKey environment variable not set.");
            }

            // Check if the key is a comma-separated list
            if (apiKey.includes(',')) {
                const keys = apiKey.split(',').map(key => key.trim()).filter(key => key);
                if (keys.length > 0) {
                    // Select a random key from the array
                    apiKey = keys[Math.floor(Math.random() * keys.length)];
                } else {
                    throw new Error("TavilyKey environment variable is empty or contains only commas.");
                }
            }

            const tvly = tavily({ apiKey });

            const searchOptions = {
                search_depth: searchDepth,
                topic: topic,
                max_results: maxResults,
                include_answer: false, // Usually just want results for AI processing
                include_images: true,
                include_image_descriptions: true,
            };

            if (includeRawContent === "text" || includeRawContent === "markdown") {
                if (!allowRawContent) {
                    throw new Error("直连原文抓取默认关闭。确有必要时需同时传 allow_raw_content=true，并将 max_results 设为 1。");
                }
                if (maxResults !== 1) {
                    throw new Error("启用 include_raw_content 时 max_results 必须为 1。");
                }
                searchOptions.include_raw_content = includeRawContent;
            }

            if (country) {
                // https://docs.tavily.com/documentation/api-reference/endpoint/search#body-country
                // 确保只传递非空字符串
                const validCountry = [
                    'afghanistan', 'albania', 'algeria', 'andorra', 'angola', 'argentina', 'armenia', 'australia', 'austria',
                    'azerbaijan', 'bahamas', 'bahrain', 'bangladesh', 'barbados', 'belarus', 'belgium', 'belize', 'benin',
                    'bhutan', 'bolivia', 'bosnia and herzegovina', 'botswana', 'brazil', 'brunei', 'bulgaria', 'burkina faso',
                    'burundi', 'cambodia', 'cameroon', 'canada', 'cape verde', 'central african republic', 'chad', 'chile',
                    'china', 'colombia', 'comoros', 'congo', 'costa rica', 'croatia', 'cuba', 'cyprus', 'czech republic',
                    'denmark', 'djibouti', 'dominican republic', 'ecuador', 'egypt', 'el salvador', 'equatorial guinea', 'eritrea',
                    'estonia', 'ethiopia', 'fiji', 'finland', 'france', 'gabon', 'gambia', 'georgia', 'germany', 'ghana', 'greece',
                    'guatemala', 'guinea', 'haiti', 'honduras', 'hungary', 'iceland', 'india', 'indonesia', 'iran', 'iraq',
                    'ireland', 'israel', 'italy', 'jamaica', 'japan', 'jordan', 'kazakhstan', 'kenya', 'kuwait', 'kyrgyzstan',
                    'latvia', 'lebanon', 'lesotho', 'liberia', 'libya', 'liechtenstein', 'lithuania', 'luxembourg', 'madagascar',
                    'malawi', 'malaysia', 'maldives', 'mali', 'malta', 'mauritania', 'mauritius', 'mexico', 'moldova', 'monaco',
                    'mongolia', 'montenegro', 'morocco', 'mozambique', 'myanmar', 'namibia', 'nepal', 'netherlands', 'new zealand',
                    'nicaragua', 'niger', 'nigeria', 'north korea', 'north macedonia', 'norway', 'oman', 'pakistan', 'panama',
                    'papua new guinea', 'paraguay', 'peru', 'philippines', 'poland', 'portugal', 'qatar', 'romania', 'russia',
                    'rwanda', 'saudi arabia', 'senegal', 'serbia', 'singapore', 'slovakia', 'slovenia', 'somalia', 'south africa',
                    'south korea', 'south sudan', 'spain', 'sri lanka', 'sudan', 'sweden', 'switzerland', 'syria', 'taiwan',
                    'tajikistan', 'tanzania', 'thailand', 'togo', 'trinidad and tobago', 'tunisia', 'turkey', 'turkmenistan',
                    'uganda', 'ukraine', 'united arab emirates', 'united kingdom', 'united states', 'uruguay', 'uzbekistan',
                    'venezuela', 'vietnam', 'yemen', 'zambia', 'zimbabwe'
                ];
                if (validCountry.includes(country)) {
                    searchOptions.country = country;
                }
            }

            // 检查日期参数，确保它们存在且非空，以避免潜在的 API 错误
            // 根据错误日志，当 start_date 或 end_date 存在时，Tavily API 不允许同时设置 time_range 参数。
            // @tavily/core 库可能存在默认设置 time_range 的行为，因此在这里显式地将其设为 null 来避免冲突。
            // 优先处理 start_date 和 end_date。如果它们存在，则忽略 time_range 参数以避免冲突。
            if (startDate || endDate) {
                if (startDate && startDate.trim()) {
                    searchOptions.start_date = startDate.trim();
                }
                if (endDate && endDate.trim()) {
                    searchOptions.end_date = endDate.trim();
                }
                searchOptions.time_range = null; // 显式覆盖任何默认或传入的 time_range 值
                // 防御 @tavily/core 0.5.2 SDK 内部 _search() 函数硬编码 days:3 默认值的问题
                // SDK 合并参数时 defaultOptions.days=3 不会被 undefined 覆盖，需显式传入
                searchOptions.days = undefined;
            } else if (time_range) {
                // 仅在没有日期范围时才使用 time_range 参数
                const validTimeRanges = ['day', 'week', 'month', 'year', 'd', 'w', 'm', 'y'];
                if (validTimeRanges.includes(time_range)) {
                    searchOptions.time_range = time_range;
                }
            }

            // 检测是否包含 | 分隔的多个查询
            const subQueries = query.split('|').map(q => q.trim()).filter(q => q.length > 0);

            if (subQueries.length === 0) {
                throw new Error("No valid search query after splitting by '|'");
            }
            if (subQueries.length > DIRECT_MAX_SUBQUERIES) {
                throw new Error("TavilySearch 直连仅允许单一查询；多关键词并发检索请使用 VSearch。");
            }

            if (subQueries.length > 1) {
                // 多个子查询 => 并发搜索
                const searchPromises = subQueries.map(subQuery =>
                    tvly.search(subQuery, searchOptions)
                        .then(response => ({ subQuery, response }))
                );

                const settledResults = await Promise.allSettled(searchPromises);

                let markdownResult = '';
                const failedResults = [];
                let hasAnySuccess = false;

                settledResults.forEach((result, index) => {
                    if (result.status === 'fulfilled') {
                        hasAnySuccess = true;
                        const { subQuery, response } = result.value;
                        markdownResult += `## 🔍 查询: ${subQuery}\n\n`;
                        markdownResult += formatTavilyResults(response);
                        markdownResult += '\n\n---\n\n';
                    } else {
                        failedResults.push({ subQuery: subQueries[index], error: result.reason?.message || '未知错误' });
                    }
                });

                // 补充失败查询信息
                if (failedResults.length > 0) {
                    markdownResult += `## ⚠️ 以下查询失败\n\n`;
                    for (const fail of failedResults) {
                        markdownResult += `### 查询: ${fail.subQuery}\n`;
                        markdownResult += `错误: ${fail.error}\n\n`;
                    }
                }

                if (!hasAnySuccess && failedResults.length > 0) {
                    throw new Error(`All searches failed. First error: ${failedResults[0].error}`);
                }

                output = { status: "success", result: markdownResult };

            } else {
                // 单个查询 => 原有流程
                const response = await tvly.search(query, searchOptions);
                output = { status: "success", result: formatTavilyResults(response) };
            }

        } catch (e) {
            let errorMessage;
            if (e instanceof SyntaxError) {
                errorMessage = "Invalid JSON input.";
            } else if (e instanceof Error) {
                errorMessage = e.message;
            } else {
                errorMessage = "An unknown error occurred.";
            }
            output = { status: "error", error: `Tavily Search Error: ${errorMessage}` };
        }

        // Output JSON to stdout
        process.stdout.write(JSON.stringify(output, null, 2));
    });
}

main().catch(error => {
    // Catch any unhandled promise rejections from main
    process.stdout.write(JSON.stringify({ status: "error", error: `Unhandled Plugin Error: ${error.message || error}` }));
    process.exit(1); // Indicate failure
});