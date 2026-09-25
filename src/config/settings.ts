/**
 * Plugin-owned settings surface for the ported bash tool: the `tool-plus`
 * namespace, a FLAT settings schema (OMP `bash*`-style scalar keys — the shared
 * client configuration form writes scalar fields only), its defaults, the
 * mapping onto the nested {@link RuntimeConfig} the runtime consumes, and the
 * optional-settings consumer wiring. Keeping the whole config-export surface
 * here lets the ported OMP runtime stay pristine — the entry only calls
 * {@link installBashPlusSettings} and re-exports this module's `Config`.
 * @module @xiaoso/dsh-tool-plus/settings
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: pulls the `ctx.settings` Context merge (SettingsProvider surface).
import type {} from '@deepseek-ai/dsh-settings'
import type { MinimizerConfig } from '../tools/bash/types.ts'
import { TOOL_PLUS_FIELDS, toolPlusField, type ToolPlusFieldValue } from './fields.ts'

/**
 * The Loader commits a settings write into this plugin's live config
 * references and announces the changed paths on the owning fiber
 * (`@deepseek-ai/cordis-plugin-loader` declares this event). The declaration
 * lives in the Loader package, which a business plugin does not depend on, so
 * the one event this module consumes is spelled here — copied verbatim from the
 * Loader's own declaration, so a future signature change fails loudly here
 * instead of silently missing the notification.
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Volatile config values were committed into the running fiber without a remount; dispatched to the owning fiber only.
     * @param paths - changed config paths as key arrays; every value is committed before dispatch.
     * @mode emit
     */
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

/**
 * Protocol key `@deepseek-ai/cosmokit` stamps on a live config reference.
 * `Symbol.for` keeps the check valid across copies of the shared library — the
 * reason cosmokit's own `isVolatile` resolves the same key.
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** Every field of this namespace is one of these scalars (or absent). */
type FieldValue = boolean | number | string | undefined

/**
 * Whether a parsed value is one of the Loader's live config references.
 *
 * `@deepseek-ai/cordis` re-exports the `Volatile` TYPE only, and cosmokit —
 * which owns the runtime check — is not a dependency of this package, so the
 * protocol is read here instead of imported.
 * @param value - a parsed config value.
 * @returns whether the value is a live reference.
 */
function isLiveField(value: unknown): value is Volatile<FieldValue> {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
}

/** Truncation strategy for background→foreground completion messages (OMP config parity). */
export type OutputTruncateStrategy = 'bytes' | 'lines'

/** Retention mode for a truncated completion message: head, tail, or middle (head+tail). */
export type OutputRetentionMode = 'head' | 'tail' | 'middle'

/** Byte-based retention settings; `middle` keeps head+tail, `head`/`tail` keep one window. */
export interface ByteRetentionConfig {
  mode: OutputRetentionMode
  headBytes: number
  tailBytes: number
}

/** Reader-backend preference for URL reads (`providers.fetch` parity). */
export type FetchReaderPreference =
  | 'auto' | 'native' | 'trafilatura' | 'lynx' | 'parallel' | 'jina' | 'browser'

/** Line-based retention settings, mirroring the byte-based structure. */
export interface LineRetentionConfig {
  mode: OutputRetentionMode
  headLines: number
  tailLines: number
}

/**
 * Background-job completion text truncation (mirrors the OMP `bashOutputTruncate*`
 * family). Only the settled preview text is affected; streaming reads and the
 * completion notice are untouched.
 */
export interface OutputTruncateConfig {
  strategy: OutputTruncateStrategy
  /** Threshold (in `strategy` units) below which the text is kept intact. */
  triggerBytes: number
  triggerLines: number
  bytes: ByteRetentionConfig
  lines: LineRetentionConfig
}

/**
 * The resolved runtime configuration, nested for the OMP runtime consumers.
 * {@link RuntimeConfig} is built from the flat {@link Config} by
 * {@link resolveConfig}; the OMP-ported runtime files never see the flat shape.
 */
export interface RuntimeConfig {
  enableRunInBackground: boolean
  autoBackgroundMs: number
  defaultTimeoutMs: number
  maxTimeoutMs: number
  outputMaxBytes: number
  outputSinkTailBytes: number
  outputSinkHeadBytes: number
  minimizer: MinimizerConfig
  interceptorEnabled: boolean
  nonInteractiveEnv: boolean
  snapshotEnabled: boolean
  rmSafe: boolean
  useShellCommandWrapper: boolean
  /**
   * Whether the browser half mounts this plugin's tool cards (the Node runtime
   * never reads it; it rides the resolved config so the field table, the schema,
   * and this projection stay a single source of truth).
   */
  webCards: boolean
  maxBackgroundJobs: number
  outputTruncate: OutputTruncateConfig
  // File tools (OMP parity)
  editBlockAutoGenerated: boolean
  editMode: string
  editFuzzyMatch: boolean
  editFuzzyThreshold: number
  editEnforceSeenLines: boolean
  readSummarizeEnabled: boolean
  readSummarizeProse: boolean
  readSummarizeMinBodyLines: number
  readSummarizeMinCommentLines: number
  readSummarizeMinTotalLines: number
  readSummarizeUnfoldUntil: number
  readSummarizeUnfoldLimit: number
  readDefaultLimit: number
  readLineNumbers: boolean
  readRenderMarkdown: boolean
  readConcurrentSafe: boolean
  grepContextBefore: number
  grepContextAfter: number
  grepCaseDefault: boolean
  grepGitignoreDefault: boolean
  globGitignoreDefault: boolean
  globHiddenDefault: boolean
  astGrepEnabled: boolean
  astEditEnabled: boolean
  fetchEnabled: boolean
  fetchMaxTimeoutSeconds: number
  fetchReader: FetchReaderPreference
  browserReaderEnabled: boolean
  imagesAutoResize: boolean
  imagesBlockImages: boolean
  imagesExcludeWebp: boolean
  imagesInputMaxBytes: number
  imagesResizeMaxSide: number
  imagesResizeMaxBytes: number
  imagesResizeMinSide: number
  imagesResizeJpegQuality: number
}

/** Settings namespace of this plugin, served to the web Plugins page. */
export const BASH_PLUS_SETTINGS_NS = 'tool-plus'

/** OMP-parity defaults for the completion-message truncation policy. */
export const DEFAULT_OUTPUT_TRUNCATE: OutputTruncateConfig = {
  strategy: 'bytes',
  triggerBytes: 10_240,
  triggerLines: 100,
  bytes: { mode: 'middle', headBytes: 4_096, tailBytes: 4_096 },
  lines: { mode: 'middle', headLines: 50, tailLines: 100 },
}

/**
 * Timing knobs (ms). DEFAULT_MAX_TIMEOUT_MS is OMP-parity (= upstream bash
 * per-tool max 3600s); DEFAULT_TIMEOUT_MS was deliberately relaxed from
 * 300_000 to 3_600_000 with the bash-plus settings card (763023e,
 * 2026-08-19) — NOT OMP-parity (OMP bash default is 300s), compensated by
 * auto-backgrounding after DEFAULT_AUTO_BACKGROUND_MS. By design there is no
 * upstream `tools.maxTimeout` global-cap equivalent: maxTimeoutMs always
 * applies. (second-impl-audit.md S-11 终局, 2026-08-29.)
 */
export const DEFAULT_TIMEOUT_MS = 3_600_000
export const DEFAULT_MAX_TIMEOUT_MS = 3_600_000
export const DEFAULT_AUTO_BACKGROUND_MS = 60_000
export const DEFAULT_MAX_BACKGROUND_JOBS = 15

/**
 * Plugin settings, one scalar key per option — every field is writable through
 * the shared client configuration form (`ctx.configForms.get('tool-plus')`
 * `.set`/`.unset`). Defaults live in the {@link Config} schema and in
 * {@link resolveConfig}.
 */
export interface Config {
  enableRunInBackground?: boolean
  autoBackgroundMs?: number
  defaultTimeoutMs?: number
  maxTimeoutMs?: number
  outputMaxBytes?: number
  outputSinkTailBytes?: number
  outputSinkHeadBytes?: number
  minimizerEnabled?: boolean
  interceptorEnabled?: boolean
  nonInteractiveEnv?: boolean
  snapshotEnabled?: boolean
  /** Redefine `rm` in the session shell to move into the system trash (default true). */
  rmSafe?: boolean
  useShellCommandWrapper?: boolean
  /** Mount this plugin's browser tool cards (default true; off returns to the shipped rows). */
  webCards?: boolean
  maxBackgroundJobs?: number
  outputTruncateStrategy?: OutputTruncateStrategy
  outputTruncateTriggerBytes?: number
  outputTruncateTriggerLines?: number
  outputTruncateByteMode?: OutputRetentionMode
  outputTruncateByteHeadBytes?: number
  outputTruncateByteTailBytes?: number
  outputTruncateLineMode?: OutputRetentionMode
  outputTruncateLineHeadLines?: number
  outputTruncateLineTailLines?: number
  // File tools (OMP `edit.blockAutoGenerated` / `read.summarize.*` parity)
  editBlockAutoGenerated?: boolean
  editMode?: 'replace' | 'patch' | 'hashline' | 'apply_patch'
  editFuzzyMatch?: boolean
  editFuzzyThreshold?: number
  editEnforceSeenLines?: boolean
  readSummarizeEnabled?: boolean
  readSummarizeProse?: boolean
  readSummarizeMinBodyLines?: number
  readSummarizeMinCommentLines?: number
  readSummarizeMinTotalLines?: number
  readSummarizeUnfoldUntil?: number
  readSummarizeUnfoldLimit?: number
  readDefaultLimit?: number
  readLineNumbers?: boolean
  readRenderMarkdown?: boolean
  readConcurrentSafe?: boolean
  grepContextBefore?: number
  grepContextAfter?: number
  grepCaseDefault?: boolean
  grepGitignoreDefault?: boolean
  globGitignoreDefault?: boolean
  globHiddenDefault?: boolean
  astGrepEnabled?: boolean
  astEditEnabled?: boolean
  fetchEnabled?: boolean
  fetchMaxTimeoutSeconds?: number
  fetchReader?: FetchReaderPreference
  browserReaderEnabled?: boolean
  imagesAutoResize?: boolean
  imagesBlockImages?: boolean
  imagesExcludeWebp?: boolean
  imagesInputMaxBytes?: number
  imagesResizeMaxSide?: number
  imagesResizeMaxBytes?: number
  imagesResizeMinSide?: number
  imagesResizeJpegQuality?: number
}

/** Schema default of one field, sourced from the single-source field table. */
function fieldDefault<T extends ToolPlusFieldValue>(name: string, fallback: T): T {
  const value = toolPlusField(name)?.default
  return (value === undefined ? fallback : value) as T
}

/**
 * Runtime configuration schema for the plugin, in the dsh 0.1.7 settings shape:
 * EVERY field is declared `.volatile()`, because a settings namespace is the
 * plugin's own entry and `SettingsForms.describe()` serves exactly the fields
 * whose schema declares them live. {@link resolveConfig} maps the flat surface
 * onto {@link RuntimeConfig}.
 *
 * The annotation is deliberately inferred rather than written as `z<Config>`:
 * the schema's parsed output is {@link LiveConfig} (one stable reference per
 * field), while {@link Config} stays the plain settings DOCUMENT the browser
 * edits and the specs pass in.
 */
export const Config = z.object({
  enableRunInBackground: z.boolean().default(fieldDefault('enableRunInBackground', true)).volatile(),
  autoBackgroundMs: z.number().default(fieldDefault('autoBackgroundMs', DEFAULT_AUTO_BACKGROUND_MS)).volatile(),
  defaultTimeoutMs: z.number().default(fieldDefault('defaultTimeoutMs', DEFAULT_TIMEOUT_MS)).volatile(),
  maxTimeoutMs: z.number().default(fieldDefault('maxTimeoutMs', DEFAULT_MAX_TIMEOUT_MS)).volatile(),
  outputMaxBytes: z.number().default(fieldDefault('outputMaxBytes', 51_200)).volatile(),
  outputSinkTailBytes: z.number().default(fieldDefault('outputSinkTailBytes', 51_200)).volatile(),
  outputSinkHeadBytes: z.number().default(fieldDefault('outputSinkHeadBytes', 20_480)).volatile(),
  minimizerEnabled: z.boolean().default(fieldDefault('minimizerEnabled', true)).volatile(),
  interceptorEnabled: z.boolean().default(fieldDefault('interceptorEnabled', true)).volatile(),
  nonInteractiveEnv: z.boolean().default(fieldDefault('nonInteractiveEnv', true)).volatile(),
  snapshotEnabled: z.boolean().default(fieldDefault('snapshotEnabled', true)).volatile(),
  rmSafe: z.boolean().default(fieldDefault('rmSafe', true)).volatile(),
  useShellCommandWrapper: z.boolean().default(fieldDefault('useShellCommandWrapper', false)).volatile(),
  webCards: z.boolean().default(fieldDefault('webCards', true)).volatile(),
  maxBackgroundJobs: z.number().default(fieldDefault('maxBackgroundJobs', DEFAULT_MAX_BACKGROUND_JOBS)).volatile(),
  outputTruncateStrategy: z.union(['bytes', 'lines'] as const).default(fieldDefault('outputTruncateStrategy', 'bytes')).volatile(),
  outputTruncateTriggerBytes: z.number().default(fieldDefault('outputTruncateTriggerBytes', 10_240)).volatile(),
  outputTruncateTriggerLines: z.number().default(fieldDefault('outputTruncateTriggerLines', 100)).volatile(),
  outputTruncateByteMode: z.union(['head', 'tail', 'middle'] as const).default(fieldDefault('outputTruncateByteMode', 'middle')).volatile(),
  outputTruncateByteHeadBytes: z.number().default(fieldDefault('outputTruncateByteHeadBytes', 4_096)).volatile(),
  outputTruncateByteTailBytes: z.number().default(fieldDefault('outputTruncateByteTailBytes', 4_096)).volatile(),
  outputTruncateLineMode: z.union(['head', 'tail', 'middle'] as const).default(fieldDefault('outputTruncateLineMode', 'middle')).volatile(),
  outputTruncateLineHeadLines: z.number().default(fieldDefault('outputTruncateLineHeadLines', 50)).volatile(),
  outputTruncateLineTailLines: z.number().default(fieldDefault('outputTruncateLineTailLines', 100)).volatile(),
  // File tools — OMP defaults (settings-schema.ts:3228/3290ff)
  editBlockAutoGenerated: z.boolean().default(fieldDefault('editBlockAutoGenerated', true)).volatile(),
  readSummarizeEnabled: z.boolean().default(fieldDefault('readSummarizeEnabled', true)).volatile(),
  readSummarizeProse: z.boolean().default(fieldDefault('readSummarizeProse', false)).volatile(),
  readSummarizeMinBodyLines: z.number().default(fieldDefault('readSummarizeMinBodyLines', 4)).volatile(),
  readSummarizeMinCommentLines: z.number().default(fieldDefault('readSummarizeMinCommentLines', 6)).volatile(),
  readSummarizeMinTotalLines: z.number().default(fieldDefault('readSummarizeMinTotalLines', 100)).volatile(),
  readSummarizeUnfoldUntil: z.number().default(fieldDefault('readSummarizeUnfoldUntil', 50)).volatile(),
  readSummarizeUnfoldLimit: z.number().default(fieldDefault('readSummarizeUnfoldLimit', 100)).volatile(),
  // File tools — OMP 其余键（edit.mode/fuzzy/grep.* 等）
  editMode: z.union(['replace', 'patch', 'hashline', 'apply_patch'] as const).default(fieldDefault('editMode', 'replace')).volatile(),
  editFuzzyMatch: z.boolean().default(fieldDefault('editFuzzyMatch', true)).volatile(),
  editFuzzyThreshold: z.number().default(fieldDefault('editFuzzyThreshold', 0.95)).volatile(),
  editEnforceSeenLines: z.boolean().default(fieldDefault('editEnforceSeenLines', false)).volatile(),
  readDefaultLimit: z.number().default(fieldDefault('readDefaultLimit', 300)).volatile(),
  readLineNumbers: z.boolean().default(fieldDefault('readLineNumbers', false)).volatile(),
  readRenderMarkdown: z.boolean().default(fieldDefault('readRenderMarkdown', false)).volatile(),
  readConcurrentSafe: z.boolean().default(fieldDefault('readConcurrentSafe', true)).volatile(),
  grepContextBefore: z.number().default(fieldDefault('grepContextBefore', 1)).volatile(),
  grepContextAfter: z.number().default(fieldDefault('grepContextAfter', 3)).volatile(),
  // 搜索默认值开关（grep/glob 未显式传参时的默认；默认=上游硬编码 true）
  grepCaseDefault: z.boolean().default(fieldDefault('grepCaseDefault', true)).volatile(),
  grepGitignoreDefault: z.boolean().default(fieldDefault('grepGitignoreDefault', true)).volatile(),
  globGitignoreDefault: z.boolean().default(fieldDefault('globGitignoreDefault', true)).volatile(),
  globHiddenDefault: z.boolean().default(fieldDefault('globHiddenDefault', true)).volatile(),
  // AST 工具启用开关（OMP settings-schema.ts:3831/3842；astGrep 默认 false）
  astGrepEnabled: z.boolean().default(fieldDefault('astGrepEnabled', false)).volatile(),
  astEditEnabled: z.boolean().default(fieldDefault('astEditEnabled', true)).volatile(),
  // File tools — fetch（URL 抓取）与图片（拍板#22：read 图片路径已还原并入）
  fetchEnabled: z.boolean().default(fieldDefault('fetchEnabled', true)).volatile(),
  fetchMaxTimeoutSeconds: z.number().default(fieldDefault('fetchMaxTimeoutSeconds', 0)).volatile(),
  fetchReader: z.union(['auto', 'native', 'trafilatura', 'lynx', 'parallel', 'jina', 'browser'] as const).default(fieldDefault('fetchReader', 'auto')).volatile(),
  browserReaderEnabled: z.boolean().default(fieldDefault('browserReaderEnabled', true)).volatile(),
  imagesAutoResize: z.boolean().default(fieldDefault('imagesAutoResize', true)).volatile(),
  imagesBlockImages: z.boolean().default(fieldDefault('imagesBlockImages', false)).volatile(),
  imagesExcludeWebp: z.boolean().default(fieldDefault('imagesExcludeWebp', false)).volatile(),
  imagesInputMaxBytes: z.number().default(fieldDefault('imagesInputMaxBytes', 20 * 1024 * 1024)).volatile(),
  imagesResizeMaxSide: z.number().default(fieldDefault('imagesResizeMaxSide', 1568)).volatile(),
  imagesResizeMaxBytes: z.number().default(fieldDefault('imagesResizeMaxBytes', 500 * 1024)).volatile(),
  imagesResizeMinSide: z.number().default(fieldDefault('imagesResizeMinSide', 200)).volatile(),
  imagesResizeJpegQuality: z.number().default(fieldDefault('imagesResizeJpegQuality', 80)).volatile(),
})

/**
 * Live entry config: what the Loader hands `apply` for this entry, and what
 * {@link installBashPlusSettings} re-reads after a settings write commits. One
 * stable reference per schema field — read it through `.get()`, never as a
 * plain value.
 */
export type LiveConfig = ReturnType<typeof Config>

/**
 * Unwrap the Loader's live field references into a plain settings document.
 * @param input - the entry's live config, or an already-plain document.
 * @returns a plain copy carrying the fields the input has.
 */
function plainFields(input: Config | LiveConfig): Config {
  const out: Config = {}
  for (const [field, value] of Object.entries(input)) {
    Object.assign(out, { [field]: isLiveField(value) ? value.get() : value })
  }
  return out
}

/**
 * Resolve the flat settings (composition entry or the settings document) to
 * the nested runtime config the ported OMP runtime consumes. A direct mount
 * (`ctx.plugin`) skips the Loader's schema parse, so the `?? default` pass
 * mirrors the schema; the settings namespace resolution rides the same path.
 * Accepts both shapes a caller can hold: the Loader's live entry config (one
 * reference per field) and a plain settings document.
 * @param input - the entry's live config, or a plain (possibly partial) document.
 * @returns the fully-defaulted nested runtime config.
 */
export function resolveConfig(input: Config | LiveConfig): RuntimeConfig {
  // Every field of the live config is a stable reference; unwrap once so the
  // `?? default` pass below reads plain values for both shapes.
  const config = plainFields(input)
  const resolveMinimizer = (): MinimizerConfig => ({
    enabled: config.minimizerEnabled ?? fieldDefault('minimizerEnabled', true),
    only: [],
    except: [],
    maxCaptureBytes: 512 * 1024,
  })
  return {
    enableRunInBackground: config.enableRunInBackground ?? fieldDefault('enableRunInBackground', true),
    autoBackgroundMs: config.autoBackgroundMs ?? fieldDefault('autoBackgroundMs', DEFAULT_AUTO_BACKGROUND_MS),
    defaultTimeoutMs: config.defaultTimeoutMs ?? fieldDefault('defaultTimeoutMs', DEFAULT_TIMEOUT_MS),
    maxTimeoutMs: config.maxTimeoutMs ?? fieldDefault('maxTimeoutMs', DEFAULT_MAX_TIMEOUT_MS),
    outputMaxBytes: config.outputMaxBytes ?? fieldDefault('outputMaxBytes', 51_200),
    outputSinkTailBytes: config.outputSinkTailBytes ?? fieldDefault('outputSinkTailBytes', 51_200),
    outputSinkHeadBytes: config.outputSinkHeadBytes ?? fieldDefault('outputSinkHeadBytes', 20_480),
    minimizer: resolveMinimizer(),
    interceptorEnabled: config.interceptorEnabled ?? fieldDefault('interceptorEnabled', true),
    nonInteractiveEnv: config.nonInteractiveEnv ?? fieldDefault('nonInteractiveEnv', true),
    snapshotEnabled: config.snapshotEnabled ?? fieldDefault('snapshotEnabled', true),
    rmSafe: config.rmSafe ?? fieldDefault('rmSafe', true),
    useShellCommandWrapper: config.useShellCommandWrapper ?? fieldDefault('useShellCommandWrapper', false),
    webCards: config.webCards ?? fieldDefault('webCards', true),
    maxBackgroundJobs: config.maxBackgroundJobs ?? fieldDefault('maxBackgroundJobs', DEFAULT_MAX_BACKGROUND_JOBS),
    outputTruncate: {
      strategy: config.outputTruncateStrategy ?? fieldDefault('outputTruncateStrategy', DEFAULT_OUTPUT_TRUNCATE.strategy),
      triggerBytes: config.outputTruncateTriggerBytes ?? fieldDefault('outputTruncateTriggerBytes', DEFAULT_OUTPUT_TRUNCATE.triggerBytes),
      triggerLines: config.outputTruncateTriggerLines ?? fieldDefault('outputTruncateTriggerLines', DEFAULT_OUTPUT_TRUNCATE.triggerLines),
      bytes: {
        mode: config.outputTruncateByteMode ?? fieldDefault('outputTruncateByteMode', DEFAULT_OUTPUT_TRUNCATE.bytes.mode),
        headBytes: config.outputTruncateByteHeadBytes ?? fieldDefault('outputTruncateByteHeadBytes', DEFAULT_OUTPUT_TRUNCATE.bytes.headBytes),
        tailBytes: config.outputTruncateByteTailBytes ?? fieldDefault('outputTruncateByteTailBytes', DEFAULT_OUTPUT_TRUNCATE.bytes.tailBytes),
      },
      lines: {
        mode: config.outputTruncateLineMode ?? fieldDefault('outputTruncateLineMode', DEFAULT_OUTPUT_TRUNCATE.lines.mode),
        headLines: config.outputTruncateLineHeadLines ?? fieldDefault('outputTruncateLineHeadLines', DEFAULT_OUTPUT_TRUNCATE.lines.headLines),
        tailLines: config.outputTruncateLineTailLines ?? fieldDefault('outputTruncateLineTailLines', DEFAULT_OUTPUT_TRUNCATE.lines.tailLines),
      },
    },
    editBlockAutoGenerated: config.editBlockAutoGenerated ?? fieldDefault('editBlockAutoGenerated', true),
    readSummarizeEnabled: config.readSummarizeEnabled ?? fieldDefault('readSummarizeEnabled', true),
    readSummarizeProse: config.readSummarizeProse ?? fieldDefault('readSummarizeProse', false),
    readSummarizeMinBodyLines: config.readSummarizeMinBodyLines ?? fieldDefault('readSummarizeMinBodyLines', 4),
    readSummarizeMinCommentLines: config.readSummarizeMinCommentLines ?? fieldDefault('readSummarizeMinCommentLines', 6),
    readSummarizeMinTotalLines: config.readSummarizeMinTotalLines ?? fieldDefault('readSummarizeMinTotalLines', 100),
    readSummarizeUnfoldUntil: config.readSummarizeUnfoldUntil ?? fieldDefault('readSummarizeUnfoldUntil', 50),
    readSummarizeUnfoldLimit: config.readSummarizeUnfoldLimit ?? fieldDefault('readSummarizeUnfoldLimit', 100),
    editMode: config.editMode ?? fieldDefault('editMode', 'replace'),
    editFuzzyMatch: config.editFuzzyMatch ?? fieldDefault('editFuzzyMatch', true),
    editFuzzyThreshold: config.editFuzzyThreshold ?? fieldDefault('editFuzzyThreshold', 0.95),
    editEnforceSeenLines: config.editEnforceSeenLines ?? fieldDefault('editEnforceSeenLines', false),
    readDefaultLimit: config.readDefaultLimit ?? fieldDefault('readDefaultLimit', 300),
    readLineNumbers: config.readLineNumbers ?? fieldDefault('readLineNumbers', false),
    readRenderMarkdown: config.readRenderMarkdown ?? fieldDefault('readRenderMarkdown', false),
    readConcurrentSafe: config.readConcurrentSafe ?? fieldDefault('readConcurrentSafe', true),
    grepContextBefore: config.grepContextBefore ?? fieldDefault('grepContextBefore', 1),
    grepContextAfter: config.grepContextAfter ?? fieldDefault('grepContextAfter', 3),
    grepCaseDefault: config.grepCaseDefault ?? fieldDefault('grepCaseDefault', true),
    grepGitignoreDefault: config.grepGitignoreDefault ?? fieldDefault('grepGitignoreDefault', true),
    globGitignoreDefault: config.globGitignoreDefault ?? fieldDefault('globGitignoreDefault', true),
    globHiddenDefault: config.globHiddenDefault ?? fieldDefault('globHiddenDefault', true),
    astGrepEnabled: config.astGrepEnabled ?? fieldDefault('astGrepEnabled', false),
    astEditEnabled: config.astEditEnabled ?? fieldDefault('astEditEnabled', true),
    fetchEnabled: config.fetchEnabled ?? fieldDefault('fetchEnabled', true),
    fetchMaxTimeoutSeconds: config.fetchMaxTimeoutSeconds ?? fieldDefault('fetchMaxTimeoutSeconds', 0),
    fetchReader: config.fetchReader ?? fieldDefault('fetchReader', 'auto'),
    browserReaderEnabled: config.browserReaderEnabled ?? fieldDefault('browserReaderEnabled', true),
    imagesAutoResize: config.imagesAutoResize ?? fieldDefault('imagesAutoResize', true),
    imagesBlockImages: config.imagesBlockImages ?? fieldDefault('imagesBlockImages', false),
    imagesExcludeWebp: config.imagesExcludeWebp ?? fieldDefault('imagesExcludeWebp', false),
    imagesInputMaxBytes: config.imagesInputMaxBytes ?? fieldDefault('imagesInputMaxBytes', 20 * 1024 * 1024),
    imagesResizeMaxSide: config.imagesResizeMaxSide ?? fieldDefault('imagesResizeMaxSide', 1568),
    imagesResizeMaxBytes: config.imagesResizeMaxBytes ?? fieldDefault('imagesResizeMaxBytes', 500 * 1024),
    imagesResizeMinSide: config.imagesResizeMinSide ?? fieldDefault('imagesResizeMinSide', 200),
    imagesResizeJpegQuality: config.imagesResizeJpegQuality ?? fieldDefault('imagesResizeJpegQuality', 80),
  }
}

/**
 * Install the optional-settings consumer wiring for this plugin, in the dsh
 * 0.1.7 shape.
 *
 * 0.1.7 deleted the namespace-registration API (`SettingsForms` no longer has
 * `installSection`): a settings namespace is not something a plugin installs
 * any more — it IS the plugin's own profile entry, and the service serves
 * exactly the Config fields whose schema declares them live
 * ({@link Config} declares every field `.volatile()`). The plugin therefore
 * keeps one authoritative source, its own entry config:
 *
 *  - the Loader merges the composition layers and the profile override before
 *    `apply` runs, so the entry already carries the effective settings;
 *  - a settings write is committed INTO that entry's live references without a
 *    remount, and the Loader then announces the changed paths on this fiber
 *    (`loader/volatile-update`) — which is the signal for refreshing
 *    registration facts (the `editMode`-sensitive descriptions and the AST
 *    switches), exactly as the settings docs prescribe.
 *
 * The plugin ships its own settings pages in the browser half, so it owns its
 * page policy: `configure({ auto: false })` tells the settings service not to
 * auto-generate a schema page for this entry. That call rides an optional
 * `ctx.inject(['settings'], ...)` child, so the plugin runs unchanged in a
 * deployment that composes no settings service at all.
 *
 * Mirrors the official bash-local pattern (`packages/shell/bash-local`): the
 * business plugin reads its own Config references and registers only its page
 * policy; nothing re-registers the namespace.
 * @param ctx - plugin context owning the wiring.
 * @param entry - the entry's config as the Loader resolved it (live references
 * over the composition layers and the profile override), or a plain document.
 * @param onSource - receives a thunk of the currently authoritative runtime config.
 */
export function installBashPlusSettings(
  ctx: Context,
  entry: Config | LiveConfig,
  onSource: (current: () => RuntimeConfig) => void,
): void {
  // The entry's references already carry composition + profile override, so the
  // same thunk serves the first resolution and every later one.
  const current = (): RuntimeConfig => resolveConfig(entry)
  onSource(current)
  // A committed settings write is folded into those references in place; the
  // Loader dispatches this to the owning fiber only, so re-derive from the very
  // same references the write just updated.
  ctx.on('loader/volatile-update', () => { onSource(current) })
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(
      () => settingsCtx.settings.configure({ auto: false }, ctx.fiber),
      'tool-plus: own settings pages',
    )
  })
}
