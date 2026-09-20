/**
 * 预设面板的纯映射层：把 `presets/status` / `presets/apply` 的返回值翻成本地化
 * 文案、可用动作与差异摘要。零 React、零 DOM、零 I/O —— 由
 * `tests/unit/preset-panel.spec.ts` 单独覆盖，UI（`PresetPanel.tsx`）只做渲染。
 *
 * 契约来源：`docs/superpowers/specs/2026-09-17-preset-upgrade-design.md` §4.2/§7。
 * 类型与端点名直接取自共享契约模块 `src/tools/shared/browser-rpc-channel.ts`
 * （两半同一个来源，客户端这一侧不复制一份会漂移的定义）。
 * @module @xiaoso/dsh-tool-plus/client/preset-panel
 */

import {
  BUNDLED_PRESET_IDS,
  PRESET_ACTION_ENDPOINT,
  PRESET_COMPARE_ENDPOINT,
  PRESET_STATUS_ENDPOINT,
  type PresetCompareValue,
  type PresetTemplateValue,
  type PresetActionValue,
  type PresetActionResultValue,
  type PresetChangeValue,
  type PresetDeltaValue,
  type PresetSourceValue,
  type PresetStatusListValue,
  type PresetStatusValue,
} from '../tools/shared/browser-rpc-channel.ts'
import type { BashPlusLocaleKey } from './locales.ts'

/** Re-exported so the panel's tests and callers keep one import site. */
export { BUNDLED_PRESET_IDS }

/** 端点名（共享契约常量，见模块注释）。 */
export { PRESET_ACTION_ENDPOINT, PRESET_COMPARE_ENDPOINT, PRESET_STATUS_ENDPOINT }

/** 预设来源：我们的随包模板 / 用户根 / 官方随附。 */
export type PresetSource = PresetSourceValue

/** 一个预设的完整状态（`presets/status` 的一项）。 */
export type PresetStatus = PresetStatusValue

/** `presets/status` 的返回值。 */
export type PresetStatusResult = PresetStatusListValue

/** 一个预设动作：`upgrade` = 只改冲突行；`reset` = 整份对齐当前模板。 */
export type PresetAction = PresetActionValue

/** 与自带模板的一处具体差异。 */
export type PresetDelta = PresetDeltaValue

/** 可选模板（面板"对比模板"下拉的一项）。 */
export type PresetTemplate = PresetTemplateValue

/** 一次比较的结果（两个状态点 + 弹窗的全部数据）。 */
export type PresetCompare = PresetCompareValue

/** 改写产生的一处改动。 */
export type PresetActionChange = PresetChangeValue

/** `presets/apply` 的返回值。 */
export type PresetActionResult = PresetActionResultValue

/**
 * 官方工具行 id → 面向使用者的名字。id 是内部标识，不直接出现在界面上；
 * 表外的 id（将来上游换名）退回原样显示，宁可难看也不吞掉信息。
 */
const CONFLICT_NAME_KEYS: Record<string, BashPlusLocaleKey> = {
  'tool-bash': 'presetEntryCommand',
  'tool-pwsh': 'presetEntryPwsh',
  'tool-fs': 'presetEntryFiles',
  'tool-fs-search': 'presetEntrySearch',
}

/**
 * 组合文件读不到但形状没问题：`conflicts` 为空、`clean` 为假，且既没被 roster
 * 标 `broken` 也不是形状无法识别 —— 唯一解释是文件不存在/读不了（例如目录在、
 * `agent.cordis.yml` 缺）。这不是"与模板一致"，要对用户说「未安装」。
 */
function compositionUnreadable(status: PresetStatus): boolean {
  return status.broken === undefined
    && !status.unrecognized
    && !status.clean
    && status.conflicts.length === 0
}

/**
 * roster 缺席我们随包的两份时补出「未安装」行（不改变 roster 原有顺序，
 * 补出的行按 {@link BUNDLED_PRESET_IDS} 顺序排在前面）。
 */
export function mergeBundledPresets(presets: readonly PresetStatus[]): PresetStatus[] {
  const present = new Set(presets.map(preset => preset.id))
  const missing: PresetStatus[] = BUNDLED_PRESET_IDS
    .filter(id => !present.has(id))
    .map(id => ({
      id,
      source: 'ours' as const,
      path: '',
      conflicts: [],
      clean: false,
      unrecognized: false,
      installed: false,
      templatePresent: true,
      templateDiffers: false,
    }))
  return missing.length === 0 ? [...presets] : [...missing, ...presets]
}

/**
 * 下拉里一次只看一个预设时的默认选中项：随包的那份（{@link BUNDLED_PRESET_IDS}
 * 的第一项）在场就选它，否则退清单第一项；空清单返回 undefined。
 */
export function initialPresetId(presets: readonly PresetStatus[]): string | undefined {
  const preferred = BUNDLED_PRESET_IDS.find(id => presets.some(preset => preset.id === id))
  return preferred ?? presets[0]?.id
}

/**
 * 当前选中项在重拉状态后可能已经消失（预设被删、改名、roster 变化）：仍在场就
 * 保留，否则回落到 {@link initialPresetId}，避免下拉指向一个不存在的选项。
 */
export function resolveSelectedPresetId(
  presets: readonly PresetStatus[],
  current: string | undefined,
): string | undefined {
  if (current !== undefined && presets.some(preset => preset.id === current)) return current
  return initialPresetId(presets)
}

/** 下拉选项文案：优先展示 name（preset.yml 的显示名），缺了就退 id。 */
export function presetOptionLabel(preset: PresetStatus): string {
  return preset.name !== undefined && preset.name !== '' ? preset.name : preset.id
}

/**
 * 状态点色调：绿 = 正常（不用管），黄 = 有需要处理的东西，红 = 读不到/无法比较。
 * 宿主有 `--dsw-alias-state-{success,warn,error}-primary` 三档 token，直接用。
 */
export type PresetTone = 'ok' | 'warn' | 'error'

/** 一个状态点：色调 + 一句话。 */
export interface PresetIndicator {
  tone: PresetTone
  label: string
}

/**
 * 状态点 ①（工具行）：这份预设里我们那几个官方工具行是否都已禁用 ——
 * 也就是"本插件的工具在这个预设里是否生效"。
 * @param t - 文案表。
 * @param compare - 当前比较结果；尚未返回时给"正在检查"的黄点。
 * @returns 状态点。
 */
export function presetToolIndicator(
  t: (key: BashPlusLocaleKey) => string,
  compare: PresetCompareValue | null,
): PresetIndicator {
  if (compare === null) return { tone: 'warn', label: t('presetToolLoading') }
  if (compare.status === 'unreadable') return { tone: 'error', label: t('presetToolError') }
  if (compare.conflicts.length > 0) {
    return {
      tone: 'warn',
      label: t('presetToolWarn').replace('{count}', String(compare.conflicts.length)),
    }
  }
  return { tone: 'ok', label: t('presetToolOk') }
}

/**
 * 状态点 ②（完整比较）：这份预设的内容与我们选中的模板差多少 ——
 * 不只是工具开关，整份组合文件都算。
 * @param t - 文案表。
 * @param compare - 当前比较结果；尚未返回时给"正在比较"的黄点。
 * @returns 状态点。
 */
export function presetCompareIndicator(
  t: (key: BashPlusLocaleKey) => string,
  compare: PresetCompareValue | null,
): PresetIndicator {
  if (compare === null) return { tone: 'warn', label: t('presetCompareLoading') }
  if (compare.status === 'unreadable') return { tone: 'error', label: t('presetCompareError') }
  if (compare.identical) return { tone: 'ok', label: t('presetCompareOk') }
  return {
    tone: 'warn',
    label: t('presetCompareWarn').replace('{count}', String(compare.items.length)),
  }
}

/** 差异弹窗的一行：点号路径 + 两侧的值（缺失/整行用本地化占位）。 */
export interface PresetDiffRow {
  path: string
  /** 这份预设的值。 */
  yours: string
  /** 模板的值。 */
  template: string
}

/**
 * 差异弹窗的行：把比较结果翻成"路径 / 两份预设各自的值"三列。
 * 值缺失或整行差异都给出占位词，让用户一眼看出哪边没有。
 * @param t - 文案表。
 * @param compare - 当前比较结果。
 * @returns 表格行；不可比较时为空数组。
 */
export function presetDiffRows(
  t: (key: BashPlusLocaleKey) => string,
  compare: PresetCompareValue | null,
): PresetDiffRow[] {
  if (compare === null || compare.status === 'unreadable') return []
  const absent = t('presetDiffAbsent')
  const whole = t('presetDiffWholeRow')
  return compare.items.map((item) => {
    const path = item.path === '' ? item.row : `${item.row}.${item.path}`
    switch (item.kind) {
      case 'changed':
        return { path, yours: item.yours ?? '', template: item.template ?? '' }
      case 'only-yours':
        return { path, yours: item.yours ?? '', template: absent }
      case 'only-template':
        return { path, yours: absent, template: item.template ?? absent }
      case 'row-only-yours':
        return { path, yours: whole, template: absent }
      case 'row-only-template':
        return { path, yours: absent, template: whole }
    }
  })
}

/** 模板下拉的选项文案：优先显示模板自报的名字，缺了退 id。 */
export function presetTemplateLabel(template: PresetTemplate): string {
  return template.name !== undefined && template.name !== '' ? template.name : template.id
}

/**
 * 选中的模板：①选中的预设自己有同名模板就用它（`tool-plus-ptc` 就该比
 * `tool-plus-ptc`）；②否则退随包的第一份模板（`BUNDLED_PRESET_IDS[0]`，即
 * `tool-plus-standard`，别按目录名排序撞上 ptc）；③再不行才退清单第一项。
 * 清单为空返回 undefined。
 * @param templates - 可选模板清单。
 * @param current - 当前选中的模板 id。
 * @param presetId - 当前选中的预设 id（同名模板优先）。
 * @returns 选中的模板 id。
 */
export function resolveSelectedTemplateId(
  templates: readonly PresetTemplate[],
  current: string | undefined,
  presetId: string | undefined,
): string | undefined {
  if (current !== undefined && templates.some(template => template.id === current)) return current
  if (presetId !== undefined && templates.some(template => template.id === presetId)) return presetId
  const preferred = BUNDLED_PRESET_IDS.find(id => templates.some(template => template.id === id))
  return preferred ?? templates[0]?.id
}

/**
 * 补充说明行：读取失败原因、无法识别的内容。差异不再在这里铺开 ——
 * 它进了「查看差异」弹窗，正文只留两个状态点。
 * @param t - 文案表。
 * @param status - 该预设的状态。
 * @returns 要渲染的说明行（可能为空）。
 */
export function presetNotes(t: (key: BashPlusLocaleKey) => string, status: PresetStatus): string[] {
  const notes: string[] = []
  if (status.broken !== undefined) {
    notes.push(t('presetNoteBroken').replace('{reason}', status.broken))
  } else if (status.unrecognized) {
    notes.push(t('presetNoteUnrecognized'))
  }
  return notes
}

/**
 * 该预设可执行的动作，按渲染顺序。
 *
 * - 官方随附预设一律无动作（写不了，它的只读语义由"没有按钮"表达，不再用徽标）；
 * - 其余预设都给两个动作：`upgrade`（最小更新：只禁用冲突行）与 `reset`
 *   （用**所选模板**整份覆盖）；
 * - 读不了、无法识别时只剩 `reset` —— 整份覆盖是唯一能修的办法，最小更新会拒绝。
 * @param status - 该预设的状态。
 * @returns 动作清单。
 */
export function presetActions(status: PresetStatus): PresetAction[] {
  if (status.source === 'shipped') return []
  // 「最小更新」要读得到组合文件才谈得上改行：读不了 / 形状不认 / 目录还没有 → 只给重置。
  const unusable = status.broken !== undefined
    || status.unrecognized
    || !status.installed
    || compositionUnreadable(status)
  return unusable ? ['reset'] : ['upgrade', 'reset']
}

/** 动作按钮文案：两个动作都面向所有可写预设，文案不再区分来源。 */
export function presetActionText(
  t: (key: BashPlusLocaleKey) => string,
  action: PresetAction,
): string {
  return action === 'reset' ? t('presetActionReset') : t('presetActionUpdate')
}

/**
 * 动作按钮的悬浮说明：讲清这个按钮**具体会做什么**，以及当前状态下有没有意义。
 * 用户要求"一眼看出含义"：需要更新时说清改哪几行，不需要更新时也要明说无需更新。
 * @param t - 文案表。
 * @param action - 该按钮的动作。
 * @param status - 该预设状态（决定"要不要更新"）。
 * @param templateLabel - 当前所选模板的显示名（重置提示里点名它是哪份）。
 * @returns 悬浮提示文案。
 */
export function presetActionHint(
  t: (key: BashPlusLocaleKey) => string,
  action: PresetAction,
  status: PresetStatus,
  templateLabel: string,
): string {
  const fill = (key: BashPlusLocaleKey, values: Record<string, string>): string => {
    let text = t(key)
    for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, value)
    return text
  }
  if (action === 'reset') return fill('presetActionResetHint', { template: templateLabel })
  if (status.conflicts.length === 0) return t('presetActionUpdateNothing')
  return fill('presetActionUpdateHint', {
    count: String(status.conflicts.length),
    rows: presetConflictNames(t, status.conflicts).join(t('presetListSeparator')),
  })
}

/** 冲突行 id → 面向使用者的名字列表（保序、不去重）。 */
export function presetConflictNames(t: (key: BashPlusLocaleKey) => string, conflicts: readonly string[]): string[] {
  return conflicts.map(id => {
    const key = CONFLICT_NAME_KEYS[id]
    return key === undefined ? id : t(key)
  })
}

/**
 * 重置的二次确认文案。还没安装（含 roster 缺席补出的行）时没有本地改动可丢，
 * 不能拿"会覆盖本地改动"吓人；其余情况按覆盖风险如实提示。两种情况都点名
 * 用的是**哪份模板**：重置的来源是用户在「对比模板」里选的那份。
 * @param t - 文案表。
 * @param status - 该预设状态。
 * @param templateLabel - 所选模板的显示名。
 * @returns 确认文案。
 */
export function presetConfirmText(
  t: (key: BashPlusLocaleKey) => string,
  status: PresetStatus,
  templateLabel: string,
): string {
  if (!status.installed || compositionUnreadable(status)) {
    return t('presetConfirmInstall').replace('{template}', templateLabel)
  }
  return t('presetConfirmReset').replace('{template}', templateLabel)
}

/**
 * 执行前摘要：将要改哪几行 / 将写入什么。**没事可做时返回 null**（不渲染这一行）——
 * 用户明确要求去掉「工具行都已禁用，无需调整。」这种"没有信息量的状态句"。
 * @param t - 文案表。
 * @param status - 该预设状态。
 * @returns 摘要文案，或 null（无需渲染）。
 */
export function presetPendingText(t: (key: BashPlusLocaleKey) => string, status: PresetStatus): string | null {
  const actions = presetActions(status)
  if (actions.length === 0) return null
  if (status.broken !== undefined || status.unrecognized) return t('presetPendingReset')
  if (!status.installed || compositionUnreadable(status)) return t('presetPendingInstall')
  if (status.conflicts.length === 0) return null
  const names = presetConflictNames(t, status.conflicts)
  return t('presetPendingRows')
    .replace('{count}', String(status.conflicts.length))
    .replace('{rows}', names.join(t('presetListSeparator')))
}

/**
 * 执行后结果：成功（改了几处、改了哪几处、是否留了备份）/ 无变化 / 失败原因。
 * 多行文本，`\n` 分段；调用方的结果行按 `white-space: pre-wrap` 渲染。
 *
 * `action` 必须传：宿主只在 `upgrade` 时返回逐行改动（`reset` 是整份覆盖，
 * `changes` 恒为空），所以重置不能套用"调整了 N 行"的句式 —— 否则会渲染成
 * "调整了 0 处"这种假话。
 */
export function presetResultText(
  t: (key: BashPlusLocaleKey) => string,
  result: PresetActionResult,
  action: PresetAction,
): string {
  if (!result.ok) {
    return t('presetResultFailed').replace('{reason}', result.reason ?? t('presetFailUnknown'))
  }
  if (action === 'reset') {
    if (!result.changed) return t('presetResultResetNoChange')
    const lines = [t('presetResultResetDone')]
    if (result.backupPath !== undefined) lines.push(t('presetResultBackup'))
    return lines.join('\n')
  }
  if (!result.changed) return t('presetResultNoChange')
  const lines = [t('presetResultDone').replace('{count}', String(result.changes.length))]
  if (result.changes.length > 0) {
    const names = presetConflictNames(t, result.changes.map(change => change.id))
    lines.push(t('presetResultRows').replace('{rows}', names.join(t('presetListSeparator'))))
  }
  if (result.backupPath !== undefined) lines.push(t('presetResultBackup'))
  return lines.join('\n')
}
