/**
 * DSH adapter type shim for OMP `tools/index.ts`.
 *
 * The original `tools/index.ts` is the 746-line OMP tool registry barrel.
 * The write adapter's hand-written `tools/*` shims (and `utils/*`, `web/*`
 * which import through `../tools/`) only reference its `ToolSession` and
 * `Tool` types, so this shim re-exports just those from the DSH adapter
 * (`../sdk`) and pi-agent-core.
 *
 * NOTE (step.md 决策记录): OMP 工具注册中心不随 read/write 移植——待用户确认。
 */
import type { AgentTool } from '@oh-my-pi/pi-agent-core'

export type { ToolSession } from '../sdk'

export type Tool = AgentTool<any, any, any>

/**
 * A late LSP diagnostics result that arrived after the edit/write tool already
 * returned (verbatim OMP surface). Surfaced via
 * {@link ToolSession.queueDeferredDiagnostics}; DSH never produces LSP
 * diagnostics (LSP is pointed off), so this type is only referenced, never
 * constructed.
 */
export interface DeferredDiagnosticsEntry {
  /** Absolute path the diagnostics belong to (the renderer shortens it). */
  path: string
  /** One-line severity summary, e.g. "2 errors". */
  summary: string
  /** Formatted, ready-to-display diagnostic lines. */
  messages: string[]
  /** True when any message is error severity. */
  errored: boolean
  /**
   * Evaluated at injection time (in the dispatcher's stale check): drop the
   * entry when a newer mutation to the same file has superseded it.
   */
  isStale(): boolean
}
