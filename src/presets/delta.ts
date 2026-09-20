/**
 * 预设差异清单：只读地说清"用户这份和随包模板差在哪"。
 *
 * 为什么需要它：`templateDiffers: boolean` 只能说"不一样"，而面板上紧挨着的
 * 是"工具冲突行都已禁用、无需调整"。两句都对，但读起来打架 —— 前者说的是
 * **你改过内容**，后者说的是**我们自己那 4 个冲突行**。把差异逐条列出来，
 * 面板才不需要用户自己猜"到底哪里不同、更新会不会动它"。
 *
 * 契约：①比**展开到叶子的点号路径**（`config.thresholdRatio`，列表项带 `[i]`）——
 * 真实漂移常藏在嵌套键里，只比顶层键会得出"没有差异"的错误结论；②冲突行的
 * `disabled` 由 `conflicts` 负责，不在差异里重复报；③形状不可识别 → 空清单，
 * 绝不猜；④顺序＝用户这份的行序在前，模板独有的行补在后；⑤`total` 是全量，
 * `items` 可被 `limit` 截断（面板据此说"等 N 项"）。
 * @module @xiaoso/dsh-tool-plus/presets/delta
 */

import { isYoursDelta } from '../tools/shared/browser-rpc-channel.ts'
import { PRESET_CONFLICT_IDS, readPresetRows, type PresetRowView } from './rewrite.ts'

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
  /** 顶层行的 id。 */
  row: string
  /** 行内点号路径（如 `config.thresholdRatio`）；整行差异时为空串。 */
  path: string
  /** 你这份里的值（`only-template` / `row-only-template` 时不带）。 */
  yours?: string
  /** 模板里的值（`only-yours` / `row-only-yours` 时不带）。 */
  template?: string
}

/** 差异清单：`items` 已按 `limit` 截断，`total` 是全量条数。 */
export interface PresetDelta {
  items: PresetDeltaItem[]
  total: number
  /**
   * 全量口径的两个分组：`yoursCount` = 你自己加/改的（更新不覆盖，重置会覆盖），
   * `behindCount` = 模板有而你没有的（模板已更新，重置可对齐）。
   * 分组计数必须按**全量**算：`items` 被 `limit` 截断后数它会把"等 N 项"说错。
   */
  yoursCount: number
  behindCount: number
}

/** 默认最多列几条（再多就该去看文件本身了）。 */
const DEFAULT_LIMIT = 6

/** 某个路径是不是"我们自己的冲突行开关"——那属于 conflicts 的话题。 */
function isConflictSwitch(row: string, path: string, conflictIds: readonly string[]): boolean {
  return path === 'disabled' && conflictIds.includes(row)
}

/** 把行视图折成 `路径 → 值`（重复路径以最后一个为准，与 YAML 一致）。 */
function leafMap(row: PresetRowView): Map<string, string> {
  return new Map(row.leaves.map(entry => [entry.path, entry.value]))
}

/**
 * 比较两份组合文件，列出差异（只读，不改任何字节）。
 * @param userText - 用户这份的 `agent.cordis.yml` 原文。
 * @param templateText - 随包模板的同一文件原文。
 * @param options - `conflictIds`（默认 {@link PRESET_CONFLICT_IDS}）与 `limit`（默认 6）。
 * @returns 差异清单；两侧任一不可识别时为空清单。
 */
export function presetDelta(
  userText: string,
  templateText: string,
  options: { conflictIds?: readonly string[]; limit?: number } = {},
): PresetDelta {
  const yours = readPresetRows(userText)
  const theirs = readPresetRows(templateText)
  if (yours === undefined || theirs === undefined) return { items: [], total: 0, yoursCount: 0, behindCount: 0 }

  const conflictIds = options.conflictIds ?? PRESET_CONFLICT_IDS
  const limit = options.limit ?? DEFAULT_LIMIT
  const theirRows = new Map(theirs.map(row => [row.id, row]))
  const myRowIds = new Set(yours.map(row => row.id))
  const items: PresetDeltaItem[] = []

  for (const row of yours) {
    const counterpart = theirRows.get(row.id)
    if (counterpart === undefined) {
      items.push({ kind: 'row-only-yours', row: row.id, path: '' })
      continue
    }
    const mine = leafMap(row)
    const other = leafMap(counterpart)
    for (const [path, value] of mine) {
      if (isConflictSwitch(row.id, path, conflictIds)) continue
      if (!other.has(path)) {
        items.push({ kind: 'only-yours', row: row.id, path, yours: value })
        continue
      }
      const theirValue = other.get(path) ?? ''
      if (theirValue !== value) {
        items.push({ kind: 'changed', row: row.id, path, yours: value, template: theirValue })
      }
    }
    for (const [path, value] of other) {
      if (isConflictSwitch(row.id, path, conflictIds)) continue
      if (!mine.has(path)) items.push({ kind: 'only-template', row: row.id, path, template: value })
    }
  }
  for (const row of theirs) {
    if (!myRowIds.has(row.id)) items.push({ kind: 'row-only-template', row: row.id, path: '' })
  }

  const yoursCount = items.filter(item => isYoursDelta(item.kind)).length
  return {
    items: items.slice(0, Math.max(0, limit)),
    total: items.length,
    yoursCount,
    behindCount: items.length - yoursCount,
  }
}
