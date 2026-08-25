/**
 * DSH adapter type shim for OMP `session/agent-storage.ts`.
 *
 * The original `AgentStorage` is a Bun-backed SQLite store (`bun:sqlite`,
 * `@oh-my-pi/pi-ai` SqliteAuthCredentialStore). DSH's write adapter only
 * references it as a **type** (`storage: AgentStorage | null` parameter
 * annotations); no adapter code constructs or drives it.
 *
 * NOTE: the real implementation is Bun-only and is left for the unified Bun
 * compatibility pass (step.md "Bun 兼容"). This shim provides the structural
 * type so `import type { AgentStorage }` resolves. Instantiating it throws.
 */
import type { StoredAuthCredential } from "@oh-my-pi/pi-ai"

/**
 * Agent session storage facade (verbatim OMP type surface).
 *
 * Only the members the write adapter references are declared; the full OMP
 * class (settings / model-usage / model-perf / credential rows) is Bun-only
 * and deferred to the Bun compatibility pass.
 */
export class AgentStorage {
  /** DSH: Bun-only SQLite storage is not instantiated. */
  constructor() {
    throw new Error(
      'AgentStorage is Bun-only and not available in DSH (Bun compatibility pass pending)',
    )
  }

  /** List stored credentials for a provider (verbatim OMP surface). */
  listAuthCredentials(provider?: string): StoredAuthCredential[] {
    throw new Error('AgentStorage is Bun-only and not available in DSH')
  }
}
