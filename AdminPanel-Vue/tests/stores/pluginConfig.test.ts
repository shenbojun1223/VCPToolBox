import { createRequire } from 'node:module'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type * as UtilsModule from '@/utils'

const require = createRequire(import.meta.url)
const dotenv = require('dotenv') as {
  parse: (source: string) => Record<string, string>
}

const { mockGetPlugins, mockSavePluginConfig, mockShowMessage } = vi.hoisted(() => ({
  mockGetPlugins: vi.fn(async () => [] as unknown[]),
  mockSavePluginConfig: vi.fn(async () => undefined),
  mockShowMessage: vi.fn<(message: string, type: string) => void>(),
}))

vi.mock('@/api', () => ({
  pluginApi: {
    getPlugins: (...args: unknown[]) => mockGetPlugins(...args),
    savePluginConfig: (...args: unknown[]) => mockSavePluginConfig(...args),
    saveInvocationCommandDescription: vi.fn(async () => undefined),
    togglePlugin: vi.fn(async () => ({ success: true })),
  },
}))

vi.mock('@/utils', async () => {
  const actual = await vi.importActual<typeof UtilsModule>('@/utils')
  return {
    ...actual,
    showMessage: (...args: [string, string]) => mockShowMessage(...args),
  }
})

import { usePluginConfigStore } from '@/stores/pluginConfig'
import { serializeEnvAssignment } from '@/utils'

function makePlugin(
  configEnvContent: string,
  configSchema: Record<string, string> = {},
  defaults: Record<string, string> = {}
) {
  return {
    manifest: {
      name: 'calendar',
      configSchema,
      defaults,
      capabilities: {
        invocationCommands: [
          {
            commandIdentifier: 'calendar.refresh',
            description: 'refresh cmd',
          },
        ],
      },
    },
    enabled: true,
    configEnvContent,
  }
}

describe('plugin config store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('loads plugin config and infers entry types', async () => {
    const store = usePluginConfigStore()

    mockGetPlugins.mockResolvedValue([
      makePlugin('ENABLED=true\nRETRIES=3\nCUSTOM_KEY=abc', {
        ENABLED: 'boolean',
        RETRIES: 'integer',
        TITLE: 'string',
      }),
    ])

    await store.loadPluginConfig('calendar')

    expect(store.pluginData?.manifest.name).toBe('calendar')
    expect(store.hasConfigSchema).toBe(true)

    const enabledEntry = store.configEntries.find((entry) => entry.key === 'ENABLED')
    const retriesEntry = store.schemaEntries.find((entry) => entry.key === 'RETRIES')
    const customEntry = store.configEntries.find((entry) => entry.key === 'CUSTOM_KEY')

    expect(enabledEntry?.type).toBe('boolean')
    expect(enabledEntry?.value).toBe(true)
    expect(retriesEntry?.type).toBe('integer')
    expect(retriesEntry?.value).toBe(3)
    expect(customEntry?.type).toBe('string')
    expect(store.commandDescriptions['calendar.refresh']).toBe('refresh cmd')
  })

  it('round-trips all required regression values unchanged through plugin load and save', async () => {
    const store = usePluginConfigStore()
    const values = [
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
    const source = values
      .map((value, index) => serializeEnvAssignment(`REGRESSION_${index}`, value))
      .join('\n')
    const document = `${source}\nAUDIT_SENTINEL=unchanged`

    mockGetPlugins.mockResolvedValue([makePlugin(document)])

    await store.loadPluginConfig('calendar')
    await store.savePluginConfig('calendar')

    expect(mockSavePluginConfig).toHaveBeenCalledTimes(1)
    const savedText = (mockSavePluginConfig.mock.calls[0] as [string, string])[1]
    const parsed = dotenv.parse(savedText)

    values.forEach((value, index) => {
      expect(parsed[`REGRESSION_${index}`]).toBe(value)
    })
    expect(parsed.AUDIT_SENTINEL).toBe('unchanged')
  })

  it('saves edited and unedited schema/custom values through real dotenv semantics', async () => {
    const store = usePluginConfigStore()
    const source = [
      '# comment',
      'ENABLED=TRUE',
      'RETRIES=03',
      'CUSTOM_KEY=old',
      'AUDIT_SENTINEL=unchanged',
      '',
      '',
    ].join('\n')

    mockGetPlugins.mockResolvedValue([
      makePlugin(source, {
        ENABLED: 'boolean',
        RETRIES: 'integer',
        TITLE: 'string',
      }, { TITLE: 'DefaultTitle' }),
    ])
    mockSavePluginConfig.mockResolvedValue(undefined)

    await store.loadPluginConfig('calendar')

    const retriesEntry = store.schemaEntries.find((entry) => entry.key === 'RETRIES')
    const customEntry = store.configEntries.find((entry) => entry.key === 'CUSTOM_KEY')

    if (!retriesEntry || !customEntry) {
      throw new Error('test setup failed: expected entries not found')
    }

    retriesEntry.value = 5
    customEntry.value = 'overridden "quoted"\nnext'

    await store.savePluginConfig('calendar')

    expect(mockSavePluginConfig).toHaveBeenCalledTimes(1)
    const saveCall = mockSavePluginConfig.mock.calls[0] as [
      string,
      string,
      { loadingKey: string }
    ]
    expect(saveCall[0]).toBe('calendar')
    expect(saveCall[2]).toEqual({ loadingKey: 'plugin-config.save' })
    expect(saveCall[1]).toContain('# comment')

    expect(dotenv.parse(saveCall[1])).toEqual({
      ENABLED: 'TRUE',
      RETRIES: '5',
      CUSTOM_KEY: 'overridden "quoted"\nnext',
      AUDIT_SENTINEL: 'unchanged',
      TITLE: 'DefaultTitle',
    })
    expect(mockShowMessage).toHaveBeenCalledWith('插件配置已保存！', 'success')
  })

  it('preserves unedited boolean/integer text exactly and never damages untouched fields', async () => {
    const store = usePluginConfigStore()
    const source = "FLAG=TRUE\nCOUNT=03\nPADDED=' 3 '\nAUDIT_SENTINEL=unchanged"

    mockGetPlugins.mockResolvedValue([makePlugin(source)])

    await store.loadPluginConfig('calendar')
    await store.savePluginConfig('calendar')

    expect(mockSavePluginConfig).toHaveBeenCalledTimes(1)
    const savedText = (mockSavePluginConfig.mock.calls[0] as [string, string])[1]

    expect(savedText).toContain('FLAG=TRUE')
    expect(savedText).toContain('COUNT=03')
    expect(savedText).toContain("PADDED=' 3 '")
    expect(dotenv.parse(savedText)).toEqual({
      FLAG: 'TRUE',
      COUNT: '03',
      PADDED: ' 3 ',
      AUDIT_SENTINEL: 'unchanged',
    })
  })

  it('never damages unedited numeric-looking custom or schema fields', async () => {
    const store = usePluginConfigStore()
    const source = [
      'BIG=9007199254740993',
      'SCIENTIFIC=1e3',
      'HEX=0x10',
      'ODD=abc',
      'EMPTY=',
      'AUDIT_SENTINEL=unchanged',
    ].join('\n')

    mockGetPlugins.mockResolvedValue([
      makePlugin(source, {
        BIG: 'integer',
        SCIENTIFIC: 'integer',
        ODD: 'integer',
        EMPTY: 'integer',
      }),
    ])

    await store.loadPluginConfig('calendar')
    await store.savePluginConfig('calendar')

    expect(mockSavePluginConfig).toHaveBeenCalledTimes(1)
    const savedText = (mockSavePluginConfig.mock.calls[0] as [string, string])[1]

    expect(savedText).toContain('BIG=9007199254740993')
    expect(savedText).toContain('SCIENTIFIC=1e3')
    expect(savedText).toContain('HEX=0x10')
    expect(savedText).toContain('ODD=abc')
    expect(savedText).toContain('EMPTY=')
    expect(dotenv.parse(savedText)).toEqual({
      BIG: '9007199254740993',
      SCIENTIFIC: '1e3',
      HEX: '0x10',
      ODD: 'abc',
      EMPTY: '',
      AUDIT_SENTINEL: 'unchanged',
    })
  })

  it('blocks unrepresentable edits before any API call and retains the edit', async () => {
    const store = usePluginConfigStore()
    const secretMarker = 'SENTINEL_SECRET_VALUE'
    const unrepresentableValue = secretMarker + "'" + String.fromCharCode(96) + '\\n#tail'

    mockGetPlugins.mockResolvedValue([makePlugin('SAFE=ok')])

    await store.loadPluginConfig('calendar')
    const safeEntry = store.configEntries.find((entry) => entry.key === 'SAFE')
    if (!safeEntry) throw new Error('test setup failed: SAFE entry missing')

    safeEntry.value = unrepresentableValue
    await store.savePluginConfig('calendar')

    expect(mockSavePluginConfig).not.toHaveBeenCalled()
    expect(store.statusType).toBe('error')
    expect(store.statusMessage).toContain('保存失败')
    expect(store.configEntries.find((entry) => entry.key === 'SAFE')?.value).toBe(unrepresentableValue)

    const errorMessage = String(mockShowMessage.mock.calls.at(-1)?.[0] ?? '')
    expect(errorMessage).toContain('保存失败')
    expect(errorMessage).not.toContain(secretMarker)
    expect(errorMessage).not.toContain(unrepresentableValue)
  })

  it('blocks malformed truncated source before any API call', async () => {
    const store = usePluginConfigStore()

    mockGetPlugins.mockResolvedValue([makePlugin('A="unterminated\nB=ok')])

    await store.loadPluginConfig('calendar')
    expect(store.configEntries.find((entry) => entry.key === 'A')?.parseError).toBeTruthy()
    expect(store.configEntries.find((entry) => entry.key === 'B')?.value).toBe('ok')

    await store.savePluginConfig('calendar')

    expect(mockSavePluginConfig).not.toHaveBeenCalled()
    expect(store.statusType).toBe('error')
    expect(store.statusMessage).toContain('第 1 行')
  })

  it('blocks duplicate key documents before any API call', async () => {
    const store = usePluginConfigStore()

    mockGetPlugins.mockResolvedValue([makePlugin('A=1\nA=2\nB=3')])

    await store.loadPluginConfig('calendar')
    expect(store.configEntries.find((entry) => entry.key === 'A' && entry.duplicateKey)?.parseError)
      .toContain('重复')

    await store.savePluginConfig('calendar')

    expect(mockSavePluginConfig).not.toHaveBeenCalled()
    expect(store.statusType).toBe('error')
    expect(store.statusMessage).toContain('第 2 行')
  })

  it('blocks a reserved key in the loaded document before saving', async () => {
    const store = usePluginConfigStore()
    mockGetPlugins.mockResolvedValue([
      makePlugin('__proto__=SYNTHETIC_VALUE\nAUDIT_SENTINEL=unchanged'),
    ])
    await store.loadPluginConfig('calendar')
    await store.savePluginConfig('calendar')
    expect(mockSavePluginConfig).not.toHaveBeenCalled()
    expect(store.statusType).toBe('error')
    expect(mockShowMessage).toHaveBeenCalledWith(expect.stringContaining('保存失败'), 'error')
    expect(String(mockShowMessage.mock.calls.at(-1)?.[0])).not.toContain('SYNTHETIC_VALUE')
    expect(store.configEntries.find(entry => entry.key === 'AUDIT_SENTINEL')?.value).toBe('unchanged')
  })

  it('rejects an edited key that the backend cannot persist without losing the edit', async () => {
    const store = usePluginConfigStore()
    mockGetPlugins.mockResolvedValue([makePlugin('SAFE=original\nAUDIT_SENTINEL=unchanged')])
    await store.loadPluginConfig('calendar')
    const entry = store.configEntries.find(item => item.key === 'SAFE')
    if (!entry) throw new Error('test setup: missing SAFE')
    entry.key = '__proto__'
    entry.value = 'SYNTHETIC_EDIT'
    await store.savePluginConfig('calendar')
    expect(mockSavePluginConfig).not.toHaveBeenCalled()
    expect(store.statusType).toBe('error')
    expect(entry.value).toBe('SYNTHETIC_EDIT')
    expect(mockShowMessage).not.toHaveBeenCalledWith(expect.any(String), 'success')
  })


  it('preserves legitimate inherited-object names as custom fields with no schema', async () => {
    const source = 'constructor=first\ntoString=second\nhasOwnProperty=third\nAUDIT_SENTINEL=unchanged'
    const store = usePluginConfigStore()
    mockGetPlugins.mockResolvedValue([makePlugin(source)])
    await store.loadPluginConfig('calendar')
    await store.savePluginConfig('calendar')
    expect(mockSavePluginConfig).toHaveBeenCalledTimes(1)
    const text = (mockSavePluginConfig.mock.calls[0] as unknown as [string, string, unknown])[1]
    expect(dotenv.parse(text)).toEqual(dotenv.parse(source))
  })

  it('does not overwrite values when an edited custom key collides with another key', async () => {
    const store = usePluginConfigStore()
    mockGetPlugins.mockResolvedValue([makePlugin('FIRST=one\nSECOND=two\nAUDIT_SENTINEL=unchanged')])
    await store.loadPluginConfig('calendar')
    const entry = store.configEntries.find(item => item.key === 'SECOND')
    if (!entry) throw new Error('test setup: missing SECOND')
    entry.key = 'FIRST'
    await store.savePluginConfig('calendar')
    expect(mockSavePluginConfig).not.toHaveBeenCalled()
    expect(store.statusType).toBe('error')
    expect(entry.value).toBe('two')
  })

})