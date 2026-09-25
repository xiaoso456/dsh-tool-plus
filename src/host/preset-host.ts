/**
 * Host half of the preset surface: read the deployment's declared presets and
 * apply the panel's three actions through the harness's own config editor.
 *
 * WHY WE DO NOT WRITE FILES OURSELVES: dsh 0.1.7 removed the directory preset
 * mechanism and the `agent_preset` tool with it. The only supported programmatic
 * write path is `ctx.configEditor.edit()`, and it is a better one than we had —
 * it takes the profile lock, serializes with HMR, validates the next config
 * through the Loader's own waterfall, writes atomically, rolls back on a failed
 * reconcile, and refuses when a home patch or `--patch` overlay would defeat the
 * edit. It also gives us "revert to the bundled declaration" for free: handing
 * back the inherited config makes it delete the override's `config` key.
 *
 * The service is resolved per call, so a deployment that mounts the editor
 * after this plugin still works instead of caching an early `undefined`.
 *
 * Everything here is a thin adapter; the decisions live in `src/presets/**`
 * (pure, fs-free, unit-testable) and this module only resolves services and
 * shapes results.
 * @module @xiaoso/dsh-tool-plus/host/preset-host
 */

import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUNDLED_PRESET_IDS,
  profileRowId,
  type PresetActionResultValue,
  type PresetCompareValue,
  type PresetStatusListValue,
} from '../tools/shared/browser-rpc-channel.ts'
import { comparePlugins } from '../presets/compare.ts'
import { disableConflicts } from '../presets/conflicts.ts'
import { planPresetAction, type PresetActionKind } from '../presets/plan.ts'
import { isRowList } from '../presets/rows.ts'
import { listPresetStatuses as buildStatusList, templatePlugins, type PresetFacts } from '../presets/status.ts'

/** The context slice this module needs: Cordis service lookup only. */
export interface PresetHostCtx {
  get(name: string): unknown
}

/** Structural view of one addressable Loader entry. */
interface EntryLike {
  options: { id: string; name?: string; config?: unknown }
}

/** One `configEditor.configuration()` row. */
interface ConfigurationRowLike {
  entry: EntryLike
  /** The bundled layer's config (our shipped declaration). */
  inherited: Record<string, unknown>
  /** The profile layer's config; `{}` when the user never overrode the row. */
  override: Record<string, unknown>
}

/**
 * The slice of `@deepseek-ai/dsh-config-editor` this plugin uses. Declared
 * structurally so the plugin keeps zero build-time coupling to a package it
 * never bundles.
 */
export interface ConfigEditorLike {
  /** Absolute path of the profile patch this editor writes. */
  readonly documentPath: string
  entries(): readonly EntryLike[]
  configuration(): readonly ConfigurationRowLike[]
  edit(
    entry: EntryLike,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>
}

/** One roster entry as the registry reports it. */
interface RosterRowLike {
  readonly id?: unknown
  readonly name?: unknown
  readonly description?: unknown
  readonly broken?: unknown
  readonly isDefault?: unknown
}

/**
 * The slice of the preset registry this plugin uses.
 *
 * `remoteExportList()` is preferred: it is the roster the official client reads,
 * and unlike `list()` it also carries `isDefault`. `list()` remains the fallback
 * for a deployment whose registry predates the exported roster.
 */
export interface AgentPresetsLike {
  list?(): Promise<readonly RosterRowLike[]>
  remoteExportList?(): Promise<{ readonly presets?: readonly RosterRowLike[] } | undefined>
}

/** Narrow a non-empty string, else undefined. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** `{ key: value }` only when the value is present, so optional fields stay absent. */
function optional(key: string, value: string | undefined): Record<string, string> {
  return value === undefined ? {} : { [key]: value }
}

/** Read a service only when it actually looks like the one we need. */
function configEditorOf(ctx: PresetHostCtx): ConfigEditorLike | undefined {
  const service = ctx.get('configEditor') as ConfigEditorLike | undefined
  return service !== undefined && typeof service.edit === 'function' && typeof service.configuration === 'function'
    ? service
    : undefined
}

/** Read the preset registry roster only when it exposes one of its two readers. */
async function rosterOf(ctx: PresetHostCtx): Promise<readonly RosterRowLike[] | undefined> {
  const service = ctx.get('agentPresets') as AgentPresetsLike | undefined
  if (service === undefined) return undefined
  try {
    // Preferred: the roster the official client reads (it also marks the default).
    if (typeof service.remoteExportList === 'function') {
      const exported = await service.remoteExportList()
      if (Array.isArray(exported?.presets)) return exported.presets
    }
    if (typeof service.list === 'function') return await service.list()
    return undefined
  } catch {
    // A broken roster must not take the whole panel down: our own rows stay
    // readable through the config editor.
    return undefined
  }
}

/** Everything one collection pass produced. */
interface Collected {
  facts: PresetFacts[]
  editor: ConfigEditorLike | undefined
  /** Row id → entry, for the write path. */
  entries: Map<string, EntryLike>
}

/**
 * Collect every declared preset this deployment can see.
 *
 * Ordering is OURS FIRST (the panel's primary subject), then the rest in the
 * registry's own order — which the registry sorts by each declaration's `order`.
 * @param ctx - context used to resolve the services.
 * @returns the facts, the editor (when present) and the row→entry map.
 */
async function collect(ctx: PresetHostCtx): Promise<Collected> {
  const editor = configEditorOf(ctx)
  const roster = await rosterOf(ctx)
  const byId = new Map<string, PresetFacts>()
  const entries = new Map<string, EntryLike>()

  // 1) Every addressable `preset-*` row: this is where our own declarations and
  //    their profile-layer overrides become visible. Bundle-inserted rows are
  //    children of the profile's root Include, so they are addressable too.
  if (editor !== undefined) {
    for (const row of editor.configuration()) {
      const entryId = text(row.entry.options.id)
      if (entryId === undefined || !entryId.startsWith('preset-')) continue
      const effective = (row.entry.options.config ?? {}) as Record<string, unknown>
      // Identity: the declaration's own `config.id`. A row whose config is
      // unusable still gets a stable identity from its entry id.
      const id = text(row.inherited.id) ?? text(row.override.id) ?? text(effective.id) ?? entryId.slice('preset-'.length)
      entries.set(entryId, row.entry)
      byId.set(id, {
        id,
        entryId,
        ...optional('name', text(row.inherited.name) ?? text(effective.name)),
        ...optional('description', text(row.inherited.description) ?? text(effective.description)),
        isDefault: false,
        effective,
        inherited: row.inherited,
        override: row.override,
        ours: BUNDLED_PRESET_IDS.includes(id),
      })
    }
  }

  // 2) Roster identity and activation diagnostics, merged onto the same ids.
  const rosterOrder: string[] = []
  for (const row of roster ?? []) {
    const id = text(row.id)
    if (id === undefined) continue
    rosterOrder.push(id)
    const existing = byId.get(id)
    byId.set(id, {
      id,
      ...(existing?.entryId === undefined ? {} : { entryId: existing.entryId }),
      ...optional('name', text(row.name) ?? existing?.name),
      ...optional('description', text(row.description) ?? existing?.description),
      isDefault: row.isDefault === true,
      ...optional('broken', text(row.broken)),
      ...(existing?.effective === undefined ? {} : { effective: existing.effective }),
      ...(existing?.inherited === undefined ? {} : { inherited: existing.inherited }),
      ...(existing?.override === undefined ? {} : { override: existing.override }),
      ours: BUNDLED_PRESET_IDS.includes(id),
    })
  }

  // Our own ids are ALWAYS listed, even when neither the registry nor the config
  // editor knows them: "this profile carries no declaration row for the plugin"
  // is a state the panel has to be able to explain, not silently omit.
  const ours = BUNDLED_PRESET_IDS.map(id => byId.get(id) ?? { id, isDefault: false, ours: true })
  const others = rosterOrder
    .filter((id) => !BUNDLED_PRESET_IDS.includes(id))
    .map((id) => byId.get(id))
    .filter((fact): fact is PresetFacts => fact !== undefined)
  return { facts: [...ours, ...others], editor, entries }
}

/**
 * The pre-0.1.7 user preset directory, reported ONLY as a cleanup hint.
 *
 * dsh reads no directory any more ("Definitions are ordinary plugin rows; the
 * registry neither scans directories nor accepts preset paths"), so a leftover
 * `$DSH_HOME/.agent-presets` is dead weight. We surface its path so the panel can
 * tell the user it is safe to delete; we never read or write presets through it.
 * @returns the absolute path when the directory exists and holds entries.
 */
function legacyPresetRoot(): string | undefined {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const dir = join(home, '.agent-presets')
  try {
    return readdirSync(dir).length > 0 ? dir : undefined
  } catch {
    return undefined
  }
}

/**
 * This plugin's own version, for the backup file name.
 *
 * Probes two candidates because the module URL differs between the built single
 * file (`lib/index.mjs` → `../package.json` is the package root) and the source
 * tree under test (`src/host/…` → `../../package.json`). Falls back to
 * `'unknown'` rather than failing an action over a cosmetic label.
 * @returns the version string, or `'unknown'`.
 */
function pluginVersion(): string {
  for (const candidate of ['../package.json', '../../package.json']) {
    try {
      const raw = JSON.parse(readFileSync(fileURLToPath(new URL(candidate, import.meta.url)), 'utf8')) as { version?: unknown }
      if (typeof raw.version === 'string' && raw.version.length > 0) return raw.version
    } catch {
      // Keep probing: the other candidate covers the other layout.
    }
  }
  return 'unknown'
}

/**
 * Copy the profile patch aside before we change it.
 *
 * The config editor already gives us atomicity and rollback, but NOT a durable
 * "what it looked like before" artifact — and `align` overwrites content the
 * user may have written there. This restores the pre-0.1.10 affordance exactly:
 * one `<patch>.bak-<plugin version>` beside the patch, written once and never
 * overwritten, so the earliest pre-change state survives repeated actions.
 * @param documentPath - the profile patch the editor is about to rewrite.
 * @returns the backup path, or undefined when there was nothing to copy.
 */
function backupProfilePatch(documentPath: string): string | undefined {
  if (!existsSync(documentPath)) return undefined
  const target = `${documentPath}.bak-${pluginVersion()}`
  if (existsSync(target)) return target
  // A failed copy propagates: the caller turns it into a refusal, because
  // changing the file without its safety net is worse than not changing it.
  copyFileSync(documentPath, target)
  return target
}

/** One failure in the gateway's shape. */
function failure(reason: string): PresetActionResultValue {
  return { ok: false, changed: false, reason, changes: [] }
}

/**
 * Answer `presets/status`.
 * @param ctx - context used to resolve the config editor and the registry.
 * @returns the panel's full status payload.
 */
export async function listPresetStatuses(ctx: PresetHostCtx): Promise<PresetStatusListValue> {
  const { facts, editor } = await collect(ctx)
  const list = buildStatusList(facts, editor !== undefined)
  const legacy = legacyPresetRoot()
  return legacy === undefined ? list : { ...list, legacyPresetRoot: legacy }
}

/**
 * Answer `presets/apply` by planning the action and, when it is worth writing,
 * delegating the write to the harness's own config editor.
 * @param ctx - context used to resolve the services.
 * @param presetId - the preset to act on.
 * @param action - `upgrade`, `align` or `revert`.
 * @param templateId - the align target (required for `align`).
 * @returns the action result, never throwing.
 */
export async function applyPresetAction(
  ctx: PresetHostCtx,
  presetId: string,
  action: PresetActionKind,
  templateId?: string,
): Promise<PresetActionResultValue> {
  try {
    const { facts, editor, entries } = await collect(ctx)
    const fact = facts.find((item) => item.id === presetId)
    if (fact === undefined) return failure(`unknown preset: ${presetId}`)

    const wanted = templateId === undefined ? undefined : templatePlugins(facts, templateId)
    const plan = planPresetAction({
      action,
      ours: fact.ours,
      customized: fact.override !== undefined && Object.keys(fact.override).length > 0,
      effective: fact.effective,
      inherited: fact.inherited,
      ...(wanted === undefined ? {} : { templatePlugins: wanted }),
      ...(templateId === undefined ? {} : { templateId }),
    })
    if (plan.kind === 'noop') return { ok: true, changed: false, reason: plan.reason, changes: [] }

    if (editor === undefined) {
      return failure('this deployment has no editable profile: ctx.configEditor is unavailable')
    }
    const entry = fact.entryId === undefined ? undefined : entries.get(fact.entryId)
    if (entry === undefined) {
      return failure(
        `this profile has no addressable row for ${presetId} (expected id ${profileRowId(presetId)}); `
        + 'install the plugin as a profile bundle so its patch declares the preset',
      )
    }

    // Safety net first: the editor keeps atomicity, this keeps the "before".
    const backupPath = backupProfilePatch(editor.documentPath)

    if (plan.kind === 'revert') {
      await editor.edit(entry, (_current, inherited) => inherited)
    } else if (plan.kind === 'align') {
      await editor.edit(entry, current => ({ ...current, plugins: wanted }))
    } else {
      // The pre-check decided there IS something to disable; re-derive from the
      // fresh `current` read under the profile lock so a concurrent edit cannot
      // be clobbered by our earlier snapshot.
      await editor.edit(entry, (current) => {
        if (!isRowList(current.plugins)) return current
        return { ...current, plugins: disableConflicts(current.plugins).plugins }
      })
    }
    return {
      ok: true,
      changed: true,
      ...(backupPath === undefined ? {} : { backupPath }),
      changes: plan.kind === 'upgrade' ? plan.changes : [],
    }
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error))
  }
}

/**
 * Answer `presets/compare`: one preset's effective plugins against one of our
 * declared templates. Never throws; an unresolvable side reports `unreadable`
 * (that is a state the panel renders as a red dot, not a failed call).
 * @param ctx - context used to resolve the services.
 * @param presetId - the preset being inspected.
 * @param templateId - the template to compare it against.
 * @returns the comparison.
 */
export async function comparePresetAgainstTemplate(
  ctx: PresetHostCtx,
  presetId: string,
  templateId: string,
): Promise<PresetCompareValue> {
  const empty: PresetCompareValue = {
    presetId,
    templateId,
    status: 'unreadable',
    conflicts: [],
    identical: false,
    yoursCount: 0,
    behindCount: 0,
    items: [],
  }
  try {
    const { facts } = await collect(ctx)
    const fact = facts.find((item) => item.id === presetId)
    if (fact === undefined) return empty
    const template = templatePlugins(facts, templateId)
    if (template === undefined) return empty
    return { presetId, templateId, ...comparePlugins(fact.effective?.plugins, template) }
  } catch {
    return empty
  }
}
