/**
 * 预设比较：把"某份预设"和"我们随包的某个模板"放在一起看。
 *
 * 面板现在是两块信息、两个状态点：
 *   ①**工具行**：这份预设里我们那 4 个冲突行都禁用了吗（=`conflicts`）；
 *   ②**完整比较**：内容上和我们选的模板差多少（=`items`，弹窗里逐条展示）。
 * 这是只读操作，绝不写盘。比较一律**不跳过**冲突行的 `disabled` —— 第二个点
 * 要的是"完整的比较"，工具开关的不同也必须出现在差异清单里，否则会出现
 * "说内容一致、却说工具行没配好"这种自相矛盾的读数。
 * @module @xiaoso/dsh-tool-plus/presets/compare
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  COMPOSITION_FILE_NAME,
  METADATA_FILE_NAME,
  type PresetDeps,
  packageRootDir,
} from './paths.ts'
import { presetDelta, type PresetDeltaItem } from './delta.ts'
import { analyzePresetComposition, type PresetAnalysis } from './rewrite.ts'

/** 面板"对比模板"下拉的一项：模板 id（可读性靠 name）。 */
export interface PresetTemplate {
  id: string
  name?: string
}

/** 一次比较的结果（面板两个状态点 + 弹窗的全部数据）。 */
export interface PresetComparison {
  /** 任一侧读不到或形状不可识别 → `unreadable`，此时 `items` 为空。 */
  status: 'ok' | 'unreadable'
  /** 这份预设里还没禁用的冲突行（空 = 我们的工具已生效）。 */
  conflicts: string[]
  /** 内容层面逐项一致（注释与排版差异不算，逐字节相同也不额外判断）。 */
  identical: boolean
  yoursCount: number
  behindCount: number
  /** 全部差异，不截断（弹窗自己滚动）。 */
  items: PresetDeltaItem[]
}

/** 模板根目录：`<packageRoot>/presets`。 */
function templatesRoot(deps: PresetDeps): string {
  return path.join(packageRootDir(deps), 'presets')
}

/** 读不到/不可识别时的统一结果（面板渲染红点，不抛）。 */
const UNREADABLE_COMPARISON: PresetComparison = {
  status: 'unreadable',
  conflicts: [],
  identical: false,
  yoursCount: 0,
  behindCount: 0,
  items: [],
}

/** 只读文本文件；读不到返回 undefined（不抛）。 */
function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/** 模板元数据里的 `name:`（一行，去掉引号）；读不到就退回 id。 */
function templateName(id: string, deps: PresetDeps): string | undefined {
  const text = readText(path.join(templatesRoot(deps), id, METADATA_FILE_NAME))
  if (text === undefined) return undefined
  const match = /^name[ \t]*:[ \t]*(.+)$/m.exec(text)
  if (match === null) return undefined
  return match[1].trim().replace(/^['"]|['"]$/g, '')
}

/**
 * 列出包里带模板的预设 id（面板"对比模板"下拉的选项）。只读目录，不抛。
 * @param deps - 路径注入（测试用）。
 * @returns 按 id 排序的模板清单（读不到目录时为空数组）。
 */
export function listTemplates(deps: PresetDeps = {}): PresetTemplate[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(templatesRoot(deps), { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(id => fs.existsSync(path.join(templatesRoot(deps), id, COMPOSITION_FILE_NAME)))
    .sort()
    .map((id) => {
      const name = templateName(id, deps)
      return name === undefined ? { id } : { id, name }
    })
}

/** 读一份模板的组合文件；不存在返回 undefined。 */
export function readTemplateComposition(templateId: string, deps: PresetDeps = {}): string | undefined {
  return readText(path.join(templatesRoot(deps), templateId, COMPOSITION_FILE_NAME))
}

/**
 * 比较两份组合文件文本（纯函数，只读）。
 * @param presetText - 所选预设的原文。
 * @param templateText - 所选模板的原文。
 * @returns 两个状态点与弹窗需要的全部数据。
 */
export function compareCompositions(presetText: string, templateText: string): PresetComparison {
  const analysis: PresetAnalysis = analyzePresetComposition(presetText)
  const unreadable = analysis.shape === 'unrecognized'
  if (unreadable) return UNREADABLE_COMPARISON
  // 完整比较：conflictIds 传空数组 = 不跳过任何键（工具行的 disabled 也要报）。
  const delta = presetDelta(presetText, templateText, { conflictIds: [], limit: Number.MAX_SAFE_INTEGER })
  return {
    status: 'ok',
    conflicts: analysis.conflicts,
    identical: delta.total === 0,
    yoursCount: delta.yoursCount,
    behindCount: delta.behindCount,
    items: delta.items,
  }
}

/**
 * 读盘版比较：预设一侧用 roster 给的组合文件路径，模板一侧按 id 去包里找。
 * 任一侧读不到都返回 `unreadable` —— 那是面板要渲染的红点，不是调用失败。
 * @param presetPath - 所选预设的组合文件绝对路径（来自 roster）。
 * @param templateId - 所选模板的 id。
 * @param deps - 路径注入（测试用）。
 * @returns 比较结果。
 */
export function comparePresetFile(
  presetPath: string,
  templateId: string,
  deps: PresetDeps = {},
): PresetComparison {
  const presetText = readText(presetPath)
  const templateText = readTemplateComposition(templateId, deps)
  if (presetText === undefined || templateText === undefined) return UNREADABLE_COMPARISON
  return compareCompositions(presetText, templateText)
}
