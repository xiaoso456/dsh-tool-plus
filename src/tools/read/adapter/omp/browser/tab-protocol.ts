/**
 * DSH adapter type shim for OMP `tools/browser/tab-protocol.ts`.
 *
 * 拍板#16 (2026-08-25): 浏览器工具链整体删除，不移植。read-pdf.ts（verbatim）
 * 仅类型引用 `ScreenshotResult`，故保留最小类型面。
 */
export type Transferable = unknown

export interface ObservationEntry {
  kind: string
  text?: string
}

export interface Observation {
  entries: ObservationEntry[]
}

export interface ScreenshotResult {
  dest: string
  mimeType: string
  bytes: number
  width: number
  height: number
}

export interface SessionSnapshot {
  cwd: string
  browserScreenshotDir?: string
}

export interface Transport {
  kind: string
}
