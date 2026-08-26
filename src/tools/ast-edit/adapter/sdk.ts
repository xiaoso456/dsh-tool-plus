/**
 * DSH adapter for OMP's `sdk.ts` — the `ToolSession` interface the ast_edit
 * engine consumes.
 *
 * ast_edit reuses the read engine's tool-scope resolver (`resolveToolSearchScope`
 * from `src/tools/read/adapter/omp/path-utils.ts`) and the hashline snapshot
 * store (`getFileSnapshotStore` from `src/tools/edit/adapter/omp/`), so this
 * session facade only declares the members those engines actually touch. DSH
 * supplies the session adapter (`src/tools/ast-edit/adapter/index.ts`); the
 * resolve/apply queue, local:// router, skills, and snapshot store are DSH-side
 * and optional (absent → preview-apply resolution is inert, matching read).
 */
import type { Settings } from '../../omp/config/settings.ts'
import type { Skill } from '../../omp/extensibility/skills.ts'
import type { AgentToolResult } from '@oh-my-pi/pi-agent-core'
import type { Model } from '@oh-my-pi/pi-ai'

/** Tool-choice queue for staged resolution previews (DSH: never present). */
export interface ToolChoiceQueueLike {
  registerPendingInvoker: (id: string, toolName: string, invoker: ResolveInvoker) => void
  removePendingInvoker: (id: string) => void
}

/** Staged resolution invocation runner (DSH: never present). */
export type ResolveInvoker = (invocation: unknown) => Promise<AgentToolResult<unknown>>

/**
 * Minimal ToolSession surface used by the OMP ast_edit engine (verbatim member
 * shapes). DSH provides a session adapter implementing this interface.
 */
export interface ToolSession {
  /** Current working directory */
  cwd: string
  /** Whether LSP integrations are enabled (DSH: false — no LSP) */
  enableLsp?: boolean
  /** Whether an edit-capable tool is available (controls hashline output) */
  hasEditTool?: boolean
  /** Session settings (read keys and edit keys; DSH maps them onto tool-plus config). */
  settings: Settings
  /** Active model string for edit-mode resolution (optional in DSH). */
  getActiveModelString?: () => string | undefined
  /** Active model object (optional in DSH). */
  getActiveModel?: () => Model | undefined
  /** Hashline snapshot store (created lazily by the engine). */
  fileSnapshotStore?: import('@oh-my-pi/hashline').InMemorySnapshotStore
  /** Local protocol options (DSH has no local:// sandbox — optional). */
  localProtocolOptions?: import('../../omp/internal-urls/index.ts').LocalProtocolOptions
  /** Pre-loaded skills (DSH: none). */
  skills?: readonly Skill[]
  /** Tool-choice queue (resolution devices; DSH: adapter-installed, captures the apply). */
  getToolChoiceQueue?: () => ToolChoiceQueueLike | undefined
  /** Captured preview-apply invoker (DSH resolve channel, plan.md 拍板#14). */
  pendingInvoker?: () => Promise<AgentToolResult<unknown>>
}
