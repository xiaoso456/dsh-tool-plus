/**
 * DSH adapter type shim for OMP `tools/index.ts`.
 *
 * The original is the 746-line OMP tool-registry barrel (imports every
 * built-in tool and re-exports the whole toolbox). The tool-plus adapters
 * only consume its `ToolSession` and `Tool` types, so this shared shim
 * re-exports those from the shared DSH adapter (`../sdk`) and pi-agent-core,
 * plus the edit adapter's LSP-batch surface. No tool registries are carried.
 *
 * NOTE (step.md 决策记录): registry barrel intentionally not ported —
 * decision pending user confirmation.
 */
import type { AgentTool } from '@oh-my-pi/pi-agent-core'
import type { Settings } from '../config/settings.ts'

declare module '@oh-my-pi/pi-agent-core' {
  interface AgentToolContext {
    /** Tool-call batch context (DSH: present when the harness supplies it). */
    toolCall?: import('@oh-my-pi/pi-agent-core').ToolCallContext
    hasUI?: boolean
    toolNames?: string[]
  }
}

export type { ToolSession } from '../sdk.ts'
export type { Settings }

export type Tool = AgentTool<any, any, any>

/** LSP batch request handle (no LSP in DSH — inert). */
export interface LspBatchRequest {
  id: string
  flush: boolean
}

/** Deferred diagnostics queue entry (no LSP in DSH — never populated). */
export type { DeferredDiagnosticsEntry } from '../sdk.ts'
