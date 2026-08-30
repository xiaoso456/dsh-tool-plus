/**
 * Browser caller for the plugin's Connection RPC channel.
 *
 * The official `@deepseek-ai/dsh-client-connection/client` package ships the
 * protocol primitives as types (`RpcFetch`, `ClientConnectionRpc`, `RpcResult`)
 * and the `RpcId` brand, but its published `createWebConnectionRpc` factory is
 * internal to the bundle — not re-exported. This module re-implements that
 * factory against the same public wire contract (docs/api-gateway.md, the
 * client `rpc.ts` source): a `POST {origin}/{channel}/{endpoint}` with a
 * `client-request` JSON envelope, answered by a `server-response` envelope
 * echoing the rpcId. Host-side registration uses the official
 * `ctx.connection.rpc.handle` — this file only mirrors the caller half.
 * @module @xiaoso/dsh-tool-plus/client/web-connection-rpc
 */

import { RpcId } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientConnectionRpc, RpcFetch, RpcResult } from '@deepseek-ai/dsh-client-connection/client'

const INTERNAL_BASE = 'http://dsh.internal'
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

function randomUuid(): string {
  // crypto.randomUUID (secure contexts) with a Math.random fallback for
  // non-secure previews — correlation only, no security property.
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  if (g.crypto?.randomUUID !== undefined) return g.crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseConnectionResponse(value: unknown): {
  readonly rpcId: string
  readonly result:
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: object } }
} {
  if (!isRecord(value) || value.type !== 'server-response' || typeof value.rpcId !== 'string') {
    throw new TypeError('connection: invalid server-response envelope')
  }
  const result = value.result
  if (!isRecord(result)) throw new TypeError('connection: invalid server-response result')
  if (result.ok === true) {
    return {
      rpcId: value.rpcId,
      result: { ok: true, value: result.value },
    }
  }
  if (result.ok !== false || !isRecord(result.error)) {
    throw new TypeError('connection: invalid server-response result')
  }
  const error = result.error
  if (typeof error.code !== 'string' || typeof error.message !== 'string' || !isRecord(error.details)) {
    throw new TypeError('connection: invalid server-response failure')
  }
  return {
    rpcId: value.rpcId,
    result: {
      ok: false,
      error: { code: error.code, message: error.message, details: error.details },
    },
  }
}

function resolveBase(): string {
  const location = (globalThis as { location?: { origin?: string } }).location
  return location?.origin !== undefined && location.origin !== 'null' ? location.origin : INTERNAL_BASE
}

function assertTarget(channel: string, endpoint: string): void {
  const segments = endpoint.split('/')
  if (
    !CHANNEL_PATTERN.test(channel)
    || segments.some(segment =>
      segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment),
    )
  ) {
    throw new Error(`connection: invalid RPC target ${JSON.stringify(`${channel}/${endpoint}`)}`)
  }
}

/**
 * Create the browser-backed generic RPC caller for the plugin's channel
 * (the `/tool-plus` host registration). Wire-compatible with the official
 * ClientConnectionRpc contract; only the transport override differs.
 * @param doFetch - transport override; defaults to the page's global fetch.
 */
export function createWebConnectionRpc(doFetch?: RpcFetch): ClientConnectionRpc {
  const send: RpcFetch = doFetch ?? ((input, init) => globalThis.fetch(input, init))
  return {
    async call(channel, endpoint, payload, signal) {
      assertTarget(channel, endpoint)
      const rpcId = RpcId(randomUuid())
      const response = await send(
        new URL(`${channel}/${endpoint}`, resolveBase()),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId,
            method: endpoint,
            payload,
          }),
          ...(signal === undefined ? {} : { signal }),
        },
      )
      if (!response.ok) {
        throw new Error(`transport failure for ${channel}/${endpoint}: HTTP ${response.status}`)
      }
      const full = parseConnectionResponse(await response.json())
      if (full.rpcId !== rpcId) {
        throw new Error(`rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${full.rpcId}`)
      }
      // The wire shape is deliberately loose (codes are validated by the host
      // against the closed union); the typed contract applies at this seam.
      return full.result as RpcResult<unknown>
    },
  }
}
