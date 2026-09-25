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
 * The preset ids this plugin **declares**. Single source of truth for both
 * halves: the host picks its own declarations out of the profile's composed
 * configuration, and the panel uses the list to tell "ours" from everything else.
 *
 * They ship as `@deepseek-ai/dsh-agent-preset` declaration rows in this
 * package's own bundle patches (`presets/<id>.patch.yml`), so installing the
 * plugin as a profile bundle declares them: no install step, no file copy, and
 * nothing written at startup.
 */
export const BUNDLED_PRESET_IDS: readonly string[] = ['tool-plus-standard', 'tool-plus-ptc']

/** Endpoint that applies one preset action to the active profile. */
export const PRESET_ACTION_ENDPOINT = 'presets/apply'

/** Endpoint that compares one preset against one of our declarations (read-only). */
export const PRESET_COMPARE_ENDPOINT = 'presets/compare'

/**
 * Loader row id a preset declaration is addressed by. A profile patch overrides
 * a declaration **by this id** — the harness's config editor locates the row by
 * id, and the override replaces the row's whole `config`.
 * @param presetId - The preset identity (the declaration's `config.id`).
 * @returns The row id as it appears in profile patches.
 */
export function profileRowId(presetId: string): string {
  return `preset-${presetId}`
}

/** One preset action the settings panel may ask for. */
export type PresetActionValue = 'upgrade' | 'align' | 'revert'

/** Payload of a presets/apply call. */
export interface PresetActionPayload {
  /** The preset to act on. */
  id: string
  /**
   * `upgrade` disables the still-mounted official tool rows and nothing else;
   * `align` replaces the whole plugin list with one of our declarations;
   * `revert` removes the profile override so the row falls back to its bundled
   * declaration.
   */
  action: PresetActionValue
  /** Required for `align`: which of our declarations to align this preset to. */
  templateId?: string
}

/**
 * Where a preset comes from. dsh 0.1.7 dropped the registry's `trust` and `path`
 * fields, so the only distinction left is "this plugin declared it" versus
 * "something else did" (the shipped set, or another user-installed bundle).
 */
export type PresetSourceValue = 'ours' | 'other'

/** One preset change produced by an upgrade. */
export interface PresetChangeValue {
  /** The official tool row id that was handled. */
  id: string
  /** `disabled` = the row had no switch and got one; `flipped` = an existing value became `true`. */
  action: 'disabled' | 'flipped'
}

/** One agent preset as surfaced to the settings panel. */
export interface PresetStatusValue {
  id: string
  /** Loader row id in the profile patch (`preset-<id>`); absent when this profile has no such row. */
  entryId?: string
  name?: string
  description?: string
  source: PresetSourceValue
  /** Whether a session naming no preset composes this one. */
  isDefault: boolean
  /** Official tool rows this preset still mounts enabled (empty = nothing to disable). */
  conflicts: string[]
  clean: boolean
  /** The plugin list is not a readable row list — never rewritten. */
  unrecognized: boolean
  /** Why the registry cannot mount this preset, when it reported one. */
  broken?: string
  /** The user wrote an override for this row in the profile patch. */
  customized: boolean
  /** For our own presets: whether the effective content differs from the bundled declaration. */
  templateDiffers: boolean
  /**
   * For our own presets: *what* differs (so the panel can say it instead of the
   * bare "differs", which reads as contradictory next to "nothing to adjust").
   * Absent when there is nothing to compare.
   */
  templateDelta?: PresetDeltaValue
  /** Rows in the effective plugin list, group children included (scale hint). */
  rowCount: number
}

/** One concrete difference between a preset's effective content and a template. */
export interface PresetDeltaItemValue {
  kind: 'changed' | 'only-yours' | 'only-template' | 'row-only-yours' | 'row-only-template'
  /**
   * Row path: a top-level row id (`tool-web`), or a group child
   * (`delegation/tool-ralph`). A bare id would point at the wrong row when a
   * nested row shares its id.
   */
  row: string
  /** Dotted path inside that row (e.g. `config.thresholdRatio`); empty for a row-level difference. */
  path: string
  /** Value in the preset's effective content (`only-template` / `row-only-template` omit it). */
  yours?: string
  /** Value in the template (`only-yours` / `row-only-yours` omit it). */
  template?: string
}

/** Concrete preset-vs-template differences; `items` is capped, `total` is not. */
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

/** One declaration we ship, as the panel's "compare with" picker needs it. */
export interface PresetTemplateValue {
  id: string
  name?: string
}

/** presets/compare request. */
export interface PresetComparePayloadValue {
  /** The preset being inspected (any preset in the roster). */
  presetId: string
  /** The declaration we ship to compare it against. */
  templateId: string
}

/**
 * presets/compare result: the full, uncapped comparison between one preset and
 * one of our declarations. `conflicts` answers "are our tools wired in", `items`
 * answers "how else does the content differ" (and is what the diff dialog shows).
 */
export interface PresetCompareValue {
  presetId: string
  templateId: string
  /** `unreadable` when either side cannot be resolved — nothing to compare. */
  status: 'ok' | 'unreadable'
  /** Official tool rows still mounted (empty = the plugin's tools are wired in). */
  conflicts: string[]
  /** Content is structurally identical (row order and formatting ignored). */
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
  /** Declarations this package ships (the "compare with" picker's options). */
  templates: PresetTemplateValue[]
  /**
   * Whether this deployment has an editable profile at all (`ctx.configEditor`
   * is present). Without it the panel can still show state but cannot write.
   */
  writable: boolean
  /**
   * Absolute path of a legacy `$DSH_HOME/.agent-presets` directory, present only
   * when one still exists and is non-empty. dsh 0.1.7 reads no such directory —
   * it is a cleanup hint for users upgrading from the directory mechanism, not a
   * feature of this deployment.
   */
  legacyPresetRoot?: string
}

/** presets/apply result. */
export interface PresetActionResultValue {
  ok: boolean
  changed: boolean
  /** Why nothing was written, or why the write failed (one line for the panel). */
  reason?: string
  /**
   * The `<profile patch>.bak-<version>` copy taken before this write, when the
   * patch already existed. One backup per profile, written once and never
   * overwritten, so it always holds the earliest pre-change state.
   */
  backupPath?: string
  changes: PresetChangeValue[]
}
