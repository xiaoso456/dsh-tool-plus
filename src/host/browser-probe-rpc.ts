/**
 * Host half of the browser-detection RPC: registers the `/tool-plus` logical
 * channel on the official Connection transport and answers `browser/detect`
 * by probing the machine for usable browsers. The settings panel (client
 * half) calls this through `createWebConnectionRpc().call(...)` — the
 * documented public RPC surface of `@deepseek-ai/dsh-client-connection`,
 * not a private plugin hook.
 *
 * Trust policy is `loopback`: the probe only reports local filesystem paths,
 * so it must never be reachable from a non-loopback host. Registration is
 * best-effort — if `connection` is missing (non-web deployments) or the
 * channel is already taken, the probe is simply unavailable and the panel
 * shows "Unavailable".
 * @module @xiaoso/dsh-tool-plus/host/browser-probe-rpc
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { BROWSER_DETECT_ENDPOINT, TOOL_PLUS_RPC_CHANNEL } from '../tools/shared/browser-rpc-channel.ts'
import { probeBrowsers } from '../tools/shared/browser-detect.ts'

/** Result shape of one Connection RPC call (official pattern in the gateway). */
type ConnectionRpcResult = Awaited<ReturnType<ConnectionRpcHandler>>

/**
 * Install the browser/detect RPC endpoint. Returns a disposer that removes
 * the registration (call it from the plugin's `ctx.effect` teardown).
 * Never throws for "unavailable" — the return value tells the caller whether
 * the channel is actually live.
 */
export function installBrowserProbeRpc(ctx: Context): () => Promise<void> | void {
  let disposer: (() => Promise<void>) | undefined
  ctx.inject(['connection'], (connectionCtx) => {
    try {
      const handler: ConnectionRpcHandler = async (endpoint, _payload, _signal): Promise<ConnectionRpcResult> => {
        if (endpoint !== BROWSER_DETECT_ENDPOINT) {
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
          const found = probeBrowsers()
          return { ok: true, value: { found } }
        } catch (error) {
          return {
            ok: false,
            error: {
              code: 'internal',
              message: error instanceof Error ? error.message : String(error),
              details: {},
            },
          }
        }
      }
      disposer = connectionCtx.connection.rpc.handle(TOOL_PLUS_RPC_CHANNEL, handler, { authority: 'loopback' })
    } catch {
      // Channel already registered or `connection` unavailable — the probe is
      // out of service, which is a degraded-but-valid deployment state.
      disposer = undefined
    }
  })
  return () => disposer?.()
}
