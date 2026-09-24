'use strict';

const { StringDecoder } = require('node:string_decoder');

const JSON_WHITESPACE = new Set([' ', '\t', '\r', '\n']);
const VALID_STATUSES = new Set(['success', 'error']);
const LOG_PREFIXES = ['INFO', 'DEBUG', 'WARN', 'WARNING', 'ERROR', 'TRACE'];
const MAX_LOG_PREFIX_TRACK_CHARS = 64;

function isProtocolResponse(value) {
    return Boolean(
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        VALID_STATUSES.has(value.status)
    );
}

function isKnownLogPrefix(prefix) {
    const normalized = prefix.trim().toUpperCase();
    return LOG_PREFIXES.some(logPrefix => (
        normalized === logPrefix ||
        normalized.startsWith(`${logPrefix}:`) ||
        normalized.startsWith(`${logPrefix} `) ||
        normalized.startsWith(`[${logPrefix}]`)
    ));
}

/**
 * Finds a complete protocol object in a noisy stream without promoting an
 * object nested in a non-protocol root value.
 *
 * The parser consumes each supplied character once. A root array is skipped
 * as one container, and a malformed root object is discarded through its
 * matching boundary before scanning resumes. A malformed object that is
 * explicitly prefixed by a known log level may be abandoned at a newline,
 * but only while it has not opened another JSON container or emitted JSON
 * structure such as ':' or a quote. This preserves the existing
 * `INFO {not-json\n` log-prefix recovery without treating an arbitrary
 * unterminated object as safe to resynchronize.
 *
 * The caller may pass strings (the normal child_process stdout mode after
 * setEncoding('utf8')) or Buffer chunks. Buffer input is decoded with a
 * StringDecoder so a UTF-8 code point split between chunks is preserved.
 * Candidate pieces are retained as an array and joined once, when a
 * complete top-level object closes.
 */
class IncrementalJsonObjectParser {
    constructor() {
        this._decoder = new StringDecoder('utf8');
        this._usingBufferInput = false;

        this._mode = 'seeking';
        this._containers = [];
        this._candidateParts = [];
        this._rootNeedsKey = false;
        this._inString = false;
        this._escaped = false;
        this._candidateHasLogPrefix = false;
        this._malformedHasStructure = false;
        this._linePrefix = '';
        this._response = null;

        this._scannedChars = 0;
        this._completedCandidates = 0;
        this._discardedCandidates = 0;
        this._jsonParseAttempts = 0;
    }

    push(chunk) {
        if (this._response !== null || chunk === undefined || chunk === null) {
            return this._response;
        }

        let text;
        if (Buffer.isBuffer(chunk)) {
            this._usingBufferInput = true;
            text = this._decoder.write(chunk);
        } else {
            text = String(chunk);
        }

        return this._scan(text);
    }

    end() {
        if (this._response !== null || !this._usingBufferInput) {
            return this._response;
        }
        return this._scan(this._decoder.end());
    }

    getStats() {
        return {
            scannedChars: this._scannedChars,
            completedCandidates: this._completedCandidates,
            discardedCandidates: this._discardedCandidates,
            jsonParseAttempts: this._jsonParseAttempts,
            candidateDepth: this._containers.length
        };
    }

    _startRoot(kind) {
        this._mode = kind === '{' ? 'candidate' : 'skip';
        this._containers = [kind];
        this._candidateParts = [];
        this._rootNeedsKey = kind === '{';
        this._inString = false;
        this._escaped = false;
        this._candidateHasLogPrefix = kind === '{' && isKnownLogPrefix(this._linePrefix);
        this._malformedHasStructure = false;
    }

    _beginDiscardCandidate() {
        if (this._mode === 'candidate') {
            this._discardedCandidates++;
        }
        this._mode = 'discard';
        this._candidateParts = [];
        this._rootNeedsKey = false;
        this._malformedHasStructure = false;
    }

    _resetToSeeking() {
        this._mode = 'seeking';
        this._containers = [];
        this._candidateParts = [];
        this._rootNeedsKey = false;
        this._inString = false;
        this._escaped = false;
        this._candidateHasLogPrefix = false;
        this._malformedHasStructure = false;
        this._linePrefix = '';
    }

    _finishCandidate(text, startIndex, endIndex) {
        if (startIndex >= 0) {
            this._candidateParts.push(text.slice(startIndex, endIndex + 1));
        }

        const candidate = this._candidateParts.join('');
        this._completedCandidates++;
        this._jsonParseAttempts++;

        let parsed;
        try {
            parsed = JSON.parse(candidate);
        } catch (_) {
            parsed = null;
        }

        this._resetToSeeking();

        if (isProtocolResponse(parsed)) {
            this._response = parsed;
        }
        return this._response;
    }

    _trackSeekingPrefix(character) {
        if (character === '\n') {
            this._linePrefix = '';
            return;
        }
        if (character === '\r') {
            return;
        }
        if (this._linePrefix.length < MAX_LOG_PREFIX_TRACK_CHARS) {
            this._linePrefix += character;
        }
    }

    _markMalformedStructure(character) {
        if (character === ':' || character === ',' || character === '"' || character === '[' || character === ']') {
            this._malformedHasStructure = true;
        }
    }

    _closeContainer(text, index, candidatePartStart) {
        const closingCharacter = text[index];
        const expectedOpening = closingCharacter === '}' ? '{' : '[';
        const currentOpening = this._containers[this._containers.length - 1];

        if (currentOpening !== expectedOpening) {
            if (this._mode === 'candidate') {
                this._beginDiscardCandidate();
            }
            this._markMalformedStructure(closingCharacter);
            return { candidatePartStart, response: null };
        }

        this._containers.pop();
        if (this._containers.length > 0) {
            return { candidatePartStart, response: null };
        }

        if (this._mode === 'candidate') {
            const response = this._finishCandidate(text, candidatePartStart, index);
            return { candidatePartStart: -1, response };
        }

        this._resetToSeeking();
        return { candidatePartStart: -1, response: null };
    }

    _scan(text) {
        let candidatePartStart = this._mode === 'candidate' ? 0 : -1;

        for (let index = 0; index < text.length; index++) {
            const character = text[index];
            this._scannedChars++;

            if (this._mode === 'seeking') {
                if (character === '{' || character === '[') {
                    this._startRoot(character);
                    candidatePartStart = character === '{' ? index : -1;
                } else {
                    this._trackSeekingPrefix(character);
                }
                continue;
            }

            if (this._inString) {
                if (this._escaped) {
                    this._escaped = false;
                } else if (character === '\\') {
                    this._escaped = true;
                } else if (character === '"') {
                    this._inString = false;
                }
                continue;
            }

            if (this._mode === 'discard' && character === '\n' && this._containers.length === 1 && !this._malformedHasStructure && this._candidateHasLogPrefix) {
                this._resetToSeeking();
                continue;
            }

            if (this._mode === 'candidate' && this._rootNeedsKey) {
                if (JSON_WHITESPACE.has(character)) {
                    continue;
                }
                if (character === '"') {
                    this._rootNeedsKey = false;
                    this._inString = true;
                    continue;
                }
                if (character === '}') {
                    const result = this._closeContainer(text, index, candidatePartStart);
                    candidatePartStart = result.candidatePartStart;
                    if (result.response !== null) return result.response;
                    continue;
                }

                this._beginDiscardCandidate();
                candidatePartStart = -1;
            }

            if (character === '"') {
                if (this._mode === 'discard') this._malformedHasStructure = true;
                this._inString = true;
                continue;
            }

            if (character === '{' || character === '[') {
                if (this._mode === 'discard') this._malformedHasStructure = true;
                this._containers.push(character);
                continue;
            }

            if (character === '}' || character === ']') {
                const result = this._closeContainer(text, index, candidatePartStart);
                candidatePartStart = result.candidatePartStart;
                if (result.response !== null) return result.response;
                continue;
            }

            if (this._mode === 'discard') {
                this._markMalformedStructure(character);
            }
        }

        if (this._mode === 'candidate' && candidatePartStart >= 0) {
            this._candidateParts.push(text.slice(candidatePartStart));
        }
        return this._response;
    }
}

module.exports = {
    IncrementalJsonObjectParser,
    isProtocolResponse
};
