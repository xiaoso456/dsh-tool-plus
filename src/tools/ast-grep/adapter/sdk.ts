/**
 * DSH adapter for OMP's `sdk.ts` — the `ToolSession` interface the ast_grep
 * engine consumes.
 *
 * ast_grep is a read-only AST search tool. It reuses the read engine's tool
 * scope resolver (`resolveToolSearchScope` from
 * `src/tools/read/adapter/omp/path-utils.ts`), the hashline snapshot store
 * (`recordFileSnapshot`/`recordSeenLinesFromBody` from
 * `src/tools/edit/adapter/omp/file-snapshot-store.ts`), and the display-mode
 * resolver (`resolveFileDisplayMode`), so this session facade declares exactly
 * those members. DSH supplies the session adapter
 * (`src/tools/ast-grep/adapter/index.ts`); the local:// router, skills, and
 * snapshot store are DSH-side and optional (absent → read-scope resolution and
 * hashline recording are inert, matching read). `getSessionSpawns` feeds the
 * scout-spawnability hint in the tool description (`isScoutSpawnable`); when
 * absent DSH defaults to unrestricted (`"*"`).
 */
import type { Settings } from '../../read/adapter/config/settings.ts'
import type { Skill } from '../../read/adapter/extensibility/skills.ts'
import type { Model } from '@oh-my-pi/pi-ai'

/**
 * Minimal ToolSession surface used by the OMP ast_grep engine (verbatim member
 * shapes). DSH provides a session adapter implementing this interface.
 */
export interface ToolSession {
  /** Current working directory */
  cwd: string
  /** Whether an edit-capable tool is available (suppresses hashline output) */
  hasEditTool?: boolean
  /** Session settings (read keys and task keys; DSH maps them onto tool-plus config). */
  settings: Settings
  /** Active model string for edit-mode resolution (optional in DSH). */
  getActiveModelString?: () => string | undefined
  /** Active model object (optional in DSH). */
  getActiveModel?: () => Model | undefined
  /** Hashline snapshot store (created lazily by the engine). */
  fileSnapshotStore?: import('@oh-my-pi/hashline').InMemorySnapshotStore
  /** Local protocol options (DSH has no local:// sandbox — optional). */
  localProtocolOptions?: import('../../read/adapter/internal-urls/index.ts').LocalProtocolOptions
  /** Pre-loaded skills (DSH: none). */
  skills?: readonly Skill[]
  /** Session subagent-spawn policy string, used for the scout hint (optional in DSH). */
  getSessionSpawns?: () => string | null | undefined
}
