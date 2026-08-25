/**
 * DSH adapter type shim for OMP `tools/index.ts`.
 *
 * The original is the 746-line OMP tool-registry barrel (imports every built-in
 * tool and re-exports the whole toolbox). read/write only consume its
 * `ToolSession`, `DeferredDiagnosticsEntry`, and `Tool` types, so the shim
 * re-exports `ToolSession`/`DeferredDiagnosticsEntry` from the DSH adapter
 * (`../sdk`) and defines `Tool` from pi-agent-core. No tool registries are
 * carried.
 *
 * NOTE (step.md 决策记录): registry barrel intentionally not ported — decision
 * pending user confirmation. Mirrors `omp/index.ts`.
 */
import type { AgentTool } from '@oh-my-pi/pi-agent-core'

export type { ToolSession, DeferredDiagnosticsEntry } from '../sdk.ts'

export type Tool = AgentTool<any, any, any>
