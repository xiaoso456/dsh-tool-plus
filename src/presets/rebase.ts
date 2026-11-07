/**
 * 「跟随官方」：从**当前环境**官方随附的预设声明，派生出我们增强版的 plugins。
 *
 * 为什么需要它：我们的两份增强版原本是按 dsh 某个版本的基线手抄/生成后随包发布的，
 * 官方一升级（0.2.1 → 0.2.2 删了 list-agents 子路径），随包那份就失效，只能等插件发版。
 * 这里把"增量"做成运行时可重算的纯函数：官方怎么改，派生结果就跟着改，不再依赖发版。
 *
 * 增量只有三项，与 scripts/build-preset-patches.mjs 的 delta 一一对应（tests/unit/preset-rebase.spec.ts
 * 钉住两边逐值相等，任何一边改了另一边不跟，测试即红）：
 * - 去掉 HOST_PLANE_ROW_IDS：宿主面已由 cordis.patch.yml 接管，agent 面再挂会造成影子实例；
 * - FORCED_DISABLED_ROW_IDS 强制 disabled: true（两档增强版都不启用 pwsh）；
 * - 在第一个被去掉的行的位置插入 DOC_ROW（故意 disabled，只作文档用）。
 * 其余每一行都原样继承官方——包括官方新增的行。
 *
 * 形状不对就拒绝（返回 ok: false 带原因），绝不猜：官方删了宿主面某一行时，不能派生出一份残缺列表。
 * 纯函数，无 I/O，不修改输入。
 * @module @xiaoso/dsh-tool-plus/presets/rebase
 */

import { isRowList, rowId, type PresetRow } from './rows.ts'

/** 宿主面已接管、agent 面必须缺席的三行。 */
export const HOST_PLANE_ROW_IDS: readonly string[] = ['tool-bash', 'tool-fs', 'tool-fs-search']

/** 产品决定：两档增强版都不启用 pwsh，关掉而非删除。 */
export const FORCED_DISABLED_ROW_IDS: readonly string[] = ['tool-pwsh']

/** 文档行：插在原 shell/fs 段的位置，故意 disabled。 */
export const DOC_ROW: PresetRow = { id: 'tool-plus', name: '@xiaoso/dsh-tool-plus', disabled: true }

/** 我们的预设 id → 它跟随的官方预设 id（官方 patch 里 config.id）。 */
export const OFFICIAL_BASE_OF: Readonly<Record<string, string>> = {
  'tool-plus-standard': 'standard',
  'tool-plus-ptc': 'ptc',
}

/** 派生结果：成功给出 plugins，失败给出可读原因（调用方据此 no-op，绝不写盘）。 */
export type RebaseResult = { ok: true; plugins: PresetRow[] } | { ok: false; reason: string }

/**
 * 从官方 plugins 派生我们的 plugins。
 * @param official - 官方声明的 config.plugins（宿主的 inherited 层）。
 * @returns 派生结果。
 */
export function rebasePlugins(official: unknown): RebaseResult {
  if (!isRowList(official)) return { ok: false, reason: 'official plugin list is not a readable row list' }
  const missing = HOST_PLANE_ROW_IDS.filter(id => !official.some(row => rowId(row) === id))
  if (missing.length > 0) {
    return { ok: false, reason: 'official plugin list no longer carries ' + missing.join(', ') + ' at top level; re-derive the delta before shipping' }
  }
  const isHostPlane = (row: PresetRow): boolean => HOST_PLANE_ROW_IDS.includes(rowId(row) ?? '')
  const at = official.findIndex(isHostPlane)
  const kept = official
    .filter(row => !isHostPlane(row))
    .map(row => (FORCED_DISABLED_ROW_IDS.includes(rowId(row) ?? '') ? { ...row, disabled: true } : row))
  // at 是第一个被去掉的行的原下标；其前面没有被去掉的行，所以在 kept 里的下标同样是 at。
  kept.splice(at, 0, { ...DOC_ROW })
  return { ok: true, plugins: kept }
}
