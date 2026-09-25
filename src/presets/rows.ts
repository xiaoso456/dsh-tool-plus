/**
 * preset 组合的**行模型**：官方声明式 preset 的 `config.plugins` 就是一棵
 * Cordis entry list，本模块是它唯一的读写口径。
 *
 * 为什么不再有 YAML 文本层：旧机制里预设是磁盘上的 `agent.cordis.yml`，我们
 * 只能逐行做文本手术（保缩进、保注释、保 CRLF）。0.1.7 起预设是 profile 配置
 * 里的一条声明，宿主给我们的**已经是解析好的对象树**（`configEditor` 的
 * `inherited` / `override`，以及 `entry.options.config`），再走文本就是自找
 * 麻烦：`!!js` 标记、块标量、引号风格全都不该由我们操心。
 *
 * 三条纪律：
 * - **形状判定照抄官方**：顶层必须是行列表，且每一行是带非空字符串 `name`
 *   的映射（官方 `entryListProblem` 同款）。不满足 → `undefined`，一律不处理。
 * - **只认顶层行**：`tool-bash`/`tool-fs` 这类 id 只按顶层匹配；group 里嵌套的
 *   同名行属于那个 group 的私有组成，绝不被外层动作波及。
 * - **绝不原地改**：所有"改写"都返回新对象，输入保持可比较（宿主按深相等判定
 *   是否落盘，原地改会让幂等判定失去意义）。
 * @module @xiaoso/dsh-tool-plus/presets/rows
 */

/** 一行 Cordis 配置项的最小子集（其余键原样透传）。 */
export interface PresetRow {
  id?: unknown
  name?: unknown
  group?: unknown
  disabled?: unknown
  isolate?: unknown
  config?: unknown
  [key: string]: unknown
}

/** 行 id 的取值（非空字符串才认，与官方对 `name` 的要求同款）。 */
export function rowId(row: PresetRow): string | undefined {
  return typeof row.id === 'string' && row.id.length > 0 ? row.id : undefined
}

/** 行模块名（官方 entry-list 要求每行都有非空 `name`）。 */
export function rowName(row: PresetRow): string | undefined {
  return typeof row.name === 'string' && row.name.length > 0 ? row.name : undefined
}

/** 这一行是不是 group 载体（group 的子行在 `config` 里）。 */
export function isGroupRow(row: PresetRow): boolean {
  return row.group === true && Array.isArray(row.config)
}

/**
 * 判定一份 `plugins` 值是不是合法的顶层行列表。规则与官方
 * `entryListProblem` 一致：必须是数组，每一项必须是带非空 `name` 的映射。
 * @param value - 待判定的值（来自宿主配置或测试注入）。
 * @returns 合法时为 true。
 */
export function isRowList(value: unknown): value is PresetRow[] {
  if (!Array.isArray(value)) return false
  return value.every((row) => typeof row === 'object' && row !== null && !Array.isArray(row) && rowName(row as PresetRow) !== undefined)
}

/**
 * 展平一棵行树（含 group 嵌套），键为 `父/子` 形式的路径。
 *
 * 路径是**给面板看的标识**，也用于我们自己的差异比较；官方
 * `compositionInventory()` 回的行没有路径（它压平后只剩 entryId/moduleName），
 * 所以需要分组结构时只能从声明本身取。
 * @param rows - 顶层行列表。
 * @param prefix - 递归时的父路径。
 * @returns 路径 → 行。
 */
export function flattenRows(rows: readonly PresetRow[], prefix = ''): Map<string, PresetRow> {
  const out = new Map<string, PresetRow>()
  for (const row of rows) {
    const id = rowId(row)
    // 匿名行不参与路径寻址（官方允许无名 id 的插入行存在）。
    if (id === undefined) continue
    const path = prefix.length > 0 ? `${prefix}/${id}` : id
    out.set(path, row)
    if (isGroupRow(row)) {
      for (const [nested, nestedRow] of flattenRows(row.config as PresetRow[], path)) out.set(nested, nestedRow)
    }
  }
  return out
}

/** 一个叶子：行内点号路径 → 规范化后的值字符串。 */
export interface RowLeaf {
  /** 行内路径，如 `config.thresholdRatio` 或 `config.models[0].id`。 */
  path: string
  /** 规范化值：标量走 `JSON.stringify`，所以 `true`/`"true"`/`1` 不会互相混淆。 */
  value: string
}

/**
 * `!!js` 表达式标记：entry-list 方言把它解析成 `{ __jsExpr: <源码> }`（见
 * `vendor/include/src/index.ts` 的 `JsExpr`）。它对我们是**标量**——一整段待求值的
 * 源码，不是可以逐键比较的结构。漏了这一步会造出 `disabled.__jsExpr` 这种假叶子，
 * 顺带让"冲突行的 disabled 归 conflicts 管"这条跳过规则失效。
 * @param value - 待判定的值。
 * @returns 是表达式标记时为 true。
 */
export function isJsExpr(value: unknown): value is { __jsExpr: string } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 1
    && typeof (value as { __jsExpr?: unknown }).__jsExpr === 'string'
}

/** 规范化一个标量用于比较与展示。 */
function canonical(value: unknown): string {
  if (value === undefined) return ''
  // 表达式按源码显示，比一串 `{"__jsExpr":…}` 好读，且两侧口径一致。
  if (isJsExpr(value)) return `!!js ${value.__jsExpr}`
  return JSON.stringify(value) ?? String(value)
}

/**
 * 收集一行自己的叶子路径（不含 `id`，不含 group 的子行）。
 *
 * 用规范化 JSON 而不是 `String()`：Loader 对 `disabled` 的语义是
 * "布尔取 Boolean(value)"，所以字符串 `"false"` 与布尔 `false` **语义相反**；
 * 两者若都显示成 `false`，面板就会把一处真实差异藏起来。
 * @param row - 目标行。
 * @param base - 递归时的前缀。
 * @returns 该行的叶子清单（顺序为键的声明顺序）。
 */
export function rowLeaves(row: PresetRow, base = ''): RowLeaf[] {
  const out: RowLeaf[] = []
  const walk = (value: unknown, path: string): void => {
    // 表达式标记是标量，先于对象分支判定。
    if (isJsExpr(value)) {
      out.push({ path, value: canonical(value) })
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`))
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        walk(nested, path.length > 0 ? `${path}.${key}` : key)
      }
      return
    }
    out.push({ path, value: canonical(value) })
  }
  for (const [key, value] of Object.entries(row)) {
    // 行身份不是内容，不参与差异。
    if (key === 'id') continue
    // group 的子行由 flattenRows 单独寻址，不重复展开。
    if (key === 'config' && isGroupRow(row)) continue
    walk(value, base.length > 0 ? `${base}.${key}` : key)
  }
  return out
}

/** 规范化的深比较（两侧都是 YAML/JSON 值，无函数与原型差异）。 */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}
