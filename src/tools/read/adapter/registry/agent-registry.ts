/**
 * DSH adapter interface shim for OMP `registry/agent-registry.ts`.
 *
 * The original (312 lines) is the process-global agent registry (main session +
 * subagents) backing `agent://` / `history://` internal protocols, IRC routing,
 * and the agent hub. DSH has no OMP internal agent protocol routing (plan.md:
 * internal URLs canHandle=false), so the registry is a clearly-removed
 * capability and only a minimal surface is kept: `global()` returns an empty
 * registry whose `list()`/`get()` resolve to nothing, so the verbatim OMP
 * `internal-urls/local-protocol.ts` and `registry-helpers.ts` copies compile
 * and their registry lookups short-circuit to "no sessions".
 */
export interface AgentRegistryRef {
  id: string
  kind: 'main' | 'sub' | 'advisor'
  session?: { sessionManager?: { getArtifactsDir(): string | null; getSessionId(): string | null } } | null
  sessionFile?: string | null
}

export class AgentRegistry {
  static #global: AgentRegistry | undefined

  static global(): AgentRegistry {
    if (!AgentRegistry.#global) {
      AgentRegistry.#global = new AgentRegistry()
    }
    return AgentRegistry.#global
  }

  get(_id: string): AgentRegistryRef | undefined {
    return undefined
  }

  list(): AgentRegistryRef[] {
    return []
  }
}
