/**
 * DSH adapter type shim for OMP `registry/agent-registry.ts`.
 *
 * The original `AgentRegistry` is the process-global registry of agents
 * (main session + subagents). DSH has no OMP agent registry — `agent://` /
 * `local://` internal protocols are deliberately pointed off (canHandle=false,
 * plan.md §2). The write adapter's internal-urls handlers reference
 * `AgentRegistry.global()` only to discover session roots / agent transcripts;
 * with no registry these paths degrade to empty results (local:// unavailable).
 *
 * NOTE: the full OMP registry (lifecycle, persisted-agents, task refs) is not
 * ported. This shim provides the structural surface so `import` resolves and
 * `list()` returns no refs (agent:// / local:// resolve nothing in DSH).
 */

/** Kind of a registered agent ref (verbatim OMP surface). */
export type AgentKind = "main" | "sub" | "advisor"

/** Minimal registered-agent reference (verbatim OMP type surface). */
export interface AgentRef {
  id: string
  kind: AgentKind
  /** Live session manager, when the agent is in memory. */
  session?: {
    sessionManager?: {
      getArtifactsDir(): string | null
      getSessionId(): string | null
    }
  }
  /** Retained session file for parked/revivable agents. */
  sessionFile?: string
}

/**
 * Minimal process-global agent registry. DSH registers no OMP agents, so the
 * registry is always empty: `agent://` / `local://` resolve nothing.
 */
export class AgentRegistry {
  /** Get the process-global registry (always empty in DSH). */
  static global(): AgentRegistry {
    return AgentRegistry.#global
  }

  static #global = new AgentRegistry()

  /** No registered agents in DSH. */
  list(): AgentRef[] {
    return []
  }

  /** No registered agents in DSH. */
  get(_id: string): AgentRef | undefined {
    return undefined
  }
}
