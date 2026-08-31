/**
 * Host half of the tool-plus RPC channel: registers the `/tool-plus` logical
 * channel on the official Connection transport and answers
 * `browser/detect` (probe the machine for usable browsers) and
 * `rmSafe/status` (query = ensure + verify the rmSafe injection). The
 * settings panel (client half) calls these through
 * `createWebConnectionRpc().call(...)` — the documented public RPC surface
 * of `@deepseek-ai/dsh-client-connection`, not a private plugin hook.
 *
 * Trust policy is `loopback`: the probe only reports local filesystem paths,
 * so it must never be reachable from a non-loopback host. Registration is
 * best-effort — if `connection` is missing (non-web deployments) or the
 * channel is already taken, the endpoints are simply unavailable and the
 * panel shows "Unavailable".
 * @module @xiaoso/dsh-tool-plus/host/browser-probe-rpc
 */

import * as fs from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { BROWSER_DETECT_ENDPOINT, RM_SAFE_STATUS_ENDPOINT, TOOL_PLUS_RPC_CHANNEL } from '../tools/shared/browser-rpc-channel.ts'
import { probeBrowsers } from '../tools/shared/browser-detect.ts'
import { getShellConfig } from '../tools/bash/bash-executor.ts'
import { getOrCreateSnapshot } from '../tools/bash/shell-snapshot.ts'
import { ensureRmSafeScript, injectRmSafe, rmSafeCliPath, rmSafeScriptDir } from '../tools/bash/rm-safe.ts'
import { probeRmSafeRuntime, queryRmSafeStatus } from '../tools/bash/rm-safe-status.ts'

/** Result shape of one Connection RPC call (official pattern in the gateway). */
type ConnectionRpcResult = Awaited<ReturnType<ConnectionRpcHandler>>

/** Install-time dependencies: live config reads (hot-reload safe). */
export interface ToolPlusRpcDeps {
  /** Whether rmSafe is currently enabled (resolved config). */
  getRmSafe: () => boolean
}

/**
 * Install the tool-plus RPC endpoints. Returns a disposer that removes
 * the registration (call it from the plugin's `ctx.effect` teardown).
 * Never throws for "unavailable" — the return value tells the caller whether
 * the channel is actually live.
 */
export function installBrowserProbeRpc(ctx: Context, deps: ToolPlusRpcDeps): () => Promise<void> | void {
  let disposer: (() => Promise<void>) | undefined
  ctx.inject(['connection'], (connectionCtx) => {
    try {
      const handler: ConnectionRpcHandler = async (endpoint, _payload, _signal): Promise<ConnectionRpcResult> => {
        if (endpoint === BROWSER_DETECT_ENDPOINT) {
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
        if (endpoint === RM_SAFE_STATUS_ENDPOINT) {
          if (!deps.getRmSafe()) return { ok: true, value: { status: 'disabled' } }
          try {
            const { shell, env } = getShellConfig()
            const status = await queryRmSafeStatus({
              getOrCreateSnapshot: () => getOrCreateSnapshot(shell, env),
              cliExists: () => fs.existsSync(rmSafeCliPath()),
              ensureScript: () => ensureRmSafeScript(rmSafeScriptDir(), process.execPath, rmSafeCliPath()),
              inject: (snapshotPath, scriptPath) => injectRmSafe(snapshotPath, scriptPath),
              probe: (snapshotPath) => probeRmSafeRuntime(shell, snapshotPath),
            })
            return { ok: true, value: status }
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
        return {
          ok: false,
          error: {
            code: 'bad-request',
            message: `Unknown tool-plus endpoint: ${endpoint}`,
            details: { issues: [] },
          },
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
