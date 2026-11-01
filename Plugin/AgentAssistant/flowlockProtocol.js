'use strict';

const DEFAULT_HEARTBEAT_DELAY_SECONDS = 2;

const PROTECTED_REGION_MARKERS = [
    {
        start: '<<<[TOOL_REQUEST]>>>',
        end: '<<<[END_TOOL_REQUEST]>>>',
        caseInsensitive: true
    },
    {
        start: '[[VCP调用结果信息汇总',
        end: 'VCP调用结果结束]]',
        caseInsensitive: false
    }
];

const FLOWLOCK_PATTERNS = {
    complete: /\[\[Flowlock::Complete\]\]/i,
    fail: /\[\[Flowlock::Fail\]\]/i,
    stop: /\[\[Flowlock::Stop\]\]/i,
    start: /\[\[Flowlock::Start\]\]/i,
    heartbeat: /\[\[Flowlock::NextHeartbeat::(\d+)\]\]/ig,

    any: /\[\[\/?Flowlock::/i,
    legacyComplete: /\[\[TaskComplete(?:\s*\]\]|\s[\s\S]*?\]\])/i,
    legacyFail: /\[\[TaskFailed(?:\s*\]\]|\s[\s\S]*?\]\])/i,
    legacyHeartbeat: /\[\[NextHeartbeat::(\d+)\]\]/ig
};

function findMarkerIndex(source, marker, fromIndex, caseInsensitive) {
    if (!caseInsensitive) {
        return source.indexOf(marker, fromIndex);
    }
    // Lowercasing the entire source can change UTF-16 offsets (e.g. U+0130).
    const pattern = new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
    pattern.lastIndex = fromIndex;
    const match = pattern.exec(source);
    return match ? match.index : -1;
}

function findNextProtectedRegion(source, fromIndex) {
    let nextRegion = null;

    for (const marker of PROTECTED_REGION_MARKERS) {
        const startIndex = findMarkerIndex(source, marker.start, fromIndex, marker.caseInsensitive);
        if (startIndex === -1 || (nextRegion && startIndex >= nextRegion.startIndex)) {
            continue;
        }

        const endMarkerIndex = findMarkerIndex(
            source,
            marker.end,
            startIndex + marker.start.length,
            marker.caseInsensitive
        );

        nextRegion = {
            startIndex,
            endIndex: endMarkerIndex === -1
                ? source.length
                : endMarkerIndex + marker.end.length
        };
    }

    return nextRegion;
}

function mapUnprotectedRegions(text, transformUnprotected, transformProtected) {
    const source = String(text || '');
    const chunks = [];
    let cursor = 0;

    while (cursor < source.length) {
        const region = findNextProtectedRegion(source, cursor);
        if (!region) {
            chunks.push(transformUnprotected(source.slice(cursor)));
            break;
        }

        if (region.startIndex > cursor) {
            chunks.push(transformUnprotected(source.slice(cursor, region.startIndex)));
        }

        chunks.push(transformProtected(source.slice(region.startIndex, region.endIndex)));
        cursor = region.endIndex;
    }

    return chunks.join('');
}

function maskProtectedProtocolRegions(text) {
    return mapUnprotectedRegions(
        text,
        chunk => chunk,
        chunk => chunk.replace(/[^\r\n]/g, ' ')
    );
}

function getLastPositiveIntegerMatch(text, pattern) {
    pattern.lastIndex = 0;
    let match;
    let value = null;

    while ((match = pattern.exec(text)) !== null) {
        const candidate = Number.parseInt(match[1], 10);
        if (Number.isSafeInteger(candidate) && candidate > 0) {
            value = candidate;
        }
    }

    pattern.lastIndex = 0;
    return value;
}

// Inspect boundaries on tool/result-masked text, but retain original offsets.
// Nested prompts belong to the outer payload; a truncated prompt protects to EOF.
function findNextPromptRegions(protocolSource) {
    const boundary = /\[\[(\/?)Flowlock::NextPrompt\]\]/ig;
    const regions = [];
    let depth = 0;
    let startIndex = 0;
    let bodyStart = 0;
    let match;

    while ((match = boundary.exec(protocolSource)) !== null) {
        if (!match[1]) {
            if (depth++ === 0) {
                startIndex = match.index;
                bodyStart = boundary.lastIndex;
            }
        } else if (depth > 0 && --depth === 0) {
            regions.push({
                startIndex, bodyStart, bodyEnd: match.index,
                endIndex: boundary.lastIndex, closed: true
            });
        }
    }

    if (depth > 0) {
        regions.push({ startIndex, endIndex: protocolSource.length, closed: false });
    }
    return regions;
}

function mapNextPromptRegions(source, regions, transformOutside, transformPrompt) {
    const chunks = [];
    let cursor = 0;
    for (const region of regions) {
        chunks.push(transformOutside(source.slice(cursor, region.startIndex)));
        chunks.push(transformPrompt(source.slice(region.startIndex, region.endIndex)));
        cursor = region.endIndex;
    }
    chunks.push(transformOutside(source.slice(cursor)));
    return chunks.join('');
}

function getLastPromptMatch(source, regions) {
    let prompt = null;
    for (const region of regions) {
        if (!region.closed) continue;
        const candidate = source.slice(region.bodyStart, region.bodyEnd).trim();
        if (candidate) prompt = candidate;
    }
    return prompt;
}

function stripDirectivesFromUnprotectedChunk(chunk) {
    return chunk
        .replace(/\[\[Flowlock::(?:Complete|Fail|Stop|Start)\]\]/ig, '')
        .replace(/\[\[Flowlock::NextHeartbeat::\d+\]\]/ig, '')

        .replace(/\[\[TaskComplete(?:\s*\]\]|\s[\s\S]*?\]\])/ig, '')
        .replace(/\[\[TaskFailed(?:\s*\]\]|\s[\s\S]*?\]\])/ig, '')
        .replace(/\[\[NextHeartbeat::\d+\]\]/ig, '');
}

function buildProtocolReport(source, promptRegions) {
    // Strip each outside slice separately: deleting a payload must not join
    // two literal fragments into a new executable/strippable directive.
    return mapNextPromptRegions(
        source,
        promptRegions,
        chunk => mapUnprotectedRegions(
            chunk, stripDirectivesFromUnprotectedChunk, protectedChunk => protectedChunk
        ),
        () => ''
    )
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function stripProtocolDirectives(text) {
    const source = String(text || '');
    const regions = findNextPromptRegions(maskProtectedProtocolRegions(source));
    return buildProtocolReport(source, regions);
}

function parseFlowlockDirectives(text) {
    const source = String(text || '');
    const protectedSource = maskProtectedProtocolRegions(source);
    const promptRegions = findNextPromptRegions(protectedSource);
    const protocolSource = mapNextPromptRegions(
        protectedSource, promptRegions,
        chunk => chunk,
        chunk => chunk.replace(/[^\r\n]/g, ' ')
    );
    const isFlowlockProtocol = promptRegions.length > 0 || FLOWLOCK_PATTERNS.any.test(protocolSource);
    const complete = FLOWLOCK_PATTERNS.complete.test(protocolSource) || FLOWLOCK_PATTERNS.legacyComplete.test(protocolSource);
    const fail = FLOWLOCK_PATTERNS.fail.test(protocolSource) || FLOWLOCK_PATTERNS.legacyFail.test(protocolSource);
    const stop = FLOWLOCK_PATTERNS.stop.test(protocolSource);
    const start = FLOWLOCK_PATTERNS.start.test(protocolSource);

    let action = 'continue';
    if (complete) {
        action = 'complete';
    } else if (fail) {
        action = 'fail';
    } else if (stop) {
        action = 'stop';
    } else if (start) {
        action = 'start';
    }

    const flowlockDelay = getLastPositiveIntegerMatch(protocolSource, FLOWLOCK_PATTERNS.heartbeat);
    const legacyDelay = getLastPositiveIntegerMatch(protocolSource, FLOWLOCK_PATTERNS.legacyHeartbeat);

    return {
        action,
        isFlowlockProtocol,
        start,
        stop,
        complete,
        fail,
        nextHeartbeatSeconds: flowlockDelay ?? legacyDelay ?? DEFAULT_HEARTBEAT_DELAY_SECONDS,
        hasExplicitHeartbeat: flowlockDelay !== null || legacyDelay !== null,
        nextPrompt: getLastPromptMatch(source, promptRegions),
        report: buildProtocolReport(source, promptRegions)
    };
}

module.exports = {
    DEFAULT_HEARTBEAT_DELAY_SECONDS,
    maskProtectedProtocolRegions,
    parseFlowlockDirectives,
    stripProtocolDirectives
};