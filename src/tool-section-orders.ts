/**
 * 工具用法段在系统提示词里的位置。
 *
 * 为什么写死而不是运行时 `ctx.systemPrompt.getSectionOrder('TOOL_*')`：
 * - 那些具名位置是宿主内部的分配（上游 note 原话：「具名 order 查询属于仓库内部
 *   位置，而不是扩展 API」），第三方没有兼容承诺；
 * - 查表对未知名字返回 `undefined`，而 `systemPrompt.section()` 对非有限 order 直接
 *   抛错——宿主升级删/改一个名字，整个插件会在挂载时起不来，比顺序错更糟；
 * - 数值本身不会渲染，写死运行时零解析，跨宿主版本最多退化成“顺序稍旧”。
 *
 * 数值来源：dsh 0.2.x `@deepseek-ai/dsh-system-prompt` 的 SECTION_ORDERS
 * （TOOL_BASH 1000 → TOOL_GREP 1500）。上游改号时由
 * `tests/unit/tool-section-orders.spec.ts` 在升级 review 里先红，改常量是刻意动作。
 * @module @xiaoso/dsh-tool-plus/tool-section-orders
 */

/** 六段工具用法在提示词里的位置（官方集中分配表的 TOOL_* 值）。 */
export const TOOL_SECTION_ORDERS = {
  /** TOOL_BASH — shell 位于逐工具指导首位。 */
  bash: 1000,
  /** TOOL_READ — 文件系统指导排在 shell 之后。 */
  read: 1100,
  /** TOOL_WRITE。 */
  write: 1200,
  /** TOOL_EDIT。 */
  edit: 1300,
  /** TOOL_GLOB。 */
  glob: 1400,
  /** TOOL_GREP。 */
  grep: 1500,
} as const
