/**
 * Tool-plus configuration single source of truth: every settable field across
 * all ported tools (bash + read + write/edit guard), its kind, default value,
 * UI copy keys, and its group/tool membership — plus the tool-tab map the
 * settings page renders.
 *
 * This module is intentionally dependency-free (no host services): both the
 * Host schema (`src/config/settings.ts`) and the browser settings UI
 * (`src/client/*`) read from it, so a default or a field can never drift
 * between the two planes. The only import is the locale key type, which is
 * type-only and erased at build time.
 * @module @xiaoso/dsh-tool-plus/config
 */

import type { BashPlusLocaleKey } from '../client/locales.ts'

/** A scalar value a settings field can hold (mirrors the schema types). */
export type ToolPlusFieldValue = number | boolean | string

/** Field control kinds the settings UI renders. */
export type ToolPlusFieldKind = 'number' | 'boolean' | 'select'

/** One selectable option of a `select` field. */
export interface ToolPlusSelectOption {
  value: string
  labelKey: BashPlusLocaleKey
}

/** Conditional visibility: show this field only while a condition field matches. */
export interface ToolPlusFieldVisibility {
  /** Show only while this boolean field is true (a master switch). */
  requiresEnabled?: string
  /** Show only while this select field equals the value. */
  requiresSelect?: { field: string; value: string }
  /** Hide while this select field equals the value (e.g. hide head bytes in tail mode). */
  hideWhenSelect?: { field: string; value: string }
}

/** One configurable field of the plugin's tools. */
export interface ToolPlusField {
  /** Settings namespace key (flat schema key). */
  name: string
  /** Control kind the UI renders. */
  kind: ToolPlusFieldKind
  /** Schema default; a cleared user field reverts to this value. */
  default: ToolPlusFieldValue
  /** Locale keys for the control label and hint. */
  labelKey: BashPlusLocaleKey
  hintKey: BashPlusLocaleKey
  /** Group id (a Bash subgroup or the whole-tool group); order = render order. */
  group: string
  /** Owning tool tab. */
  tool: ToolPlusToolId
  /** Options for `select` fields. */
  options?: readonly ToolPlusSelectOption[]
  /** Conditional visibility (master switches, strategy-dependent fields). */
  visibility?: ToolPlusFieldVisibility
}

/** Tool tabs of the settings page; `fields: []` = no global settings. */
export interface ToolPlusTab {
  id: ToolPlusToolId
  labelKey: BashPlusLocaleKey
  /** Field names owned by this tool, in render order. */
  fields: readonly string[]
}

/** Identifiers of every tool tab. */
export type ToolPlusToolId =
  | 'bash' | 'read' | 'writeEdit'
  | 'grep' | 'glob' | 'astGrep' | 'astEdit' | 'readImage'

/** Field group ids -> locale key of the group heading. */
export const TOOL_PLUS_GROUP_LABELS: Record<string, BashPlusLocaleKey> = {
  timing: 'groupTiming',
  output: 'groupOutput',
  truncation: 'groupTruncation',
  behavior: 'groupBehavior',
  reading: 'groupReading',
  summary: 'groupSummary',
  fetch: 'groupFetch',
  images: 'groupImages',
  editMode: 'groupEditMode',
  guard: 'groupGuard',
  grep: 'groupGrep',
  ast: 'groupAst',
}

/**
 * Every field of the plugin, in schema order. Defaults mirror
 * `src/config/settings.ts` schema + `resolveConfig` — this table is the
 * single source; settings.ts reads from here.
 */
export const TOOL_PLUS_FIELDS: readonly ToolPlusField[] = [
  // ---- Bash: behavior -------------------------------------------------
  { name: 'enableRunInBackground', kind: 'boolean', default: true, labelKey: 'enableRunInBackground', hintKey: 'enableRunInBackgroundHint', group: 'behavior', tool: 'bash' },
  { name: 'minimizerEnabled', kind: 'boolean', default: true, labelKey: 'minimizerEnabled', hintKey: 'minimizerEnabledHint', group: 'behavior', tool: 'bash' },
  { name: 'interceptorEnabled', kind: 'boolean', default: false, labelKey: 'interceptorEnabled', hintKey: 'interceptorEnabledHint', group: 'behavior', tool: 'bash' },
  { name: 'nonInteractiveEnv', kind: 'boolean', default: true, labelKey: 'nonInteractiveEnv', hintKey: 'nonInteractiveEnvHint', group: 'behavior', tool: 'bash' },
  { name: 'snapshotEnabled', kind: 'boolean', default: true, labelKey: 'snapshotEnabled', hintKey: 'snapshotEnabledHint', group: 'behavior', tool: 'bash' },
  { name: 'useShellCommandWrapper', kind: 'boolean', default: false, labelKey: 'useShellCommandWrapper', hintKey: 'useShellCommandWrapperHint', group: 'behavior', tool: 'bash' },
  // ---- Bash: timing & backgrounding -----------------------------------
  { name: 'autoBackgroundMs', kind: 'number', default: 60_000, labelKey: 'autoBackgroundMs', hintKey: 'autoBackgroundMsHint', group: 'timing', tool: 'bash' },
  { name: 'defaultTimeoutMs', kind: 'number', default: 3_600_000, labelKey: 'defaultTimeoutMs', hintKey: 'defaultTimeoutMsHint', group: 'timing', tool: 'bash' },
  { name: 'maxTimeoutMs', kind: 'number', default: 3_600_000, labelKey: 'maxTimeoutMs', hintKey: 'maxTimeoutMsHint', group: 'timing', tool: 'bash' },
  { name: 'maxBackgroundJobs', kind: 'number', default: 15, labelKey: 'maxBackgroundJobs', hintKey: 'maxBackgroundJobsHint', group: 'timing', tool: 'bash' },
  // ---- Bash (output) --------------------------------------------------
  { name: 'outputMaxBytes', kind: 'number', default: 51_200, labelKey: 'outputMaxBytes', hintKey: 'outputMaxBytesHint', group: 'output', tool: 'bash' },
  { name: 'outputSinkTailBytes', kind: 'number', default: 51_200, labelKey: 'outputSinkTailBytes', hintKey: 'outputSinkTailBytesHint', group: 'output', tool: 'bash' },
  { name: 'outputSinkHeadBytes', kind: 'number', default: 20_480, labelKey: 'outputSinkHeadBytes', hintKey: 'outputSinkHeadBytesHint', group: 'output', tool: 'bash' },
  // ---- Bash: completion truncation -----------------------------------
  { name: 'outputTruncateStrategy', kind: 'select', default: 'bytes', labelKey: 'outputTruncateStrategy', hintKey: 'outputTruncateStrategyHint', group: 'truncation', tool: 'bash', options: [
    { value: 'bytes', labelKey: 'optBytes' },
    { value: 'lines', labelKey: 'optLines' },
  ] },
  { name: 'outputTruncateTriggerBytes', kind: 'number', default: 10_240, labelKey: 'outputTruncateTriggerBytes', hintKey: 'outputTruncateTriggerBytesHint', group: 'truncation', tool: 'bash', visibility: { requiresSelect: { field: 'outputTruncateStrategy', value: 'bytes' } } },
  { name: 'outputTruncateTriggerLines', kind: 'number', default: 100, labelKey: 'outputTruncateTriggerLines', hintKey: 'outputTruncateTriggerLinesHint', group: 'truncation', tool: 'bash', visibility: { requiresSelect: { field: 'outputTruncateStrategy', value: 'lines' } } },
  { name: 'outputTruncateByteMode', kind: 'select', default: 'middle', labelKey: 'outputTruncateByteMode', hintKey: 'outputTruncateByteModeHint', group: 'truncation', tool: 'bash', visibility: { requiresSelect: { field: 'outputTruncateStrategy', value: 'bytes' } }, options: [
    { value: 'head', labelKey: 'optHead' },
    { value: 'tail', labelKey: 'optTail' },
    { value: 'middle', labelKey: 'optMiddle' },
  ] },
  { name: 'outputTruncateByteHeadBytes', kind: 'number', default: 4_096, labelKey: 'outputTruncateByteHeadBytes', hintKey: 'outputTruncateByteHeadBytesHint', group: 'truncation', tool: 'bash', visibility: { requiresSelect: { field: 'outputTruncateStrategy', value: 'bytes' }, hideWhenSelect: { field: 'outputTruncateByteMode', value: 'tail' } } },
  { name: 'outputTruncateByteTailBytes', kind: 'number', default: 4_096, labelKey: 'outputTruncateByteTailBytes', hintKey: 'outputTruncateByteTailBytesHint', group: 'truncation', tool: 'bash', visibility: { requiresSelect: { field: 'outputTruncateStrategy', value: 'bytes' }, hideWhenSelect: { field: 'outputTruncateByteMode', value: 'head' } } },
  { name: 'outputTruncateLineMode', kind: 'select', default: 'middle', labelKey: 'outputTruncateLineMode', hintKey: 'outputTruncateLineModeHint', group: 'truncation', tool: 'bash', visibility: { requiresSelect: { field: 'outputTruncateStrategy', value: 'lines' } }, options: [
    { value: 'head', labelKey: 'optHead' },
    { value: 'tail', labelKey: 'optTail' },
    { value: 'middle', labelKey: 'optMiddle' },
  ] },
  { name: 'outputTruncateLineHeadLines', kind: 'number', default: 50, labelKey: 'outputTruncateLineHeadLines', hintKey: 'outputTruncateLineHeadLinesHint', group: 'truncation', tool: 'bash', visibility: { requiresSelect: { field: 'outputTruncateStrategy', value: 'lines' }, hideWhenSelect: { field: 'outputTruncateLineMode', value: 'tail' } } },
  { name: 'outputTruncateLineTailLines', kind: 'number', default: 100, labelKey: 'outputTruncateLineTailLines', hintKey: 'outputTruncateLineTailLinesHint', group: 'truncation', tool: 'bash', visibility: { requiresSelect: { field: 'outputTruncateStrategy', value: 'lines' }, hideWhenSelect: { field: 'outputTruncateLineMode', value: 'head' } } },
  // ---- Read: 读取基础（OMP readLineNumbers/read.defaultLimit/read.renderMarkdown） --
  { name: 'readDefaultLimit', kind: 'number', default: 300, labelKey: 'readDefaultLimit', hintKey: 'readDefaultLimitHint', group: 'reading', tool: 'read' },
  { name: 'readLineNumbers', kind: 'boolean', default: false, labelKey: 'readLineNumbers', hintKey: 'readLineNumbersHint', group: 'reading', tool: 'read' },
  { name: 'readRenderMarkdown', kind: 'boolean', default: false, labelKey: 'readRenderMarkdown', hintKey: 'readRenderMarkdownHint', group: 'reading', tool: 'read' },
  // ---- Read: 代码摘要（readSummarizeEnabled 主开关 + 从属字段） -------
  { name: 'readSummarizeEnabled', kind: 'boolean', default: true, labelKey: 'readSummarizeEnabled', hintKey: 'readSummarizeEnabledHint', group: 'summary', tool: 'read' },
  { name: 'readSummarizeProse', kind: 'boolean', default: false, labelKey: 'readSummarizeProse', hintKey: 'readSummarizeProseHint', group: 'summary', tool: 'read', visibility: { requiresEnabled: 'readSummarizeEnabled' } },
  { name: 'readSummarizeMinBodyLines', kind: 'number', default: 4, labelKey: 'readSummarizeMinBodyLines', hintKey: 'readSummarizeMinBodyLinesHint', group: 'summary', tool: 'read', visibility: { requiresEnabled: 'readSummarizeEnabled' } },
  { name: 'readSummarizeMinCommentLines', kind: 'number', default: 6, labelKey: 'readSummarizeMinCommentLines', hintKey: 'readSummarizeMinCommentLinesHint', group: 'summary', tool: 'read', visibility: { requiresEnabled: 'readSummarizeEnabled' } },
  { name: 'readSummarizeMinTotalLines', kind: 'number', default: 100, labelKey: 'readSummarizeMinTotalLines', hintKey: 'readSummarizeMinTotalLinesHint', group: 'summary', tool: 'read', visibility: { requiresEnabled: 'readSummarizeEnabled' } },
  { name: 'readSummarizeUnfoldUntil', kind: 'number', default: 50, labelKey: 'readSummarizeUnfoldUntil', hintKey: 'readSummarizeUnfoldUntilHint', group: 'summary', tool: 'read', visibility: { requiresEnabled: 'readSummarizeEnabled' } },
  { name: 'readSummarizeUnfoldLimit', kind: 'number', default: 100, labelKey: 'readSummarizeUnfoldLimit', hintKey: 'readSummarizeUnfoldLimitHint', group: 'summary', tool: 'read', visibility: { requiresEnabled: 'readSummarizeEnabled' } },
  // ---- Read: 抓取（fetchEnabled 主开关 + 超时联动） -------------------
  { name: 'fetchEnabled', kind: 'boolean', default: true, labelKey: 'fetchEnabled', hintKey: 'fetchEnabledHint', group: 'fetch', tool: 'read' },
  { name: 'fetchMaxTimeoutSeconds', kind: 'number', default: 0, labelKey: 'fetchMaxTimeoutSeconds', hintKey: 'fetchMaxTimeoutSecondsHint', group: 'fetch', tool: 'read', visibility: { requiresEnabled: 'fetchEnabled' } },
  // ---- Read: 图片（自动缩放 + 检查模式） ------------------------------
  { name: 'imagesAutoResize', kind: 'boolean', default: true, labelKey: 'imagesAutoResize', hintKey: 'imagesAutoResizeHint', group: 'images', tool: 'read' },
  { name: 'inspectImageMode', kind: 'select', default: 'auto', labelKey: 'inspectImageMode', hintKey: 'inspectImageModeHint', group: 'images', tool: 'read', options: [
    { value: 'auto', labelKey: 'optAuto' },
    { value: 'on', labelKey: 'optOn' },
    { value: 'off', labelKey: 'optOff' },
  ] },
  // ---- Write / Edit: 编辑模式（editMode 主控 + fuzzy/enforceSeen 关联）--
  { name: 'editMode', kind: 'select', default: 'replace', labelKey: 'editMode', hintKey: 'editModeHint', group: 'editMode', tool: 'writeEdit', options: [
    { value: 'replace', labelKey: 'optReplace' },
    { value: 'patch', labelKey: 'optPatch' },
    { value: 'hashline', labelKey: 'optHashline' },
    { value: 'apply_patch', labelKey: 'optApplyPatch' },
  ] },
  { name: 'editFuzzyMatch', kind: 'boolean', default: true, labelKey: 'editFuzzyMatch', hintKey: 'editFuzzyMatchHint', group: 'editMode', tool: 'writeEdit' },
  { name: 'editFuzzyThreshold', kind: 'number', default: 0.95, labelKey: 'editFuzzyThreshold', hintKey: 'editFuzzyThresholdHint', group: 'editMode', tool: 'writeEdit', visibility: { requiresEnabled: 'editFuzzyMatch' } },
  { name: 'editEnforceSeenLines', kind: 'boolean', default: false, labelKey: 'editEnforceSeenLines', hintKey: 'editEnforceSeenLinesHint', group: 'editMode', tool: 'writeEdit', visibility: { requiresSelect: { field: 'editMode', value: 'hashline' } } },
  // ---- Write / Edit: 文件守卫（全模式通用） ----------------------------
  { name: 'editBlockAutoGenerated', kind: 'boolean', default: true, labelKey: 'editBlockAutoGenerated', hintKey: 'editBlockAutoGeneratedHint', group: 'guard', tool: 'writeEdit' },
  // ---- Grep（grep.* 键） ----------------------------------------------
  { name: 'grepContextBefore', kind: 'number', default: 1, labelKey: 'grepContextBefore', hintKey: 'grepContextBeforeHint', group: 'grep', tool: 'grep' },
  { name: 'grepContextAfter', kind: 'number', default: 3, labelKey: 'grepContextAfter', hintKey: 'grepContextAfterHint', group: 'grep', tool: 'grep' },
  // ---- AST 工具启用开关（OMP settings-schema "Available Tools" 组） ----
  // astGrep.enabled 默认 false（OMP 原版：ast_grep 默认禁用，需手动开启）；
  // astEdit.enabled 默认 true。glob/grep 不设开关，默认开启（用户拍板 2026-08-25）。
  { name: 'astGrepEnabled', kind: 'boolean', default: false, labelKey: 'astGrepEnabled', hintKey: 'astGrepEnabledHint', group: 'ast', tool: 'astGrep' },
  { name: 'astEditEnabled', kind: 'boolean', default: true, labelKey: 'astEditEnabled', hintKey: 'astEditEnabledHint', group: 'ast', tool: 'astEdit' },
]

/** Tool tabs in nav order; empty `fields` = no configurable settings. */
export const TOOL_PLUS_TABS: readonly ToolPlusTab[] = [
  { id: 'bash', labelKey: 'tabBash', fields: TOOL_PLUS_FIELDS.filter(f => f.tool === 'bash').map(f => f.name) },
  { id: 'read', labelKey: 'tabRead', fields: TOOL_PLUS_FIELDS.filter(f => f.tool === 'read').map(f => f.name) },
  { id: 'writeEdit', labelKey: 'tabWriteEdit', fields: TOOL_PLUS_FIELDS.filter(f => f.tool === 'writeEdit').map(f => f.name) },
  { id: 'grep', labelKey: 'tabGrep', fields: TOOL_PLUS_FIELDS.filter(f => f.tool === 'grep').map(f => f.name) },
  { id: 'glob', labelKey: 'tabGlob', fields: [] },
  { id: 'astGrep', labelKey: 'tabAstGrep', fields: TOOL_PLUS_FIELDS.filter(f => f.tool === 'astGrep').map(f => f.name) },
  { id: 'astEdit', labelKey: 'tabAstEdit', fields: TOOL_PLUS_FIELDS.filter(f => f.tool === 'astEdit').map(f => f.name) },
  { id: 'readImage', labelKey: 'tabReadImage', fields: [] },
]

/** Look up one field definition by its schema key. */
export function toolPlusField(name: string): ToolPlusField | undefined {
  return TOOL_PLUS_FIELDS.find(field => field.name === name)
}

/** Fields of one tool tab, in table order. */
export function toolPlusFieldsOf(tool: ToolPlusToolId): readonly ToolPlusField[] {
  return TOOL_PLUS_FIELDS.filter(field => field.tool === tool)
}

/** Every schema key, for settings-schema parity tests. */
export const TOOL_PLUS_FIELD_NAMES: readonly string[] = TOOL_PLUS_FIELDS.map(field => field.name)
