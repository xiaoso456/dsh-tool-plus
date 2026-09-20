/**
 * preset 组合改写：纯函数，文本进文本出，零 I/O。
 *
 * 一个预设要"支持本插件的工具"，只需让官方 4 个冲突行 id 处于「不存在」或
 * `disabled: true` 状态（插件已在宿主面全局接管这 4 个工具；预设里再挂一份
 * 会造成 per-session 影子实例）。本模块只做这一件事：
 *
 * - 只认**顶层**行 `- id: <target>`（`-` 在第 0 列），嵌套子行一律不碰；
 * - 行块已有 `disabled: true` → no-op；`disabled: false`（或任何非 `true`
 *   标量）→ 就地改成 `true`；没有 `disabled` → 在行块末尾追加一行
 *   `  disabled: true`（缩进与行内其它键对齐）；行块不存在 → 不动；
 * - 注释、空行、缩进、CRLF/LF、YAML 顺序、用户的本地调参全部逐字节保留；
 * - 输出与输入逐字节相同时 `changes` 为空——调用方以字节相等判定是否写盘
 *   （preset 代际以 `agent.cordis.yml` 的 mtime 为键，白写一次就白造一代）；
 * - 文本不构成顶层行列表 → `shape: 'unrecognized'`，一律不改写。
 *
 * `PresetChange.action` 的 `'absent'` 供 RPC 摘要层描述"这行本来就不挂"，
 * 改写本身只报告真实发生的改动（否则"幂等时 changes 为空"不成立）。
 * @module @xiaoso/dsh-tool-plus/presets/rewrite
 */

/** 默认冲突行 id：官方 standard / ptc / cordis 挂的 4 个官方工具行。 */
export const PRESET_CONFLICT_IDS: readonly string[] = ['tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search']

/** 一次改写实际发生的一处改动。 */
export interface PresetChange {
  /** 行 id（`- id: <id>` 的值）。 */
  id: string
  /** `disabled` = 行块末尾追加了禁用键；`flipped` = 既有禁用键被改成 `true`。 */
  action: 'disabled' | 'flipped' | 'absent'
}

/** 改写结果：最终文本 + 实际改动清单。 */
export interface PresetRewriteResult {
  text: string
  changes: PresetChange[]
}

/** 只读判定：给设置页状态用。 */
export interface PresetAnalysis {
  /** 仍挂着冲突行的 id（缺 `disabled` 或值不是 `true`），按 conflictIds 顺序。 */
  conflicts: string[]
  /** 无冲突且形状可识别。 */
  clean: boolean
  /** `unrecognized` = 文本不构成顶层行列表，一律不处理。 */
  shape: 'ok' | 'unrecognized'
}

/** 一行原文 + 其行尾符（`''` 表示文件末尾无行尾符），逐字节重建用。 */
interface Line {
  text: string
  eol: '' | '\n' | '\r\n'
}

/** 一个顶层行块。 */
interface RowInfo {
  id: string
  /** `- id:` 行的下标。 */
  start: number
  /** 行块结束（下一顶层 `- ` 行或文件末尾）的下标，排他。 */
  end: number
  /** 行内键的缩进宽度（取第一个非空非注释子行），无子行时为 undefined。 */
  keyIndent: number | undefined
  /** 行内键的缩进原文（制表符要原样沿用），无子行时为 undefined。 */
  keyIndentText: string | undefined
}

/** 顶层 `- id: <value>` 行（允许尾随注释；忽略缩进的同名行）。 */
const TOP_ID_ROW = /^-[ \t]+id:[ \t]*([^#\s]+)[ \t]*(?:#.*)?$/

/** 任意顶层行（块边界判定）。 */
const TOP_ROW = /^-(?:[ \t]|$)/

/** 行内键：`disabled: <value>`（任意缩进，缩进另判）。 */
const DISABLED_KEY = /^([ \t]*)disabled[ \t]*:[ \t]*(.*)$/

/** 注释行（含缩进的纯注释行）。 */
const COMMENT_LINE = /^[ \t]*#/

/** 空行（含仅空白行）。 */
const BLANK_LINE = /^[ \t]*$/

/**
 * 无损拆行：每行保留自己的行尾符，`joinLines` 后与原文逐字节相同。
 * 只区分 LF 与 CRLF（YAML 组合文件的两种现实写法）；孤立 `\r` 当内容。
 */
function splitLines(text: string): Line[] {
  const lines: Line[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\n') continue
    const crlf = i > start && text[i - 1] === '\r'
    lines.push({ text: text.slice(start, crlf ? i - 1 : i), eol: crlf ? '\r\n' : '\n' })
    start = i + 1
  }
  if (start < text.length) lines.push({ text: text.slice(start), eol: '' })
  return lines
}

/** 逐字节重建（`splitLines` 的逆运算）。 */
function joinLines(lines: readonly Line[]): string {
  return lines.map((line) => line.text + line.eol).join('')
}

/** 文件的行尾风格：取第一个带行尾符的行，缺省 LF。 */
function fileEol(lines: readonly Line[]): '\n' | '\r\n' {
  for (const line of lines) if (line.eol !== '') return line.eol
  return '\n'
}

/** 去掉 YAML 单双引号（`- id: 'tool-bash'`）。 */
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) return value.slice(1, -1)
  }
  return value
}

/** 缩进宽度（空格与制表符都按 1 计）。 */
function indentWidth(line: string): number {
  return line.length - line.trimStart().length
}

/**
 * 形状防护：文本必须构成"顶层行列表"。
 * 判据：至少一行有效内容；**首个**有效行是顶层 `- `；所有第 0 列有效行都是
 * 顶层 `- `（映射、仅注释的空文件、被破坏的片段、只有一段缩进嵌套的片段
 * 都会落在这里）。
 */
function detectShape(lines: readonly Line[]): 'ok' | 'unrecognized' {
  const significant = lines.filter((line) => !BLANK_LINE.test(line.text) && !COMMENT_LINE.test(line.text))
  if (significant.length === 0) return 'unrecognized'
  if (!TOP_ROW.test(significant[0].text)) return 'unrecognized'
  for (const line of significant) {
    const atColumnZero = line.text.trimStart() === line.text
    if (atColumnZero && !TOP_ROW.test(line.text)) return 'unrecognized'
  }
  return 'ok'
}

/** 扫出全部顶层行块（含块内键缩进），按出现顺序。 */
function scanRows(lines: readonly Line[]): RowInfo[] {
  const starts: Array<{ index: number; id: string }> = []
  for (let i = 0; i < lines.length; i++) {
    const match = TOP_ID_ROW.exec(lines[i].text)
    if (match === null) continue
    const id = stripQuotes(match[1])
    if (id.length === 0) continue
    starts.push({ index: i, id })
  }
  return starts.map((row) => {
    let end = lines.length
    for (let i = row.index + 1; i < lines.length; i++) {
      if (TOP_ROW.test(lines[i].text)) {
        end = i
        break
      }
    }
    let keyIndent: number | undefined
    let keyIndentText: string | undefined
    for (let i = row.index + 1; i < end; i++) {
      const text = lines[i].text
      if (BLANK_LINE.test(text) || COMMENT_LINE.test(text)) continue
      keyIndent = indentWidth(text)
      keyIndentText = text.slice(0, keyIndent)
      break
    }
    return { id: row.id, start: row.index, end, keyIndent, keyIndentText }
  })
}

/**
 * 行块自身的 `disabled:` 键行下标（只认与行内其它键同缩进的那一行；
 * 嵌套子行的 `disabled` 不算）。返回 undefined 表示该行块没有禁用键。
 */
function findDisabledLine(lines: readonly Line[], row: RowInfo): number | undefined {
  for (let i = row.start + 1; i < row.end; i++) {
    const text = lines[i].text
    if (BLANK_LINE.test(text) || COMMENT_LINE.test(text)) continue
    if (row.keyIndent === undefined || indentWidth(text) !== row.keyIndent) continue
    if (DISABLED_KEY.test(text)) return i
  }
  return undefined
}

/** `disabled:` 键的值是否已是 `true`（尾随注释忽略）。 */
function disabledValue(line: string): string {
  const match = DISABLED_KEY.exec(line)
  if (match === null) return ''
  return match[2].replace(/[ \t]+#.*$/, '').trim()
}

/**
 * 把一整行 `disabled: <值>` 换成**整值** `true`，原有尾随注释保留。
 *
 * 官方随附预设会用 `!!js` 表达式值（`standard` 的 tool-bash 是
 * `disabled: !!js process.platform === 'win32'`）。表达式既不是 `true` 也不是
 * `false`，我们无从判断它当前是否生效，所以只能整值替换；替换时把旧值以
 * `# was: …` 备注留在行尾（信息不丢，且下一轮 `disabledValue` 读到的是 `true`，
 * 幂等仍然成立）。逐 token 替换是错的：会把值拼成
 * `true process.platform === 'win32'`，表达式被破坏、`!!js` 标签也丢了。
 * @param line - 原始 `disabled:` 行（含缩进与可能的尾随注释）。
 * @returns 改写后的行。
 */
function flipDisabledLine(line: string): string {
  const match = DISABLED_KEY.exec(line)
  if (match === null) return line
  const indent = match[1]
  const rest = match[2]
  // 尾随注释连它前面的空白一起原样保留（既有单测要求逐字节保真）。
  const commentPart = /([ \t]+#.*)$/.exec(rest)?.[1] ?? ''
  const value = (commentPart === '' ? rest : rest.slice(0, rest.length - commentPart.length)).trim()
  // `false` 是唯一「本来关着、直接打开」的值，不需要备注；其余（表达式/其它写法）
  // 都属于「值变了」，必须留下原值线索。
  const note = value === '' || value === 'false' ? '' : `; was: ${value}`
  if (commentPart !== '') return `${indent}disabled: true${commentPart}${note}`
  return note === '' ? `${indent}disabled: true` : `${indent}disabled: true # was: ${value}`
}

/**
 * 追加位置：行块末尾最后一处"内容行"之后（跳过尾随空行与注释行，
 * 免得把 `disabled` 插到下一行块的说明注释之后）。
 */
function appendIndex(lines: readonly Line[], row: RowInfo): number {
  let last = row.start
  for (let i = row.start + 1; i < row.end; i++) {
    const text = lines[i].text
    if (BLANK_LINE.test(text) || COMMENT_LINE.test(text)) continue
    last = i
  }
  return last + 1
}

/** 去重后按出现顺序的冲突 id。 */
function normalizeIds(conflictIds: readonly string[] | undefined): string[] {
  const source = conflictIds ?? PRESET_CONFLICT_IDS
  return [...new Set(source.filter((id) => id.length > 0))]
}

/** 每个目标 id 的处置：flip（既有键改值）/ append（追加键）/ 无。 */
type Plan =
  | { kind: 'flip'; id: string; line: number }
  | { kind: 'append'; id: string; at: number; indent: string }

/** 逐个目标 id 定处置（不改动文本）。 */
function plan(
  lines: readonly Line[],
  rows: readonly RowInfo[],
  ids: readonly string[],
): Plan[] {
  const plans: Plan[] = []
  for (const id of ids) {
    const row = rows.find((candidate) => candidate.id === id)
    if (row === undefined) continue // 行块不存在 → 不动
    const disabledAt = findDisabledLine(lines, row)
    if (disabledAt !== undefined) {
      if (disabledValue(lines[disabledAt].text) === 'true') continue // 已禁用 → 幂等
      plans.push({ kind: 'flip', id, line: disabledAt })
      continue
    }
    const indent = row.keyIndentText ?? '  '
    plans.push({ kind: 'append', id, at: appendIndex(lines, row), indent })
  }
  return plans
}

/**
 * 把官方冲突行改写成"不存在或 disabled: true"。
 *
 * `changes` 只含真实发生的改动（幂等跑第二次必为空）；`shape: 'unrecognized'`
 * 时原文本原样返回。
 * @param text - `agent.cordis.yml` 的原文。
 * @param conflictIds - 冲突行 id，缺省 {@link PRESET_CONFLICT_IDS}。
 * @returns 最终文本与实际改动清单。
 */
export function rewritePresetComposition(
  text: string,
  conflictIds?: readonly string[],
): PresetRewriteResult {
  const lines = splitLines(text)
  if (detectShape(lines) === 'unrecognized') return { text, changes: [] }

  const ids = normalizeIds(conflictIds)
  const plans = plan(lines, scanRows(lines), ids)
  const changes: PresetChange[] = []
  const eol = fileEol(lines)

  // 先就地改既有键行（下标稳定），再从后往前插入新行（插入会移位）。
  const inserts: Array<{ at: number; indent: string; id: string }> = []
  for (const entry of plans) {
    if (entry.kind === 'flip') {
      lines[entry.line] = {
        text: flipDisabledLine(lines[entry.line].text),
        eol: lines[entry.line].eol,
      }
      changes.push({ id: entry.id, action: 'flipped' })
    } else {
      inserts.push({ at: entry.at, indent: entry.indent, id: entry.id })
    }
  }
  for (const insert of inserts.sort((a, b) => b.at - a.at)) {
    // 插在文件末尾且末行无行尾符时，先给上一行补行尾符，才能续上一行。
    if (insert.at === lines.length && lines.length > 0 && lines[lines.length - 1].eol === '') {
      lines[lines.length - 1] = { text: lines[lines.length - 1].text, eol }
      lines.push({ text: `${insert.indent}disabled: true`, eol: '' })
    } else {
      lines.splice(insert.at, 0, { text: `${insert.indent}disabled: true`, eol })
    }
    changes.push({ id: insert.id, action: 'disabled' })
  }
  // changes 按 conflictIds 顺序报告，与插入顺序无关。
  const ordered = ids
    .map((id) => changes.find((change) => change.id === id))
    .filter((change): change is PresetChange => change !== undefined)

  return { text: joinLines(lines), changes: ordered }
}

/**
 * 只读判定：该组合还有哪些冲突行没被禁用。
 * @param text - `agent.cordis.yml` 的原文。
 * @param conflictIds - 冲突行 id，缺省 {@link PRESET_CONFLICT_IDS}。
 * @returns 冲突清单、是否干净、形状结论。
 */
export function analyzePresetComposition(
  text: string,
  conflictIds?: readonly string[],
): PresetAnalysis {
  const lines = splitLines(text)
  const shape = detectShape(lines)
  if (shape === 'unrecognized') return { conflicts: [], clean: false, shape }

  const rows = scanRows(lines)
  const conflicts = normalizeIds(conflictIds).filter((id) => {
    const row = rows.find((candidate) => candidate.id === id)
    if (row === undefined) return false // 不存在 = 本来就不挂
    const disabledAt = findDisabledLine(lines, row)
    return disabledAt === undefined || disabledValue(lines[disabledAt].text) !== 'true'
  })
  return { conflicts, clean: conflicts.length === 0, shape }
}

/** 一个顶层行块的只读视图：id + 它自己的键值对（供比差/展示，不用于改写）。 */
export interface PresetRowView {
  id: string
  /** 行内顶层键值对，顺序与文件一致；值为去引号、去尾随注释后的原文。 */
  keys: { key: string; value: string }[]
  /**
   * 整个行块按缩进展开出的叶子（点号路径，列表项带 `[i]`），供比差用。
   * 只比顶层键是不够的：真实漂移常常藏在 `config.thresholdRatio` 这类嵌套键里。
   */
  leaves: { path: string; value: string }[]
}

/** 行内 `key: value`（顶层键；嵌套子键缩进更大，不在这里取）。 */
const ROW_KEY = /^[ \t]*([^#\s:][^:]*):[ \t]*(.*)$/

/** 去掉行尾注释与引号，得到可比的值。 */
function leafValue(text: string): string {
  return stripQuotes(text.replace(/[ \t]+#.*$/, '').trim())
}

/**
 * 把一个行块按缩进展开成叶子路径：容器键（`config:`）只做路径前缀，列表项
 * 以 `[i]` 编号。只读、不修改原文；识别不了的行原样当叶子。
 */
function walkRowLeaves(lines: readonly Line[], row: RowInfo): { path: string; value: string }[] {
  const out: { path: string; value: string }[] = []
  const stack: { indent: number; path: string }[] = []
  const counters = new Map<string, number>()
  // 从 `row.start + 1` 起：`row.start` 就是 `- id: <自身>` 那行，它不是子项。
  for (let i = row.start + 1; i < row.end; i += 1) {
    const raw = lines[i].text
    if (COMMENT_LINE.test(raw) || BLANK_LINE.test(raw)) continue
    const indent = indentWidth(raw)
    const trimmed = raw.trim()
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
    // 每个栈帧存的是**自己的完整路径**，所以前缀只取栈顶，不能再 join 一遍。
    const prefix = stack.length === 0 ? '' : stack[stack.length - 1].path
    if (trimmed === '-' || trimmed.startsWith('- ')) {
      const index = counters.get(prefix) ?? 0
      counters.set(prefix, index + 1)
      const itemPath = prefix === '' ? `[${index}]` : `${prefix}[${index}]`
      // 列表项本身是容器（后面缩进更深的行都属于它），无论它第一个键有没有值。
      stack.push({ indent, path: itemPath })
      const body = trimmed.replace(/^-[ \t]*/, '')
      const match = ROW_KEY.exec(`  ${body}`)
      if (match === null) {
        out.push({ path: itemPath, value: leafValue(body) })
        continue
      }
      const value = leafValue(match[2])
      if (value !== '') out.push({ path: `${itemPath}.${match[1].trim()}`, value })
      continue
    }
    const match = ROW_KEY.exec(trimmed)
    if (match === null) continue
    const key = match[1].trim()
    const path = prefix === '' ? key : `${prefix}.${key}`
    const value = leafValue(match[2])
    if (value === '') stack.push({ indent, path })
    else out.push({ path, value })
  }
  return out
}

/**
 * 只读读出顶层行的键值对与展开叶子。形状不可识别时返回 undefined（不猜、不修）。
 *
 * 与 {@link analyzePresetComposition} 共用同一套扫描器（`splitLines` /
 * `detectShape` / `scanRows`）：解析只有一份，差异视图与改写视图永远同源。
 * @param text - `agent.cordis.yml` 原文。
 * @returns 逐行视图，或形状不可识别时的 undefined。
 */
export function readPresetRows(text: string): PresetRowView[] | undefined {
  const lines = splitLines(text)
  if (detectShape(lines) !== 'ok') return undefined
  return scanRows(lines).map((row) => {
    const keys: { key: string; value: string }[] = []
    if (row.keyIndent !== undefined) {
      for (let i = row.start; i < row.end; i += 1) {
        const line = lines[i].text
        if (COMMENT_LINE.test(line) || BLANK_LINE.test(line)) continue
        // 只取行自己的键：嵌套 config 下的子键缩进更大，属于值的一部分。
        if (indentWidth(line) !== row.keyIndent) continue
        const match = ROW_KEY.exec(line)
        if (match === null) continue
        keys.push({ key: match[1].trim(), value: leafValue(match[2]) })
      }
    }
    return { id: row.id, keys, leaves: walkRowLeaves(lines, row) }
  })
}
