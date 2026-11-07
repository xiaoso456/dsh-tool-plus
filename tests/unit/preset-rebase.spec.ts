/**
 * 「跟随官方」（rebase）单测：把当前环境官方随附的预设声明，经我们的增量派生成增强版的 plugins。
 *
 * 钉住三件事：
 * 1. 纯派生 rebasePlugins：去掉宿主面三行、pwsh 强制关闭、文档行插在原位置；官方结构变了就拒绝而不是猜；
 * 2. 与随包生成物一致：对仓库里的官方基线派生出的结果，逐值等于 presets/tool-plus-*.patch.yml 的 plugins——
 *    运行时派生与构建期生成器不许漂移；
 * 3. 计划判定 planPresetAction(action: 'rebase')：只对我们的预设、只在有实际改动时才写。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { OFFICIAL_BASE_OF, rebasePlugins, type RebaseResult } from '../../src/presets/rebase.ts'
import { planPresetAction } from '../../src/presets/plan.ts'
import type { PresetRow } from '../../src/presets/rows.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const JS_TAG = { tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ __jsExpr: value }) }

/** 官方随附的一份最小 plugins：含宿主面三行、pwsh、以及一行官方新增的 tool-future。 */
const OFFICIAL: PresetRow[] = [
  { id: 'persona', name: '@deepseek-ai/dsh-persona' },
  { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
  { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh' },
  { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
  { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search' },
  { id: 'tool-future', name: '@deepseek-ai/dsh-tool-future', disabled: false },
]

describe('rebasePlugins（纯派生）', () => {
  it('removes the host-plane rows, forces pwsh off and inserts the doc row at the first removed position', () => {
    const result = rebasePlugins(OFFICIAL)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plugins.map(row => row.id)).toEqual(['persona', 'tool-plus', 'tool-pwsh', 'tool-future'])
    expect(result.plugins.find(row => row.id === 'tool-pwsh')?.disabled).toBe(true)
    expect(result.plugins.find(row => row.id === 'tool-plus')).toEqual({ id: 'tool-plus', name: '@xiaoso/dsh-tool-plus', disabled: true })
    // 官方新增的行原样继承——这就是"跟随官方"的意义。
    expect(result.plugins.find(row => row.id === 'tool-future')).toEqual({ id: 'tool-future', name: '@deepseek-ai/dsh-tool-future', disabled: false })
  })

  it('does not mutate its input', () => {
    const before = JSON.stringify(OFFICIAL)
    rebasePlugins(OFFICIAL)
    expect(JSON.stringify(OFFICIAL)).toBe(before)
  })

  it('refuses when a host-plane row is gone from the official list (shape changed, do not guess)', () => {
    const drifted = OFFICIAL.filter(row => row.id !== 'tool-fs')
    const result = rebasePlugins(drifted)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('tool-fs')
  })

  it('refuses when the official value is not a row list', () => {
    expect(rebasePlugins(undefined).ok).toBe(false)
    expect(rebasePlugins('nope').ok).toBe(false)
  })

  it('maps each shipped preset to its official baseline id', () => {
    expect(OFFICIAL_BASE_OF).toEqual({ 'tool-plus-standard': 'standard', 'tool-plus-ptc': 'ptc' })
  })
})

describe('rebasePlugins 与随包生成物一致（运行时派生不许与构建期漂移）', () => {
  const cases: Array<[string, string]> = [['tool-plus-standard', 'standard'], ['tool-plus-ptc', 'ptc']]
  for (const [id, baseline] of cases) {
    it(id + ': deriving from the vendored official baseline equals the shipped file', () => {
      const official = pluginsOf(join(ROOT, 'presets', 'baseline', baseline + '.patch.yml'))
      const shipped = pluginsOf(join(ROOT, 'presets', id + '.patch.yml'))
      const result: RebaseResult = rebasePlugins(official)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.plugins).toEqual(shipped)
    })
  }
})

describe('planPresetAction(rebase)', () => {
  const official = rebasePlugins(OFFICIAL)
  const derived: PresetRow[] = official.ok ? official.plugins : []
  const stale: PresetRow[] = [{ id: 'persona', name: '@deepseek-ai/dsh-persona' }, { id: 'tool-plus', name: '@xiaoso/dsh-tool-plus', disabled: true }]

  it('writes the derived list when the effective list differs', () => {
    const plan = planPresetAction({ action: 'rebase', ours: true, customized: false, effective: { plugins: stale }, inherited: { plugins: stale }, rebased: official })
    expect(plan.kind).toBe('rebase')
    if (plan.kind !== 'rebase') return
    expect(plan.plugins).toEqual(derived)
  })

  it('is a no-op when the effective list already equals the derived list', () => {
    const plan = planPresetAction({ action: 'rebase', ours: true, customized: true, effective: { plugins: derived }, inherited: { plugins: stale }, rebased: official })
    expect(plan.kind).toBe('noop')
  })

  it('is a no-op for a preset this plugin does not declare', () => {
    const plan = planPresetAction({ action: 'rebase', ours: false, customized: false, effective: { plugins: stale }, inherited: undefined, rebased: official })
    expect(plan.kind).toBe('noop')
  })

  it('is a no-op with the reason when the official preset cannot be read', () => {
    const plan = planPresetAction({
      action: 'rebase', ours: true, customized: false, effective: { plugins: stale }, inherited: { plugins: stale },
      rebased: { ok: false, reason: 'official preset standard is not declared in this environment' },
    })
    expect(plan).toEqual({ kind: 'noop', reason: 'official preset standard is not declared in this environment' })
  })
})

/** 读一个 patch 文件里的 config.plugins（与生成器测试同一套 !!js 方言，值只用于比较）。 */
function pluginsOf(file: string): PresetRow[] {
  const document = parse(readFileSync(file, 'utf8'), { schema: 'core', customTags: [JS_TAG] }) as
    | Array<{ insert?: Array<{ config?: { plugins?: PresetRow[] } }> }>
    | null
  const plugins = document?.[0]?.insert?.[0]?.config?.plugins
  if (!Array.isArray(plugins)) throw new Error(file + ': no config.plugins list')
  return plugins
}
