/**
 * ENV 文件解析工具
 */

/**
 * ENV 条目接口
 */
export interface EnvEntry {
  key: string | null
  value: string
  isCommentOrEmpty: boolean
  isMultilineQuoted: boolean
  originalLineNumStart: number
  originalLineNumEnd: number
  inlineComment?: string
  parseError?: string
  duplicateKey?: boolean
}

export type SerializableEnvValue = string | number | boolean | null | undefined
export type EnvEntryValueType = 'string' | 'boolean' | 'integer'

/**
 * 可写回 ENV 文档的条目。
 * originalValue 用于保留未编辑字段的原始文本表示（例如 003、TRUE 或带空格的数字）。
 */
export interface EnvSerializableEntry {
  key: string | null
  value: SerializableEnvValue
  isCommentOrEmpty: boolean
  type?: EnvEntryValueType
  originalValue?: string
  inlineComment?: string
  parseError?: string
  duplicateKey?: boolean
  originalLineNumStart?: number
}

export type EnvSerializationErrorCode =
  | 'invalid-key'
  | 'unsupported-value'
  | 'unstable-source'

/**
 * ENV 写入错误。消息只说明可操作原因，不包含配置值或凭据。
 */
export class EnvSerializationError extends Error {
  readonly code: EnvSerializationErrorCode

  constructor(code: EnvSerializationErrorCode, message: string) {
    super(message)
    this.name = 'EnvSerializationError'
    this.code = code
  }
}

/**
 * 推断 ENV 值的类型
 * @param key - 配置键名
 * @param value - 配置值
 * @returns 推断的类型
 */
export function inferEnvValueType(key: string | null, value: string): 'string' | 'boolean' | 'integer' {
  if (!key) return 'string'

  const normalizedValue = value.trim()

  if (/^(true|false)$/i.test(normalizedValue)) return 'boolean'

  // Token/password-like values must stay as plain text even if they start with numbers.
  if (isSensitiveConfigKey(key)) return 'string'

  if (/^[+-]?\d+$/.test(normalizedValue)) return 'integer'

  return 'string'
}

/**
 * 将字符串值转换为预期类型
 */
export function castEnvValue(value: string | boolean | number, type: 'string' | 'boolean' | 'integer'): string | boolean | number {
  const strValue = String(value)
  if (type === 'boolean') {
    return isTrueValue(value)
  }
  if (type === 'integer') {
    const parsed = parseInt(strValue, 10)
    return isNaN(parsed) ? 0 : parsed
  }
  return strValue
}

/**
 * 判断是否为敏感配置项（API Key, Password 等）
 */
export function isSensitiveConfigKey(key: string): boolean {
  const normalizedKey = key.trim()
  if (!normalizedKey) return false

  const lowerKey = normalizedKey.toLowerCase()

  // Token 数量参数（例如 MaxToken / MaxTokens）不是密钥，不应被当作敏感信息。
  if (/(?:max|min|total|count|output|input|context|window|limit|quota|budget)[_\-.]?tokens?$/.test(lowerKey)) {
    return false
  }

  return /(?:^|[_\-.])(?:api[_\-.]?key|secret|password|passwd|token|access[_\-.]?key)(?:[_\-.]|$)/i.test(normalizedKey)
    || /(?:^|[_\-.])(?:key|api|token)$/i.test(normalizedKey)
    || /(?:api[_\-.]?key|access[_\-.]?key|secret|password|passwd|key)$/.test(lowerKey)
}

/**
 * dotenv 16.5.0 的赋值行语法。
 * 仅用于前端语义对齐与写回自检，不依赖 Node 版 dotenv。
 */
const DOTENV_LINE_PATTERN = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/m

const DOTENV_QUOTED_VALUE_PATTERN = /^(?:'(?:\\'|[^'])*'|"(?:\\"|[^"])*"|`(?:\\`|[^`])*`)$/

const ENV_KEY_PATTERN = /^[\w.-]+$/

const DOTENV_STRUCTURED_LINE_PATTERN = /^\s*(?:export\s+)?([\w.-]+)(?:[ \t]*=[ \t]*?|:[ \t]+?)([ \t]*'(?:\\'|[^'])*'|[ \t]*"(?:\\"|[^"])*"|[ \t]*\x60(?:\\\x60|[^\x60])*\x60|[^#\r\n]+)?[ \t]*(?:#.*)?$/m

function createStructuredLineRegex(): RegExp {
  return new RegExp(DOTENV_STRUCTURED_LINE_PATTERN.source, 'm')
}


function createDotenvLineRegex(global: boolean): RegExp {
  return new RegExp(DOTENV_LINE_PATTERN.source, global ? 'mg' : 'm')
}

/**
 * 与 dotenv 16.5.0 lib/main.js 的 parse() 保持一致的取值逻辑。
 * 双引号只展开 \n 与 \r；不会把 JSON 式 \\、\"、\t 当作转义。
 */
function decodeDotenvValue(rawValue: string): string {
  let value = rawValue.trim()
  const maybeQuote = value[0]

  value = value.replace(/^(['"`])([\s\S]*)\1$/mg, '$2')

  if (maybeQuote === '"') {
    value = value.replace(/\\n/g, '\n')
    value = value.replace(/\\r/g, '\r')
  }

  return value
}

function parseDotenvText(content: string): Record<string, string> {
  const parsed: Record<string, string> = {}
  const lines = content.toString().replace(/\r\n?/mg, '\n')
  const lineRegex = createDotenvLineRegex(true)

  let match: RegExpExecArray | null
  while ((match = lineRegex.exec(lines)) !== null) {
    parsed[match[1]] = decodeDotenvValue(match[2] || '')
  }

  return parsed
}

function trySerializeCandidate(value: string, candidate: string): string | null {
  const document = `DOTENV_ROUNDTRIP_KEY=${candidate}\nDOTENV_ROUNDTRIP_SENTINEL=unchanged`
  const roundTrip = parseDotenvText(document)
  const keys = Object.keys(roundTrip)

  if (
    keys.length !== 2 ||
    roundTrip.DOTENV_ROUNDTRIP_KEY !== value ||
    roundTrip.DOTENV_ROUNDTRIP_SENTINEL !== 'unchanged'
  ) {
    return null
  }

  // 前端解析器还必须与真实 dotenv 得到相同结果，避免只依赖解析器的回退行为。
  const frontendEntries = parseEnvToList(document)
  if (
    frontendEntries.length !== 2 ||
    frontendEntries[0].key !== 'DOTENV_ROUNDTRIP_KEY' ||
    frontendEntries[0].value !== value ||
    frontendEntries[0].parseError !== undefined ||
    frontendEntries[1].key !== 'DOTENV_ROUNDTRIP_SENTINEL' ||
    frontendEntries[1].value !== 'unchanged' ||
    frontendEntries[1].parseError !== undefined
  ) {
    return null
  }

  return candidate
}

function normalizeInlineComment(inlineComment: string | undefined): string {
  if (!inlineComment) return ''

  if (/[\r\n]/.test(inlineComment)) {
    throw new EnvSerializationError('unstable-source', '行尾注释包含换行符，无法安全写回。')
  }

  const normalized = inlineComment.trim()
  if (!normalized) return ''

  if (!normalized.startsWith('#')) {
    throw new EnvSerializationError('unstable-source', '行尾注释格式无效，无法安全写回。')
  }

  return ` ${normalized}`
}

export function serializeEnvValue(value: SerializableEnvValue): string {
  const normalizedValue = value == null ? '' : String(value)

  // 依次尝试 dotenv 支持的三种引号与裸值，并用同语义解析器做无损回环验证。
  const candidates = [
    normalizedValue,
    `'${normalizedValue}'`,
    `\`${normalizedValue}\``,
    `"${normalizedValue.replace(/\r/g, '\\r')}"`,
  ]

  for (const candidate of candidates) {
    if (trySerializeCandidate(normalizedValue, candidate) !== null) {
      return candidate
    }
  }

  throw new EnvSerializationError(
    'unsupported-value',
    '该值包含 ENV 语法无法无损表示的字符组合（引号、反斜杠转义与控制字符的组合），请调整值后再保存。'
  )
}

function assertEnvKey(key: string): void {
  // dotenv 16.5.0 assigns into a normal object, so this key cannot be persisted.
  if (key === '__proto__') {
    throw new EnvSerializationError(
      'invalid-key',
      '该保留键无法被当前 ENV 后端可靠保存，请更换配置键名。'
    )
  }
  if (!ENV_KEY_PATTERN.test(key)) {
    throw new EnvSerializationError(
      'invalid-key',
      '配置键名不符合 dotenv 语法（只允许字母、数字、下划线、点和连字符），已阻止保存。'
    )
  }

}

export function serializeEnvAssignment(
  key: string,
  value: SerializableEnvValue,
  inlineComment?: string
): string {
  assertEnvKey(key)
  return `${key}=${serializeEnvValue(value)}${normalizeInlineComment(inlineComment)}`
}

function canonicalInteger(rawValue: string): string | null {
  const trimmed = rawValue.trim()
  if (!/^[+-]?\d+$/.test(trimmed)) return null

  const isNegative = trimmed.startsWith('-')
  const digits = trimmed.replace(/^[+-]/, '').replace(/^0+(?=\d)/, '')
  return isNegative && digits !== '0' ? `-${digits}` : digits
}

function isSameIntegerValue(current: SerializableEnvValue, original: string): boolean {
  const currentCanonical = canonicalInteger(String(current ?? ''))
  const originalCanonical = canonicalInteger(original)

  if (originalCanonical === null) {
    // Schema 可能把历史遗留的非整数文本声明为 integer。只要值仍是
    // 类型转换得到的占位结果，就视为未编辑并保留原文。
    return String(current ?? '') === String(castEnvValue(original, 'integer'))
  }

  if (currentCanonical !== null && currentCanonical === originalCanonical) {
    return true
  }

  // 大整数经 JS Number 转换会丢失精度；若当前值正是原文的数值表示，
  // 说明用户没有修改该字段，应原样保留。
  const currentText = String(current ?? '').trim()
  const originalNumber = Number(original.trim())
  if (!Number.isNaN(originalNumber) && currentText === String(originalNumber)) {
    return true
  }

  return false
}

function isTrueValue(value: SerializableEnvValue): boolean {
  if (typeof value === 'boolean') return value
  return /^true$/i.test(String(value ?? '').trim())
}

function resolveEntryValue(entry: EnvSerializableEntry): SerializableEnvValue {
  const current = entry.value
  const original = entry.originalValue

  if (entry.type === 'boolean') {
    if (original !== undefined && isTrueValue(original) === isTrueValue(current)) {
      return original
    }
    return isTrueValue(current) ? 'true' : 'false'
  }

  if (entry.type === 'integer') {
    if (original !== undefined && isSameIntegerValue(current, original)) {
      return original
    }
    return current == null ? '' : String(current)
  }

  return current == null ? '' : String(current)
}

export function serializeEnvEntry(entry: EnvSerializableEntry): string {
  if (entry.parseError || entry.duplicateKey) {
    throw new EnvSerializationError(
      'unstable-source',
      '该行存在无法可靠解析的结构（引号截断或重复键），已阻止保存。'
    )
  }

  if (entry.isCommentOrEmpty || entry.key === null) {
    return String(entry.value ?? '')
  }

  return serializeEnvAssignment(entry.key, resolveEntryValue(entry), entry.inlineComment)
}

/**
 * 在结构化合并前检查源文档是否可安全编辑。
 */
export function assertEnvEntriesStructured(entries: readonly EnvSerializableEntry[]): void {
  const seenKeys = new Set<string>()
  entries.forEach((entry, index) => {
    const location = entry.originalLineNumStart !== undefined
      ? `第 ${entry.originalLineNumStart + 1} 行`
      : `第 ${index + 1} 项`

    try {
      if (entry.parseError || entry.duplicateKey) {
        throw new EnvSerializationError(
          'unstable-source',
          '该行存在无法可靠解析的结构（引号截断或重复键），已阻止保存。'
        )
      }
      if (!entry.isCommentOrEmpty) {
        // Validate current keys before schema filtering or Map merging can discard them.
        assertEnvKey(entry.key ?? '')
        if (seenKeys.has(entry.key!)) {
          throw new EnvSerializationError('unstable-source', '配置键重复，已阻止保存。')
        }
        seenKeys.add(entry.key!)
      }
    } catch (error) {
      if (error instanceof EnvSerializationError) {
        throw new EnvSerializationError(error.code, `${location}配置无法无损保存：${error.message}`)
      }
      throw error
    }
  })
}

export function serializeEnvEntries(entries: readonly EnvSerializableEntry[]): string {
  assertEnvEntriesStructured(entries)
  return entries.map((entry, index) => {
    const location = entry.originalLineNumStart !== undefined
      ? `第 ${entry.originalLineNumStart + 1} 行`
      : `第 ${index + 1} 项`

    try {
      return serializeEnvEntry(entry)
    } catch (error) {
      if (error instanceof EnvSerializationError) {
        throw new EnvSerializationError(error.code, `${location}配置无法无损保存：${error.message}`)
      }
      throw error
    }
  }).join('\n')
}

function extractInlineComment(matchText: string, key: string, rawValue: string): string | undefined {
  const keyIndex = matchText.indexOf(key)
  if (keyIndex < 0) return undefined

  const eqIndex = matchText.indexOf('=', keyIndex + key.length)
  const colonIndex = matchText.indexOf(':', keyIndex + key.length)
  const separatorIndex = eqIndex >= 0 && (colonIndex < 0 || eqIndex < colonIndex)
    ? eqIndex
    : colonIndex

  if (separatorIndex < 0) return undefined

  let valueEnd = separatorIndex + 1
  if (rawValue) {
    const rawValueIndex = matchText.indexOf(rawValue, separatorIndex + 1)
    if (rawValueIndex >= 0) {
      valueEnd = rawValueIndex + rawValue.length
    }
  }

  const suffix = matchText.slice(valueEnd)
  const commentIndex = suffix.indexOf('#')
  if (commentIndex < 0) return undefined

  const comment = suffix.slice(commentIndex).trimEnd()
  return comment || undefined
}

/**
 * 解析 .env 文件内容为对象列表
 */
export function parseEnvToList(content: string): EnvEntry[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const entries: EnvEntry[] = []
  const seenKeys = new Set<string>()
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmedLine = line.trim()
    const currentLineNum = i

    if (trimmedLine.startsWith('#') || trimmedLine === '') {
      entries.push({
        key: null,
        value: line,
        isCommentOrEmpty: true,
        isMultilineQuoted: false,
        originalLineNumStart: currentLineNum,
        originalLineNumEnd: currentLineNum,
      })
      i++
      continue
    }

    const remaining = lines.slice(i).join('\n')
    const match = createStructuredLineRegex().exec(remaining)

    if (!match || match.index !== 0) {
      entries.push({
        key: null,
        value: line,
        isCommentOrEmpty: true,
        isMultilineQuoted: false,
        originalLineNumStart: currentLineNum,
        originalLineNumEnd: currentLineNum,
      })
      i++
      continue
    }

    const key = match[1]
    const rawValue = match[2] || ''
    const trimmedRawValue = rawValue.trim()
    const isQuoted = /^['"`]/.test(trimmedRawValue)
    const isCompleteQuoted = !isQuoted || DOTENV_QUOTED_VALUE_PATTERN.test(trimmedRawValue)
    const matchedText = match[0].replace(/\s+$/, '')
    const matchedNewlineCount = matchedText.match(/\n/g)?.length ?? 0
    const endLineNum = currentLineNum + matchedNewlineCount
    const isMultilineQuoted = isCompleteQuoted && isQuoted && matchedNewlineCount > 0
    const duplicateKey = seenKeys.has(key)
    seenKeys.add(key)

    let parseError: string | undefined
    if (key === '__proto__') {
      parseError = '该保留键无法被当前 ENV 后端可靠保存，已阻止结构化保存。'
    } else if (!isCompleteQuoted) {
      parseError = '该行的引号未闭合或包含无法识别的引号结构，已阻止结构化保存。'
    } else if (duplicateKey) {
      parseError = '该配置键重复出现，无法确定保存后的语义，已阻止保存。'
    }

    entries.push({
      key,
      value: parseError && !duplicateKey ? trimmedRawValue : decodeDotenvValue(rawValue),
      isCommentOrEmpty: false,
      isMultilineQuoted,
      originalLineNumStart: currentLineNum,
      originalLineNumEnd: endLineNum,
      inlineComment: extractInlineComment(match[0], key, rawValue),
      parseError,
      duplicateKey,
    })

    i = endLineNum + 1
  }

  return entries
}