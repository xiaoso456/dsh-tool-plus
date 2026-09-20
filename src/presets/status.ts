/**
 * preset 状态探测：把 roster 变成设置页要的清单。同步、只读。
 *
 * roster 由调用方（RPC 层）从 `ctx.agentPresets.list()` 映射后传入——本模块
 * 不依赖 cordis 类型，只吃一个最小结构，因此可以纯 fs 单测。三种来源按设计
 * 文档 §4.2 区分：
 * - `ours`：本插件随包的两个预设（id 在 {@link DEFAULT_PRESET_IDS} 里），
 *   可"更新"（只改冲突行）与"重置"（整份对齐模板）；
 * - `user`：用户根里的其它预设，只能"升级"（只改冲突行）；
 * - `shipped`：随部署提供的官方预设（`trust: 'system'`），只读展示。
 *
 * 判定只读文件、绝不写入：官方随附根与用户根在这里都只是被读。
 * @module @xiaoso/dsh-tool-plus/presets/status
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  COMPOSITION_FILE_NAME,
  DEFAULT_PRESET_IDS,
  type PresetDeps,
  templateDir,
  userPresetDir,
} from './paths.ts'
import { analyzePresetComposition } from './rewrite.ts'
import { presetDelta, type PresetDelta } from './delta.ts'

/** 预设来源：我们随包的两份 / 用户自建 / 官方随附。 */
export type PresetSource = 'ours' | 'user' | 'shipped'

/**
 * roster 的一行（调用方从 `ctx.agentPresets.list()` 映射而来，字段名对齐
 * `dsh-agent-presets` 的 `AgentPreset`：`path` 是**组合文件**的绝对路径）。
 */
export interface PresetRosterEntry {
  id: string
  trust: 'system' | 'user'
  path: string
  name?: string
  description?: string
  broken?: string
}

/** 一个预设的设置页状态。 */
export interface PresetStatus {
  id: string
  name?: string
  description?: string
  source: PresetSource
  /** 组合文件绝对路径（`agent.cordis.yml`）。 */
  path: string
  /** 仍挂着的官方冲突行（空 = 本插件的工具已生效）。 */
  conflicts: string[]
  /** 无冲突且形状可识别。 */
  clean: boolean
  /** 组合文件**可读但**不成顶层行列表 → 一律不处理（内容问题，§5.5）。 */
  unrecognized: boolean
  /** roster 报告的不可挂载原因，原样带出。 */
  broken?: string
  /**
   * 用户根（`<dshHome>/.agent-presets/<id>`）里有这个预设的副本。
   * 设置页对我们随包的两份据此显示"已安装 / 未安装"；官方随附的预设不在用户
   * 根，故恒为 false。
   */
  installed: boolean
  /** 包内存在这个 id 的模板（只有我们随包的两份才有）。 */
  templatePresent: boolean
  /** 已安装且与模板逐字节不同 → 本地有改动（重置会覆盖它）。 */
  templateDiffers: boolean
  /**
   * 与模板**具体**差在哪些键（只读列出；`templateDiffers` 只说明"有差异"，
   * 面板需要能说清"差在哪"，否则和"工具行无需调整"并列时会自相矛盾）。
   * 无模板或不可比较时为 undefined。
   */
  templateDelta?: PresetDelta
}

/**
 * 只读组合文件的三种结局：读到 / 压根不存在 / 存在但读不了。
 * "不存在"与"读不了"必须分开：不存在是**存在性**问题（由 `installed` 与
 * roster 的 `broken` 表达），不成顶层行列表才是**内容**问题（`unrecognized`）。
 */
type CompositionRead = { kind: 'ok'; text: string } | { kind: 'missing' } | { kind: 'unreadable' }

/** 读组合文件；绝不抛。ENOENT/ENOTDIR 归为"不存在"，其余归为"读不了"。 */
function readComposition(file: string): CompositionRead {
  try {
    return { kind: 'ok', text: fs.readFileSync(file, 'utf8') }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'missing' } : { kind: 'unreadable' }
  }
}

/** 只读文本文件；读不到返回 undefined（不抛）。 */
function readTextFile(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * 列出每个 roster 行的状态（顺序与入参一致）。
 * @param roster - 调用方映射好的预设清单（`path` = 组合文件路径）。
 * @param deps - 路径注入（fs 层测试用）。
 * @returns 逐行的设置页状态。
 */
export function listPresetStatuses(
  roster: readonly PresetRosterEntry[],
  deps: PresetDeps = {},
): PresetStatus[] {
  return roster.map((entry) => {
    const source: PresetSource =
      DEFAULT_PRESET_IDS.includes(entry.id) ? 'ours' : entry.trust === 'system' ? 'shipped' : 'user'

    const installed = fs.existsSync(userPresetDir(entry.id, deps))
    const templateFile = path.join(templateDir(entry.id, deps), COMPOSITION_FILE_NAME)
    const templatePresent = fs.existsSync(templateFile)

    const read = readComposition(entry.path)
    const analysis =
      read.kind === 'ok'
        ? analyzePresetComposition(read.text)
        : // missing：文件不存在，不是内容问题；unreadable：无法识别，不处理。
          {
            conflicts: [] as string[],
            clean: false,
            shape: read.kind === 'unreadable' ? ('unrecognized' as const) : ('ok' as const),
          }
    const unrecognized = read.kind === 'missing' ? false : analysis.shape === 'unrecognized'

    const templateText = installed && templatePresent ? readTextFile(templateFile) : undefined
    const templateDiffers =
      templateText !== undefined && read.kind === 'ok' && templateText !== read.text
    // 有差异就说清差在哪：面板上"与自带模板不同"和"工具行无需调整"是两件事，
    // 只有把差异逐条列出来，用户才不会觉得这两句话在打架。
    const templateDelta =
      templateDiffers && templateText !== undefined && read.kind === 'ok'
        ? presetDelta(read.text, templateText)
        : undefined
    const delta = templateDelta !== undefined && templateDelta.total > 0 ? templateDelta : undefined

    return {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      source,
      path: entry.path,
      conflicts: analysis.conflicts,
      clean: analysis.clean,
      unrecognized,
      broken: entry.broken,
      installed,
      templatePresent,
      templateDiffers,
      templateDelta: delta,
    }
  })
}
