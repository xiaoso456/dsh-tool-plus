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
  | { status: 'failed'; reason: 'snapshot-unavailable' | 'cli-missing' | 'script-write-failed' | 'snapshot-write-failed' | 'runtime-not-effective' }
  | { status: 'injected'; runtime: 'function' | 'system' | 'unknown' }
