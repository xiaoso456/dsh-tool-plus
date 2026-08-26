/**
 * DSH adapter for OMP `sdk.ts` — the `ToolSession` interface consumed by the
 * tool-plus engines (read/write/grep/glob/edit).
 *
 * Shared superset: read/write/grep/glob adapter copies declared the members
 * their engine touches; this shared copy keeps the union (read's xdev /
 * conflict-history, grep/glob's `getSessionSpawns`, edit's `noopLoopGuard`).
 * DSH provides a session adapter implementing this interface.
 */
import type { Settings } from './config/settings.ts'
import type { Skill } from './extensibility/skills.ts'
import type { XdevState } from './tools/xdev.ts'
import type { ConflictHistory } from './tools/conflict-detect.ts'
import type { Model } from '@oh-my-pi/pi-ai'

declare module '@oh-my-pi/pi-agent-core' {
  interface AgentToolContext {
    hasUI?: boolean
    toolNames?: string[]
    /** Session settings (cross-module nominal Settings — typed loosely). */
    settings?: any
    /** Session manager (DSH: none). */
    sessionManager?: {
      saveArtifact: (text: string, toolName: string) => Promise<string | undefined>
    }
    /** Set on xd:// device dispatches (DSH: never set). */
    xdevApproved?: boolean
  }
}

/**
 * Minimal ToolSession surface used by the OMP engines (verbatim member
 * shapes, shared superset). DSH provides a session adapter implementing
 * this interface.
 */
export interface ToolSession {
  /** Current working directory */
  cwd: string
  /** Whether an edit-capable tool is available (controls hashline output) */
  hasEditTool?: boolean
  /** Session settings (read.* keys; DSH maps them onto tool-plus config). */
  settings: Settings
  /** Active model string for mode resolution (optional in DSH). */
  getActiveModelString?: () => string | undefined
  /** Active model object (image-capability checks; optional in DSH). */
  getActiveModel?: () => Model | undefined
  /** Clipboard state carried on the session (hashline clipboard). */
  editClipboard?: Record<string, unknown>
  /** Hashline snapshot store (created lazily by the engine). */
  fileSnapshotStore?: import('@oh-my-pi/hashline').InMemorySnapshotStore
  /** Plan-mode state (DSH plan is a hint layer — never enabled). */
  getPlanModeState?: () => { enabled: boolean; planFilePath: string } | undefined
  /** Plan reference path (DSH: none). */
  getPlanReferencePath?: () => string | null
  /** Local protocol options (DSH has no local:// sandbox — optional). */
  localProtocolOptions?: import('./internal-urls/index.ts').LocalProtocolOptions
  getArtifactsDir?: () => string | null
  /** Allocate a new artifact path (DSH: none). */
  allocateOutputArtifact?: (toolType: string) => Promise<{ id?: string; path?: string }>
  getSessionId?: () => string | null
  /** Session spawn policy (DSH: none — engines fall back to `"*"`). */
  getSessionSpawns?: () => string | boolean | null | undefined
  /** Hashline no-op loop guard state (edit engine; created lazily). */
  noopLoopGuard?: import('./edit/hashline/noop-loop-guard.ts').NoopLoopGuard
  /** Fetch implementation for URL reads (DSH: global fetch). */
  fetch?: typeof globalThis.fetch
  /** Tool-choice queue (resolution devices; DSH: none). */
  getToolChoiceQueue?: () => ToolChoiceQueueLike | undefined
  /** Plan-proposal handler (resolution devices; DSH: none). */
  peekPlanProposalHandler?: () => PlanProposalHandler | undefined
  /** Queued/pending invocation peek (resolution devices; DSH: none). */
  peekQueueInvoker?: () => ResolveInvoker | undefined
  peekPendingInvoker?: () => ResolveInvoker | undefined
  /** Clear pending invokers (resolution devices; DSH: none). */
  clearPendingInvokers?: () => void
  /** Whether a built-in tool is active in this turn's tool set. */
  isToolActive?: (name: string) => boolean
  /** Pre-loaded skills (DSH: none). */
  skills?: readonly Skill[]
  /** Auth storage for search providers (DSH: none). */
  authStorage?: import('@oh-my-pi/pi-ai').AuthStorage
  /** Conflict history for conflict:// write-back (DSH: absent). */
  conflictHistory?: ConflictHistory
  /** `xd://` presentation state (DSH: no X dev protocol — absent). */
  xdev?: XdevState
}

/** Tool-choice queue for staged resolution previews (DSH: never present). */
export interface ToolChoiceQueueLike {
  registerPendingInvoker: (id: string, toolName: string, invoker: ResolveInvoker) => void
  removePendingInvoker: (id: string) => void
}

/** Plan-proposal approval handler (DSH: never present). */
export type PlanProposalHandler = (title: string) => Promise<import('@oh-my-pi/pi-agent-core').AgentToolResult<unknown>>

/** Staged resolution invocation runner (DSH: never present). */
export type ResolveInvoker = (invocation: unknown) => Promise<import('@oh-my-pi/pi-agent-core').AgentToolResult<unknown>>

/** DSH: no auth storage discovery — search providers have no credentials. */
export async function discoverAuthStorage(_agentDir?: string): Promise<import('@oh-my-pi/pi-ai').AuthStorage> {
  // DSH has no agent auth storage; the verbatim engine throws
  // "Failed to initialize authentication storage" when it is absent.
  return undefined as unknown as import('@oh-my-pi/pi-ai').AuthStorage
}
