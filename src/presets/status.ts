/**
 * preset 状态：把宿主交给我们的事实折成设置页要的清单。同步、只读。
 *
 * 事实从哪来（0.1.7 起官方只提供这两处，`path` / `trust` 都已不存在）：
 * - `ctx.configEditor.configuration()` —— 每个**可寻址**的 profile 行给
 *   `{entry, inherited, override}`。`inherited` 是随包声明那一层（我们的
 *   模板），`override` 是用户写进 profile 补丁那一层。bundle 补丁 insert 的
 *   `preset-*` 行也是根 include 的子行，所以这里拿得到。
 * - `ctx.agentPresets.list()` —— 名册身份与激活诊断（`broken`），**没有**
 *   `path`，也**没有** `trust`。
 *
 * 三种来源的旧口径已失效，现在的区分只剩"是不是本插件声明的"：
 * - `ours`：id 在 {@link BUNDLED_PRESET_IDS} 里 → 三个动作齐全；
 * - `other`：别人的声明（官方随附，或用户装的别的 bundle）→ 只给"最小更新"，
 *   因为我们只该修冲突行，不该替别人重写整份内容。
 * @module @xiaoso/dsh-tool-plus/presets/status
 */

import { BUNDLED_PRESET_IDS, type PresetStatusListValue, type PresetStatusValue } from '../tools/shared/browser-rpc-channel.ts'
import { analyzePlugins } from './conflicts.ts'
import { presetDelta } from './delta.ts'
import { flattenRows, isRowList } from './rows.ts'

/**
 * 一个 preset 的原始事实（宿主层收集，本模块纯消费）。
 *
 * `inherited` / `override` 是**完整 config 对象**（`{id,name,description,order,plugins}`），
 * 不是 plugins 列表 —— 因为 profile 补丁按行 id 覆盖时替换的是**整份 `config`**，
 * 判断"改没改过"必须看整份，不能只看 plugins。
 */
export interface PresetFacts {
  /** 预设身份（`config.id`）。 */
  id: string
  /** profile 补丁里那一行的 id（`preset-<id>`）；本 profile 没有这一行时为 undefined。 */
  entryId?: string
  name?: string
  description?: string
  isDefault: boolean
  /** 宿主报告的不可挂载原因（行名解析不到、缺服务…），原样带出。 */
  broken?: string
  /** 生效的完整 config（宿主的 `entry.options.config`）；取不到时为 undefined。 */
  effective?: Record<string, unknown>
  /** 随包声明那一层的 config（`configEditor` 的 `inherited`）；取不到时为 undefined。 */
  inherited?: Record<string, unknown>
  /** 用户在 profile 层写的 config（`configEditor` 的 `override`）；空对象 = 没有覆盖。 */
  override?: Record<string, unknown>
  /** 这个 preset 是不是本插件声明的（id ∈ {@link BUNDLED_PRESET_IDS}）。 */
  ours: boolean
}

/** 生效的 plugins：宿主的生效 config 优先，回落到覆盖层、再回落到随包声明。 */
function effectivePlugins(facts: PresetFacts): unknown {
  if (facts.effective?.plugins !== undefined) return facts.effective.plugins
  const overridePlugins = facts.override?.plugins
  if (overridePlugins !== undefined) return overridePlugins
  return facts.inherited?.plugins
}

/** 覆盖里是不是真带了内容（`{}` 表示没有覆盖行）。 */
function isCustomized(facts: PresetFacts): boolean {
  return facts.override !== undefined && Object.keys(facts.override).length > 0
}

/**
 * 把一个 preset 折成面板状态。
 * @param facts - 宿主收集的原始事实。
 * @param templateIds - 随包声明的模板清单（用于"与随包声明是否一致"）。
 * @returns 面板状态行。
 */
export function toPresetStatus(facts: PresetFacts, templateIds: readonly string[]): PresetStatusValue {
  const plugins = effectivePlugins(facts)
  const analysis = analyzePlugins(plugins)
  const customized = isCustomized(facts)
  const rows = isRowList(plugins) ? flattenRows(plugins).size : 0

  // 只有我们自己声明的预设才谈"与随包模板的差异"：别的 preset 的 inherited
  // 是别人的内容，拿它跟我们的模板比没有意义。
  const comparable = facts.ours && templateIds.includes(facts.id) && isRowList(plugins) && isRowList(facts.inherited?.plugins)
  const templateDiffers = comparable && presetDelta(plugins, facts.inherited?.plugins, { limit: Number.MAX_SAFE_INTEGER }).total > 0
  const templateDelta = templateDiffers
    ? presetDelta(plugins, facts.inherited?.plugins)
    : undefined
  const delta = templateDelta !== undefined && templateDelta.total > 0 ? templateDelta : undefined

  return {
    id: facts.id,
    ...(facts.entryId === undefined ? {} : { entryId: facts.entryId }),
    ...(facts.name === undefined ? {} : { name: facts.name }),
    ...(facts.description === undefined ? {} : { description: facts.description }),
    source: facts.ours ? 'ours' : 'other',
    isDefault: facts.isDefault,
    conflicts: analysis.conflicts,
    clean: analysis.clean,
    unrecognized: analysis.shape === 'unrecognized',
    ...(facts.broken === undefined ? {} : { broken: facts.broken }),
    customized,
    templateDiffers,
    ...(delta === undefined ? {} : { templateDelta: delta }),
    rowCount: rows,
  }
}

/**
 * 列出每个事实的状态，并给出模板清单。
 * @param facts - 宿主收集的原始事实（顺序即面板顺序）。
 * @param writable - 本部署有没有可编辑的 profile（`configEditor` 是否在场）。
 * @returns `presets/status` 的完整返回值。
 */
export function listPresetStatuses(facts: readonly PresetFacts[], writable: boolean): PresetStatusListValue {
  const templateIds = facts.filter((item) => item.ours).map((item) => item.id)
  const templates = facts
    .filter((item) => item.ours)
    .map((item) => (item.name === undefined ? { id: item.id } : { id: item.id, name: item.name }))
  return {
    presets: facts.map((item) => toPresetStatus(item, templateIds)),
    templates,
    writable,
  }
}

/**
 * 取某个模板声明的 plugins（面板"对比 / 对齐"的右侧）。
 * @param facts - 同一个事实集合。
 * @param templateId - 模板 id（本插件声明的某个 preset）。
 * @returns 该模板的 plugins；不是我们的模板时 undefined。
 */
export function templatePlugins(facts: readonly PresetFacts[], templateId: string): unknown {
  const fact = facts.find((item) => item.ours && item.id === templateId)
  return fact?.inherited?.plugins
}
