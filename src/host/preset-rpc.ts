/**
 * Host half of the preset endpoints: answers `presets/status` (roster +
 * conflicts + template diff), `presets/apply` (upgrade / align / revert) and
 * `presets/compare` for the settings panel's 「全局」tab.
 *
 * These endpoints live on the **same** `/tool-plus` route as `browser/detect`
 * and `rmSafe/status` (see `browser-probe-rpc.ts`). That route is a plain
 * `webServer.register({ kind: 'prefix', path: '/tool-plus' })` registration, NOT
 * `connection.rpc.handle`: in this deployment the Connection handler resolves
 * its owner through `this.ctx` without the `webServer` injection, so a
 * `rpc.handle` registration never takes effect. The Connection service is still
 * used for its loopback trust fence (`connection.requestRejection`).
 *
 * This module is a wire adapter only: payload validation plus dispatch into an
 * injected {@link PresetRpcDeps}. The service lookup, the configuration reads
 * and the writes live in `../host/preset-host.ts`; the decision logic lives in
 * `src/presets/**`. Trust policy is `loopback` — these endpoints read the user's
 * profile configuration and the write path edits it, so they must never be
 * reachable from a non-loopback host.
 * @module @xiaoso/dsh-tool-plus/host/preset-rpc
 */

import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import {
  PRESET_ACTION_ENDPOINT,
  PRESET_COMPARE_ENDPOINT,
  PRESET_STATUS_ENDPOINT,
  type PresetActionPayload,
  type PresetActionResultValue,
  type PresetActionValue,
  type PresetComparePayloadValue,
  type PresetCompareValue,
  type PresetStatusListValue,
} from '../tools/shared/browser-rpc-channel.ts'

/** Result shape of one Connection RPC call (official pattern in the gateway). */
type ConnectionRpcResult = Awaited<ReturnType<ConnectionRpcHandler>>

/** The context slice this handler needs: pass-through to the injected deps. */
export interface PresetEndpointCtx {
  /** Cordis service lookup, forwarded to the host implementation. */
  get(name: string): unknown
}

/**
 * Everything the endpoints need from the host plane. Injected so this module
 * stays a thin wire adapter whose parsing helpers are testable without a
 * Connection service, a Loader, or a profile.
 */
export interface PresetRpcDeps {
  /** Read every declared preset with its conflicts and template diff. */
  listPresets: (ctx: PresetEndpointCtx) => Promise<PresetStatusListValue>
  /** Apply one action to one preset. The only path that writes. */
  applyAction: (
    ctx: PresetEndpointCtx,
    id: string,
    action: PresetActionValue,
    templateId?: string,
  ) => Promise<PresetActionResultValue>
  /** Read-only comparison between one preset and one of our declarations. */
  comparePreset: (ctx: PresetEndpointCtx, presetId: string, templateId: string) => Promise<PresetCompareValue>
}

/**
 * Validate a `presets/compare` payload: two non-empty ids, nothing else.
 * @param payload - the raw RPC payload.
 * @returns the narrowed payload, or undefined when invalid.
 */
export function parsePresetComparePayload(payload: unknown): PresetComparePayloadValue | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const { presetId, templateId } = payload as { presetId?: unknown; templateId?: unknown }
  if (typeof presetId !== 'string' || presetId.length === 0) return undefined
  if (typeof templateId !== 'string' || templateId.length === 0) return undefined
  return { presetId, templateId }
}

/**
 * Validate a `presets/apply` payload. Anything that is not exactly
 * `{ id: non-empty string, action: 'upgrade' | 'align' | 'revert', templateId?: non-empty string }`
 * is rejected, so the write endpoint never receives a half-formed request.
 * @param payload - the raw RPC payload.
 * @returns the narrowed payload, or undefined when invalid.
 */
export function parsePresetActionPayload(payload: unknown): PresetActionPayload | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const { id, action, templateId } = payload as { id?: unknown; action?: unknown; templateId?: unknown }
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (action !== 'upgrade' && action !== 'align' && action !== 'revert') return undefined
  if (templateId !== undefined && (typeof templateId !== 'string' || templateId.length === 0)) return undefined
  return templateId === undefined ? { id, action } : { id, action, templateId }
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

/**
 * Answer one preset endpoint on the shared `/tool-plus` route.
 *
 * Returns `undefined` for an endpoint this module does not own, so the caller
 * (the single route handler) can keep serving its own families.
 * @param ctx - context forwarded to the injected host implementation.
 * @param deps - injected host implementation.
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

  if (endpoint === PRESET_STATUS_ENDPOINT) {
    try {
      return { ok: true, value: await deps.listPresets(ctx) }
    } catch (error) {
      return failure(error)
    }
  }

  if (endpoint === PRESET_COMPARE_ENDPOINT) {
    const parsed = parsePresetComparePayload(payload)
    if (!parsed) return failure('presets/compare expects { presetId: string, templateId: string }', 'bad-request')
    try {
      return { ok: true, value: await deps.comparePreset(ctx, parsed.presetId, parsed.templateId) }
    } catch (error) {
      return failure(error)
    }
  }

  const parsed = parsePresetActionPayload(payload)
  if (!parsed) {
    return failure(
      'presets/apply expects { id: string, action: "upgrade" | "align" | "revert", templateId?: string }',
      'bad-request',
    )
  }
  try {
    const value = await deps.applyAction(ctx, parsed.id, parsed.action, parsed.templateId)
    return { ok: true, value }
  } catch (error) {
    return failure(error)
  }
}
