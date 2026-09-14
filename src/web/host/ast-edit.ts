/**
 * `ast_edit` tool card: project the engine's own change preview plus its
 * counters into the `{kind:'ast_edit'}` meta this plugin's browser half
 * consumes (plan §4.3).
 *
 * The engine renders a preview (`displayContent`: grouped hits with a `│` line
 * gutter) for exactly the replacements it found, so the card reuses that text
 * verbatim instead of sampling `before`/`after`. The preview is bounded by
 * {@link AST_EDIT_META_MAX_BYTES}: past that budget the text is truncated (the
 * file list and counters survive), and if even an empty preview cannot fit the
 * payload, trailing files are dropped.
 *
 * Zero-dependency by design (no React, no Node built-ins beyond the contract's
 * own helpers), so the Node half can import it from `presentationMeta` without
 * dragging anything into the browser bundle.
 *
 * Defensive: a card never throws and never emits `undefined` values (the host
 * rejects non-lossless metadata and turns a successful call into an error); no
 * replacement, or no preview text, projects to `null` so the row falls back to
 * the generic shell.
 *
 * @module @xiaoso/dsh-tool-plus/web/host/ast-edit
 */
import { AST_EDIT_META_MAX_BYTES, capTail, capText, jsonByteLength } from '../contract.ts'
import type { AstEditCardMeta } from '../contract.ts'

/** `value` as a plain record, or `null` (arrays, `null` and primitives drop). */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Non-negative integer, or `null`. */
function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/** Non-blank string, or `null`. */
function nonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** The engine's `fileReplacements[{path,count}]`, malformed entries dropped. */
function projectFiles(value: unknown): { path: string; count: number }[] {
  if (!Array.isArray(value)) return []
  const files: { path: string; count: number }[] = []
  for (const entry of value) {
    const file = asRecord(entry)
    if (file === null) continue
    const path = nonBlankString(file.path)
    const count = nonNegativeInteger(file.count)
    if (path === null || count === null) continue
    files.push({ path, count })
  }
  return files
}

/**
 * Total replacements: the engine's own count when present, else the file
 * counts' sum (a missing array then counts as zero).
 */
function replacementsOf(record: Record<string, unknown>, files: readonly { count: number }[]): number {
  const reported = nonNegativeInteger(record.totalReplacements)
  if (reported !== null) return reported
  return files.reduce((total, file) => total + file.count, 0)
}

/**
 * Build the payload within {@link AST_EDIT_META_MAX_BYTES}.
 *
 * Trailing files are dropped first (the counters survive), then the preview
 * gets every remaining byte. The preview budget is found by binary search over
 * `capText` — the raw text is measured in UTF-8 bytes while the payload is
 * measured as JSON, and escaping can inflate the latter, so spending the exact
 * cap on text is not enough.
 */
function fitAstEditMeta(
  raw: string,
  files: readonly { path: string; count: number }[],
  replacements: number,
  applied: boolean,
): AstEditCardMeta | null {
  const build = (preview: string, retained: readonly { path: string; count: number }[]): AstEditCardMeta => ({
    kind: 'ast_edit',
    preview,
    files: [...retained],
    replacements,
    applied,
  })
  const retained = capTail(files, AST_EDIT_META_MAX_BYTES, kept => build('', kept))
  const fits = (budget: number): boolean =>
    jsonByteLength(build(capText(raw, budget), retained)) <= AST_EDIT_META_MAX_BYTES

  if (!fits(0)) return null
  let low = 0
  let high = AST_EDIT_META_MAX_BYTES
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (fits(mid)) low = mid
    else high = mid - 1
  }
  return build(capText(raw, low), retained)
}

/**
 * Project the ast_edit engine's result into card metadata.
 * @param details - the engine's `displayContent` / `fileReplacements` /
 *   `totalReplacements` / `applied` fields (the adapter's value carries the
 *   same names).
 * @returns the ast_edit card metadata, or `null` when the call previews no
 *   replacement or produced no preview text.
 */
export function projectAstEditCardMeta(details: unknown): AstEditCardMeta | null {
  const record = asRecord(details)
  if (record === null) return null
  const preview = nonBlankString(record.displayContent)
  if (preview === null) return null
  const files = projectFiles(record.fileReplacements)
  const replacements = replacementsOf(record, files)
  if (replacements <= 0) return null
  return fitAstEditMeta(preview, files, replacements, record.applied === true)
}
