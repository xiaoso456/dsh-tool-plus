/**
 * DSH adapter stub for OMP `tools/browser/tab-supervisor.ts`.
 *
 * 拍板#16 (2026-08-25): 浏览器工具链整体删除，不移植。read-pdf.ts（verbatim）
 * 在 PDF 页面截图路径动态 import 本模块，故保留最小类型面 + 明示不支持抛错。
 */
import { ToolError } from '../../../omp/tools/tool-errors.ts'
import type { ToolSession } from '../../../omp/sdk.ts'
import type { BrowserHandle } from './registry.ts'

export interface RunInTabOptions {
  code: string
  timeoutMs: number
  signal?: AbortSignal
  session: ToolSession
}

export interface RunResultOk {
  screenshots: import('./tab-protocol.ts').ScreenshotResult[]
  observations?: import('./tab-protocol.ts').ObservationEntry[]
}

export interface ReleaseTabOptions {
  kill?: boolean
  timeoutMs?: number
}

/** DSH: no browser tool — cannot acquire a tab. */
export async function acquireTab(
  _name: string,
  _browser: BrowserHandle,
  _opts: Record<string, unknown>,
): Promise<void> {
  throw new ToolError('DSH has no browser tool: tab sessions are unavailable.')
}

export async function releaseTab(_name: string, _opts?: ReleaseTabOptions): Promise<void> {
  /* no-op */
}

export async function runInTab(_name: string, _opts: RunInTabOptions): Promise<RunResultOk> {
  throw new ToolError('DSH has no browser tool: running code in a tab is unavailable.')
}
