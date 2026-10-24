import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import {
  assertEnvEntriesStructured,
  castEnvValue,
  inferEnvValueType,
  isSensitiveConfigKey,
  parseEnvToList,
  serializeEnvAssignment,
  serializeEnvEntries,
  serializeEnvValue,
} from '../../src/utils/env'

const require = createRequire(import.meta.url)
const dotenv = require('dotenv') as {
  parse: (source: string) => Record<string, string>
}
const dotenvPackage = require('dotenv/package.json') as { version: string }

const SENTINEL_LINE = 'AUDIT_SENTINEL=unchanged'

function expectLosslessRoundTrip(key: string, value: string): string {
  const assignment = serializeEnvAssignment(key, value)
  const document = `${assignment}\n${SENTINEL_LINE}`

  const backendParsed = dotenv.parse(document)
  expect(backendParsed).toEqual({
    [key]: value,
    AUDIT_SENTINEL: 'unchanged',
  })

  const frontendEntries = parseEnvToList(document)
  expect(frontendEntries).toHaveLength(2)
  expect(frontendEntries[0]).toMatchObject({
    key,
    value,
    isCommentOrEmpty: false,
  })
  expect(frontendEntries[0].parseError).toBeUndefined()
  expect(frontendEntries[1]).toMatchObject({
    key: 'AUDIT_SENTINEL',
    value: 'unchanged',
    isCommentOrEmpty: false,
  })

  return assignment
}

const REQUIRED_REGRESSION_VALUES = [
  'plain-value',
  'value #1',
  'line "one"\nline two',
  "O'Brien",
  "value 'single' and \"double\" # tail",
  "owner's C:\\new\\test",
  'folder #one\\',
  ' value ',
  'a\rb',
  "owner's\nnext",
  JSON.stringify({ label: "owner's", text: '"quoted"', path: 'C:\\new' }),
  'C:\\new\\test',
  "owner's\ttab",
]

const ADDITIONAL_ROUND_TRIP_VALUES = [
  '',
  '   ',
  '# leading hash',
  '中文 ünïcødé',
  'actual\tTAB',
  'actual\nLF',
  'actual\rCR',
  'actual\r\nCRLF',
  'literal\\nsequence',
  'literal\\rsequence',
  'literal\\tsequence',
  'continuous\\\\backslashes',
  'trailing-backslash\\',
  "all-quotes ' \" and surrounding space ",
  '{"nested":{"owner\'s":\"value\"}}',
]

describe('env utilities', () => {
  it('uses the backend dotenv 16.5.0 parser as the independent oracle', () => {
    expect(dotenvPackage.version).toBe('16.5.0')
  })

  it('round-trips every required regression value through real dotenv and the frontend parser', () => {
    REQUIRED_REGRESSION_VALUES.forEach((value) => {
      expectLosslessRoundTrip('VALUE', value)
    })
  })

  it('round-trips deterministic whitespace, Unicode, control and backslash combinations', () => {
    ADDITIONAL_ROUND_TRIP_VALUES.forEach((value) => {
      expectLosslessRoundTrip('VALUE', value)
    })
  })

  it('keeps adjacent keys and inline comments independent across mixed values', () => {
    const values = [
      'plain',
      'value #1',
      "owner's C:\\new\\test",
      'line "one"\nline two',
      'a\rb',
      '',
    ]
    const assignments = values.map((value, index) => serializeEnvAssignment(`KEY_${index}`, value))
    const document = `${assignments.join('\n')}\n${SENTINEL_LINE}`

    const backendParsed = dotenv.parse(document)
    const frontendEntries = parseEnvToList(document)

    expect(backendParsed.AUDIT_SENTINEL).toBe('unchanged')
    expect(frontendEntries).toHaveLength(values.length + 1)

    values.forEach((value, index) => {
      expect(backendParsed[`KEY_${index}`]).toBe(value)
      expect(frontendEntries[index]).toMatchObject({
        key: `KEY_${index}`,
        value,
        isCommentOrEmpty: false,
      })
    })
    expect(frontendEntries[values.length]).toMatchObject({
      key: 'AUDIT_SENTINEL',
      value: 'unchanged',
    })
  })

  it('parses single quotes with backend semantics instead of JSON decoding', () => {
    const document = "A='O\\'Brien'\nB=\"C:\\\\new\"\nC=`literal\\n`"
    const backendParsed = dotenv.parse(document)
    const entries = parseEnvToList(document)

    expect(entries.map((entry) => entry.value)).toEqual([
      backendParsed.A,
      backendParsed.B,
      backendParsed.C,
    ])
    expect(backendParsed.A).toBe("O\\'Brien")
    expect(backendParsed.B).toBe('C:\\\new')
    expect(backendParsed.C).toBe('literal\\n')
  })

  it('normalizes CR and CRLF like dotenv, while retaining representable actual controls', () => {
    const crDocument = "A='a\rb'"
    expect(dotenv.parse(crDocument)).toEqual(dotenv.parse('A=\'a\nb\''))
    expect(parseEnvToList(crDocument)[0].value).toBe('a\nb')

    expectLosslessRoundTrip('CR_VALUE', 'a\rb')
    expectLosslessRoundTrip('CRLF_VALUE', 'a\r\nb')
    expectLosslessRoundTrip('LF_VALUE', 'a\nb')
    expectLosslessRoundTrip('TAB_VALUE', 'a\tb')
  })

  it('preserves comments, empty lines, line positions and multiline editing metadata', () => {
    const source = '# heading\n\nA=1 # keep me\nB="one\ntwo"\n'
    const entries = parseEnvToList(source)

    expect(entries).toHaveLength(5)
    expect(entries[0]).toMatchObject({
      key: null,
      value: '# heading',
      isCommentOrEmpty: true,
      originalLineNumStart: 0,
      originalLineNumEnd: 0,
    })
    expect(entries[1]).toMatchObject({
      key: null,
      value: '',
      isCommentOrEmpty: true,
      originalLineNumStart: 1,
      originalLineNumEnd: 1,
    })
    expect(entries[2]).toMatchObject({
      key: 'A',
      value: '1',
      inlineComment: '# keep me',
      originalLineNumStart: 2,
      originalLineNumEnd: 2,
    })
    expect(entries[3]).toMatchObject({
      key: 'B',
      value: 'one\ntwo',
      isMultilineQuoted: true,
      originalLineNumStart: 3,
      originalLineNumEnd: 4,
    })
    expect(entries[4]).toMatchObject({
      key: null,
      value: '',
      isCommentOrEmpty: true,
      originalLineNumStart: 5,
      originalLineNumEnd: 5,
    })

    const rewritten = serializeEnvEntries(entries)
    expect(rewritten).toContain('# heading')
    expect(rewritten).toContain(' # keep me')
    expect(dotenv.parse(rewritten)).toEqual({
      A: '1',
      B: 'one\ntwo',
    })
    expect(parseEnvToList(rewritten).map((entry) => entry.value)).toEqual(
      entries.map((entry) => entry.value)
    )
  })

  it('preserves standalone comments and blank lines that follow assignments', () => {
    const source = 'A=1\n# heading for B\n\nB=2 # inline\n# trailing\nC=3'
    const entries = parseEnvToList(source)

    expect(entries.map((entry) => entry.key)).toEqual(['A', null, null, 'B', null, 'C'])
    expect(entries[1]).toMatchObject({
      value: '# heading for B',
      originalLineNumStart: 1,
    })
    expect(entries[2]).toMatchObject({
      value: '',
      originalLineNumStart: 2,
    })
    expect(entries[3]).toMatchObject({
      value: '2',
      inlineComment: '# inline',
      originalLineNumStart: 3,
    })
    expect(entries[4]).toMatchObject({
      value: '# trailing',
      originalLineNumStart: 4,
    })
    expect(serializeEnvEntries(entries)).toBe(source)
  })

  it('keeps unedited integer text when JavaScript number casting loses information', () => {
    const source = 'BIG=9007199254740993\nSCIENTIFIC=1e3\nHEX=0x10\nODD=abc\nEMPTY='
    const entries = parseEnvToList(source).map((entry) => ({
      ...entry,
      type: entry.isCommentOrEmpty ? 'string' as const : 'integer' as const,
      originalValue: entry.isCommentOrEmpty ? undefined : entry.value,
      value: entry.isCommentOrEmpty ? entry.value : castEnvValue(entry.value, 'integer'),
    }))

    const rewritten = serializeEnvEntries(entries)

    expect(dotenv.parse(rewritten)).toEqual({
      BIG: '9007199254740993',
      SCIENTIFIC: '1e3',
      HEX: '0x10',
      ODD: 'abc',
      EMPTY: '',
    })
  })

  it('does not swallow neighboring assignments on truncated quotes and blocks saving', () => {
    const entries = parseEnvToList('A="unterminated\nB=ok\nC=\'also')

    expect(entries).toHaveLength(3)
    expect(entries[0]).toMatchObject({ key: 'A' })
    expect(entries[0].parseError).toBeTruthy()
    expect(entries[1]).toMatchObject({ key: 'B', value: 'ok' })
    expect(entries[1].parseError).toBeUndefined()
    expect(entries[2]).toMatchObject({ key: 'C' })
    expect(entries[2].parseError).toBeTruthy()

    expect(() => assertEnvEntriesStructured(entries)).toThrow(/第 1 行/)
    expect(() => serializeEnvEntries(entries)).toThrow()
  })

  it('marks duplicate keys as ambiguous and blocks structural edits', () => {
    const entries = parseEnvToList('A=1\nA=2\nB=3')

    expect(entries).toHaveLength(3)
    expect(entries[0].duplicateKey).toBe(false)
    expect(entries[1]).toMatchObject({ key: 'A', duplicateKey: true })
    expect(entries[1].parseError).toContain('重复')
    expect(entries[2]).toMatchObject({ key: 'B', value: '3' })

    expect(() => assertEnvEntriesStructured(entries)).toThrow(/第 2 行/)
    expect(() => serializeEnvEntries(entries)).toThrow()
  })

  it('validates keys without narrowing normal dotenv keys', () => {
    expect(serializeEnvAssignment('A.B-C_1', 'x')).toBe('A.B-C_1=x')

    for (const key of ['', 'A\nB', 'A=B', 'A#B', 'A: B', 'WITH SPACE', '中文键']) {
      expect(() => serializeEnvAssignment(key, 'x')).toThrow()
    }
  })

  it('rejects genuinely unrepresentable values with actionable non-secret errors', () => {
    const secretMarker = 'SENTINEL_SECRET_VALUE'
    const value = secretMarker + "'" + String.fromCharCode(96) + '\\n#tail'

    expect(() => serializeEnvValue(value)).toThrow(/无法无损表示/)
    try {
      serializeEnvEntries([
        {
          key: 'SECRET_VALUE',
          value,
          isCommentOrEmpty: false,
          originalLineNumStart: 0,
        },
      ])
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      const message = (error as Error).message
      expect(message).toContain('第 1 行')
      expect(message).not.toContain(secretMarker)
      expect(message).not.toContain(value)
    }
  })

  it('rejects values that combine all three quote styles with comment/whitespace constraints', () => {
    const allQuotes = "all-quotes ' \" " + String.fromCharCode(96) + ' and # plus space '
    expect(() => serializeEnvValue(allQuotes)).toThrow(/无法无损表示/)
    expect(() => serializeEnvAssignment('COMBINED', allQuotes)).toThrow(/无法无损表示/)
  })

  it('keeps unedited typed values byte-for-byte in the rewritten document', () => {
    const source = 'FLAG=TRUE\nCOUNT=03\nPADDED=\' 3 \'\nEMPTY=\n'
    const entries = parseEnvToList(source).map((entry) => ({
      ...entry,
      type: entry.key === 'FLAG'
        ? 'boolean' as const
        : entry.key === 'COUNT' || entry.key === 'PADDED'
          ? 'integer' as const
          : 'string' as const,
      originalValue: entry.value,
      value: entry.key === 'FLAG'
        ? true
        : entry.key === 'COUNT' || entry.key === 'PADDED'
          ? 3
          : entry.value,
    }))

    const rewritten = serializeEnvEntries(entries)
    expect(rewritten).toContain('FLAG=TRUE')
    expect(rewritten).toContain('COUNT=03')
    expect(rewritten).toContain("PADDED=' 3 '")
    expect(dotenv.parse(rewritten)).toEqual({
      FLAG: 'TRUE',
      COUNT: '03',
      PADDED: ' 3 ',
      EMPTY: '',
    })
  })

  it('keeps token-like keys as string and only detects pure integers', () => {
    expect(inferEnvValueType('NEWAPI_MONITOR_ACCESS_TOKEN', '4TQJ6oxRC+vy6WrBlSsK2EFmapfZ')).toBe(
      'string'
    )
    expect(inferEnvValueType('tavilykey', '123456')).toBe('string')
    expect(inferEnvValueType('adminpassword', '123456')).toBe('string')
    expect(inferEnvValueType('WhitelistEmbeddingModelMaxToken', '3072')).toBe('integer')
    expect(inferEnvValueType('MODEL_ALIAS', '4o-mini')).toBe('string')
    expect(inferEnvValueType('RETRY_COUNT', '03')).toBe('integer')
  })

  it('detects concatenated sensitive keys while keeping token limits non-sensitive', () => {
    expect(isSensitiveConfigKey('tavilykey')).toBe(true)
    expect(isSensitiveConfigKey('TavilyKey')).toBe(true)
    expect(isSensitiveConfigKey('adminpassword')).toBe(true)
    expect(isSensitiveConfigKey('openaiApiKey')).toBe(true)

    expect(isSensitiveConfigKey('WhitelistEmbeddingModelMaxToken')).toBe(false)
    expect(isSensitiveConfigKey('MultiModalModelOutputMaxTokens')).toBe(false)
  })
})