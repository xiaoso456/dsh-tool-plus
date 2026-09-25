/**
 * 状态映射（src/presets/status.ts）单测：宿主事实 → 面板状态。
 *
 * 关键语义变化（相对旧目录机制）：
 * - `installed`（目录在不在）没了，取而代之的是 `customized`（profile 层有没有覆盖）
 *   与 `entryId`（这一行在不在本 profile）；
 * - `source` 只剩 `ours` / `other` —— 0.1.7 的 registry 不再提供 `trust`；
 * - `templateDiffers` 只对**我们自己声明**的 preset 有意义（别人的 inherited 是别人
 *   的内容，拿它跟我们的模板比毫无意义）。
 */
import { describe, expect, it } from 'vitest'
import { listPresetStatuses, templatePlugins, toPresetStatus, type PresetFacts } from '../../src/presets/status.ts'
import type { PresetRow } from '../../src/presets/rows.ts'

const row = (id: string, extra: Record<string, unknown> = {}): PresetRow => ({ id, name: `@deepseek-ai/dsh-${id}`, ...extra })

const CLEAN: PresetRow[] = [row('persona'), row('tool-pwsh', { disabled: true })]
const DIRTY: PresetRow[] = [row('persona'), row('tool-fs')]

const facts = (over: Partial<PresetFacts> = {}): PresetFacts => ({
  id: 'tool-plus-standard',
  entryId: 'preset-tool-plus-standard',
  name: 'Tool Plus 标准增强版',
  isDefault: false,
  effective: { id: 'tool-plus-standard', order: 20, plugins: CLEAN },
  inherited: { id: 'tool-plus-standard', order: 20, plugins: CLEAN },
  override: {},
  ours: true,
  ...over,
})

describe('toPresetStatus', () => {
  it('reports a bundled, untouched preset as clean and not customized', () => {
    const status = toPresetStatus(facts(), ['tool-plus-standard'])
    expect(status).toMatchObject({
      id: 'tool-plus-standard',
      entryId: 'preset-tool-plus-standard',
      source: 'ours',
      customized: false,
      templateDiffers: false,
      clean: true,
      conflicts: [],
      unrecognized: false,
      rowCount: 2,
    })
    expect(status.templateDelta).toBeUndefined()
  })

  it('flags a still-mounted tool row and an override separately', () => {
    const status = toPresetStatus(
      facts({ effective: { id: 'tool-plus-standard', plugins: DIRTY }, override: { id: 'tool-plus-standard', plugins: DIRTY } }),
      ['tool-plus-standard'],
    )
    expect(status.conflicts).toEqual(['tool-fs'])
    expect(status.clean).toBe(false)
    expect(status.customized).toBe(true)
    expect(status.templateDiffers).toBe(true)
    expect(status.templateDelta?.total).toBeGreaterThan(0)
  })

  it('never claims a template diff for presets we do not declare', () => {
    const status = toPresetStatus(
      facts({ id: 'standard', entryId: 'preset-standard', ours: false, override: { id: 'standard', plugins: DIRTY } }),
      ['tool-plus-standard'],
    )
    expect(status.source).toBe('other')
    expect(status.customized).toBe(true)
    expect(status.templateDiffers).toBe(false)
    expect(status.templateDelta).toBeUndefined()
  })

  it('marks an unreadable plugin list as unrecognized instead of guessing', () => {
    const status = toPresetStatus(facts({ effective: { id: 'x', plugins: 'nope' }, inherited: undefined }), [])
    expect(status.unrecognized).toBe(true)
    expect(status.clean).toBe(false)
    expect(status.rowCount).toBe(0)
  })

  it('carries the registry diagnostic through untouched', () => {
    const status = toPresetStatus(facts({ broken: 'row "tool-fs" names a plugin that cannot be resolved' }), ['tool-plus-standard'])
    expect(status.broken).toContain('cannot be resolved')
  })
})

describe('listPresetStatuses', () => {
  it('offers only our own declarations as align targets and passes writability through', () => {
    const list = listPresetStatuses(
      [
        facts(),
        facts({ id: 'standard', entryId: 'preset-standard', name: 'standard', ours: false }),
        facts({ id: 'tool-plus-ptc', entryId: 'preset-tool-plus-ptc', name: 'Tool Plus PTC 增强版', order: 21 } as Partial<PresetFacts>),
      ],
      false,
    )
    expect(list.templates).toEqual([
      { id: 'tool-plus-standard', name: 'Tool Plus 标准增强版' },
      { id: 'tool-plus-ptc', name: 'Tool Plus PTC 增强版' },
    ])
    expect(list.presets.map(preset => preset.id)).toEqual(['tool-plus-standard', 'standard', 'tool-plus-ptc'])
    expect(list.writable).toBe(false)
  })

  it('resolves a template only for our own ids', () => {
    const all = [facts(), facts({ id: 'standard', entryId: 'preset-standard', ours: false })]
    expect(templatePlugins(all, 'tool-plus-standard')).toEqual(CLEAN)
    expect(templatePlugins(all, 'standard')).toBeUndefined()
  })
})
