/**
 * preset 改写纯函数（src/presets/rewrite.ts）单测。
 *
 * 覆盖设计文档 §5（改写规则：只认顶层行、追加/翻转 disabled、逐字节保真、
 * 幂等、形状防护）与 §10 的纯函数验收 1–8。
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PRESET_CONFLICT_IDS,
  analyzePresetComposition,
  rewritePresetComposition,
} from '../../src/presets/rewrite.ts'

/** 一份形态接近真实预设的组合：4 个冲突行各不相同（缺 disabled / false / 嵌套 config）。 */
const FIXTURE = `# 组合头注释
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: hi

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
  config:
    maxBytes: 100

- id: tool-plus
  name: '@xiaoso/dsh-tool-plus'
  disabled: true

- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: false

- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'

# 尾注释
- id: planning
  name: cordis:group
`

const EXPECTED = `# 组合头注释
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: hi

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: true

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
  config:
    maxBytes: 100
  disabled: true

- id: tool-plus
  name: '@xiaoso/dsh-tool-plus'
  disabled: true

- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: true

- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
  disabled: true

# 尾注释
- id: planning
  name: cordis:group
`

/** 仓库自带的两个模板（相对本 spec 文件解析，测试里不出现写死路径）。 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const TEMPLATE_IDS = ['tool-plus-standard', 'tool-plus-ptc'] as const

describe('rewritePresetComposition', () => {
  it('把 4 个冲突行块禁用（3 个补 disabled、1 个翻转），其余行逐字节不变', () => {
    const { text, changes } = rewritePresetComposition(FIXTURE)

    expect(text).toBe(EXPECTED)
    expect(changes).toEqual([
      { id: 'tool-bash', action: 'disabled' },
      { id: 'tool-pwsh', action: 'flipped' },
      { id: 'tool-fs', action: 'disabled' },
      { id: 'tool-fs-search', action: 'disabled' },
    ])
  })

  it('已 disabled: true → no-op（changes 为空、文本逐字节相同）', () => {
    const { text, changes } = rewritePresetComposition(EXPECTED)

    expect(changes).toEqual([])
    expect(text).toBe(EXPECTED)
  })

  it('行块不存在 → no-op，且不误伤缩进嵌套的同名 id', () => {
    const nested = `- id: planning
  name: cordis:group
  group: true
  config:
    isolate: true
    entries:
      - id: tool-bash
        name: '@deepseek-ai/dsh-tool-bash'
`
    const { text, changes } = rewritePresetComposition(nested)

    expect(changes).toEqual([])
    expect(text).toBe(nested)
    expect(analyzePresetComposition(nested)).toEqual({ conflicts: [], clean: true, shape: 'ok' })
  })

  it('disabled: false → 改成 true，且保留行尾注释与本地调参', () => {
    const source = `- id: compaction
  name: '@deepseek-ai/dsh-compaction'
  config:
    thresholdRatio: 0.4

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: false   # 用户手写注释
`
    const { text, changes } = rewritePresetComposition(source)

    expect(changes).toEqual([{ id: 'tool-bash', action: 'flipped' }])
    expect(text).toContain('    thresholdRatio: 0.4')
    // 只允许那一行变化：把源文本的 disabled 值换成 true 后应与输出逐字节相同。
    expect(text).toBe(source.replace('  disabled: false   # 用户手写注释', '  disabled: true   # 用户手写注释'))
  })

  it('幂等：同输入跑两次，第二次 changes 为空且文本与第一次逐字节相同', () => {
    const first = rewritePresetComposition(FIXTURE)
    const second = rewritePresetComposition(first.text)

    expect(second.changes).toEqual([])
    expect(second.text).toBe(first.text)
  })

  it('CRLF 文件：追加行用 CRLF，其余字节不变', () => {
    const source = '- id: tool-bash\r\n  name: x\r\n- id: persona\r\n  name: y\r\n'
    const { text, changes } = rewritePresetComposition(source)

    expect(changes).toEqual([{ id: 'tool-bash', action: 'disabled' }])
    expect(text).toBe('- id: tool-bash\r\n  name: x\r\n  disabled: true\r\n- id: persona\r\n  name: y\r\n')
  })

  it('制表符缩进的行块：追加行沿用同一缩进字符', () => {
    const source = '- id: tool-bash\n\tname: x\n'
    const { text } = rewritePresetComposition(source)

    expect(text).toBe('- id: tool-bash\n\tname: x\n\tdisabled: true\n')
  })

  it('行块末尾是空行与注释时，禁用键追加在最后一个键行之后（不越过注释）', () => {
    const source = `- id: tool-bash
  name: x

# 下一行块的说明
- id: persona
  name: y
`
    const { text } = rewritePresetComposition(source)

    expect(text).toBe(`- id: tool-bash
  name: x
  disabled: true

# 下一行块的说明
- id: persona
  name: y
`)
  })

  it('文件末尾无行尾符时也能追加', () => {
    const { text } = rewritePresetComposition('- id: tool-bash\n  name: x')

    expect(text).toBe('- id: tool-bash\n  name: x\n  disabled: true')
  })

  it('破坏输入（映射/仅注释/空）→ shape unrecognized 且不产生改写', () => {
    for (const broken of ['', '\n\n', '# 只有注释\n', 'foo: bar\n', '  - id: tool-bash\n', '{"id":"x"}\n']) {
      const analysis = analyzePresetComposition(broken)
      expect(analysis.shape).toBe('unrecognized')
      expect(analysis.clean).toBe(false)

      const { text, changes } = rewritePresetComposition(broken)
      expect(changes).toEqual([])
      expect(text).toBe(broken)
    }
  })

  it('自定义 conflictIds 只处理给定 id', () => {
    const source = '- id: tool-bash\n  name: x\n\n- id: tool-fs\n  name: y\n'
    const { text, changes } = rewritePresetComposition(source, ['tool-fs'])

    expect(changes).toEqual([{ id: 'tool-fs', action: 'disabled' }])
    expect(text).toBe('- id: tool-bash\n  name: x\n\n- id: tool-fs\n  name: y\n  disabled: true\n')
  })

  it('PRESET_CONFLICT_IDS 与设计文档冻结清单一致', () => {
    expect(PRESET_CONFLICT_IDS).toEqual(['tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search'])
  })
})

describe('analyzePresetComposition', () => {
  it('挂着冲突行时按 conflictIds 顺序列出，clean=false', () => {
    const analysis = analyzePresetComposition(FIXTURE)

    expect(analysis).toEqual({
      conflicts: ['tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search'],
      clean: false,
      shape: 'ok',
    })
  })

  it('全部禁用或不存在 → clean=true', () => {
    expect(analyzePresetComposition(EXPECTED)).toEqual({ conflicts: [], clean: true, shape: 'ok' })
    expect(analyzePresetComposition('- id: persona\n  name: x\n')).toEqual({
      conflicts: [],
      clean: true,
      shape: 'ok',
    })
  })

  it('仓库自带两个模板本身干净（模板里挂上冲突行会让本用例变红）', () => {
    for (const id of TEMPLATE_IDS) {
      const file = path.join(REPO_ROOT, 'presets', id, 'agent.cordis.yml')
      const text = fs.readFileSync(file, 'utf8')
      expect(analyzePresetComposition(text)).toEqual({ conflicts: [], clean: true, shape: 'ok' })
      // 干净模板上改写必须是 no-op（一个字节都不写盘的前提）。
      const { text: rewritten, changes } = rewritePresetComposition(text)
      expect(changes).toEqual([])
      expect(rewritten).toBe(text)
    }
  })
})

/**
 * 官方随附预设的 `disabled` 值是 `!!js` 表达式（`standard` 的 tool-bash 就是
 * `disabled: !!js process.platform === 'win32'`）。表达式既不是 `true` 也不是
 * `false`，我们无从判断它当前是否生效，所以升级必须把**整值**换成 `true`
 * （否则冲突行在某些平台上仍会挂载），并把原表达式留成注释——不能像早期实现那样
 * 只替换第一个 token，那会把值拼成 `true process.platform === 'win32'`（表达式被
 * 破坏、`!!js` 标签丢失、语义变成垃圾字符串）。
 */
const EXPRESSION_DISABLED = [
  '- id: tool-bash',
  "  name: '@deepseek-ai/dsh-tool-bash'",
  "  disabled: !!js process.platform === 'win32'",
  '',
  '- id: tool-pwsh',
  "  name: '@deepseek-ai/dsh-tool-pwsh'",
  "  disabled: !!js process.platform !== 'win32'",
  '',
  '- id: tool-fs',
  "  name: '@deepseek-ai/dsh-tool-fs'",
  '  disabled: false # 保留这条注释',
  '',
  '- id: tool-fs-search',
  "  name: '@deepseek-ai/dsh-tool-fs-search'",
  '',
  '- id: unrelated',
  "  name: '@deepseek-ai/dsh-unrelated'",
  "  disabled: !!js process.platform === 'win32'",
  '',
].join('\n')

describe('表达式值的 disabled（!!js）', () => {
  it('整值换成 true 并把原表达式留成注释', () => {
    const { text, changes } = rewritePresetComposition(EXPRESSION_DISABLED)
    expect(text).toContain("  disabled: true # was: !!js process.platform === 'win32'")
    expect(text).toContain("  disabled: true # was: !!js process.platform !== 'win32'")
    expect(text).toContain('  disabled: true # 保留这条注释')
    expect(text).toContain('  disabled: true\n')
    expect(changes.map((change) => change.id).sort()).toEqual(['tool-bash', 'tool-fs', 'tool-fs-search', 'tool-pwsh'])
    expect(changes.every((change) => change.action === 'flipped' || change.action === 'disabled')).toBe(true)
  })

  it('非冲突行的表达式值一个字节都不动', () => {
    const { text } = rewritePresetComposition(EXPRESSION_DISABLED)
    expect(text).toContain("  disabled: !!js process.platform === 'win32'")
    expect(text.split("disabled: !!js process.platform === 'win32'").length - 1).toBe(1)
  })

  it('改写结果再跑一次是 no-op（幂等：注释里的原值不会再被当成需要翻转的值）', () => {
    const first = rewritePresetComposition(EXPRESSION_DISABLED)
    const second = rewritePresetComposition(first.text)
    expect(second.changes).toEqual([])
    expect(second.text).toBe(first.text)
  })

  it('analyze 之后 clean=true、conflicts 为空', () => {
    const { text } = rewritePresetComposition(EXPRESSION_DISABLED)
    expect(analyzePresetComposition(text)).toEqual({ conflicts: [], clean: true, shape: 'ok' })
  })
})
