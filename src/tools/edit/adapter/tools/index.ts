/**
 * DSH adapter for OMP's `tools/index.ts` — the `ToolSession` interface the
 * edit engine consumes.
 *
 * Only the members the edit engine actually touches are declared (verbatim
 * shapes where applicable); everything else in OMP's session (tools registry,
 * settings storage, LSP, MCP, IRC, …) is DSH-side and intentionally absent.
 */
import type { Settings } from '../config/settings.ts'

declare module '@oh-my-pi/pi-agent-core' {
  interface AgentToolContext {
    /** Tool-call batch context (DSH: present when the harness supplies it). */
    toolCall?: import('@oh-my-pi/pi-agent-core').ToolCallContext
    hasUI?: boolean
    toolNames?: string[]
  }
}

/** LSP batch request handle (no LSP in DSH — inert). */
export interface LspBatchRequest {
  id: string
  flush: boolean
}

/** Deferred diagnostics queue entry (no LSP in DSH — never populated). */
export interface DeferredDiagnosticsEntry {
  path: string
  summary: string
  messages: string[]
  errored: boolean
  isStale: () => boolean
}

/**
 * Minimal ToolSession surface used by the OMP edit engine (verbatim member
 * shapes). DSH provides a session adapter implementing this interface.
 */
export interface ToolSession {
  /** Current working directory */
  cwd: string
  /** Whether LSP integrations are enabled (DSH: false — no LSP) */
  enableLsp?: boolean
  /** Whether an edit-capable tool is available (controls hashline output) */
  hasEditTool?: boolean
  /** Session settings (edit.* keys; DSH maps them onto tool-plus config). */
  settings: Settings
  /** Active model string for edit-mode resolution (optional in DSH). */
  getActiveModelString?: () => string | undefined
  /** Clipboard state carried on the session (hashline clipboard). */
  editClipboard?: Record<string, unknown>
  /** Hashline snapshot store (created lazily by the engine). */
  fileSnapshotStore?: import('@oh-my-pi/hashline').InMemorySnapshotStore
  /** Hashline no-op loop guard state (created lazily by the engine). */
  noopLoopGuard?: import('../omp/hashline/noop-loop-guard.ts').NoopLoopGuard
  /** Diagnostics ledger (no LSP in DSH — inert but present for engine types). */
  diagnosticsLedger?: import('../lsp/diagnostics-ledger.ts').DiagnosticsLedger
  /** Queue deferred diagnostics (no LSP in DSH — optional, unused). */
  queueDeferredDiagnostics?: (entry: DeferredDiagnosticsEntry) => void
  /** Bump/read file mutation versions (no LSP in DSH — optional). */
  bumpFileMutationVersion?: (path: string) => number
  getFileMutationVersion?: (path: string) => number
  /** Plan-mode state (DSH plan is a hint layer — never enabled). */
  getPlanModeState?: () => { enabled: boolean } | undefined
  /** Local protocol options (DSH has no local:// sandbox — optional). */
  localProtocolOptions?: unknown
  getArtifactsDir?: () => string | null
  getSessionId?: () => string | null
}
