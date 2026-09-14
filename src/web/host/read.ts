/**
 * Host projection for the `read` card: the OMP engine already hands the renderer
 * a prefix-free window (`details.displayContent` —
 * `{text, startLine, lineNumbers?}`) exactly so the UI can draw its own gutter,
 * and that is what the shipped read card consumes
 * (`{kind:'read', path, offset, lines, totalLines, lang?}`).
 *
 * Three details drive the projection:
 *  - the card path must be the file, never the model-facing argument: the OMP
 *    argument carries an inline selector (`src/foo.ts:5-16,40-80`, `:raw`), so
 *    the selector is stripped from whatever path source wins;
 *  - `lineNumbers[i] === null` marks an elided span (the body renders `…`); such
 *    entries carry no file line number and must be dropped, or the card's
 *    "strictly increasing" rule breaks;
 *  - only local, text-like reads take the card. Images, directories, internal
 *    URLs (`skill://`, `conflict://N`, …), web URLs, SQLite, archives and
 *    converted documents all fall back to the generic shell.
 *
 * The projection is bounded: past {@link READ_META_MAX_BYTES} whole trailing
 * lines are dropped, and an empty window projects to `null` rather than to an
 * empty card.
 *
 * @module @xiaoso/dsh-tool-plus/web/host/read
 */

import * as path from 'node:path'
import { READ_META_MAX_BYTES, capTail } from '../contract.ts'
import type { CardReadLine, ReadCardMeta } from '../contract.ts'
import { getLanguageFromPath } from '../../tools/omp/utils/lang-from-path.ts'

/** `scheme://` — `file://` is still a local read; every other scheme is not. */
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i

/**
 * Extensions whose reads are never a plain line window: SQLite and archive
 * readers (`omp/tools/sqlite-reader.ts`, `read/adapter/omp/tools/read-archive.ts`)
 * and markit document conversions (`omp/utils/markit.ts` CONVERTIBLE_EXTENSIONS)
 * all render their own body, so a line-numbered card would misrepresent them.
 */
const NON_TEXT_EXTENSIONS = new Set([
  '.sqlite', '.sqlite3', '.db', '.db3',
  '.zip', '.jar', '.war', '.ear', '.apk', '.tar', '.tgz',
  '.pdf', '.docx', '.pptx', '.xlsx', '.epub',
])

/** Whether `value` is a plain object (never `null` or an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A positive integer, or `undefined`. */
function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined
}

/** Non-blank string, or `undefined`. */
function nonBlankString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Whether the colon at `index` separates a Windows drive letter from its path. */
function isDriveColon(target: string, index: number): boolean {
  if (index < 1 || !/[a-zA-Z]/.test(target[index - 1] ?? '')) return false
  const next = target[index + 1]
  if (next !== '/' && next !== '\\') return false
  const before = index >= 2 ? target[index - 2] : undefined
  return before === undefined || before === '/' || before === '\\'
}

/**
 * Strip the model-facing inline selector from a read target, leaving the file
 * path the card should show.
 *
 * Handles `:5-16,40-80`, `:raw`, `:50+150`, `:conflicts` and the SQLite/archive
 * sub-selectors (`db.sqlite:table:key`), plus the `file://` form the engine
 * itself expands. Windows drive letters survive.
 * @param target - the raw read target (`args.path`, or a resolved path).
 * @returns the path without its selector.
 */
export function stripReadSelector(target: string): string {
  let value = target.trim()
  if (/^file:\/\//i.test(value)) value = value.slice('file://'.length)

  let end = value.length
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== ':') continue
    // A scheme colon (`conflict://`) is not a selector.
    if (value[index + 1] === '/' && value[index + 2] === '/') continue
    if (isDriveColon(value, index)) continue
    end = index
    break
  }

  let base = value.slice(0, end)
  // `file:///C:/x/y.ts` leaves `/C:/x/y.ts`; the leading slash is the URL root.
  if (/^\/[a-zA-Z]:[\\/]/.test(base)) base = base.slice(1)
  return base
}

/** Whether the target names something other than a local file path. */
function isNonLocalTarget(target: string): boolean {
  const scheme = SCHEME_RE.exec(target.trim())
  return scheme !== null && scheme[1]!.toLowerCase() !== 'file'
}

/** Whether the path is one of the non-text extension families above. */
function hasNonTextExtension(target: string): boolean {
  const lower = target.toLowerCase()
  if (/\.tar\.gz$/.test(lower)) return true
  return NON_TEXT_EXTENSIONS.has(path.extname(lower))
}

/** Read the display window into strictly increasing, numbered lines. */
function readWindowLines(text: string, startLine: number, rawNumbers: unknown): CardReadLine[] {
  if (text === '') return []
  const textLines = text.split('\n')
  const numbers = Array.isArray(rawNumbers) ? rawNumbers : undefined
  const lines: CardReadLine[] = []

  for (let index = 0; index < textLines.length; index += 1) {
    const number = numbers === undefined ? startLine + index : positiveInteger(numbers[index])
    // Elided spans (and anything else without a file line number) carry no line.
    if (number === undefined) continue
    if (lines.length > 0 && number <= lines[lines.length - 1]!.number) continue
    lines.push({ number, text: textLines[index] ?? '' })
  }

  return lines
}

/**
 * Project a read result value into read-card metadata.
 *
 * Every emitted field is plain JSON and no key is ever `undefined`: the metadata
 * rides `presentationMeta`, where a non-lossless payload turns a successful call
 * into a failed one. A non-text read, or a window without a single numbered
 * line, yields `null` and leaves the row on the generic shell.
 * @param args - the tool's arguments (only `path` is read).
 * @param value - the tool's output value, as the adapter projects it.
 * @returns the card metadata, or `null` when this read does not take the card.
 */
export function readCardMeta(args: unknown, value: unknown): ReadCardMeta | null {
  if (!isRecord(value)) return null
  // Images and directories render their own row / tree; several text blocks mean
  // this was a multi-target or enveloped read, not one line window.
  if (value.image !== undefined && value.image !== null) return null
  if (value.isDirectory === true) return null
  if (value.textBlocks !== undefined && value.textBlocks !== 1) return null

  const source = isRecord(value.source) ? value.source : undefined
  if (source !== undefined && (source.type === 'url' || source.type === 'internal')) return null

  const requested = isRecord(args) ? nonBlankString(args.path) : undefined
  if (requested !== undefined && isNonLocalTarget(requested)) return null

  const sourcePath = source !== undefined && source.type === 'path' ? nonBlankString(source.value) : undefined
  const resolved = nonBlankString(value.path)
  const raw = sourcePath ?? resolved ?? requested
  if (raw === undefined) return null

  const target = stripReadSelector(raw)
  if (target === '' || isNonLocalTarget(target) || hasNonTextExtension(target)) return null

  const display = isRecord(value.display) ? value.display : undefined
  const startLine = display === undefined ? undefined : positiveInteger(display.startLine)
  if (display === undefined || typeof display.text !== 'string' || startLine === undefined) return null

  const lines = readWindowLines(display.text, startLine, display.lineNumbers)
  if (lines.length === 0) return null

  // `totalLines` only exists on the paths that reached EOF; otherwise the last
  // returned line is the honest total (and keeps the card's range valid).
  const declaredTotal = positiveInteger(value.totalLines)
  const lastLine = lines[lines.length - 1]!.number
  const totalLines = declaredTotal !== undefined && declaredTotal >= lastLine ? declaredTotal : lastLine
  const language = getLanguageFromPath(target)

  const build = (kept: readonly CardReadLine[]): ReadCardMeta => ({
    kind: 'read',
    path: target,
    offset: kept[0]?.number ?? lines[0]!.number,
    lines: [...kept],
    totalLines,
    ...language === undefined || language === '' ? {} : { lang: language },
  })

  const retained = capTail(lines, READ_META_MAX_BYTES, build)
  return retained.length === 0 ? null : build(retained)
}
