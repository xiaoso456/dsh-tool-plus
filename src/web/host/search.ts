/**
 * Host projection for the `grep` / `ast_grep` / `glob` search cards.
 *
 * The engines already render the display text the TUI used to read: the grouped
 * file output (`# dir/` / `## file.ts#<tag>` headers) followed by code-frame
 * body lines (`*12│text` for a match, ` 12│text` for context, `…` for a gap).
 * That text is the only place the matched *line numbers* live — `details` only
 * carries per-file counts — so the card is rebuilt by parsing it with the same
 * `classifyGroupedLines` helper the TUI renderers used, then reading each
 * `formatCodeFrameLine` gutter back.
 *
 * Everything is defensive and bounded:
 *  - an engine that explicitly reports zero (a `matchCount` of `0`, or an empty
 *    `paths` array backed by a zero count) is a *known empty result*: it projects
 *    to the empty card the client already renders, so the same tool never shows
 *    two different shells;
 *  - a display that yields no file group at all projects to `null` unless that
 *    zero was reported (the row then falls back to the generic shell — the result
 *    text stays fully visible);
 *  - the payload is capped at {@link SEARCH_META_MAX_BYTES} by dropping trailing
 *    groups/paths, with `truncated` raised and `total` left at its pre-cap value.
 *
 * @module @xiaoso/dsh-tool-plus/web/host/search
 */

import * as path from 'node:path'
import { SEARCH_META_MAX_BYTES, capTail } from '../contract.ts'
import type { CardSearchFileGroup, CardSearchMatchLine, SearchMatchesCardMeta, SearchPathsCardMeta } from '../contract.ts'
import { classifyGroupedLines } from '../../tools/omp/tools/grouped-file-output.ts'

/**
 * One rendered body line's gutter: optional `formatCodeFrameLine` match marker,
 * the 1-based line number, and the display separator. Both shipped modes end up
 * in `displayContent`, so the parser also accepts the model-facing `|` / `:`
 * separators an older engine version could emit.
 */
const CODE_FRAME_RE = /^\s*(\*?)(\d+)[│|:]([\s\S]*)$/

/** Whether `value` is a plain object (never `null` or an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Non-negative integer, or `undefined`. */
function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

/** The non-blank string `value` holds, or `undefined`. */
function nonBlankString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * The pre-cap total to report: the engine's own count when it is present and at
 * least what the display actually holds, otherwise the parsed count. The
 * metadata contract requires `total >= files.length`, and an engine count below
 * the parsed one only means the display and the count disagree.
 */
function reportedTotal(declared: unknown, parsed: number): number {
  const count = nonNegativeInteger(declared)
  return count !== undefined && count >= parsed ? count : parsed
}

/** One parsed code-frame body line, or `null` for headers/gaps/unparsable text. */
function parseFrameLine(line: string): { lineNumber: number; line: string; isMatch: boolean } | null {
  const match = CODE_FRAME_RE.exec(line)
  if (match === null) return null
  const lineNumber = Number(match[2])
  if (!Number.isInteger(lineNumber) || lineNumber < 1) return null
  return { lineNumber, line: match[3] ?? '', isMatch: match[1] === '*' }
}

/**
 * Parse one grouped display into per-file match groups, in first-seen order.
 *
 * Only `*`-marked body lines become matches; context lines and `…` gap lines are
 * dropped. A body line whose owning file cannot be resolved (a URL group, or a
 * display read without a session base) is skipped rather than attributed to the
 * wrong file.
 * @param display - the engine's `displayContent`.
 * @param base - directory the display-relative header paths are relative to (the session cwd).
 * @param fileScope - absolute path of the only file, for a display without headers.
 * @returns the match groups; empty when nothing could be attributed.
 */
function parseMatchGroups(
  display: string,
  base: string | undefined,
  fileScope: string | undefined,
): CardSearchFileGroup[] {
  const lines = display.split('\n')
  const contexts = classifyGroupedLines(lines, base, fileScope)
  const groups: CardSearchFileGroup[] = []
  const byPath = new Map<string, CardSearchFileGroup>()

  for (let index = 0; index < lines.length; index += 1) {
    const context = contexts[index]
    if (context === undefined || context.kind !== 'content') continue
    const parsed = parseFrameLine(lines[index] ?? '')
    if (parsed === null || !parsed.isMatch) continue
    const filePath = context.filePath
    if (typeof filePath !== 'string' || filePath === '') continue

    let group = byPath.get(filePath)
    if (group === undefined) {
      group = { path: filePath, matches: [] }
      byPath.set(filePath, group)
      groups.push(group)
    }
    const matchLine: CardSearchMatchLine = { lineNumber: parsed.lineNumber, line: parsed.line }
    group.matches.push(matchLine)
  }

  return groups
}

/**
 * The known-empty matches card: the engine explicitly reported `matchCount: 0`,
 * so there is no grouping to parse but the empty result itself is definitive.
 */
function emptyMatchesMeta(): SearchMatchesCardMeta {
  return { kind: 'search', shape: 'matches', files: [], truncated: false, total: 0 }
}

/**
 * Project a `grep` / `ast_grep` result value into grouped-matches card metadata.
 *
 * @param input - the tool's output value: `displayContent`, `cwd`, `files`,
 *   `matchCount` and `truncated` as the adapters project them.
 * @returns the card metadata, or `null` when no file group could be parsed.
 */
export function searchMatchesCardMeta(input: unknown): SearchMatchesCardMeta | null {
  if (!isRecord(input)) return null

  // An engine-reported zero is authoritative even when it ships no display text
  // (the empty engine result has no `displayContent` key at all). Anything else
  // without a display is a dirty input we refuse to guess a card for.
  const zeroMatches = input.matchCount === 0
  const display = typeof input.displayContent === 'string' ? input.displayContent : undefined
  if (display === undefined || display === '') return zeroMatches ? emptyMatchesMeta() : null

  const base = nonBlankString(input.cwd)
  const files = Array.isArray(input.files) ? input.files : []
  let fileScope = files.length === 1 ? nonBlankString(files[0]) : undefined
  if (fileScope !== undefined && base !== undefined && !path.isAbsolute(fileScope)) {
    fileScope = path.resolve(base, fileScope)
  }

  const groups = parseMatchGroups(display, base, fileScope)
  if (groups.length === 0) return zeroMatches ? emptyMatchesMeta() : null

  const parsedMatches = groups.reduce((total, group) => total + group.matches.length, 0)
  const total = reportedTotal(input.matchCount, parsedMatches)
  const retained = capTail(groups, SEARCH_META_MAX_BYTES, kept => ({
    kind: 'search',
    shape: 'matches',
    files: kept,
    truncated: true,
    total,
  }))
  if (retained.length === 0) return null

  const retainedMatches = retained.reduce((count, group) => count + group.matches.length, 0)
  return {
    kind: 'search',
    shape: 'matches',
    files: retained,
    truncated: input.truncated === true || retainedMatches < total,
    total,
  }
}

/**
 * Project a `glob` result value into path-list card metadata.
 *
 * @param input - the tool's output value: `paths`, `fileCount`, `total` and `truncated`.
 * @returns the card metadata, or `null` when the value is not a glob result (no
 *   `paths` key, or an empty one the engine never backed with a zero count).
 */
export function searchPathsCardMeta(input: unknown): SearchPathsCardMeta | null {
  if (!isRecord(input)) return null

  // Only a real `paths` key marks a glob result; an absent key (another tool's
  // value, dirty input) is not ours to project.
  const listed = input.paths
  if (!Array.isArray(listed)) return null

  // An empty array is the engine's explicit "no files" answer, so it projects to
  // the empty card rather than falling back to the generic shell. The array alone
  // is only a shape though: the engine's own zero count (glob's `fileCount: 0`,
  // or the `total` this contract reads) has to back it, otherwise a bare array on
  // an unrelated value stays a dirty input.
  if (listed.length === 0) {
    const reportedZero = nonNegativeInteger(input.fileCount) === 0 || nonNegativeInteger(input.total) === 0
    if (!reportedZero) return null
    return {
      kind: 'search',
      shape: 'paths',
      paths: [],
      truncated: false,
      total: reportedTotal(input.total, 0),
    }
  }

  const raw = listed.filter((entry): entry is string => typeof entry === 'string')
  if (raw.length === 0) return null

  const total = reportedTotal(input.total, raw.length)
  const retained = capTail(raw, SEARCH_META_MAX_BYTES, kept => ({
    kind: 'search',
    shape: 'paths',
    paths: kept,
    truncated: true,
    total,
  }))
  if (retained.length === 0) return null

  return {
    kind: 'search',
    shape: 'paths',
    paths: retained,
    truncated: input.truncated === true || retained.length < total,
    total,
  }
}
