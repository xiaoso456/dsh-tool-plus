/**
 * 冲突不变式：一个 preset「接上了本插件的工具」当且仅当官方那 4 个工具行
 * 处于**不存在**或 **`disabled: true`** 状态。
 *
 * 原因（这套设计的地基，别丢）：`@xiaoso/dsh-tool-plus` 作为包在**宿主面**
 * 加载时，它自己的 profile 补丁已经禁用了这 4 行并插入**一行全局** `tool-plus`；
 * 注册表按 scope 分层、就近优先，所以宿主面那一份已经服务所有会话。若某个
 * preset 又在 **agent 面**挂一份同名工具行，就会用**第二个 `apply()` 影子实例**
 * 盖掉健康的宿主实例，而那个实例的 settings 注入永不触发（cfg 退化成
 * replace-mode 读取 —— 2026-08-25 hashline 事故的根因）。
 *
 * 与旧文本实现的唯一区别是**载体**：以前逐行读 `agent.cordis.yml` 的文本，
 * 现在直接看宿主交给我们的行对象。判定规则一字不改：
 * - 只认**顶层**行；group 里嵌套的同名行不碰；
 * - `disabled` 严格等于布尔 `true` 才算已处理 —— 缺席、`false`、字符串、
 *   `!!js` 表达式统统算冲突（`!!js` 在挂载时才求值，我们要的是无条件关闭，
 *   所以和旧实现一样整值翻成 `true`）；
 * - 输出恒为新数组，输入不变；结果与输入逐值相同时 `changes` 为空（调用方以
 *   此判定"不写盘"）。
 * @module @xiaoso/dsh-tool-plus/presets/conflicts
 */

import { isRowList, rowId, type PresetRow } from './rows.ts'

/** 官方 standard / ptc / cordis 会挂的 4 个工具行 id。 */
export const PRESET_CONFLICT_IDS: readonly string[] = ['tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search']

/** 一次改写实际发生的一处改动。 */
export interface PresetChange {
  /** 行 id（顶层 `- id: <id>`）。 */
  id: string
  /** `disabled` = 该行原本没有 `disabled` 键，现在补上；`flipped` = 既有值被翻成 `true`。 */
  action: 'disabled' | 'flipped'
}

/** 只读判定：给设置页状态用。 */
export interface PresetAnalysis {
  /** 仍挂着冲突行的 id（缺 `disabled` 或值不是布尔 `true`），按 conflictIds 顺序。 */
  conflicts: string[]
  /** 无冲突且形状可识别。 */
  clean: boolean
  /** `unrecognized` = 不是合法的顶层行列表，一律不处理也不改写。 */
  shape: 'ok' | 'unrecognized'
}

/** 该行是否已被无条件关闭（只有布尔 `true` 算）。 */
function disabled(row: PresetRow): boolean {
  return row.disabled === true
}

/** 顶层行里按 id 找第一行（只看顶层，与不变式一致）。 */
function topRow(rows: readonly PresetRow[], id: string): PresetRow | undefined {
  return rows.find((row) => rowId(row) === id)
}

/**
 * 只读分析一份 `plugins` 值。
 * @param plugins - 声明的子插件列表（来自宿主配置，形状未知）。
 * @param conflictIds - 冲突行清单，默认 {@link PRESET_CONFLICT_IDS}。
 * @returns 冲突清单、是否干净、形状是否可识别。
 */
export function analyzePlugins(
  plugins: unknown,
  conflictIds: readonly string[] = PRESET_CONFLICT_IDS,
): PresetAnalysis {
  if (!isRowList(plugins)) return { conflicts: [], clean: false, shape: 'unrecognized' }
  const conflicts = conflictIds.filter((id) => {
    const row = topRow(plugins, id)
    // 行不存在 = 这份 preset 本来就不挂它，不是冲突。
    return row !== undefined && !disabled(row)
  })
  return { conflicts, clean: conflicts.length === 0, shape: 'ok' }
}

/** 改写结果：新列表 + 实际改动清单 + 改写后仍未解决的冲突（理论上为空）。 */
export interface PresetConflictRewrite {
  plugins: PresetRow[]
  changes: PresetChange[]
}

/**
 * 把那 4 个仍挂着的冲突行翻成 `disabled: true`（不改别的行、不删行）。
 * @param plugins - 合法顶层行列表。
 * @param conflictIds - 冲突行清单，默认 {@link PRESET_CONFLICT_IDS}。
 * @returns 新列表与实际改动清单（无改动时 `changes` 为空且列表为原引用）。
 */
export function disableConflicts(
  plugins: readonly PresetRow[],
  conflictIds: readonly string[] = PRESET_CONFLICT_IDS,
): PresetConflictRewrite {
  const changes: PresetChange[] = []
  let touched = false
  const next = plugins.map((row) => {
    const id = rowId(row)
    if (id === undefined || !conflictIds.includes(id) || disabled(row)) return row
    changes.push({ id, action: Object.hasOwn(row, 'disabled') ? 'flipped' : 'disabled' })
    touched = true
    return { ...row, disabled: true }
  })
  if (!touched) return { plugins: plugins as PresetRow[], changes: [] }
  // 冲突清单按 conflictIds 顺序报告，与面板文案顺序一致。
  changes.sort((a, b) => conflictIds.indexOf(a.id) - conflictIds.indexOf(b.id))
  return { plugins: next, changes }
}
