/**
 * Host half of the tool-plus RPC channel: serves `browser/detect`,
 * `rmSafe/status`, `presets/status` and `presets/apply` to the settings panel,
 * reached from the browser as `POST /tool-plus/<endpoint>` with the official
 * Connection envelope (`{ type: 'client-request', rpcId, method, payload }`).
 *
 * **Why this registers its own route instead of calling `connection.rpc.handle`.**
 * The documented helper is unusable from a plugin in a real web deployment on
 * dsh 0.1.5-rc.1: `HostConnectionService.rpc` builds its handle against
 * `owner = this.ctx` (`rpc-host.ts: "Generic channel registry scoped to the
 * Context reading this service"`), and `register()` then evaluates
 * `owner.webServer.register(route)`. The client-connection row declares
 * `inject = ['credentials']` only, and the web server is mounted on a branch of
 * the context tree that is not an ancestor of that row, so the call dies with
 * `Error: cannot get property "webServer" without inject` — caught nowhere,
 * route never registered, every browser round trip answered `405` by the static
 * fallback (verified on the real deployment: `POST /tool-plus/*` → 405 while
 * `POST /api*` → 401). Registering the same prefix route through
 * `webServer.register` is what official host plugins do (`host/open-in-app`),
 * and the trust fence is still the service's own `requestRejection` — the wire
 * contract below is the published one, mirrored by
 * `src/client/web-connection-rpc.ts`.
 *
 * The route rides a **child row with a static `inject` list**, the way official
 * web-plane rows declare their needs (`packages/client/hmr`:
 * `inject = ['clientModules', 'webServer']`): `connection` and `webServer` are
 * mounted *after* this plugin applies, and a `ctx.inject(['connection'], cb)`
 * callback is never invoked for such a late service. A CLI-only deployment
 * simply never applies the row — best-effort by construction, without gating
 * the rest of the plugin.
 *
 * Trust policy is `loopback`: the probe only reports local filesystem paths and
 * the preset endpoints read/write files under the user's DSH home, so they must
 * never be reachable from a non-loopback host.
 * @module @xiaoso/dsh-tool-plus/host/browser-probe-rpc
 */

import * as fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { BROWSER_DETECT_ENDPOINT, RM_SAFE_STATUS_ENDPOINT, TOOL_PLUS_RPC_CHANNEL } from '../tools/shared/browser-rpc-channel.ts'
import { probeBrowsers } from '../tools/shared/browser-detect.ts'
import { runtimeLogger } from '../tools/bash/logger.ts'
import { handlePresetEndpoint, type PresetRpcDeps } from './preset-rpc.ts'
import { getShellConfig } from '../tools/bash/bash-executor.ts'
import { getOrCreateSnapshot } from '../tools/bash/shell-snapshot.ts'
import { injectRmSafe, rmSafeCliPath } from '../tools/bash/rm-safe.ts'
import { probeRmSafeRuntime, queryRmSafeStatus } from '../tools/bash/rm-safe-status.ts'

/** Result shape of one Connection RPC call (official gateway contract). */
type ConnectionRpcResult = Awaited<ReturnType<ConnectionRpcHandler>>

/** One endpoint handler: endpoint name and raw payload in, envelope result out. */
type RpcHandler = (endpoint: string, payload: unknown) => Promise<ConnectionRpcResult>

/** Structural view of a host web route (no build-time coupling to its package). */
interface WebServerLike {
  register(route: {
    kind: 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Structural view of the slice of the Connection service used here. */
interface ConnectionLike {
  /** 401/403 for a request outside the trust fence, undefined when allowed. */
  requestRejection(req: IncomingMessage): number | undefined
}

/** Install-time dependencies: live config reads (hot-reload safe). */
export interface ToolPlusRpcDeps {
  /** Whether rmSafe is currently enabled (resolved config). */
  getRmSafe: () => boolean
  /**
   * Preset analysis served on the *same* channel (`presets/status` /
   * `presets/apply`). Omitted when the caller has no preset analysis to inject.
   */
  presets?: PresetRpcDeps
}

/** Cap on one request body; every legitimate payload here is a few hundred bytes. */
const MAX_BODY_BYTES = 1024 * 1024

/** One internal error result in the gateway's shape. */
function failure(error: unknown): ConnectionRpcResult {
  return {
    ok: false,
    error: {
      code: 'internal',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  }
}

/** Write one JSON response (official host-plugin idiom). */
function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(body)
}

/** One `server-response` envelope carrying a failure, in the published shape. */
function errorEnvelope(rpcId: string, code: string, message: string): unknown {
  return { type: 'server-response', rpcId, result: { ok: false, error: { code, message, details: {} } } }
}

/** Read a capped request body, or undefined when it exceeds the cap. */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Narrow a parsed body to the client-request envelope (published schema). */
function clientRequest(body: unknown): { rpcId: string; method: string; payload: unknown } | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const { type, rpcId, method, payload } = body as Record<string, unknown>
  if (type !== 'client-request' || typeof rpcId !== 'string' || typeof method !== 'string') return undefined
  return { rpcId, method, payload }
}

/** Endpoint path segment(s) after the channel prefix, or undefined when malformed. */
function endpointOf(url: string | undefined): string | undefined {
  const pathname = new URL(String(url), 'http://localhost').pathname
  if (!pathname.startsWith(`${TOOL_PLUS_RPC_CHANNEL}/`)) return undefined
  const endpoint = pathname.slice(TOOL_PLUS_RPC_CHANNEL.length + 1)
  if (endpoint.length === 0 || endpoint.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return undefined
  return endpoint
}

/**
 * Install the tool-plus RPC endpoints. Returns a disposer that removes the
 * registration. Never throws for "unavailable" — without the web plane the
 * child row is never applied, and a failed registration is logged rather than
 * swallowed.
 */
export function installBrowserProbeRpc(ctx: Context, deps: ToolPlusRpcDeps): () => Promise<void> | void {
  let disposer: (() => void) | undefined

  const row = ctx.plugin({
    name: 'tool-plus-rpc',
    // Both services are required: the endpoints are served by the web server and
    // the trust fence comes from Connection.
    inject: ['connection', 'webServer'],
    apply: (rowCtx: Context): void => {
      const connection = (rowCtx as unknown as { connection: ConnectionLike }).connection
      const server = (rowCtx as unknown as { webServer: WebServerLike }).webServer

      const handler: RpcHandler = async (endpoint, payload): Promise<ConnectionRpcResult> => {
        if (endpoint === BROWSER_DETECT_ENDPOINT) {
          try {
            const found = probeBrowsers()
            return { ok: true, value: { found } }
          } catch (error) {
            return failure(error)
          }
        }
        if (endpoint === RM_SAFE_STATUS_ENDPOINT) {
          if (!deps.getRmSafe()) return { ok: true, value: { status: 'disabled' } }
          try {
            const { shell, env } = getShellConfig()
            const status = await queryRmSafeStatus({
              getOrCreateSnapshot: () => getOrCreateSnapshot(shell, env),
              cliExists: () => fs.existsSync(rmSafeCliPath()),
              nodePath: () => process.execPath,
              cliPath: () => rmSafeCliPath(),
              inject: (snapshotPath, nodePath, cliPath) => injectRmSafe(snapshotPath, nodePath, cliPath),
              probe: (snapshotPath) => probeRmSafeRuntime(shell, snapshotPath),
            })
            return { ok: true, value: status }
          } catch (error) {
            return failure(error)
          }
        }
        // Preset endpoints share this route: one route serves every family.
        if (deps.presets !== undefined) {
          const handled = await handlePresetEndpoint(rowCtx, deps.presets, endpoint, payload)
          if (handled !== undefined) return handled
        }
        return {
          ok: false,
          error: {
            code: 'bad-request',
            message: `Unknown tool-plus endpoint: ${endpoint}`,
            details: { issues: [] },
          },
        }
      }

      try {
        disposer = server.register({
          kind: 'prefix',
          path: TOOL_PLUS_RPC_CHANNEL,
          handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
            const rejection = connection.requestRejection(req)
            if (rejection !== undefined) {
              res.statusCode = rejection
              res.end()
              return
            }
            if (req.method !== 'POST') {
              res.statusCode = 405
              res.setHeader('allow', 'POST')
              res.end()
              return
            }
            if ((req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
              sendJson(res, 415, errorEnvelope('invalid-request', 'gateway/bad-request', 'content type must be application/json'))
              return
            }
            const raw = await readBody(req)
            let parsed: unknown
            try {
              parsed = raw === undefined ? undefined : JSON.parse(raw)
            } catch {
              sendJson(res, 400, errorEnvelope('invalid-request', 'gateway/bad-request', 'body is not JSON'))
              return
            }
            const message = clientRequest(parsed)
            if (message === undefined) {
              sendJson(res, 400, errorEnvelope('invalid-request', 'gateway/bad-request', 'invalid client-request message'))
              return
            }
            const endpoint = endpointOf(req.url)
            if (endpoint === undefined) {
              sendJson(res, 404, errorEnvelope(message.rpcId, 'gateway/bad-request', 'unknown tool-plus endpoint'))
              return
            }
            if (message.method !== endpoint) {
              sendJson(res, 200, errorEnvelope(
                message.rpcId,
                'gateway/bad-request',
                `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
              ))
              return
            }
            try {
              const result = await handler(endpoint, message.payload)
              sendJson(res, 200, { type: 'server-response', rpcId: message.rpcId, result })
            } catch (error) {
              res.statusCode = 500
              res.end(`handler failure: ${String(error)}`)
            }
          },
        })
        runtimeLogger().info(`tool-plus RPC live on ${TOOL_PLUS_RPC_CHANNEL}`)
      } catch (error) {
        // Route already registered or the registration itself failed — the
        // endpoints are out of service, which is a degraded-but-valid state.
        // It is never silent, though: a swallowed registration failure is
        // exactly the kind of signal that costs an afternoon later.
        runtimeLogger().warn(`tool-plus RPC unavailable: ${error instanceof Error ? error.message : String(error)}`)
        disposer = undefined
      }
    },
  })

  return () => {
    disposer?.()
    disposer = undefined
    void (row as unknown as Promise<unknown>).catch?.(() => {})
  }
}
