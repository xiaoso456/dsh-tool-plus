/**
 * 差异清单：只读地说清"这份 preset 与另一份（通常是随包声明）差在哪"。
 *
 * 为什么需要它：`templateDiffers: boolean` 只能说"不一样"，而面板上紧挨着的
 * 是"冲突行都已禁用、无需调整"。两句都对，读起来却打架 —— 前者说的是
 * **内容被改过**，后者说的是**我们自己那 4 个冲突行**。把差异逐条列出来，
 * 用户才不用猜"到底哪里不同、对齐会不会动它"。
 *
 * 契约（自旧文本实现原样继承，语义未变）：
 * - 比**展开到叶子的点号路径**（`config.thresholdRatio`、`config.models[0].id`）——
 *   真实漂移常藏在嵌套键里，只比顶层键会得出"没有差异"的错误结论；
 * - 冲突行的 `disabled` 由 `conflicts` 负责，不在差异里重复报；
 * - 形状不可识别 → 空清单，绝不猜；
 * - 顺序 = 你这份的行序在前（含 group 内子行），对方独有的行补在后；
 * - `total` 是全量，`items` 可被 `limit` 截断（面板据此说"等 N 项"）。
 * @module @xiaoso/dsh-tool-plus/presets/delta
 */

import { isYoursDelta } from '../tools/shared/browser-rpc-channel.ts'
import { PRESET_CONFLICT_IDS } from './conflicts.ts'
import { flattenRows, isRowList, rowLeaves, type PresetRow } from './rows.ts'

/** 一条差异：整行只在一侧、某个叶子只在一侧、或同一个叶子两边值不同。 */
export type PresetDeltaKind =
  | 'changed'
  | 'only-yours'
  | 'only-template'
  | 'row-only-yours'
  | 'row-only-template'

/** 差异清单的一项。`path` 为空串表示整行层面的差异。 */
export interface PresetDeltaItem {
  kind: PresetDeltaKind
  /**
   * 行路径：顶层行的 id（`tool-web`），或 group 内子行（`delegation/tool-ralph`）。
   * 用路径而不是裸 id，是因为嵌套行重名时裸 id 会指错行。
   */
  row: string
  /** 行内点号路径（如 `config.thresholdRatio`）；整行差异时为空串。 */
  path: string
  /** 你这份里的值（`only-template` / `row-only-template` 时不带）。 */
  yours?: string
  /** 对方的同名值（`only-yours` / `row-only-yours` 时不带）。 */
  template?: string
}

/** 差异清单：`items` 已按 `limit` 截断，`total` 是全量条数。 */
export interface PresetDelta {
  items: PresetDeltaItem[]
  total: number
  /**
   * 全量口径的两个分组：`yoursCount` = 你自己加/改的（对齐会覆盖它），
   * `behindCount` = 对方有而你没有的（对方已更新，对齐可补上）。
   * 分组计数必须按**全量**算：`items` 被 `limit` 截断后数它会把"等 N 项"说错。
   */
  yoursCount: number
  behindCount: number
}

/** 默认最多列几条（再多就该去看配置本身了）。 */
const DEFAULT_LIMIT = 6

/** 空结果（任一侧形状不可识别时）。 */
const EMPTY: PresetDelta = { items: [], total: 0, yoursCount: 0, behindCount: 0 }

/** 某个叶子的 `disabled` 是不是"我们自己的冲突行开关"——那属于 conflicts 的话题。 */
function isConflictSwitch(rowPath: string, leafPath: string, conflictIds: readonly string[]): boolean {
  return leafPath === 'disabled' && !rowPath.includes('/') && conflictIds.includes(rowPath)
}

/**
 * 比较两份 `config.plugins`，列出差异（只读，不改任何值）。
 * @param yours - 你这一侧的 plugins（形状未知）。
 * @param theirs - 对方的 plugins（形状未知）。
 * @param options - `conflictIds`（默认 {@link PRESET_CONFLICT_IDS}）与 `limit`（默认 6）。
 * @returns 差异清单；两侧任一形状不可识别时为空清单。
 */
export function presetDelta(
  yours: unknown,
  theirs: unknown,
  options: { conflictIds?: readonly string[]; limit?: number } = {},
): PresetDelta {
  if (!isRowList(yours) || !isRowList(theirs)) return EMPTY

  const conflictIds = options.conflictIds ?? PRESET_CONFLICT_IDS
  const limit = options.limit ?? DEFAULT_LIMIT
  const mine = flattenRows(yours)
  const other = flattenRows(theirs)
  const items: PresetDeltaItem[] = []

  const leavesOf = (row: PresetRow): Map<string, string> =>
    new Map(rowLeaves(row).map((leaf) => [leaf.path, leaf.value]))

  for (const [path, row] of mine) {
    const counterpart = other.get(path)
    if (counterpart === undefined) {
      items.push({ kind: 'row-only-yours', row: path, path: '' })
      continue
    }
    const a = leavesOf(row)
    const b = leavesOf(counterpart)
    for (const [leaf, value] of a) {
      if (isConflictSwitch(path, leaf, conflictIds)) continue
      if (!b.has(leaf)) {
        items.push({ kind: 'only-yours', row: path, path: leaf, yours: value })
        continue
      }
      const theirsValue = b.get(leaf) ?? ''
      if (theirsValue !== value) {
        items.push({ kind: 'changed', row: path, path: leaf, yours: value, template: theirsValue })
      }
    }
    for (const [leaf, value] of b) {
      if (isConflictSwitch(path, leaf, conflictIds)) continue
      if (!a.has(leaf)) items.push({ kind: 'only-template', row: path, path: leaf, template: value })
    }
  }
  for (const path of other.keys()) {
    if (!mine.has(path)) items.push({ kind: 'row-only-template', row: path, path: '' })
  }

  const yoursCount = items.filter((item) => isYoursDelta(item.kind)).length
  return {
    items: items.slice(0, Math.max(0, limit)),
    total: items.length,
    yoursCount,
    behindCount: items.length - yoursCount,
  }
}
