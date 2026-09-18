'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MAX_INPUT_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const PARSER_TIMEOUT_MS = 10000;
const REVIEW_COMMANDS = new Set([
    'invoke-expression', 'invoke-command', 'start-process',
    'powershell', 'pwsh', 'cmd',
    'set-alias', 'new-alias', 'import-alias', 'import-module'
]);
const REVIEW_MEMBERS = new Set([
    'invoke', 'invokereturnasis', 'invokewithcontext',
    'addscript', 'newscriptblock', 'invokescript'
]);
const PROVIDER_WRITERS = new Set([
    'set-item', 'new-item', 'set-content', 'add-content', 'copy-item', 'move-item'
]);

// Match the execution target, NOT paths and prose occurring in arguments.
function commandIdentity(value) {
    return String(value || '').trim().replace(/\\/g, '/')
        .split('/').pop().replace(/\.(?:exe|com|cmd|bat)$/i, '').toLowerCase();
}

function policyKeys(name) {
    const key = commandIdentity(name);
    const keys = new Set(key ? [key] : []);
    // Preserve the destructive-operation family without matching display cmdlets.
    if (key === 'format-volume') keys.add('format');
    if (key === 'restart-computer' || key === 'restart-service') keys.add('restart');
    return [...keys];
}

function diagnostic(decision, rule, fact = {}, index = 0, name = '') {
    const safeName = String(name).replace(/[\r\n\t\x00-\x1f]/g, '?').slice(0, 120);
    return {
        decision, rule, commandName: safeName,
        commandIndex: index, line: fact.line || 0, column: fact.column || 0,
        canAuthorize: decision === 'auth-required' || decision === 'review-required'
    };
}

function summarize(diagnostics) {
    const priority = ['forbidden', 'review-required', 'auth-required'];
    const decision = priority.find(d => diagnostics.some(x => x.decision === d)) || 'allow';
    const primary = diagnostics.find(x => x.decision === decision);
    const canAuthorize = decision === 'auth-required' || decision === 'review-required';
    return {
        decision,
        isForbidden: decision === 'forbidden',
        requiresReview: decision === 'review-required',
        needsAuth: decision === 'auth-required',
        canAuthorize,
        matchedKeyword: primary ? primary.rule : null,
        reason: primary
            ? `${decision}: ${primary.rule}; command=${primary.commandName || '(unresolved)'}; input=${primary.commandIndex + 1}; line=${primary.line}; column=${primary.column}; canAuthorize=${canAuthorize}`
            : null,
        diagnostics
    };
}

function reviewFailure(rule) {
    return summarize([diagnostic('review-required', rule)]);
}

function evaluateFacts(parsed, forbiddenKeywords, authRequiredKeywords) {
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.results) ||
        !Array.isArray(forbiddenKeywords) || !Array.isArray(authRequiredKeywords)) {
        return reviewFailure('PARSER_SCHEMA');
    }
    const forbidden = new Set(forbiddenKeywords.filter(Boolean).map(commandIdentity));
    const auth = new Set(authRequiredKeywords.filter(Boolean).map(commandIdentity));
    const diagnostics = [];
    function applyPolicy(names, fact, index) {
        const keys = [...new Set(names.flatMap(policyKeys))];
        const forbiddenKey = keys.find(key => forbidden.has(key));
        const authKey = keys.find(key => auth.has(key));
        if (forbiddenKey) {
            diagnostics.push(diagnostic('forbidden', forbiddenKey, fact, index, names[0]));
        } else if (authKey) {
            diagnostics.push(diagnostic('auth-required', authKey, fact, index, names[0]));
        }
    }

    for (let index = 0; index < parsed.results.length; index++) {
        const item = parsed.results[index];
        if (!item || !Array.isArray(item.errors) || !Array.isArray(item.facts)) {
            return reviewFailure('PARSER_SCHEMA');
        }
        for (const error of item.errors) {
            diagnostics.push(diagnostic('review-required', 'PARSE_ERROR', error, index));
        }
        for (const fact of item.facts) {
            if (!fact || typeof fact.kind !== 'string' ||
                !Number.isInteger(fact.line) || !Number.isInteger(fact.column)) {
                return reviewFailure('PARSER_SCHEMA');
            }
            if (fact.kind === 'command') {
                if (typeof fact.name !== 'string' || typeof fact.resolved !== 'string' ||
                    typeof fact.inlineBlock !== 'boolean' || typeof fact.dotSource !== 'boolean' ||
                    typeof fact.providerReference !== 'boolean' || typeof fact.automationType !== 'boolean') {
                    return reviewFailure('PARSER_SCHEMA');
                }
                if (fact.inlineBlock) continue; // The nested AST is also traversed.
                if (!fact.name) {
                    diagnostics.push(diagnostic('review-required', 'DYNAMIC_COMMAND', fact, index));
                    continue;
                }
                const literal = commandIdentity(fact.name);
                const resolved = commandIdentity(fact.resolved || fact.name);
                // Literal forbidden aliases win over canonical authorization rules.
                applyPolicy([fact.name, fact.resolved || fact.name], fact, index);
                if (REVIEW_COMMANDS.has(literal) || REVIEW_COMMANDS.has(resolved)) {
                    diagnostics.push(diagnostic('review-required', 'INDIRECT_EXECUTION', fact, index, literal));
                }
                if (fact.dotSource || /\.(?:ps1|psm1)$/i.test(fact.name)) {
                    diagnostics.push(diagnostic('review-required', 'EXTERNAL_PS_SCRIPT', fact, index, literal));
                }
                if (fact.providerReference && PROVIDER_WRITERS.has(resolved)) {
                    diagnostics.push(diagnostic('review-required', 'COMMAND_TABLE_MUTATION', fact, index, literal));
                }
                if (fact.automationType && resolved === 'new-object') {
                    diagnostics.push(diagnostic('review-required', 'DYNAMIC_AUTOMATION', fact, index, literal));
                }
            } else if (fact.kind === 'redirect') {
                if (typeof fact.append !== 'boolean') return reviewFailure('PARSER_SCHEMA');
                applyPolicy([fact.append ? 'add-content' : 'set-content'], fact, index);
            } else if (fact.kind === 'method') {
                if (typeof fact.member !== 'string' || typeof fact.typeName !== 'string') {
                    return reviewFailure('PARSER_SCHEMA');
                }
                const member = fact.member.toLowerCase();
                const type = fact.typeName.toLowerCase().replace(/^system\.management\.automation\./, '');
                if (!member || REVIEW_MEMBERS.has(member) ||
                    (member === 'create' && (type === 'scriptblock' || type === 'powershell'))) {
                    diagnostics.push(diagnostic('review-required', 'DYNAMIC_EVALUATION', fact, index, member));
                }
            } else if (fact.kind === 'using') {
                if (typeof fact.usingKind !== 'string') return reviewFailure('PARSER_SCHEMA');
                if (['module', 'assembly'].includes(fact.usingKind.toLowerCase())) {
                    diagnostics.push(diagnostic('review-required', 'EXTERNAL_IMPORT', fact, index));
                }
            } else {
                return reviewFailure('PARSER_SCHEMA');
            }
        }
    }
    return summarize(diagnostics);
}

function checkCommands(commands, forbidden, auth, options = {}) {
    if (!Array.isArray(commands) || !commands.length ||
        commands.some(c => typeof c !== 'string' || !c.trim())) {
        return reviewFailure('INPUT_SCHEMA');
    }
    const input = JSON.stringify({ commands });
    if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) return reviewFailure('INPUT_LIMIT');
    const env = { ...process.env };
    delete env.DECRYPTED_AUTH_CODE;
    let child;
    try {
        child = spawnSync(options.shell || 'powershell.exe', [
            '-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass',
            '-File', path.join(__dirname, 'inspect-command-ast.ps1')
        ], {
            input, encoding: 'utf8', windowsHide: true,
            timeout: PARSER_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, env
        });
    } catch {
        return reviewFailure('PARSER_START_FAILED');
    }
    if (child.error || child.status !== 0 || child.signal) {
        const rule = child.error && child.error.code === 'ETIMEDOUT'
            ? 'PARSER_TIMEOUT' : 'PARSER_PROCESS_FAILED';
        return reviewFailure(rule);
    }
    try {
        const parsed = JSON.parse(child.stdout.replace(/^\uFEFF/, ''));
        if (!parsed || !Array.isArray(parsed.results) || parsed.results.length !== commands.length) {
            return reviewFailure('PARSER_SCHEMA');
        }
        return evaluateFacts(parsed, forbidden, auth);
    } catch {
        return reviewFailure('PARSER_OUTPUT_INVALID');
    }
}

module.exports = { checkCommands, evaluateFacts, commandIdentity };