/**
 * DSH adapter type shim for OMP `tools/index.ts`.
 *
 * The original is the 746-line OMP tool-registry barrel (imports every
 * built-in tool and re-exports the whole toolbox). read/write only consume
 * its `ToolSession` and `Tool` types, so the shim re-exports those from the
 * DSH adapter (`../sdk`) and pi-agent-core. No tool registries are carried.
 *
 * NOTE (step.md 决策记录): registry barrel intentionally not ported —
 * decision pending user confirmation.
 */
import type { AgentTool } from '@oh-my-pi/pi-agent-core'
import type { Settings } from '../config/settings.ts'

export type { ToolSession } from '../sdk.ts'
export type { Settings }

export type Tool = AgentTool<any, any, any>
