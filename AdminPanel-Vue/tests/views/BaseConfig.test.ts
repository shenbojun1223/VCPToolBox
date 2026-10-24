import { createRequire } from 'node:module'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ref } from 'vue'
import type * as VueModule from 'vue'
import type * as UtilsModule from '@/utils'

const require = createRequire(import.meta.url)
const dotenv = require('dotenv') as {
  parse: (source: string) => Record<string, string>
}

const { mockGetMainConfig, mockSaveMainConfig, mockShowMessage } = vi.hoisted(() => ({
  mockGetMainConfig: vi.fn(),
  mockSaveMainConfig: vi.fn(async () => undefined),
  mockShowMessage: vi.fn<(message: string, type: string) => void>(),
}))

vi.mock('vue', async () => {
  const actual = await vi.importActual<typeof VueModule>('vue')
  return {
    ...actual,
    onMounted: () => {},
    onBeforeUnmount: () => {},
    useSSRContext: () => ({ modules: new Set<string>() }),
  }
})

vi.mock('@/api', () => ({
  adminConfigApi: {
    getMainConfig: (...args: unknown[]) => mockGetMainConfig(...args),
    saveMainConfig: (...args: unknown[]) => mockSaveMainConfig(...args),
  },
}))

vi.mock('@/utils', async () => {
  const actual = await vi.importActual<typeof UtilsModule>('@/utils')
  return {
    ...actual,
    showMessage: (...args: [string, string]) => mockShowMessage(...args),
  }
})

import BaseConfig from '../../src/views/BaseConfig.vue'

interface BaseConfigEntry {
  key: string | null
  value: string
  isCommentOrEmpty: boolean
  isMultilineQuoted: boolean
  originalLineNumStart: number
  originalLineNumEnd: number
  type: 'string' | 'boolean' | 'integer'
  originalValue?: string
  parseError?: string
  duplicateKey?: boolean
}

interface BaseConfigVm {
  configEntries: Ref<BaseConfigEntry[]>
  statusMessage: Ref<string>
  statusType: Ref<'info' | 'success' | 'error'>
  loadConfig: () => Promise<void>
  handleSubmit: () => Promise<void>
}

function mainConfig(content: string) {
  return {
    content,
    exampleContent: content,
    source: 'config.env' as const,
    hasCustomConfig: true,
    configExists: true,
    exampleExists: false,
    configMatchesExample: false,
  }
}

function createVm(): BaseConfigVm {
  const component = BaseConfig as unknown as {
    setup: (
      props: Record<string, unknown>,
      context: { expose: () => void }
    ) => BaseConfigVm
  }

  return component.setup({}, { expose: () => {} })
}

describe('BaseConfig env persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads, edits and saves through the shared lossless serializer', async () => {
    const source = [
      '# heading',
      'FLAG=TRUE',
      'COUNT=03',
      "PADDED=' 3 '",
      'CUSTOM=old',
      'AUDIT_SENTINEL=unchanged',
      '',
    ].join('\n')

    mockGetMainConfig.mockResolvedValue(mainConfig(source))
    mockSaveMainConfig.mockResolvedValue(undefined)

    const vm = createVm()
    await vm.loadConfig()

    const countEntry = vm.configEntries.value.find((entry) => entry.key === 'COUNT')
    const customEntry = vm.configEntries.value.find((entry) => entry.key === 'CUSTOM')
    if (!countEntry || !customEntry) {
      throw new Error('test setup failed: expected entries missing')
    }

    countEntry.value = '5'
    customEntry.value = 'line "one"\nline two'

    await vm.handleSubmit()

    expect(mockSaveMainConfig).toHaveBeenCalledTimes(1)
    const savedText = (mockSaveMainConfig.mock.calls[0] as [string, unknown])[0]

    expect(savedText).toContain('# heading')
    expect(dotenv.parse(savedText)).toEqual({
      FLAG: 'TRUE',
      COUNT: '5',
      PADDED: ' 3 ',
      CUSTOM: 'line "one"\nline two',
      AUDIT_SENTINEL: 'unchanged',
    })
    expect(vm.statusType.value).toBe('success')
    expect(mockShowMessage).toHaveBeenCalledWith('全局配置已保存！', 'success')
  })

  it('preserves unedited lossy numeric text and comments after assignments', async () => {
    const source = [
      '# heading',
      'BIG=9007199254740993',
      'SCIENTIFIC=1e3',
      '# comment after values',
      '',
      'EMPTY=',
      'AUDIT_SENTINEL=unchanged',
      '',
    ].join('\n')

    mockGetMainConfig.mockResolvedValue(mainConfig(source))
    mockSaveMainConfig.mockResolvedValue(undefined)

    const vm = createVm()
    await vm.loadConfig()
    await vm.handleSubmit()

    expect(mockSaveMainConfig).toHaveBeenCalledTimes(1)
    const savedText = (mockSaveMainConfig.mock.calls[0] as [string, unknown])[0]

    expect(savedText).toContain('# heading')
    expect(savedText).toContain('\n# comment after values\n\n')
    expect(dotenv.parse(savedText)).toEqual({
      BIG: '9007199254740993',
      SCIENTIFIC: '1e3',
      EMPTY: '',
      AUDIT_SENTINEL: 'unchanged',
    })
  })

  it('blocks unrepresentable values with visible feedback and zero save calls', async () => {
    const secretMarker = 'SENTINEL_SECRET_VALUE'
    const unrepresentableValue = secretMarker + "'" + String.fromCharCode(96) + '\\n#tail'

    mockGetMainConfig.mockResolvedValue(mainConfig('SAFE=ok\nAUDIT_SENTINEL=unchanged'))

    const vm = createVm()
    await vm.loadConfig()

    const safeEntry = vm.configEntries.value.find((entry) => entry.key === 'SAFE')
    if (!safeEntry) throw new Error('test setup failed: SAFE entry missing')

    safeEntry.value = unrepresentableValue
    await vm.handleSubmit()

    expect(mockSaveMainConfig).not.toHaveBeenCalled()
    expect(vm.statusType.value).toBe('error')
    expect(vm.statusMessage.value).toContain('保存失败')
    expect(vm.configEntries.value.find((entry) => entry.key === 'SAFE')?.value)
      .toBe(unrepresentableValue)

    const errorMessage = String(mockShowMessage.mock.calls.at(-1)?.[0] ?? '')
    expect(errorMessage).toContain('保存失败')
    expect(errorMessage).not.toContain(secretMarker)
  })

  it('blocks malformed source with visible feedback and zero save calls', async () => {
    mockGetMainConfig.mockResolvedValue(
      mainConfig('A="unterminated\nB=ok\nAUDIT_SENTINEL=unchanged')
    )

    const vm = createVm()
    await vm.loadConfig()

    expect(vm.configEntries.value.find((entry) => entry.key === 'A')?.parseError).toBeTruthy()
    expect(vm.configEntries.value.find((entry) => entry.key === 'B')?.value).toBe('ok')

    await vm.handleSubmit()

    expect(mockSaveMainConfig).not.toHaveBeenCalled()
    expect(vm.statusType.value).toBe('error')
    expect(vm.statusMessage.value).toContain('第 1 行')
    expect(mockShowMessage).toHaveBeenCalledWith(
      expect.stringContaining('保存失败'),
      'error'
    )
  })

  it('blocks a backend-discarded key in the source with zero save calls', async () => {
    mockGetMainConfig.mockResolvedValue(
      mainConfig('__proto__=SYNTHETIC_VALUE\nAUDIT_SENTINEL=unchanged')
    )
    const vm = createVm()
    await vm.loadConfig()
    await vm.handleSubmit()
    expect(mockSaveMainConfig).not.toHaveBeenCalled()
    expect(vm.statusType.value).toBe('error')
    expect(mockShowMessage).toHaveBeenCalledWith(expect.stringContaining('保存失败'), 'error')
    expect(vm.statusMessage.value).not.toContain('SYNTHETIC_VALUE')
    expect(vm.configEntries.value.find(entry => entry.key === 'AUDIT_SENTINEL')?.value).toBe('unchanged')
  })

  it('rejects an edited reserved key while preserving the pending edit', async () => {
    mockGetMainConfig.mockResolvedValue(mainConfig('SAFE=original\nAUDIT_SENTINEL=unchanged'))
    const vm = createVm()
    await vm.loadConfig()
    const entry = vm.configEntries.value.find(item => item.key === 'SAFE')
    if (!entry) throw new Error('test setup: missing SAFE')
    entry.key = '__proto__'
    entry.value = 'SYNTHETIC_EDIT'
    await vm.handleSubmit()
    expect(mockSaveMainConfig).not.toHaveBeenCalled()
    expect(vm.statusType.value).toBe('error')
    expect(entry.value).toBe('SYNTHETIC_EDIT')
    expect(mockShowMessage).not.toHaveBeenCalledWith(expect.any(String), 'success')
  })


  it('rejects newly introduced duplicate keys before saving the document', async () => {
    mockGetMainConfig.mockResolvedValue(mainConfig('FIRST=one\nSECOND=two\nAUDIT_SENTINEL=unchanged'))
    const vm = createVm()
    await vm.loadConfig()
    const entry = vm.configEntries.value.find(item => item.key === 'SECOND')
    if (!entry) throw new Error('test setup: missing SECOND')
    entry.key = 'FIRST'
    await vm.handleSubmit()
    expect(mockSaveMainConfig).not.toHaveBeenCalled()
    expect(vm.statusType.value).toBe('error')
    expect(entry.value).toBe('two')
  })

})