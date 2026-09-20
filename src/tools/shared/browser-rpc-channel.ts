/**
 * Shared RPC channel constants for the browser-detection round trip between
 * the settings panel (client half) and the host. Both halves import this
 * module so the channel/endpoint never drift.
 *
 * The channel rides the official `@deepseek-ai/dsh-client-connection` generic
 * RPC transport (host registers with `ctx.connection.rpc.handle`; the client
 * calls via `createWebConnectionRpc().call`). Channel names must match
 * `/^\/[A-Za-z0-9._~-]+$/` and `/api` is reserved — `/tool-plus` is ours.
 * @module @xiaoso/dsh-tool-plus/browser-rpc-channel
 */

/** Logical RPC channel registered by the host half of this plugin. */
export const TOOL_PLUS_RPC_CHANNEL = '/tool-plus'

/** Endpoint that probes the machine for usable browsers (probeBrowsers). */
export const BROWSER_DETECT_ENDPOINT = 'browser/detect'

/** Endpoint that reports the rmSafe injection status (query = ensure + verify). */
export const RM_SAFE_STATUS_ENDPOINT = 'rmSafe/status'

/** Payload of a browser/detect call (currently empty). */
export interface BrowserDetectPayload {}

/** One detected browser as surfaced over the wire. */
export interface BrowserDetectItem {
  kind: 'edge' | 'chrome' | 'chromium' | 'cfr' | 'env'
  name: string
  path: string
}

/** Successful browser/detect result. */
export interface BrowserDetectValue {
  found: BrowserDetectItem[]
}

/** rmSafe/status result (mirrors RmSafeStatus from bash/rm-safe-status). */
export type RmSafeStatusValue =
  | { status: 'disabled' }
  | { status: 'failed'; reason: 'snapshot-unavailable' | 'cli-missing' | 'snapshot-write-failed' | 'runtime-not-effective' }
  | { status: 'injected'; runtime: 'function' | 'system' | 'unknown' }

/** Endpoint that lists agent presets with their status (roster + conflicts + template diff). */
export const PRESET_STATUS_ENDPOINT = 'presets/status'

/**
 * The preset ids this plugin ships a template for. Single source of truth for
 * both halves: the host uses it for the startup bootstrap and the template
 * lookup, the panel uses it to synthesize the "not installed" rows for a
 * deployment whose roster does not carry them yet.
 */
export const BUNDLED_PRESET_IDS: readonly string[] = ['tool-plus-standard', 'tool-plus-ptc']

/** Endpoint that applies one preset action to a user-root preset. */
export const PRESET_ACTION_ENDPOINT = 'presets/apply'

/** Endpoint that compares one preset against one of our templates (read-only). */
export const PRESET_COMPARE_ENDPOINT = 'presets/compare'

/** One preset action the settings panel may ask for. */
export type PresetActionValue = 'upgrade' | 'reset'

/** Payload of a presets/apply call. */
export interface PresetActionPayload {
  /** Preset id (a directory name under the user preset root, or a roster id). */
  id: string
  /** `upgrade` disables conflicting rows only; `reset` overwrites from our template. */
  action: PresetActionValue
  /**
   * Which of our templates `reset` should align this preset to. Absent means
   * "the template with the same id" (historical behaviour); the panel always
   * sends the template the user picked in the compare picker, so a preset can
   * be aligned to a different template than its own.
   */
  templateId?: string
}

/** Which layer a preset comes from: our shipped templates, the user root, or the shipped set. */
export type PresetSourceValue = 'ours' | 'user' | 'shipped'

/** One preset change produced by a rewrite. */
export interface PresetChangeValue {
  /** The official tool row id that was handled. */
  id: string
  /** `disabled` = row had no switch and got one; `flipped` = `disabled: false` -> true; `absent` = nothing to do. */
  action: 'disabled' | 'flipped' | 'absent'
}

/** One agent preset as surfaced to the settings panel. */
export interface PresetStatusValue {
  id: string
  name?: string
  description?: string
  source: PresetSourceValue
  path: string
  /** Official tool rows this preset still mounts (empty = nothing to disable). */
  conflicts: string[]
  clean: boolean
  /** Composition could not be parsed as a top-level row list — never rewritten. */
  unrecognized: boolean
  broken?: string
  /** Whether the preset directory exists in the writable user root. */
  installed: boolean
  /** Whether our package ships a template for this id. */
  templatePresent: boolean
  /** For template-backed presets: whether the local copy differs from the template. */
  templateDiffers: boolean
  /**
   * For template-backed presets: *what* differs (so the panel can say it instead
   * of the bare "differs", which reads as contradictory next to "nothing to
   * adjust"). Absent when there is nothing to compare.
   */
  templateDelta?: PresetDeltaValue
}

/** One concrete difference between the local copy and the bundled template. */
export interface PresetDeltaItemValue {
  kind: 'changed' | 'only-yours' | 'only-template' | 'row-only-yours' | 'row-only-template'
  /** Top-level row id. */
  row: string
  /** Dotted path inside that row (e.g. `config.thresholdRatio`); empty for a row-level difference. */
  path: string
  /** Value in the local copy (`only-template` / `row-only-template` omit it). */
  yours?: string
  /** Value in the template (`only-yours` / `row-only-yours` omit it). */
  template?: string
}

/** Concrete local-vs-template differences; `items` is capped, `total` is not. */
export interface PresetDeltaValue {
  items: PresetDeltaItemValue[]
  total: number
  /** Full-population counts per group: your own edits vs the template being ahead. */
  yoursCount: number
  behindCount: number
}

/**
 * Whether one difference belongs to the "yours" group (you added or changed it)
 * rather than the "behind" group (the template has it, you do not). Lives in the
 * shared contract so host and client group the exact same way.
 * @param kind - The difference kind.
 * @returns True for the "yours" group.
 */
export function isYoursDelta(kind: PresetDeltaItemValue['kind']): boolean {
  return kind === 'changed' || kind === 'only-yours' || kind === 'row-only-yours'
}

/** One template we ship, as the panel's "compare with" picker needs it. */
export interface PresetTemplateValue {
  id: string
  name?: string
}

/** presets/compare request. */
export interface PresetComparePayloadValue {
  /** The preset being inspected (any roster id). */
  presetId: string
  /** The template we ship to compare it against. */
  templateId: string
}

/**
 * presets/compare result: the full, uncapped comparison between one preset and
 * one of our templates. `conflicts` answers "are our tools wired in", `items`
 * answers "how else does the content differ" (and is what the diff dialog shows).
 */
export interface PresetCompareValue {
  presetId: string
  templateId: string
  /** `unreadable` when either side cannot be read/parsed — nothing to compare. */
  status: 'ok' | 'unreadable'
  /** Official tool rows still mounted (empty = the plugin's tools are wired in). */
  conflicts: string[]
  /** Content is structurally identical (comments/formatting ignored). */
  identical: boolean
  /** Full-population counts: your own edits vs the template being ahead. */
  yoursCount: number
  behindCount: number
  /** Every difference, uncapped (the dialog scrolls). */
  items: PresetDeltaItemValue[]
}

/** presets/status result. */
export interface PresetStatusListValue {
  presets: PresetStatusValue[]
  /** Templates this package ships (the "compare with" picker's options). */
  templates: PresetTemplateValue[]
}

/** presets/apply result (mirrors PresetInstallResult from presets/install). */
export interface PresetActionResultValue {
  ok: boolean
  changed: boolean
  reason?: string
  backupPath?: string
  changes: PresetChangeValue[]
}
