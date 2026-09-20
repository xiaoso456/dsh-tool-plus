/**
 * Host half of the preset endpoints: answers `presets/status` (roster +
 * conflicts + template diff) and `presets/apply` (disable conflicting rows /
 * reset from our template) for the settings panel's 「全局」tab.
 *
 * These endpoints live on the **same** `/tool-plus` channel registration as
 * `browser/detect` and `rmSafe/status` (see `browser-probe-rpc.ts`): a
 * Connection channel has exactly one handler, so a second
 * `connection.rpc.handle('/tool-plus', …)` never takes effect. That is why this
 * module exports an endpoint handler instead of installing a channel of its
 * own.
 *
 * The preset analysis itself lives in `src/presets/**` and is **injected**, so
 * this module stays a thin wire adapter and its helpers are testable without a
 * Connection service or a filesystem.
 *
 * Trust policy is `loopback` (the channel's own policy): these endpoints read
 * and write files under the user's DSH home, so they must never be reachable
 * from a non-loopback host.
 * @module @xiaoso/dsh-tool-plus/host/preset-rpc
 */

import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import {
  PRESET_ACTION_ENDPOINT,
  PRESET_COMPARE_ENDPOINT,
  PRESET_STATUS_ENDPOINT,
  type PresetActionPayload,
  type PresetActionResultValue,
  type PresetComparePayloadValue,
  type PresetCompareValue,
  type PresetStatusListValue,
  type PresetTemplateValue,
} from '../tools/shared/browser-rpc-channel.ts'
import type { PresetInstallResult } from '../presets/install.ts'
import type { PresetComparison, PresetTemplate } from '../presets/compare.ts'
import type { PresetRosterEntry, PresetStatus } from '../presets/status.ts'

/** Payload shape of a `presets/compare` call (shared contract). */
type PresetComparePayload = PresetComparePayloadValue

/** Result shape of one Connection RPC call (official pattern in the gateway). */
type ConnectionRpcResult = Awaited<ReturnType<ConnectionRpcHandler>>

/**
 * Structural view of one official `ctx.agentPresets.list()` entry. Declared
 * here instead of importing `@deepseek-ai/dsh-agent-presets` so the plugin
 * keeps zero build-time coupling to a package it never bundles — the service
 * is reached through the context, and every field is validated on the way in.
 */
interface RosterPresetLike {
  readonly id?: unknown
  readonly trust?: unknown
  readonly path?: unknown
  readonly name?: unknown
  readonly description?: unknown
  readonly broken?: unknown
}

/** The only slice of the official agent-presets service this plugin uses. */
export interface AgentPresetsServiceLike {
  list(): Promise<readonly RosterPresetLike[]>
}

/** Install-time dependencies: the preset analysis owned by the host half. */
export interface PresetRpcDeps {
  /** Build one status row per roster entry (reads the user root, never writes). */
  listStatuses: (roster: readonly PresetRosterEntry[]) => PresetStatus[]
  /** Apply one action to one preset (the only endpoint that writes). */
  applyAction: (
    id: string,
    action: PresetActionPayload['action'],
    templateId?: string,
  ) => PresetInstallResult
  /** Templates this package ships (the panel's "compare with" options). */
  listTemplates: () => PresetTemplate[]
  /**
   * Read-only comparison between one roster preset and one of our templates.
   * Returns `status: 'unreadable'` instead of throwing when a file cannot be
   * read — that is a state the panel renders (red dot), not a failed call.
   */
  comparePreset: (preset: PresetRosterEntry, templateId: string) => PresetComparison
}

/**
 * Validate a `presets/compare` payload: two non-empty ids, nothing else.
 * @param payload - the raw RPC payload.
 * @returns the narrowed payload, or undefined when invalid.
 */
export function parsePresetComparePayload(payload: unknown): PresetComparePayload | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const { presetId, templateId } = payload as { presetId?: unknown; templateId?: unknown }
  if (typeof presetId !== 'string' || presetId.length === 0) return undefined
  if (typeof templateId !== 'string' || templateId.length === 0) return undefined
  return { presetId, templateId }
}

/**
 * Validate a `presets/apply` payload. Anything that is not exactly
 * `{ id: non-empty string, action: 'upgrade' | 'reset' }` is rejected, so the
 * write endpoint never receives a half-formed request.
 * @param payload - the raw RPC payload.
 * @returns the narrowed payload, or undefined when invalid.
 */
export function parsePresetActionPayload(payload: unknown): PresetActionPayload | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const { id, action, templateId } = payload as { id?: unknown; action?: unknown; templateId?: unknown }
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (action !== 'upgrade' && action !== 'reset') return undefined
  if (templateId !== undefined && (typeof templateId !== 'string' || templateId.length === 0)) return undefined
  return templateId === undefined ? { id, action } : { id, action, templateId }
}

/**
 * Narrow one roster entry coming from the official service. Unknown trust is
 * treated as `user` (the conservative side: it is a writable preset only when
 * the caller proves otherwise — the caller matches ids against our templates).
 * @param preset - raw entry from `ctx.agentPresets.list()`.
 * @returns the entry in our own shape.
 */
export function toRosterEntry(preset: RosterPresetLike): PresetRosterEntry {
  const text = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined)
  return {
    id: text(preset.id) ?? '',
    trust: preset.trust === 'system' ? 'system' : 'user',
    path: text(preset.path) ?? '',
    name: text(preset.name),
    description: text(preset.description),
    broken: text(preset.broken),
  }
}

/** One RPC error result in the gateway's shape. */
function failure(error: unknown, code: 'internal' | 'bad-request' = 'internal'): ConnectionRpcResult {
  return {
    ok: false,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  }
}

/** The context slice this handler needs: service lookup only. */
export interface PresetEndpointCtx {
  /** Cordis service lookup; `agentPresets` is mounted by the harness. */
  get(name: string): unknown
}

/**
 * Answer one preset endpoint on the shared `/tool-plus` channel.
 *
 * Returns `undefined` for an endpoint this module does not own, so the caller
 * (the single channel handler) can keep serving its own families. The service
 * is resolved per call: a deployment that mounts `agent-presets` after this
 * plugin still gets a working endpoint instead of a stale `undefined`.
 * @param ctx - context used to resolve the `agentPresets` service.
 * @param deps - injected preset analysis.
 * @param endpoint - the requested endpoint name.
 * @param payload - the raw RPC payload.
 * @returns the RPC result, or undefined when the endpoint is not ours.
 */
export async function handlePresetEndpoint(
  ctx: PresetEndpointCtx,
  deps: PresetRpcDeps,
  endpoint: string,
  payload: unknown,
): Promise<ConnectionRpcResult | undefined> {
  if (endpoint !== PRESET_STATUS_ENDPOINT && endpoint !== PRESET_ACTION_ENDPOINT && endpoint !== PRESET_COMPARE_ENDPOINT) {
    return undefined
  }

  const service = ctx.get('agentPresets') as AgentPresetsServiceLike | undefined
  if (!service || typeof service.list !== 'function') {
    return failure('agent presets are not available in this deployment')
  }

  if (endpoint === PRESET_STATUS_ENDPOINT) {
    try {
      const roster = await service.list()
      const value: PresetStatusListValue = {
        presets: deps.listStatuses(roster.map(toRosterEntry)),
        templates: deps.listTemplates(),
      }
      return { ok: true, value }
    } catch (error) {
      return failure(error)
    }
  }

  if (endpoint === PRESET_COMPARE_ENDPOINT) {
    const parsed = parsePresetComparePayload(payload)
    if (!parsed) {
      return failure('presets/compare expects { presetId: string, templateId: string }', 'bad-request')
    }
    try {
      const roster = (await service.list()).map(toRosterEntry)
      const preset = roster.find(entry => entry.id === parsed.presetId)
      if (preset === undefined) {
        return failure(`unknown preset: ${parsed.presetId}`, 'bad-request')
      }
      if (!deps.listTemplates().some(template => template.id === parsed.templateId)) {
        return failure(`unknown template: ${parsed.templateId}`, 'bad-request')
      }
      const value: PresetCompareValue = {
        presetId: parsed.presetId,
        templateId: parsed.templateId,
        ...deps.comparePreset(preset, parsed.templateId),
      }
      return { ok: true, value }
    } catch (error) {
      return failure(error)
    }
  }

  const parsed = parsePresetActionPayload(payload)
  if (!parsed) {
    return failure(
      'presets/apply expects { id: string, action: "upgrade" | "reset", templateId?: string }',
      'bad-request',
    )
  }
  try {
    const value: PresetActionResultValue = deps.applyAction(parsed.id, parsed.action, parsed.templateId)
    return { ok: true, value }
  } catch (error) {
    return failure(error)
  }
}
