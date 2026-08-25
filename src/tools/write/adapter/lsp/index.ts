/**
 * DSH adapter for OMP's `lsp/index.ts` + `lsp/writethrough.ts` surface.
 *
 * OMP routes every edit/write through an LSP writethrough (format +
 * diagnostics). DSH has no LSP infrastructure (plan.md §3 cuts LSP), so the
 * writethrough callback performs the actual file write directly — the edit
 * itself is fully functional; formatting/diagnostics simply do not exist as
 * a DSH capability.
 */
import type { FileDiagnosticsResult } from './types.ts'

export type { FileDiagnosticsResult } from './types.ts'

/** Per-file deferred LSP diagnostics wiring (no LSP in DSH — inert). */
export interface WritethroughDeferredHandle {
  onDeferredDiagnostics: (diagnostics: FileDiagnosticsResult) => void
  signal: AbortSignal
  finalize: (diagnostics: FileDiagnosticsResult | undefined) => void
}

/** LSP batch request handle (no LSP in DSH — inert). */
export interface LspBatchRequest {
  id: string
  flush: boolean
}

/**
 * Callback type for the LSP writethrough. DSH's writethrough writes the
 * content to `dst` (via the provided file handle when present) and returns
 * no diagnostics.
 */
export type WritethroughCallback = (
  dst: string,
  content: string,
  signal?: AbortSignal,
  file?: { write(content: string): Promise<void> },
  batch?: LspBatchRequest,
  getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
) => Promise<FileDiagnosticsResult | undefined>

/** Write `content` to `dst` (or the passed file handle) — no LSP pass. */
export async function writethroughNoop(
  dst: string,
  content: string,
  _signal?: AbortSignal,
  file?: { write(content: string): Promise<void> },
  _batch?: LspBatchRequest,
  _getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
): Promise<FileDiagnosticsResult | undefined> {
  if (file) {
    await file.write(content)
  } else {
    await writeFileUtf8(dst, content)
  }
  return undefined
}

/** Async UTF-8 write (node:fs) used when no file handle is supplied. */
export async function writeFileUtf8(dst: string, content: string): Promise<void> {
  const { writeFile, mkdir } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  try {
    await writeFile(dst, content, 'utf8')
  } catch (err) {
    // Parent dirs may not exist yet — create them and retry once.
    if (err && typeof err === 'object' && (err as { code?: string }).code === 'ENOENT') {
      await mkdir(dirname(dst), { recursive: true })
      await writeFile(dst, content, 'utf8')
      return
    }
    throw err
  }
}

/** Flush a batched LSP write (no-op for DSH — no diagnostics). */
export async function flushLspWritethroughBatch(
  _batchId: string,
  _cwd: string,
  _signal?: AbortSignal,
): Promise<FileDiagnosticsResult | undefined> {
  return undefined
}

/**
 * Create an LSP writethrough callback (DSH: plain write, no diagnostics).
 */
export function createLspWritethrough(
  _cwd: string,
  _options?: {
    enableFormat?: boolean
    enableDiagnostics?: boolean
    transformDiagnostics?: (absPath: string, result: FileDiagnosticsResult) => FileDiagnosticsResult
  },
): WritethroughCallback {
  return writethroughNoop
}
