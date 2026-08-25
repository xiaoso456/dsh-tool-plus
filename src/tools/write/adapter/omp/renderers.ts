/**
 * DSH adapter type shim for OMP `tools/renderers.ts`.
 *
 * Original is the TUI renderer registry for all built-in tools (plan.md:
 * TUI 渲染去掉). xdev.ts only type-imports `ToolRenderer`, so the shim keeps
 * the verbatim type shape without the 35-tool registry.
 */
import type { Component } from '@oh-my-pi/pi-tui'
import type { RenderResultOptions } from '../extensibility/custom-tools/types.ts'
import type { Theme } from '../modes/theme/theme.ts'

export type FirstResultViewportRepaint = boolean | ((args: unknown, options: RenderResultOptions) => boolean)

export type ToolRenderer = {
  renderCall: (args: unknown, options: RenderResultOptions, theme: Theme) => Component
  renderResult: (
    result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
    options: RenderResultOptions & { renderContext?: Record<string, unknown> },
    theme: Theme,
    args?: unknown,
  ) => Component
  mergeCallAndResult?: boolean
  inline?: boolean
  animatedPendingPreview?: boolean | ((args: unknown) => boolean)
  animatedPartialResult?: boolean | ((args: unknown) => boolean)
  forceFirstResultViewportRepaint?: FirstResultViewportRepaint
  forceResultViewportRepaintOnSettle?: boolean
}
