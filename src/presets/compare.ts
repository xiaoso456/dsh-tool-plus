/**
 * 预设比较：把"某份 preset 生效的 plugins"和"某个随包声明的 plugins"放在一起看。
 *
 * 面板是两块信息、两个状态点：
 *   ①**工具行**：这份 preset 里那 4 个冲突行都禁用了吗（=`conflicts`）；
 *   ②**完整比较**：内容上和选中的模板差多少（=`items`，弹窗里逐条展示）。
 * 只读，绝不写盘。比较一律**不跳过**冲突行的 `disabled` —— 第二个点要的是
 * "完整的比较"，工具开关的不同也必须出现在差异清单里，否则会出现"说内容一致、
 * 却说工具行没配好"这种自相矛盾的读数。
 * @module @xiaoso/dsh-tool-plus/presets/compare
 */

import { analyzePlugins } from './conflicts.ts'
import { presetDelta, type PresetDeltaItem } from './delta.ts'
import { isRowList } from './rows.ts'

/** 一次比较的结果（面板两个状态点 + 弹窗的全部数据）。 */
export interface PresetComparison {
  /** 任一侧不是合法行列表 → `unreadable`，此时 `items` 为空。 */
  status: 'ok' | 'unreadable'
  /** 这份 preset 里还没禁用的冲突行（空 = 本插件的工具已生效）。 */
  conflicts: string[]
  /** 内容层面逐项一致（顺序不同不算差异，逐值比较）。 */
  identical: boolean
  yoursCount: number
  behindCount: number
  /** 全部差异，不截断（弹窗自己滚动）。 */
  items: PresetDeltaItem[]
}

/** 任一侧不可比较时的统一结果（面板渲染红点，不抛）。 */
const UNREADABLE_COMPARISON: PresetComparison = {
  status: 'unreadable',
  conflicts: [],
  identical: false,
  yoursCount: 0,
  behindCount: 0,
  items: [],
}

/**
 * 比较两份 `config.plugins`（纯函数，只读）。
 * @param presetPlugins - 所选 preset 生效的 plugins。
 * @param templatePlugins - 所选模板的 plugins（随包声明）。
 * @returns 两个状态点与弹窗需要的全部数据。
 */
export function comparePlugins(presetPlugins: unknown, templatePlugins: unknown): PresetComparison {
  if (!isRowList(presetPlugins) || !isRowList(templatePlugins)) return UNREADABLE_COMPARISON
  const analysis = analyzePlugins(presetPlugins)
  if (analysis.shape === 'unrecognized') return UNREADABLE_COMPARISON
  // 完整比较：conflictIds 传空数组 = 不跳过任何键（工具行的 disabled 也要报）。
  const delta = presetDelta(presetPlugins, templatePlugins, { conflictIds: [], limit: Number.MAX_SAFE_INTEGER })
  return {
    status: 'ok',
    conflicts: analysis.conflicts,
    identical: delta.total === 0,
    yoursCount: delta.yoursCount,
    behindCount: delta.behindCount,
    items: delta.items,
  }
}
