/**
 * 预设面板的纯映射测试：预设状态 → 本地化文案、可用动作、差异/待改摘要、
 * 动作结果文案。与 React 无关，只测 `src/client/preset-panel.ts` 的纯函数。
 * 契约来源：docs/superpowers/specs/2026-09-17-preset-upgrade-design.md §7 + task-10。
 * @module tests
 */

import { describe, expect, it } from 'vitest'
import {
  BUNDLED_PRESET_IDS,
  PRESET_ACTION_ENDPOINT,
  PRESET_STATUS_ENDPOINT,
  mergeBundledPresets,
  initialPresetId,
  presetActionHint,
  presetActionText,
  presetActions,
  presetConflictNames,
  presetCompareIndicator,
  presetConfirmText,
  presetDiffRows,
  presetNotes,
  presetOptionLabel,
  presetPendingText,
  presetResultText,
  presetTemplateLabel,
  presetToolIndicator,
  resolveSelectedPresetId,
  resolveSelectedTemplateId,
  type PresetActionResult,
  type PresetCompare,
  type PresetTemplate,
  type PresetStatus,
} from '../../src/client/preset-panel.ts'
import { en, zh, type BashPlusLocaleKey } from '../../src/client/locales.ts'

const tzh = (key: BashPlusLocaleKey): string => zh[key]
const ten = (key: BashPlusLocaleKey): string => en[key]

/** Our bundled preset, installed and identical to the shipped template. */
function ours(over: Partial<PresetStatus> = {}): PresetStatus {
  return {
    id: 'tool-plus-standard',
    name: 'Tool Plus Standard',
    source: 'ours',
    path: '.agent-presets/tool-plus-standard/agent.cordis.yml',
    conflicts: [],
    clean: true,
    unrecognized: false,
    installed: true,
    templatePresent: true,
    templateDiffers: false,
    ...over,
  }
}

/** A user-root preset (self-made or copied from the official root). */
function user(over: Partial<PresetStatus> = {}): PresetStatus {
  return {
    id: 'my-preset',
    name: 'My Preset',
    source: 'user',
    path: '.agent-presets/my-preset/agent.cordis.yml',
    conflicts: [],
    clean: true,
    unrecognized: false,
    installed: true,
    templatePresent: false,
    templateDiffers: false,
    ...over,
  }
}

/** An official shipped preset (read-only listing). */
function shipped(over: Partial<PresetStatus> = {}): PresetStatus {
  return {
    id: 'standard',
    name: 'Standard',
    source: 'shipped',
    path: 'shipped/standard/agent.cordis.yml',
    conflicts: ['tool-bash', 'tool-fs'],
    clean: false,
    unrecognized: false,
    installed: true,
    templatePresent: false,
    templateDiffers: false,
    ...over,
  }
}


describe('preset notes (difference and failure detail)', () => {
  it('says nothing for an installed, up-to-date bundled preset', () => {
    expect(presetNotes(tzh, ours())).toEqual([])
  })

  it('says nothing for a preset that merely differs from the template', () => {
    // 差异不再在正文里铺开（那是「查看差异」弹窗的活）：正文只留读取故障。
    expect(presetNotes(tzh, ours({ templateDiffers: true }))).toEqual([])
  })

  it('surfaces the read failure reason', () => {
    const notes = presetNotes(tzh, ours({ broken: 'permission denied' }))
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('permission denied')
    expect(notes[0]).not.toContain('{reason}')
  })

  it('reports unrecognized content as left untouched', () => {
    const notes = presetNotes(tzh, user({ unrecognized: true }))
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('无法识别')
  })

  it('never names internal entry ids in the difference note', () => {
    for (const status of [ours({ templateDiffers: true }), user({ clean: false, conflicts: ['tool-bash'] })]) {
      for (const note of presetNotes(tzh, status)) expect(note).not.toContain('tool-')
    }
  })
})

describe('preset actions', () => {
  it('offers minimal update + reset for our bundled presets', () => {
    expect(presetActions(ours())).toEqual(['upgrade', 'reset'])
    expect(presetActions(ours({ templateDiffers: true }))).toEqual(['upgrade', 'reset'])
  })

  it('offers only reset when the preset cannot be updated row by row', () => {
    // 最小更新只改冲突行：文件读不了 / 形状不认 / 压根没有文件时宿主会直接拒绝，
    // 所以只给「重置当前预设为模板」（整份覆盖是唯一能修能建的动作）。
    expect(presetActions(ours({ broken: 'boom' }))).toEqual(['reset'])
    expect(presetActions(ours({ unrecognized: true }))).toEqual(['reset'])
    expect(presetActions(ours({ installed: false }))).toEqual(['reset'])
    expect(presetActions(ours({ clean: false, conflicts: [] }))).toEqual(['reset'])
  })

  it('offers both actions for user-root presets too (reset aligns to the picked template)', () => {
    // 用户语义（2026-09-19）：重置 = 把所选预设对齐到所选模板，任何可写预设都能做。
    expect(presetActions(user())).toEqual(['upgrade', 'reset'])
    expect(presetActions(user({ clean: false, conflicts: ['tool-bash'] }))).toEqual(['upgrade', 'reset'])
    expect(presetActions(user({ unrecognized: true }))).toEqual(['reset'])
    expect(presetActions(user({ broken: 'boom' }))).toEqual(['reset'])
  })

  it('offers nothing for read-only shipped presets', () => {
    expect(presetActions(shipped())).toEqual([])
  })

  it('labels both actions by what they do', () => {
    expect(presetActionText(tzh, 'upgrade')).toBe('最小更新')
    expect(presetActionText(tzh, 'reset')).toBe('重置为对比模板')
    expect(presetActionText(ten, 'upgrade')).not.toBe('最小更新')
  })

  it('explains each action on hover, and says so when there is nothing to update', () => {
    const withConflicts = user({ clean: false, conflicts: ['tool-bash', 'tool-fs-search'] })
    const update = presetActionHint(tzh, 'upgrade', withConflicts, '某模板')
    expect(update).toContain('2')
    expect(update).toContain('命令执行')
    expect(update).toContain('文件搜索')
    expect(update).not.toContain('tool-fs-search')
    // 无事可做时也要给提示，明说无需更新（用户要求"一眼看出含义"）。
    expect(presetActionHint(tzh, 'upgrade', user(), '某模板')).toBe('当前没有需要更新的工具行。')
    // 重置提示必须点名用的是哪份模板。
    expect(presetActionHint(tzh, 'reset', user(), 'Tool Plus PTC 增强版')).toContain('Tool Plus PTC 增强版')
    expect(presetActionHint(ten, 'reset', user(), 'X')).not.toBe(presetActionHint(tzh, 'reset', user(), 'X'))
  })
})

describe('conflict entry names', () => {
  it('maps the official tool entries to user-facing names', () => {
    expect(presetConflictNames(tzh, ['tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search']))
      .toEqual(['命令执行', 'PowerShell', '文件读写', '文件搜索'])
  })

  it('keeps the order and falls back to the raw id when unknown', () => {
    expect(presetConflictNames(tzh, ['tool-fs', 'custom-row', 'tool-bash']))
      .toEqual(['文件读写', 'custom-row', '命令执行'])
  })

  it('localizes the entry names', () => {
    expect(presetConflictNames(ten, ['tool-bash', 'tool-fs-search']))
      .toEqual(['Command execution', 'File search'])
  })
})

describe('pending-change summary (shown before a run)', () => {
  it('lists how many entries will change and which, without internal ids', () => {
    const text = presetPendingText(tzh, user({ clean: false, conflicts: ['tool-bash', 'tool-fs-search'] }))
    expect(text).toContain('2')
    expect(text).toContain('命令执行')
    expect(text).toContain('文件搜索')
    expect(text).not.toContain('tool-fs-search')
  })

  it('renders nothing when there is nothing to do', () => {
    // 用户明确要求去掉「工具行都已禁用，无需调整。」这种没有信息量的状态句。
    expect(presetPendingText(tzh, user())).toBeNull()
  })

  it('mentions the write when our bundled preset is not installed yet', () => {
    const text = presetPendingText(tzh, ours({ installed: false }))
    expect(text).toContain('未安装')
    expect(presetPendingText(tzh, ours({ clean: false, conflicts: [] }))).toContain('未安装')
  })

  it('has no summary when no action is offered', () => {
    expect(presetPendingText(tzh, shipped())).toBeNull()
  })

  it('is English-localized', () => {
    const text = presetPendingText(ten, user({ clean: false, conflicts: ['tool-bash'] }))
    expect(text).not.toBe(presetPendingText(tzh, user({ clean: false, conflicts: ['tool-bash'] })))
    expect(text).not.toContain('tool-bash')
  })
})

describe('action result text (shown after a run)', () => {
  const done: PresetActionResult = {
    ok: true,
    changed: true,
    backupPath: '.agent-presets/tool-plus-standard/agent.cordis.yml.bak-0.1.8',
    changes: [{ id: 'tool-bash', action: 'disabled' }, { id: 'tool-fs-search', action: 'flipped' }],
  }

  it('reports what changed, by count and by friendly name', () => {
    const text = presetResultText(tzh, done, 'upgrade')
    expect(text).toContain('已调整 2 处')
    expect(text).toContain('命令执行')
    expect(text).toContain('文件搜索')
    expect(text).toContain('备份')
    expect(text).not.toContain('tool-bash')
  })

  it('omits the backup line when no backup was written', () => {
    expect(presetResultText(tzh, { ...done, backupPath: undefined }, 'upgrade')).not.toContain('备份')
  })

  it('reports a no-op upgrade', () => {
    expect(presetResultText(tzh, { ok: true, changed: false, changes: [] }, 'upgrade'))
      .toBe('没有需要改动的行。')
  })

  it('reports a reset without pretending rows were adjusted', () => {
    // 宿主的 reset 是整份覆盖：changes 恒为空，changed 才是唯一信号。
    const text = presetResultText(tzh, { ok: true, changed: true, changes: [], backupPath: '/tmp/x.bak-1' }, 'reset')
    expect(text).toContain('已重置为所选模板')
    expect(text).toContain('备份')
    expect(text).not.toContain('已调整 0 处')
    expect(text).not.toContain('0')
  })

  it('reports a reset that changed nothing', () => {
    const text = presetResultText(tzh, { ok: true, changed: false, changes: [] }, 'reset')
    expect(text).toContain('没有改动')
    expect(text).not.toContain('0')
  })

  it('reports the failure reason and never leaks the placeholder', () => {
    const text = presetResultText(tzh, { ok: false, changed: false, changes: [], reason: 'permission denied' }, 'upgrade')
    expect(text).toContain('操作失败')
    expect(text).toContain('permission denied')
    expect(text).not.toContain('{reason}')
  })

  it('falls back to a generic reason when the host omits one', () => {
    const text = presetResultText(tzh, { ok: false, changed: false, changes: [] }, 'reset')
    expect(text).not.toContain('{reason}')
    expect(text).not.toContain('undefined')
  })

  it('is English-localized', () => {
    for (const action of ['upgrade', 'reset'] as const) {
      const enText = presetResultText(ten, done, action)
      expect(enText).not.toBe(presetResultText(tzh, done, action))
      if (action === 'upgrade') expect(enText).toContain('2')
    }
  })
})

describe('reset confirmation copy', () => {
  it('warns about overwriting local changes for an installed preset', () => {
    const text = presetConfirmText(tzh, ours({ templateDiffers: true }), '某模板')
    expect(text).toContain('本地改动')
    expect(text).toContain('备份')
  })

  it('does not claim local changes will be lost when nothing is installed', () => {
    for (const status of [ours({ installed: false }), ours({ clean: false, conflicts: [] })]) {
      const text = presetConfirmText(tzh, status, '某模板')
      expect(text).not.toContain('本地改动')
      expect(text).toContain('写入')
    }
  })

  it('is English-localized', () => {
    expect(presetConfirmText(ten, ours({ installed: false }), 'X')).not.toBe(presetConfirmText(tzh, ours({ installed: false }), 'X'))
    expect(presetConfirmText(ten, ours(), 'X')).not.toBe(presetConfirmText(tzh, ours(), 'X'))
  })
})

describe('bundled-preset roster merge', () => {
  it('pins the two bundled preset ids', () => {
    expect([...BUNDLED_PRESET_IDS]).toEqual(['tool-plus-standard', 'tool-plus-ptc'])
  })

  it('leaves a roster that already lists both untouched (order preserved)', () => {
    const roster = [shipped(), ours(), ours({ id: 'tool-plus-ptc', name: 'PTC' }), user()]
    expect(mergeBundledPresets(roster)).toEqual(roster)
  })

  it('prepends a not-installed row when the roster is missing a bundled preset', () => {
    const merged = mergeBundledPresets([shipped(), user()])
    expect(merged.map(preset => preset.id)).toEqual(['tool-plus-standard', 'tool-plus-ptc', 'standard', 'my-preset'])
    const standard = merged[0]!
    expect(standard.source).toBe('ours')
    expect(standard.installed).toBe(false)
    expect(standard.templatePresent).toBe(true)
  })

  it('keeps the missing bundled row usable: 未安装 + only reset', () => {
    const standard = mergeBundledPresets([user()])[0]!
    expect(standard.installed).toBe(false)
    expect(presetActions(standard)).toEqual(['reset'])
    expect(presetPendingText(tzh, standard)).toContain('未安装')
  })

  it('fills only the absent id when the roster has one of the two', () => {
    const merged = mergeBundledPresets([ours({ id: 'tool-plus-ptc' })])
    expect(merged.map(preset => preset.id)).toEqual(['tool-plus-standard', 'tool-plus-ptc'])
  })
})

describe('RPC endpoints', () => {
  it('names a channel-relative endpoint for status and one for actions', () => {
    for (const endpoint of [PRESET_STATUS_ENDPOINT, PRESET_ACTION_ENDPOINT]) {
      expect(endpoint.length).toBeGreaterThan(0)
      expect(endpoint).toMatch(/^[A-Za-z0-9_$.-]+(\/[A-Za-z0-9_$.-]+)*$/)
      expect(endpoint.startsWith('/')).toBe(false)
    }
    expect(PRESET_STATUS_ENDPOINT).not.toBe(PRESET_ACTION_ENDPOINT)
  })
})

/**
 * 面板改成「下拉选一个、只看这一个」之后，选中态是纯数据问题：默认选中随包的那份、
 * 落选/缺席都要有确定的回落，选项文案要能直接给用户看。这些都在纯函数层钉住。
 */
function shippedOption(id: string, name?: string): PresetStatus {
  return {
    id,
    name,
    source: 'shipped',
    path: `.agent-presets/${id}/agent.cordis.yml`,
    conflicts: [],
    clean: true,
    unrecognized: false,
    installed: true,
    templatePresent: false,
    templateDiffers: false,
  }
}

describe('下拉选择（一次只看一个预设）', () => {
  it('默认选中随包的那份（tool-plus-standard）', () => {
    expect(initialPresetId([shippedOption('standard'), ours(), shippedOption('minimal')])).toBe('tool-plus-standard')
  })

  it('默认那份缺席时退回清单第一项', () => {
    expect(initialPresetId([shippedOption('standard'), shippedOption('minimal')])).toBe('standard')
  })

  it('空清单返回 undefined', () => {
    expect(initialPresetId([])).toBeUndefined()
  })

  it('选中项已不在清单里时回落到默认（重拉状态后不会悬空）', () => {
    expect(resolveSelectedPresetId([shippedOption('standard')], 'gone')).toBe('standard')
    expect(resolveSelectedPresetId([ours()], 'tool-plus-standard')).toBe('tool-plus-standard')
    expect(resolveSelectedPresetId([], 'gone')).toBeUndefined()
  })

  it('选项文案优先用 name，缺 name 退 id', () => {
    expect(presetOptionLabel(ours())).toBe('Tool Plus Standard')
    expect(presetOptionLabel({ ...ours(), name: undefined })).toBe('tool-plus-standard')
    expect(presetOptionLabel(shippedOption('minimal'))).toBe('minimal')
  })
})

/**
 * 两个状态点与差异弹窗的行（用户定稿的交互）：①工具行是否已接入本插件（绿/黄/红），
 * ②内容与所选模板的差异（绿/黄/红），差异逐行进弹窗、两侧各自的值都给出。
 */
describe('preset indicators and diff rows', () => {
  const compare = (over: Partial<PresetCompare> = {}): PresetCompare => ({
    presetId: 'tool-plus-standard',
    templateId: 'tool-plus-standard',
    status: 'ok',
    conflicts: [],
    identical: true,
    yoursCount: 0,
    behindCount: 0,
    items: [],
    ...over,
  })

  it('未拿到比较结果时是"正在检查/比较"的黄点', () => {
    expect(presetToolIndicator(tzh, null)).toEqual({ tone: 'warn', label: '正在检查…' })
    expect(presetCompareIndicator(tzh, null)).toEqual({ tone: 'warn', label: '正在比较…' })
  })

  it('工具行：无冲突绿、有冲突黄、读不到红', () => {
    expect(presetToolIndicator(tzh, compare())).toEqual({ tone: 'ok', label: '已接入本插件工具' })
    expect(presetToolIndicator(tzh, compare({ conflicts: ['tool-bash', 'tool-fs'] })))
      .toEqual({ tone: 'warn', label: '还有 2 个工具行未处理' })
    expect(presetToolIndicator(tzh, compare({ status: 'unreadable' })))
      .toEqual({ tone: 'error', label: '读不到这份预设' })
  })

  it('完整比较：一致绿、有差异黄（报条数）、无法比较红', () => {
    expect(presetCompareIndicator(tzh, compare())).toEqual({ tone: 'ok', label: '与所选模板一致' })
    expect(presetCompareIndicator(tzh, compare({
      identical: false,
      items: [{ kind: 'only-yours', row: 'compaction', path: 'config.thresholdRatio', yours: '0.4' }],
    }))).toEqual({ tone: 'warn', label: '与所选模板有 1 处不同' })
    expect(presetCompareIndicator(tzh, compare({ status: 'unreadable' })))
      .toEqual({ tone: 'error', label: '无法比较' })
  })

  it('差异行给出路径与两侧的值，缺失/整行用占位词', () => {
    const rows = presetDiffRows(tzh, compare({
      identical: false,
      items: [
        { kind: 'changed', row: 'a', path: 'b', yours: '1', template: '2' },
        { kind: 'only-yours', row: 'c', path: 'd', yours: '3' },
        { kind: 'only-template', row: 'e', path: 'f', template: '4' },
        { kind: 'row-only-yours', row: 'mine', path: '' },
        { kind: 'row-only-template', row: 'gone', path: '' },
      ],
    }))
    expect(rows).toEqual([
      { path: 'a.b', yours: '1', template: '2' },
      { path: 'c.d', yours: '3', template: '（没有）' },
      { path: 'e.f', yours: '（没有）', template: '4' },
      { path: 'mine', yours: '（整行）', template: '（没有）' },
      { path: 'gone', yours: '（没有）', template: '（整行）' },
    ])
    expect(presetDiffRows(tzh, compare({ status: 'unreadable' }))).toEqual([])
    expect(presetDiffRows(tzh, null)).toEqual([])
  })

  it('模板选择：同名模板优先，否则退随包第一份；已选项仍在时保留', () => {
    // 目录名排序会把 ptc 排前面，所以"退清单第一项"必须改成"退随包第一份"。
    const templates: PresetTemplate[] = [{ id: 'tool-plus-ptc', name: 'PTC 版' }, { id: 'tool-plus-standard' }]
    expect(resolveSelectedTemplateId(templates, undefined, 'tool-plus-ptc')).toBe('tool-plus-ptc')
    expect(resolveSelectedTemplateId(templates, undefined, 'zz-other')).toBe('tool-plus-standard')
    expect(resolveSelectedTemplateId(templates, 'tool-plus-ptc', 'tool-plus-standard')).toBe('tool-plus-ptc')
    expect(resolveSelectedTemplateId([], 'x', 'y')).toBeUndefined()
    expect(presetTemplateLabel(templates[0])).toBe('PTC 版')
    expect(presetTemplateLabel(templates[1])).toBe('tool-plus-standard')
  })
})