/**
 * DSH adapter for OMP `tools/acp-bridge.ts`.
 *
 * OMP routes writes through the ACP (agent client protocol) bridge when an
 * external host is attached. DSH has no ACP bridge (plan.md 判定去掉), so
 * `routeWriteThroughBridge` always returns `undefined` (not routed) and
 * writes proceed through the local ctx.fs path.
 */
import type { ToolSession } from '../../../omp/tools/index.ts'

/** Result of a bridge-routed write (verbatim OMP shape; never produced in DSH). */
export interface BridgeWriteResult {
  /** Content actually present on disk immediately after the bridge write. */
  text: string
  /** `true` when `text` differs from the content the tool asked to write. */
  driftedFromRequest: boolean
}

/**
 * Route a write through the ACP bridge. DSH has no ACP — always returns
 * undefined so the caller uses its local write path.
 */
export async function routeWriteThroughBridge(
  _session: ToolSession,
  _requestedPath: string,
  _absolutePath: string,
  _content: string,
  _signal?: AbortSignal,
): Promise<BridgeWriteResult | undefined> {
  return undefined
}
