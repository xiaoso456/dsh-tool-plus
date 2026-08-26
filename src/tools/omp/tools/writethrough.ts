/**
 * File-write channel for the write/edit engines.
 *
 * OMP routes every edit/write through an LSP writethrough (format +
 * diagnostics). DSH has no LSP infrastructure (plan.md 拍板#5 cuts LSP), so
 * the channel performs the actual file write directly: the edit itself is
 * fully functional; formatting/diagnostics simply do not exist as a DSH
 * capability. LSP-only parameters (batch request, deferred-diagnostics
 * handle) are not part of the DSH signature.
 */

/**
 * Callback type for the file write channel. DSH's writethrough writes the
 * content to `dst` (via the provided file handle when present) and returns
 * nothing.
 */
export type WritethroughCallback = (
  dst: string,
  content: string,
  signal?: AbortSignal,
  file?: { write(content: string): Promise<void> },
) => Promise<void>

/** Write `content` to `dst` (or the passed file handle) — no LSP pass. */
export async function writethroughNoop(
  dst: string,
  content: string,
  _signal?: AbortSignal,
  file?: { write(content: string): Promise<void> },
): Promise<void> {
  if (file) {
    await file.write(content)
  } else {
    await writeFileUtf8(dst, content)
  }
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
