/**
 * DSH adapter type shim for OMP `tools/index.ts`.
 *
 * The original `tools/index.ts` is the 746-line OMP tool registry barrel
 * (tools every built-in tool registers and re-exports). read/write only
 * reference its `ToolSession` and `Tool` types, so the shim re-exports just
 * those from the DSH adapter (`../sdk`) and pi-agent-core.
 *
 * NOTE (step.md 决策记录): OMP 工具注册中心不随 read/write 移植——待用户确认。
 */
import type { AgentTool } from '@oh-my-pi/pi-agent-core'
import type { Settings } from '../config/settings.ts'

export type { ToolSession } from '../sdk'
export type { Settings }

export type Tool = AgentTool<any, any, any>
