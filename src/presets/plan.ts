/**
 * 动作判定：三个面板动作各自"要不要动手、动手算不算真改动"。**纯函数**。
 *
 * 这一层存在的理由：真正落盘的是宿主自己的 `ctx.configEditor.edit()`，它**每次
 * 调用都会重写 profile 补丁文件**（哪怕内容一个字没变）。所以"是否值得写"必须
 * 在调用它**之前**判定，否则面板每点一次都会白改一次 mtime、白触发一轮 HMR 重载。
 * 判定所需的事实全部来自 {@link PresetFacts}，因此这里可以纯函数测试，不需要
 * 真的 profile、也不需要 cordis。
 *
 * 三个动作的语义（自旧目录机制映射而来，见 CHANGELOG）：
 * - `upgrade`（最小更新）：只把仍挂着的官方冲突行翻成 `disabled: true`。不改别的行，
 *   不动显示元数据 —— 幂等，已干净时一个字节都不写。
 * - `align`（对齐模板）：把生效的 plugins 整份换成所选模板声明的 plugins。
 *   *对齐到自己的随包声明* = 撤销覆盖，等价于 `revert`，这里直接归约过去。
 * - `revert`（恢复随包）：让宿主删掉 profile 补丁里那一行的 `config`，
 *   于是这一行回落到随包声明。没有覆盖时是 no-op。
 * @module @xiaoso/dsh-tool-plus/presets/plan
 */

import type { PresetChange } from './conflicts.ts'
import { analyzePlugins, disableConflicts } from './conflicts.ts'
import { isRowList, sameValue, type PresetRow } from './rows.ts'

/** 面板可以请求的三个动作。 */
export type PresetActionKind = 'upgrade' | 'align' | 'revert'

/** 判定所需的全部事实。 */
export interface PresetPlanInput {
  action: PresetActionKind
  /** 这个 preset 是不是本插件声明的（只有 ours 允许 align / revert）。 */
  ours: boolean
  /** 用户是否在 profile 层写过覆盖。 */
  customized: boolean
  /** 生效的完整 config（宿主的 `entry.options.config`）；取不到时 undefined。 */
  effective: Record<string, unknown> | undefined
  /** 随包声明那一层的完整 config（宿主的 `inherited`）。 */
  inherited: Record<string, unknown> | undefined
  /** `align` 的目标模板 plugins。 */
  templatePlugins?: unknown
  /** `align` 请求的模板 id（仅用于文案与校验）。 */
  templateId?: string
}

/** 判定结果。 */
export type PresetPlan =
  | { kind: 'noop'; reason: string }
  | { kind: 'upgrade'; changes: PresetChange[] }
  | { kind: 'align' }
  | { kind: 'revert' }

/** 生效的 plugins（覆盖优先）。 */
function effectivePlugins(input: PresetPlanInput): PresetRow[] | undefined {
  const plugins = input.effective?.plugins
  return isRowList(plugins) ? plugins : undefined
}

/**
 * 判定一个动作该不该写、会改什么。
 * @param input - 判定所需的事实。
 * @returns 计划；`noop` 时调用方**不要**调用 `configEditor.edit`。
 */
export function planPresetAction(input: PresetPlanInput): PresetPlan {
  if (input.action === 'revert') {
    if (!input.customized) return { kind: 'noop', reason: 'this preset carries no profile override to remove' }
    return { kind: 'revert' }
  }

  if (input.action === 'align') {
    if (!input.ours) return { kind: 'noop', reason: 'only presets this plugin declares can be aligned' }
    if (input.templateId === undefined) return { kind: 'noop', reason: 'align needs a template id' }
    if (!isRowList(input.templatePlugins)) return { kind: 'noop', reason: `template ${input.templateId} has no readable plugin list` }
    // 对齐到自己的随包声明 = 撤销覆盖：交给 revert，让宿主删掉 config 键。
    if (sameValue(input.templatePlugins, input.inherited?.plugins)) {
      if (!input.customized) return { kind: 'noop', reason: 'this preset already matches the bundled declaration' }
      return { kind: 'revert' }
    }
    if (sameValue(input.templatePlugins, input.effective?.plugins)) {
      return { kind: 'noop', reason: `this preset already matches template ${input.templateId}` }
    }
    return { kind: 'align' }
  }

  // upgrade：只处理冲突行。
  const plugins = effectivePlugins(input)
  if (plugins === undefined) {
    return { kind: 'noop', reason: 'the plugin list is not a readable row list, nothing was written' }
  }
  if (analyzePlugins(plugins).conflicts.length === 0) {
    return { kind: 'noop', reason: 'no official tool row needs disabling' }
  }
  const { changes } = disableConflicts(plugins)
  if (changes.length === 0) return { kind: 'noop', reason: 'no official tool row needs disabling' }
  return { kind: 'upgrade', changes }
}
