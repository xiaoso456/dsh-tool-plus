/**
 * DSH adapter for OMP `extensibility/custom-tools/types.ts`.
 *
 * The write adapter's web-search / exa chain (copied verbatim) references
 * `RenderResultOptions`, `CustomToolResult` and `CustomTool` from this module.
 * DSH has no custom-tool extensibility system, so the shim keeps the verbatim
 * type shapes needed by those copied modules and omits the deeper
 * extensibility surface (factories, session contexts, model registry chains).
 */
import type { AgentToolResult, AgentToolUpdateCallback, ToolApproval, ToolLoadMode } from '@oh-my-pi/pi-agent-core'
import type { Static, TSchema } from '@oh-my-pi/pi-ai'

/** Options passed to tool result renderers (verbatim OMP shape). */
export interface RenderResultOptions {
  /** Whether the result view is expanded */
  expanded: boolean
  /** Whether this is a partial/streaming result */
  isPartial: boolean
  /** Current spinner frame index for animated elements (0-9, only provided during partial results) */
  spinnerFrame?: number
}

/** Custom tool result (verbatim OMP alias). */
export type CustomToolResult<TDetails = any> = AgentToolResult<TDetails>

/** Minimal execution context (DSH: custom-tool system absent — structural only). */
export interface CustomToolContext {
  model?: unknown
  settings?: unknown
  fetch?: unknown
  autoApprove?: boolean
  modelRegistry?: import('../../config/model-registry.ts').ModelRegistry
  sessionManager: { getSessionId(): string }
}

/**
 * Custom tool definition (verbatim OMP type surface, structurally reduced to
 * the members the DSH web-search chain references). Not driven in DSH.
 */
export interface CustomTool<TParams extends TSchema = TSchema, TDetails = any> {
  name: string
  label: string
  strict?: boolean
  description: string
  parameters: TParams
  hidden?: boolean
  loadMode?: 'discoverable' | 'essential'
  deferrable?: boolean
  mcpServerName?: string
  mcpToolName?: string
  approval?: ToolApproval
  formatApprovalDetails?: (args: unknown) => string | string[] | undefined
  execute(
    toolCallId: string,
    params: any,
    onUpdate?: AgentToolUpdateCallback<TDetails, TParams>,
    ctx?: CustomToolContext,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<TDetails>>
  /** Custom rendering for tool call display (DSH: unused). */
  renderCall?: (args: Static<TParams>, options: RenderResultOptions, theme: import('../../modes/theme/theme.ts').Theme) => import('@oh-my-pi/pi-tui').Component
  /** Custom rendering for tool result display (DSH: unused). */
  renderResult?: (
    result: CustomToolResult<TDetails>,
    options: RenderResultOptions,
    theme: import('../../modes/theme/theme.ts').Theme,
    args?: Static<TParams>,
  ) => import('@oh-my-pi/pi-tui').Component
}
