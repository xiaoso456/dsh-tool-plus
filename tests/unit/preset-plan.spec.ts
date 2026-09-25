/**
 * 动作判定（src/presets/plan.ts）单测。
 *
 * 它存在的理由：宿主自己的 `configEditor.edit()` **每次调用都会重写 profile
 * 补丁文件**（哪怕内容没变），所以"值不值得写"必须在调用之前判定。这份测试
 * 就是那条前置判定的规格 —— 尤其是"不要无谓地写盘"。
 */
import { describe, expect, it } from 'vitest'
import { planPresetAction, type PresetPlanInput } from '../../src/presets/plan.ts'
import type { PresetRow } from '../../src/presets/rows.ts'

const row = (id: string, extra: Record<string, unknown> = {}): PresetRow => ({ id, name: `@deepseek-ai/dsh-${id}`, ...extra })

/** 一份"已接入"的 plugins（4 个冲突行都不在或已关）。 */
const CLEAN: PresetRow[] = [row('persona'), row('tool-pwsh', { disabled: true })]
/** 一份仍挂着工具行的（要修）。 */
const DIRTY: PresetRow[] = [row('persona'), row('tool-fs'), row('tool-bash')]
/** 一个与本份、与随包声明都不同的模板内容（第三个可区分的目标）。 */
const TEMPLATE: PresetRow[] = [row('persona'), row('tool-web')]

const base: PresetPlanInput = {
  action: 'upgrade',
  ours: true,
  customized: false,
  effective: { id: 'mine', plugins: DIRTY },
  inherited: { id: 'mine', plugins: CLEAN },
}

describe('planPresetAction · upgrade', () => {
  it('plans a write and lists the rows it will disable', () => {
    const plan = planPresetAction(base)
    expect(plan).toEqual({
      kind: 'upgrade',
      changes: [{ id: 'tool-bash', action: 'disabled' }, { id: 'tool-fs', action: 'disabled' }],
    })
  })

  it('is a no-op when nothing is mounted or everything is already off', () => {
    expect(planPresetAction({ ...base, effective: { id: 'mine', plugins: CLEAN } })).toEqual({
      kind: 'noop',
      reason: 'no official tool row needs disabling',
    })
  })

  it('refuses an unreadable plugin list instead of guessing', () => {
    const plan = planPresetAction({ ...base, effective: { id: 'mine', plugins: {} } })
    expect(plan.kind).toBe('noop')
    expect(plan.kind === 'noop' && plan.reason).toContain('not a readable row list')
  })

  it('works on presets we do not declare (that is the only power we claim over them)', () => {
    const plan = planPresetAction({ ...base, ours: false })
    expect(plan.kind).toBe('upgrade')
  })
})

describe('planPresetAction · align', () => {
  const aligned = { ...base, action: 'align' as const, templateId: 'tool-plus-standard', templatePlugins: TEMPLATE }

  it('requires a template id and a readable template', () => {
    expect(planPresetAction({ ...aligned, templateId: undefined })).toEqual({ kind: 'noop', reason: 'align needs a template id' })
    expect(planPresetAction({ ...aligned, templatePlugins: 'nope' })).toEqual({
      kind: 'noop',
      reason: 'template tool-plus-standard has no readable plugin list',
    })
  })

  it('is refused for presets we do not declare', () => {
    const plan = planPresetAction({ ...aligned, ours: false })
    expect(plan).toEqual({ kind: 'noop', reason: 'only presets this plugin declares can be aligned' })
  })

  it('is a no-op when the preset already matches the template', () => {
    const plan = planPresetAction({ ...aligned, effective: { id: 'mine', plugins: structuredClone(TEMPLATE) } })
    expect(plan).toEqual({ kind: 'noop', reason: 'this preset already matches template tool-plus-standard' })
  })

  it('reduces "align to my own bundled declaration" to a revert', () => {
    const plan = planPresetAction({ ...aligned, customized: true, templatePlugins: CLEAN, inherited: { id: 'mine', plugins: CLEAN } })
    expect(plan).toEqual({ kind: 'revert' })
  })

  it('is a no-op when aligning to the bundled declaration and there is no override', () => {
    const plan = planPresetAction({ ...aligned, customized: false, templatePlugins: CLEAN, inherited: { id: 'mine', plugins: CLEAN } })
    expect(plan).toEqual({ kind: 'noop', reason: 'this preset already matches the bundled declaration' })
  })

  it('plans the write otherwise', () => {
    expect(planPresetAction(aligned)).toEqual({ kind: 'align' })
  })
})

describe('planPresetAction · revert', () => {
  it('is a no-op without an override', () => {
    expect(planPresetAction({ ...base, action: 'revert' })).toEqual({
      kind: 'noop',
      reason: 'this preset carries no profile override to remove',
    })
  })

  it('plans the removal when the profile layer carries a config', () => {
    expect(planPresetAction({ ...base, action: 'revert', customized: true })).toEqual({ kind: 'revert' })
  })
})
