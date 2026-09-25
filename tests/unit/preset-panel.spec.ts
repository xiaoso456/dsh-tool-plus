/**
 * 面板纯映射层（src/client/preset-panel.ts）单测。
 *
 * 覆盖面是"用户能看到的每一句话 + 每个按钮在什么状态下出现"：
 * - 三个动作的可用性（本部署可写 / 这一行可寻址 / 是我们声明的 / 有没有覆盖）；
 * - 二次确认只在会动到已有内容的两个动作上出现；
 * - 结果文案按动作分派（对齐与恢复随包**不能**套用"调整了 N 处"的句式）。
 */
import { describe, expect, it } from 'vitest'
import {
  initialPresetId,
  presetActionHint,
  presetActionNeedsConfirm,
  presetActionText,
  presetActions,
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
  type PresetStatus,
} from '../../src/client/preset-panel.ts'
import type { BashPlusLocaleKey } from '../../src/client/locales.ts'
import type { PresetCompareValue } from '../../src/tools/shared/browser-rpc-channel.ts'

/** 只提供被断言到的键；其余回落成键名，方便一眼看出漏了哪句文案。 */
const TEXT: Partial<Record<BashPlusLocaleKey, string>> = {
  presetActionUpdate: '最小更新',
  presetActionAlign: '对齐模板',
  presetActionRevert: '恢复随包',
  presetActionUpdateHint: '只把这 {count} 个工具行（{rows}）关掉。',
  presetActionUpdateNothing: '当前没有需要关掉的工具行。',
  presetActionAlignHint: '用所选模板「{template}」整份替换这一行的插件列表。',
  presetActionRevertHint: '删掉你写在本 profile 配置里的这份预设的覆盖。',
  presetConfirmAlign: '将用模板「{template}」整份替换。',
  presetConfirmAlignEdits: '你在这一行上的改动会被覆盖。',
  presetConfirmRevert: '将删掉覆盖，回落到随包声明。',
  presetPendingRows: '工具行将调整这 {count} 处：{rows}',
  presetPendingBroken: '插件行列表读不出来。',
  presetResultDone: '已调整 {count} 处。',
  presetResultRows: '涉及：{rows}',
  presetResultNoChange: '没有需要改动的行。',
  presetResultAlignDone: '已按所选模板对齐。',
  presetResultAlignNoChange: '已经与所选模板一致。',
  presetResultRevertDone: '已删掉覆盖。',
  presetResultRevertNoChange: '这一行本来就没有覆盖。',
  presetResultFailed: '操作失败：{reason}',
  presetResultBackup: '改动前的内容已备份。',
  presetFailUnknown: '未知原因',
  presetNoteBroken: '无法挂载：{reason}',
  presetNoteUnrecognized: '插件行列表读不出来。',
  presetNoteNoRow: '没有声明行。',
  presetNoteOther: '由别处声明。',
  presetNoteCustomized: '你有覆盖。',
  presetNoteNoProfile: '只能查看。',
  presetEntryCommand: '命令执行',
  presetEntryFiles: '文件读写',
  presetListSeparator: '、',
  presetToolOk: '已接入',
  presetToolWarn: '还有 {count} 个工具行未处理',
  presetToolError: '读不到',
  presetToolLoading: '正在检查…',
  presetCompareOk: '一致',
  presetCompareWarn: '有 {count} 处不同',
  presetCompareError: '无法比较',
  presetCompareLoading: '正在比较…',
  presetDiffAbsent: '（没有）',
  presetDiffWholeRow: '（整行）',
}

const t = (key: BashPlusLocaleKey): string => TEXT[key] ?? key

const status = (over: Partial<PresetStatus> = {}): PresetStatus => ({
  id: 'tool-plus-standard',
  entryId: 'preset-tool-plus-standard',
  name: '标准增强版',
  source: 'ours',
  isDefault: false,
  conflicts: [],
  clean: true,
  unrecognized: false,
  customized: false,
  templateDiffers: false,
  rowCount: 2,
  ...over,
})

const compare = (over: Partial<PresetCompareValue> = {}): PresetCompareValue => ({
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

describe('presetActions', () => {
  it('offers all three actions on our own untouched preset', () => {
    expect(presetActions(status())).toEqual(['upgrade', 'align'])
  })

  it('adds revert only when there is an override to remove', () => {
    expect(presetActions(status({ customized: true }))).toEqual(['upgrade', 'align', 'revert'])
  })

  it('drops upgrade when the plugin list is not a readable row list', () => {
    expect(presetActions(status({ unrecognized: true }))).toEqual(['align'])
    expect(presetActions(status({ unrecognized: true, customized: true }))).toEqual(['align', 'revert'])
  })

  it('only fixes conflicts on presets another bundle declares', () => {
    expect(presetActions(status({ source: 'other' }))).toEqual(['upgrade'])
    expect(presetActions(status({ source: 'other', unrecognized: true }))).toEqual([])
  })

  it('offers nothing when this deployment cannot write or the row is not addressable', () => {
    expect(presetActions(status(), false)).toEqual([])
    expect(presetActions(status({ entryId: undefined }))).toEqual([])
  })
})

describe('action copy', () => {
  it('names each action and asks for confirmation only for the two that overwrite content', () => {
    expect(presetActionText(t, 'upgrade')).toBe('最小更新')
    expect(presetActionText(t, 'align')).toBe('对齐模板')
    expect(presetActionText(t, 'revert')).toBe('恢复随包')
    expect([presetActionNeedsConfirm('upgrade'), presetActionNeedsConfirm('align'), presetActionNeedsConfirm('revert')])
      .toEqual([false, true, true])
  })

  it('explains the upgrade with the actual rows, or says there is nothing to do', () => {
    expect(presetActionHint(t, 'upgrade', status({ conflicts: ['tool-bash', 'tool-fs'] }), '模板'))
      .toBe('只把这 2 个工具行（命令执行、文件读写）关掉。')
    expect(presetActionHint(t, 'upgrade', status(), '模板')).toBe('当前没有需要关掉的工具行。')
  })

  it('names the template in the align hint and the write location in the confirmations', () => {
    expect(presetActionHint(t, 'align', status(), 'PTC 增强版')).toBe('用所选模板「PTC 增强版」整份替换这一行的插件列表。')
    expect(presetActionHint(t, 'revert', status(), 'PTC 增强版')).toBe('删掉你写在本 profile 配置里的这份预设的覆盖。')
    expect(presetConfirmText(t, status(), 'align', 'PTC 增强版')).toBe('将用模板「PTC 增强版」整份替换。')
    // 有覆盖时补一句"你的改动会被覆盖"。
    expect(presetConfirmText(t, status({ customized: true }), 'align', 'PTC')).toContain('你在这一行上的改动会被覆盖。')
    expect(presetConfirmText(t, status({ customized: true }), 'revert', 'PTC')).toBe('将删掉覆盖，回落到随包声明。')
  })
})

describe('presetPendingText', () => {
  it('says nothing when there is nothing to do', () => {
    expect(presetPendingText(t, status())).toBeNull()
    expect(presetPendingText(t, status({ entryId: undefined }))).toBeNull()
  })

  it('lists the conflicting rows, or points at the repair when the list is unreadable', () => {
    expect(presetPendingText(t, status({ conflicts: ['tool-bash'] }))).toBe('工具行将调整这 1 处：命令执行')
    expect(presetPendingText(t, status({ unrecognized: true }))).toBe('插件行列表读不出来。')
  })
})

describe('presetNotes', () => {
  it('explains the deployment, the registry diagnostic and the override state', () => {
    expect(presetNotes(t, status(), false)).toEqual(['只能查看。'])
    expect(presetNotes(t, status({ broken: 'row "x" cannot be resolved' }))).toEqual(['无法挂载：row "x" cannot be resolved'])
    expect(presetNotes(t, status({ unrecognized: true }))).toEqual(['插件行列表读不出来。'])
    expect(presetNotes(t, status({ entryId: undefined }))).toEqual(['没有声明行。'])
    expect(presetNotes(t, status({ source: 'other', entryId: undefined }))).toEqual(['由别处声明。'])
    expect(presetNotes(t, status({ customized: true }))).toEqual(['你有覆盖。'])
  })
})

describe('presetResultText', () => {
  it('reports a failure with its reason and never leaks the placeholder', () => {
    expect(presetResultText(t, { ok: false, changed: false, changes: [] }, 'upgrade')).toBe('操作失败：未知原因')
    expect(presetResultText(t, { ok: false, changed: false, reason: 'no editable profile', changes: [] }, 'upgrade'))
      .toBe('操作失败：no editable profile')
  })

  it('reports an upgrade by count and rows', () => {
    expect(presetResultText(t, { ok: true, changed: true, changes: [{ id: 'tool-fs', action: 'disabled' }] }, 'upgrade'))
      .toBe('已调整 1 处。\n涉及：文件读写')
    expect(presetResultText(t, { ok: true, changed: false, changes: [] }, 'upgrade')).toBe('没有需要改动的行。')
  })

  it('never phrases align or revert as "adjusted N entries"', () => {
    expect(presetResultText(t, { ok: true, changed: true, changes: [] }, 'align')).toBe('已按所选模板对齐。')
    expect(presetResultText(t, { ok: true, changed: false, changes: [] }, 'align')).toBe('已经与所选模板一致。')
    expect(presetResultText(t, { ok: true, changed: true, changes: [] }, 'revert')).toBe('已删掉覆盖。')
    expect(presetResultText(t, { ok: true, changed: false, changes: [] }, 'revert')).toBe('这一行本来就没有覆盖。')
  })

  it('mentions the backup only when the host actually took one', () => {
    // 只有真写盘时宿主才落备份，所以这一行必须跟着 backupPath 走，
    // 不能在 no-op 的结果里凭空出现。
    expect(presetResultText(t, { ok: true, changed: true, changes: [], backupPath: '/x/cordis.patch.yml.bak-0.1.10' }, 'align'))
      .toBe('已按所选模板对齐。\n改动前的内容已备份。')
    expect(presetResultText(t, { ok: true, changed: true, changes: [{ id: 'tool-fs', action: 'disabled' }], backupPath: '/x/b.bak' }, 'upgrade'))
      .toBe('已调整 1 处。\n涉及：文件读写\n改动前的内容已备份。')
    expect(presetResultText(t, { ok: true, changed: false, changes: [] }, 'upgrade')).toBe('没有需要改动的行。')
  })
})

describe('selection', () => {
  it('prefers our own declaration, then the first item', () => {
    expect(initialPresetId([status({ id: 'standard', source: 'other' }), status()])).toBe('tool-plus-standard')
    expect(initialPresetId([status({ id: 'standard', source: 'other' })])).toBe('standard')
    expect(initialPresetId([])).toBeUndefined()
  })

  it('falls back when the selected preset disappears', () => {
    expect(resolveSelectedPresetId([status()], 'tool-plus-standard')).toBe('tool-plus-standard')
    expect(resolveSelectedPresetId([status()], 'gone')).toBe('tool-plus-standard')
  })

  it('follows the same-id template first, then the bundled order', () => {
    const templates = [{ id: 'tool-plus-standard', name: '标准' }, { id: 'tool-plus-ptc', name: 'PTC' }]
    expect(resolveSelectedTemplateId(templates, undefined, 'tool-plus-ptc')).toBe('tool-plus-ptc')
    expect(resolveSelectedTemplateId(templates, undefined, 'standard')).toBe('tool-plus-standard')
    expect(resolveSelectedTemplateId(templates, 'tool-plus-ptc', 'tool-plus-standard')).toBe('tool-plus-ptc')
    expect(resolveSelectedTemplateId([], undefined, undefined)).toBeUndefined()
  })

  it('labels options by display name and falls back to the id', () => {
    expect(presetOptionLabel(status())).toBe('标准增强版')
    expect(presetOptionLabel(status({ name: undefined }))).toBe('tool-plus-standard')
    expect(presetTemplateLabel({ id: 'a', name: 'A' })).toBe('A')
    expect(presetTemplateLabel({ id: 'a' })).toBe('a')
  })
})

describe('indicators and diff rows', () => {
  it('tones the tool dot by conflict count', () => {
    expect(presetToolIndicator(t, null)).toEqual({ tone: 'warn', label: '正在检查…' })
    expect(presetToolIndicator(t, compare({ status: 'unreadable' })).tone).toBe('error')
    expect(presetToolIndicator(t, compare({ conflicts: ['tool-fs'] }))).toEqual({ tone: 'warn', label: '还有 1 个工具行未处理' })
    expect(presetToolIndicator(t, compare())).toEqual({ tone: 'ok', label: '已接入' })
  })

  it('tones the compare dot by difference count', () => {
    expect(presetCompareIndicator(t, null)).toEqual({ tone: 'warn', label: '正在比较…' })
    expect(presetCompareIndicator(t, compare({ status: 'unreadable' })).tone).toBe('error')
    expect(presetCompareIndicator(t, compare({ identical: false, items: [] }))).toEqual({ tone: 'warn', label: '有 0 处不同' })
    expect(presetCompareIndicator(t, compare())).toEqual({ tone: 'ok', label: '一致' })
  })

  it('renders the diff dialog rows, marking absent and whole-row cases', () => {
    const rows = presetDiffRows(t, compare({
      identical: false,
      items: [
        { kind: 'changed', row: 'compaction', path: 'config.thresholdRatio', yours: '0.4', template: '0.8' },
        { kind: 'only-yours', row: 'mine', path: 'name', yours: '"@xiaoso/dsh-mine"' },
        { kind: 'row-only-template', row: 'extra', path: '' },
      ],
    }))
    expect(rows).toEqual([
      { path: 'compaction.config.thresholdRatio', yours: '0.4', template: '0.8' },
      { path: 'mine.name', yours: '"@xiaoso/dsh-mine"', template: '（没有）' },
      { path: 'extra', yours: '（没有）', template: '（整行）' },
    ])
    expect(presetDiffRows(t, compare({ status: 'unreadable' }))).toEqual([])
  })
})
