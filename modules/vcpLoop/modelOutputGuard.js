'use strict';

const Parser = require('./toolCallParser');
const matcher = require('./toolMarkerFuzzyMatcher');

const STATUS = 'VCP_MODEL_PROTOCOL_HALT';
// Detect the namespace, including truncated calls and the observed doubled bars.
const DSML_TAG_START = /^<\/?[|｜]+DSML[|｜]+/i;
const NOTICE = '\n\n[VCP 已暂停：模型输出含保留的回执/角色控制标记、非 VCP 的 DSML 调用标记，或超出单行检查上限。本次模型输出中的全部工具请求均未执行；此前轮次已执行的操作不回滚。请核对日志后再继续，系统不会自动重放。]\n';

// Only inspect NEW model content, never trusted tool results or persisted history.
// A line is held until its boundary so arbitrary SSE chunking cannot expose a
// partial forged receipt. Long lines fail closed with bounded pending storage.
class ModelOutputGuard {
  constructor({ maxLineChars = 1024 * 1024 } = {}) {
    this.maxLineChars = maxLineChars;
    this.pending = [];
    this.pendingChars = 0;
    this.offset = 0;
    this.fence = null;
    this.inlineTicks = 0;
    this.inTool = false;
    this.inEscape = false;
    this.executionParts = [];
    this.halt = null;
  }

  stop(reason, offset) {
    this.halt = { code: STATUS, reason, offset };
    this.pending = [];
    this.pendingChars = 0;
    this.executionParts = [];
  }

  push(chunk) {
    if (this.halt || typeof chunk !== 'string') return '';
    const output = [];
    let cursor = 0;
    const breaks = /[\r\n]/g;
    let match;
    while ((match = breaks.exec(chunk))) {
      const part = chunk.slice(cursor, match.index + 1);
      if (!this.addPending(part)) break;
      const line = this.pending.join('');
      this.pending = [];
      this.pendingChars = 0;
      const visible = this.line(line);
      this.offset += line.length;
      if (this.halt) break;
      output.push(visible);
      cursor = match.index + 1;
    }
    if (!this.halt && cursor < chunk.length) this.addPending(chunk.slice(cursor));
    return output.join('');
  }

  addPending(text) {
    if (this.pendingChars + text.length > this.maxLineChars) {
      this.stop('line_limit', this.offset);
      return false;
    }
    this.pending.push(text);
    this.pendingChars += text.length;
    return true;
  }

  finish() {
    if (this.halt || !this.pendingChars) return '';
    const line = this.pending.join('');
    this.pending = [];
    this.pendingChars = 0;
    const visible = this.line(line);
    this.offset += line.length;
    return visible;
  }

  line(text) {
    // Fences inside tool parameters are data, not Markdown.
    if (!this.inTool && !this.inlineTicks) {
      if (this.fence) {
        const end = /^ {0,3}(`+|~+)[ \t]*(?:\r?\n|\r)?$/.exec(text);
        if (end && end[1][0] === this.fence.char && end[1].length >= this.fence.length) this.fence = null;
        this.executionParts.push('\n');
        return text;
      }
      const open = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(text);
      if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
        this.fence = { char: open[1][0], length: open[1].length };
        this.executionParts.push('\n');
        return text;
      }
      // Blockquotes and indented code are documentation, never executable tools.
      if (/^(?: {0,3}>| {4}|\t)/.test(text)) {
        this.executionParts.push('\n');
        return text;
      }
    }

    let cursor = 0;
    let executable = '';
    while (cursor < text.length) {
      if (this.inTool) {
        const result = Parser.scanBlockEnd(text, cursor, this.inEscape);
        this.inEscape = result.inEscape;
        const end = result.match ? result.match.index + result.match.marker.length : text.length;
        executable += text.slice(cursor, end);
        cursor = end;
        if (!result.match) break;
        this.inTool = false;
        continue;
      }
      if (text[cursor] === '`') {
        let end = cursor + 1;
        while (text[end] === '`') end++;
        const count = end - cursor;
        if (!this.inlineTicks) this.inlineTicks = count;
        else if (this.inlineTicks === count) this.inlineTicks = 0;
        executable += ' '.repeat(count);
        cursor = end;
        continue;
      }
      if (this.inlineTicks) {
        executable += /[\r\n]/.test(text[cursor]) ? text[cursor] : ' ';
        cursor++;
        continue;
      }
      const rest = text.slice(cursor, cursor + 64);
      if (/^<<<\[(?:END_)?ROLE_DIVIDE_(?:USER|SYSTEM|ASSISTANT)\]>>>/.test(rest) ||
          /^<<<\[VCP_TOOL_BATCH_(?:START|END)(?=[:\]\r\n]|$)/.test(rest) ||
          rest.startsWith('[[VCP调用结果信息汇总:') ||
          rest.startsWith('[本轮工具调用摘要:]') ||
          rest.startsWith('<!-- VCP_TOOL_PAYLOAD -->')) {
        this.stop('reserved_protocol', this.offset + cursor);
        return '';
      }
      // Do not rescan the whole remaining line for each normal character.
      if (text[cursor] === '<') {
        if (DSML_TAG_START.test(rest)) {
          this.stop('unsupported_tool_protocol', this.offset + cursor);
          return '';
        }
        const start = matcher.findBlockStartMarker(rest, 0);
        if (start && start.index === 0) {
          executable += start.marker;
          cursor += start.marker.length;
          this.inTool = true;
          this.inEscape = false;
          continue;
        }
      }
      executable += text[cursor++];
    }
    this.executionParts.push(executable);
    return text;
  }

  executionText() {
    return this.halt ? '' : this.executionParts.join('');
  }
}

function inspectModelOutput(text) {
  const guard = new ModelOutputGuard();
  const content = guard.push(text) + guard.finish();
  return { content, executionText: guard.executionText(), halt: guard.halt };
}

module.exports = { ModelOutputGuard, inspectModelOutput, STATUS, NOTICE };