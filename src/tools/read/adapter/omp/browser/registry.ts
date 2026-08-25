/**
 * DSH adapter interface stub for OMP `tools/browser/registry.ts`.
 *
 * The original launches a shared headless-Chromium browser toolchain
 * (browser/ 全家 + puppeteer). 拍板#16 (2026-08-25): 浏览器工具链整体删除，
 * 不移植。read-pdf.ts（verbatim）仅在其 PDF 页面截图路径引用本模块的类型与
 * acquireBrowser，故此处保留最小类型面 + 明示不支持抛错（非静默 fallback）。
 */
import { ToolError } from '../tool-errors.ts'

export type PuppeteerBrowserKind =
  | { kind: 'headless'; headless: boolean }
  | { kind: 'spawned'; path: string }
  | { kind: 'connected'; cdpUrl: string }

export type BrowserKind = PuppeteerBrowserKind | { kind: string }

export interface BrowserHandleCommon {
  key: string
  kind: BrowserKind
  refCount: number
}

export interface PuppeteerBrowserHandle extends BrowserHandleCommon {
  kind: PuppeteerBrowserKind
  cdpUrl?: string
  pid?: number
}

export interface CmuxBrowserHandle extends BrowserHandleCommon {
  kind: { kind: string }
  surface?: string
}

export type BrowserHandle = PuppeteerBrowserHandle | CmuxBrowserHandle

export interface ReleaseBrowserOptions {
  kill?: boolean
  timeoutMs?: number
}

export interface AcquireBrowserOptions {
  cwd: string
  signal?: AbortSignal
  headless?: boolean
  kind?: string
}

/** DSH: no browser tool — PDF page rendering is unavailable. */
export async function acquireBrowser(
  _kind: BrowserKind,
  _opts?: Partial<AcquireBrowserOptions>,
): Promise<BrowserHandle> {
  throw new ToolError('DSH has no browser tool: PDF page screenshots are unavailable.')
}

export function holdBrowser(_browser: BrowserHandle): void {
  /* no-op: DSH has no browser handles */
}

export async function releaseBrowser(
  _browser: BrowserHandle,
  _opts?: ReleaseBrowserOptions,
): Promise<void> {
  /* no-op */
}

export function normalizeConnectedCdpUrl(rawCdpUrl: string): string {
  return rawCdpUrl
}
