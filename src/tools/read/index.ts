/**
 * DSH read tool — OMP port (plan.md §1)
 *
 * Keeps: row selector :N/:N-M/:N+K/:N- comma multi-range :raw,
 *        archive zip (delegate), sqlite (delegate), notebook .ipynb,
 *        streaming (>10MB), truncation caps, hashline anchor (header),
 *        conflict detection (notice).
 * Removes: URL pipes local:// agent:// http, image handling, TUI.
 *
 * Single param `file_path` with inline selector (no offset/limit).
 * Uses ctx.fs (resolve/stat/readText/streamText) only — no Bun, no pi-*.
 */

import * as path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { FsError } from '@deepseek-ai/dsh-fs'
import { formatArchiveEntryLines, formatBytes, openArchive, parseArchivePathCandidates } from '../shared/archive/zip'
import { readEditableNotebookText } from '../shared/notebook'
import {
  findSuffixMatchCached,
  isNotFoundError,
  prependSuffixResolutionNotice,
  type SuffixMatchCache,
} from '../shared/suffix-match'
import { trySqliteRead } from '../shared/read-sqlite.dsh'
import { CONVERTIBLE_EXTENSIONS, convertFileWithMarkit } from '../shared/markit/dsh'
import {
  formatReadHeader,
  formatSummaryElisionFooter,
  renderSummary,
  SUMMARY_DEFAULTS,
  trySummarizeCode,
} from '../shared/summary.dsh'

/** Live code-summary settings (OMP read.summarize.* parity). */
export interface ReadSummarizeSettings {
  enabled: boolean
  minBodyLines: number
  minCommentLines: number
  minTotalLines: number
  unfoldUntilLines: number
  unfoldLimitLines: number
}

export const DEFAULT_SUMMARIZE_SETTINGS: ReadSummarizeSettings = {
  enabled: true,
  minBodyLines: SUMMARY_DEFAULTS.minBodyLines,
  minCommentLines: SUMMARY_DEFAULTS.minCommentLines,
  minTotalLines: SUMMARY_DEFAULTS.minTotalLines,
  unfoldUntilLines: SUMMARY_DEFAULTS.unfoldUntil,
  unfoldLimitLines: SUMMARY_DEFAULTS.unfoldLimit,
}

// ---------------------------------------------------------------------------
// Caps — match official dsh-tool-fs read.js
// ---------------------------------------------------------------------------
const READ_MAX_LINE_LENGTH = 2000
const READ_MAX_BYTES = 50 * 1024
const STREAM_MIN_SIZE = 10 * 1024 * 1024

// ---------------------------------------------------------------------------
// Line range / selector (inline copy of shared/read-selector + path-utils)
// ---------------------------------------------------------------------------
export interface LineRange {
  startLine: number
  endLine: number | undefined
}

const LINE_RANGE_CHUNK_RE = /^L?(\d+)(?:(\.\.|[-+])L?(\d+)?)?$/i

export function parseLineRangeChunk(sel: string): LineRange | null {
  const m = LINE_RANGE_CHUNK_RE.exec(sel)
  if (!m) return null
  const rawStart = Number.parseInt(m[1]!, 10)
  if (rawStart < 1) throw new Error('Line selector 0 is invalid; lines are 1-indexed. Use :1.')
  const sep = m[2] === '..' ? '-' : m[2]
  const rhs = m[3] ? Number.parseInt(m[3], 10) : undefined
  let rawEnd: number | undefined
  if (sep === '+') {
    if (rhs === undefined || rhs < 1) throw new Error(`Invalid range ${rawStart}+${rhs ?? 0}: count must be >= 1.`)
    rawEnd = rawStart + rhs - 1
  } else if (sep === '-') {
    if (rhs !== undefined) {
      if (rhs < rawStart) throw new Error(`Invalid range ${rawStart}-${rhs}: end must be >= start.`)
      rawEnd = rhs
    }
  }
  return { startLine: rawStart, endLine: rawEnd }
}

export function parseLineRanges(sel: string): [LineRange, ...LineRange[]] | null {
  const chunks = sel.split(',')
  const parsed: LineRange[] = []
  for (const c of chunks) {
    const r = parseLineRangeChunk(c)
    if (!r) return null
    parsed.push(r)
  }
  if (parsed.length === 0) return null
  parsed.sort((a, b) => a.startLine - b.startLine)
  const merged: LineRange[] = [parsed[0]!]
  for (let i = 1; i < parsed.length; i++) {
    const cur = parsed[i]!
    const last = merged[merged.length - 1]!
    if (last.endLine === undefined) continue
    if (cur.startLine <= last.endLine + 1) {
      if (cur.endLine === undefined || cur.endLine > last.endLine) {
        merged[merged.length - 1] = { startLine: last.startLine, endLine: cur.endLine }
      }
      continue
    }
    merged.push(cur)
  }
  return merged as [LineRange, ...LineRange[]]
}

export type ParsedSelector =
  | { kind: 'none' }
  | { kind: 'raw' }
  | { kind: 'conflicts' }
  | { kind: 'lines'; ranges: [LineRange, ...LineRange[]]; raw?: boolean }

export function isRawSelector(p: ParsedSelector): boolean {
  return p.kind === 'raw' || (p.kind === 'lines' && p.raw === true)
}
export function isMultiRange(p: ParsedSelector): boolean {
  return p.kind === 'lines' && p.ranges.length > 1
}

function selectorChunkLooksReadLike(chunk: string): boolean {
  const lower = chunk.toLowerCase()
  return lower === 'raw' || lower === 'conflicts' || /^-\d+(?:[-+]\d+)?$/.test(chunk) || parseLineRanges(chunk) !== null
}

function invalidSelector(sel: string): Error {
  return new Error(
    `Invalid selector ':${sel}'. Use :N, :N-M, :N+K, :N- (open-ended), a comma-separated list of ranges, :raw, or a range combined with raw (e.g. :raw:50-100).`,
  )
}

export function parseSel(sel: string | undefined): ParsedSelector {
  if (!sel || sel.length === 0) return { kind: 'none' }
  if (sel.includes(':')) {
    const chunks = sel.split(':')
    if (chunks.length === 2) {
      const [a, b] = chunks as [string, string]
      const aIsRaw = a.toLowerCase() === 'raw'
      const bIsRaw = b.toLowerCase() === 'raw'
      const rangeChunk = aIsRaw ? b : bIsRaw ? a : null
      const rawChunk = aIsRaw ? a : bIsRaw ? b : null
      if (rangeChunk !== null && rawChunk !== null) {
        const ranges = parseLineRanges(rangeChunk)
        if (ranges) return { kind: 'lines', ranges, raw: true }
      }
    }
    if (chunks.every(selectorChunkLooksReadLike)) throw invalidSelector(sel)
    return { kind: 'none' }
  }
  if (sel.toLowerCase() === 'raw') return { kind: 'raw' }
  if (sel.toLowerCase() === 'conflicts') return { kind: 'conflicts' }
  const ranges = parseLineRanges(sel)
  if (ranges) return { kind: 'lines', ranges }
  return { kind: 'none' }
}

export function selToOffsetLimit(parsed: ParsedSelector): { offset?: number; limit?: number } {
  if (parsed.kind === 'lines') {
    const first = parsed.ranges[0]!
    const limit = first.endLine !== undefined ? first.endLine - first.startLine + 1 : undefined
    return { offset: first.startLine, limit }
  }
  return {}
}

// Split trailing :selector where selector is valid; preserve windows drive colon.
export function splitPathAndSel(rawPath: string): { path: string; sel?: string } {
  // Windows drive "C:\..." — don't peel the drive colon
  const driveLen = /^[A-Za-z]:[\\/]/.test(rawPath) ? 2 : 0
  const colon = rawPath.lastIndexOf(':')
  if (colon <= driveLen) return { path: rawPath }
  // If colon is part of "C:" drive at index 1, already handled; otherwise
  // check if after colon there's a selector-shaped tail.
  const candidate = rawPath.slice(colon + 1)
  // Quick regex pre-filter: selector must be raw/conflicts or range list
  // Reconstruct permissive check via parseSel — if kind is none, treat as not a selector
  // Also handle compound raw:range
  // To avoid false positives on e.g. "file:1" where 1 is valid selector, that's intentional
  // But for "archive.zip:member" member is not selector-shaped, so keep whole path.
  const parsed = (() => {
    try {
      return parseSel(candidate)
    } catch {
      // invalid selector shape — treat as real selector error later
      return { kind: 'none' } as ParsedSelector
    }
  })()
  // Also need to handle invalid selector that should error: if candidate looks
  // selector-like but parseSel threw via invalidSelector path (compound invalid),
  // we should surface error. Our parseSel above returns none for non-selector;
  // we detect invalid compound via explicit check.
  // For now, if candidate after colon does NOT parse as any selector kind (none),
  // then it's not a selector — return whole path.
  // However if candidate is e.g. "member/file.txt", parseSel returns none -> not selector, so keep whole path (archive case).
  if (parsed.kind === 'none') {
    // Check if candidate could be a compound that parseSel errored on via thrown invalidSelector.
    // We re-run exact invalid check: if every chunk looks read-like but compound invalid, surface error
    if (candidate.includes(':')) {
      const chunks = candidate.split(':')
      if (chunks.every(selectorChunkLooksReadLike)) {
        throw invalidSelector(candidate)
      }
    }
    // Also single invalid like ":-1" ?
    if (candidate.length > 0 && selectorChunkLooksReadLike(candidate) && candidate.startsWith('-')) {
      throw invalidSelector(candidate)
    }
    return { path: rawPath }
  }

  let basePath = rawPath.slice(0, colon)
  let sel = candidate

  // Compound trailing selector: path:1-50:raw  -> peel two colons
  const innerColon = basePath.lastIndexOf(':')
  if (innerColon > driveLen) {
    const innerCandidate = basePath.slice(innerColon + 1)
    const innerParsed = (() => {
      try { return parseSel(innerCandidate) } catch { return { kind: 'none' } as ParsedSelector }
    })()
    const outerIsRaw = candidate.toLowerCase() === 'raw'
    const innerIsRaw = innerCandidate.toLowerCase() === 'raw'
    const innerIsRange = innerParsed.kind === 'lines'
    const outerIsRange = parsed.kind === 'lines'
    // Valid compounds are one raw + one range
    if ((innerIsRaw && outerIsRange) || (innerIsRange && outerIsRaw)) {
      sel = `${innerCandidate}:${candidate}`
      basePath = basePath.slice(0, innerColon)
    }
  }
  return { path: basePath, sel }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function truncateLine(line: string): string {
  if (line.length <= READ_MAX_LINE_LENGTH) return line
  return line.slice(0, READ_MAX_LINE_LENGTH) + ' ... (line truncated to 2000 chars)'
}

function isNotebookPath(p: string): boolean {
  return p.toLowerCase().endsWith('.ipynb')
}

function renderNotebook(text: string, displayPath: string): string {
  // OMP parity: read renders the SAME editable text the edit tool parses back
  // (OMP read.ts routes .ipynb through readEditableNotebookText → notebook-
  // ToEditableText). Markers are "# %% [code] cell:N", single-\n joined, with
  // marker-shaped source lines escaped. A previous hand-rolled renderer here
  // emitted "# %% [cell N] (type)" + blank-line joins + no escaping, which
  // broke the round-trip contract (T10-1). Invalid notebooks throw OMP's
  // wording instead of silently falling back to raw JSON.
  return readEditableNotebookText(text, displayPath)
}

function detectConflictLines(lines: string[]): number {
  let n = 0
  for (const l of lines) {
    if (l.startsWith('<<<<<<< ') || l.startsWith('=======') || l.startsWith('>>>>>>> ')) n++
  }
  return n
}

async function readAllText(ctx: any, target: any, size: number | undefined, signal?: AbortSignal): Promise<string> {
  const useStream = size !== undefined && size >= STREAM_MIN_SIZE
  if (useStream && typeof ctx.fs.streamText === 'function') {
    const stream: AsyncIterable<string> = await ctx.fs.streamText(target, signal)
    let acc = ''
    for await (const chunk of stream) acc += chunk as string
    return acc
  }
  return (await ctx.fs.readText(target, signal)) as string
}

function applyRanges(lines: string[], parsed: ParsedSelector): { sliced: string[]; startLineByIndex: Map<number, number>; totalLines: number } {
  const totalLines = lines.length
  if (parsed.kind === 'none' || parsed.kind === 'raw' || parsed.kind === 'conflicts') {
    return { sliced: lines, startLineByIndex: new Map([[0, 1]]), totalLines }
  }
  const sliced: string[] = []
  const startLineByIndex = new Map<number, number>()
  let outIdx = 0
  for (const r of parsed.ranges) {
    const start = r.startLine // 1-indexed
    const end = r.endLine ?? totalLines
    for (let ln = start; ln <= end; ln++) {
      if (ln < 1 || ln > totalLines) continue
      startLineByIndex.set(outIdx, ln)
      sliced.push(lines[ln - 1]!)
      outIdx++
    }
  }
  return { sliced, startLineByIndex, totalLines }
}

function renderNumbered(sliced: string[], startLineByIndex: Map<number, number>, raw: boolean, totalLines: number, requestedOffset?: number): { text: string; truncatedByBytes: boolean; cappedNotice?: string } {
  if (raw) {
    const joined = sliced.join('\n')
    if (Buffer.byteLength(joined, 'utf-8') > READ_MAX_BYTES) {
      // byte-cap raw as well — truncate to 50KB
      const buf = Buffer.from(joined, 'utf-8')
      const cut = buf.subarray(0, READ_MAX_BYTES).toString('utf-8')
      return { text: cut, truncatedByBytes: true, cappedNotice: `Output capped at ${READ_MAX_BYTES} bytes. Use :${(requestedOffset ?? 1)}- selector with smaller range.` }
    }
    return { text: joined, truncatedByBytes: false }
  }
  const lines: string[] = []
  let bytes = 0
  let truncatedByBytes = false
  let lastEmittedLine = 0
  for (let i = 0; i < sliced.length; i++) {
    const origLn = startLineByIndex.get(i) ?? i + 1
    const content = truncateLine(sliced[i]!)
    const row = `${String(origLn).padStart(4, ' ')}: ${content}`
    const rowBytes = Buffer.byteLength(row + '\n', 'utf-8')
    if (bytes + rowBytes > READ_MAX_BYTES) {
      truncatedByBytes = true
      break
    }
    bytes += rowBytes
    lines.push(row)
    lastEmittedLine = origLn
  }
  let text = lines.join('\n')
  let cappedNotice: string | undefined
  if (truncatedByBytes) {
    const shown = lines.length
    const suffix = requestedOffset !== undefined ? ` Use :${requestedOffset} offset with smaller range or :raw for verbatim.` : ''
    cappedNotice = `Output capped at ${READ_MAX_BYTES} bytes (showing ${shown} lines).${suffix}`
    // Keep notice inside returned text for model visibility; caller may also surface via presentationMeta
    text += `\n\n[${cappedNotice}]`
  }
  return { text, truncatedByBytes, cappedNotice }
}

// ---------------------------------------------------------------------------
// Archive member read — full OMP parity via the ported engine
// (shared/archive/zip.ts): longest-first archive candidate resolution, member
// names take precedence over whole-path selectors, directory listings honor
// offset/limit, UTF-8 members flow through the normal selector pipeline,
// binary entries and missing paths surface OMP's exact wording.
// ---------------------------------------------------------------------------
interface ArchiveReadResult { path: string; text: string; truncated: boolean; totalLines: number; offset?: number }

async function realPathOf(ctx: any, candidatePath: string, cwd: string): Promise<string> {
  const target = await ctx.fs.resolve(candidatePath, { cwd })
  return (ctx.fs as any).processPath ? (ctx.fs as any).processPath(target) : ((target as any).displayPath ?? candidatePath)
}

async function tryArchiveRead(ctx: any, rawInput: string, cwd: string, suffixCache: SuffixMatchCache, signal?: AbortSignal): Promise<ArchiveReadResult | null> {
  // Bare archive path (no `:member`): OMP keeps the whole-path candidate and
  // resolves it to subPath "" → root directory listing (OMP read-archive.ts
  // line ~48: `archiveSubPath: candidate.archivePath === readPath ? "" : ...`).
  // An earlier `.filter(c => c.archivePath !== rawInput)` dropped exactly that
  // candidate, so a bare `.zip`/`.tar.gz` fell through to the plain-file
  // binary guard and surfaced dsh-fs-local's "cannot read ...: binary file"
  // (T04-1 regression). Keep the candidate; the empty subPath flows through
  // splitPathAndSel('') → parseSel(undefined)→none → getNode('')→root dir.
  const candidates = parseArchivePathCandidates(rawInput)
  if (candidates.length === 0) return null

  let resolved: { absReal: string; archivePath: string; archiveSubPath: string; suffixResolution?: { from: string; to: string } } | undefined
  for (const candidate of candidates) {
    try {
      const info = await ctx.fs.stat(await ctx.fs.resolve(candidate.archivePath, { cwd }))
      if (info?.type === 'directory') continue
      resolved = { absReal: await realPathOf(ctx, candidate.archivePath, cwd), archivePath: candidate.archivePath, archiveSubPath: candidate.subPath }
      break
    } catch (e: any) {
      // OMP resolveArchiveReadPath: on a miss, probe the workspace for a
      // unique suffix match (`name.zip` → `sub/name.zip`) and record the
      // from→to mapping so the output can carry the resolution notice.
      if (!isNotFoundError(e)) throw e
      const suffixHit = await findSuffixMatchCached(suffixCache, candidate.archivePath, cwd, signal)
      if (!suffixHit) continue
      resolved = {
        absReal: suffixHit.absolutePath,
        archivePath: candidate.archivePath,
        archiveSubPath: candidate.subPath,
        suffixResolution: { from: candidate.archivePath, to: suffixHit.displayPath },
      }
      break
    }
  }
  if (!resolved) return null

  const suffixResolution = resolved.suffixResolution
  const withNotice = (text: string): string => prependSuffixResolutionNotice(text, suffixResolution)

  const archive = await openArchive(resolved.absReal)

  // Split a trailing selector off the member path (`a.zip:f.txt:10-20`).
  const sp = splitPathAndSel(resolved.archiveSubPath)
  let archiveSubPath = sp.path
  let sel = parseSel(sp.sel)
  let node = archive.getNode(archiveSubPath)
  if (!node && archiveSubPath) {
    // `a.zip:500` / `a.zip:raw`: the whole subPath is a selector on the
    // archive root, not a member name. Member names take precedence.
    const wholeSel = parseSel(archiveSubPath)
    if (wholeSel.kind !== 'none') {
      node = archive.getNode('')
      archiveSubPath = ''
      sel = wholeSel
    }
  }
  if (!node) throw new Error(`Path '${rawInput}' not found inside archive`)

  const displayPath = archiveSubPath ? `${resolved.archivePath}:${archiveSubPath}` : resolved.archivePath

  if (node.isDirectory) {
    if (sel.kind === 'lines' && sel.ranges.length > 1) {
      throw new Error('Multi-range line selectors are not supported for archive directory listings.')
    }
    const DEFAULT_LIST_LIMIT = 500
    const allEntries = archive.listDirectory(archiveSubPath)
    const start1 = sel.kind === 'lines' && sel.ranges[0] ? sel.ranges[0]!.startLine : 1
    const sliced = start1 > 1 ? allEntries.slice(start1 - 1) : allEntries
    const limited = sliced.slice(0, DEFAULT_LIST_LIMIT)
    const entryLines = formatArchiveEntryLines(limited)
    let text = entryLines.length > 0 ? entryLines.join('\n') : '(empty archive directory)'
    if (sliced.length > limited.length) text += `\n\n(Showing ${limited.length} of ${sliced.length} entries.)`
    return { path: displayPath, text: withNotice(text), truncated: false, totalLines: allEntries.length, offset: start1 }
  }

  const entry = await archive.readFile(archiveSubPath)
  let text: string | null
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes)
  } catch {
    text = null
  }
  if (text === null) {
    return { path: displayPath, text: withNotice(`[Cannot read binary archive entry '${entry.path}' (${formatBytes(entry.size)})]`), truncated: false, totalLines: 1 }
  }

  // Immutable bytes: no hashline anchor is emitted for archive members (OMP
  // skips it too — an edit keyed to the container would clobber siblings).
  const lines = text.split('\n')
  const totalLines = lines.length
  const { sliced, startLineByIndex } = applyRanges(lines, sel)
  const requestedOffset = sel.kind === 'lines' && sel.ranges[0] ? sel.ranges[0].startLine : undefined
  const rendered = renderNumbered(sliced, startLineByIndex, sel.kind === 'raw', totalLines, requestedOffset)
  const finalText = rendered.cappedNotice ? `${rendered.text}\n\n[${rendered.cappedNotice}]` : rendered.text
  return { path: displayPath, text: withNotice(finalText), truncated: rendered.truncatedByBytes, totalLines, offset: requestedOffset ?? 1 }
}

// SQLite probe lives in shared/read-sqlite.dsh.ts (engine-backed: list /
// schema / row / query / raw selectors against node:sqlite).

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
export function registerRead(ctx: Context, getSummarySettings?: () => ReadSummarizeSettings): void {
  ctx.tools.register(defineTool({
    name: 'read',
    description: 'Read a UTF-8 text file with optional inline row selector. Selector syntax: :N (line N), :N-M (range), :N+K (K lines from N), :N- (to EOF), comma multi-range (e.g. :1-10,20-30), :raw (verbatim without line numbers), :raw:N-M. Examples: "src/foo.ts:10-20", "README.md:1", "archive.zip:member". SQLite databases read inline: "db.sqlite" lists tables, "db.sqlite:users" shows schema+sample rows, "db.sqlite:users?limit=20&offset=40" paginates, "db.sqlite:users:3" fetches a row, "db.sqlite?q=SELECT ..." runs raw SQL. Documents (.pdf/.docx/.pptx/.xlsx/.epub) convert to markdown inline; selectors apply to the converted text. Large files stream; output capped at 50KB/2000 chars per line. Notebook .ipynb is rendered as cells.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'File path with optional inline selector suffix, e.g. "src/foo.ts:10-20" or "README.md:raw:1-50". Archive members use "archive.zip:inner/path". SQLite selectors: "db.sqlite:table?limit=10" or "db.sqlite?q=SELECT ...".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          text: { type: 'string', required: true },
          truncated: { type: 'boolean' },
          totalLines: { type: 'number' },
          offset: { type: 'number' },
        },
      },
      render: (_args: any, value: any) => [{ type: 'text', text: String(value.text ?? '') }],
      presentationMeta: (_args: any, value: any) => ({
        // Lossless JSON only: explicit `undefined` properties are rejected by
        // the output validator ("returned non-lossless JSON"), and several
        // execute paths (sqlite/archive/conflict/range-error) omit `offset`.
        // Conditionally spread so absent fields stay truly absent.
        ...(value.path !== undefined ? { path: value.path } : {}),
        ...(value.offset !== undefined ? { offset: value.offset } : {}),
        ...(value.totalLines !== undefined ? { lines: value.totalLines } : {}),
      }) as any,
    },
    async execute(args: any, exec: any) {
      const rawInput = String(args.file_path ?? '')
      if (rawInput.trim().length === 0) throw new Error('file_path must be a non-empty string')
      const summarySettings = getSummarySettings?.() ?? DEFAULT_SUMMARIZE_SETTINGS

      const cwd: string = exec.agent?.session.header.cwd ?? process.cwd()
      const signal: AbortSignal | undefined = exec.signal

      // Archive / sqlite delegation (before selector peel for archive members)
      // We peel selector after checking archive? For archive we need member path.
      // Delegate early so "db.sqlite:table?limit=10" doesn't try fs stat.
      const sqliteProbe = await trySqliteRead(ctx, rawInput, cwd, signal)
      if (sqliteProbe.handled) {
        return { path: rawInput, text: sqliteProbe.text!, truncated: false, totalLines: 0 }
      }

      let basePath: string
      let selStr: string | undefined
      try {
        const split = splitPathAndSel(rawInput)
        basePath = split.path
        selStr = split.sel
      } catch (e: any) {
        throw new Error(e?.message ?? String(e))
      }

      const parsed = (() => {
        try { return parseSel(selStr) } catch (e: any) { throw new Error(e?.message ?? String(e)) }
      })()

      // Archive member/directory read: candidates are parsed from the raw
      // input (selector included) exactly like OMP — no pre-peel needed.
      // One suffix-glob memo per read call — archive and plain-path
      // resolution share misses instead of re-globbing (OMP parity).
      const suffixCache: SuffixMatchCache = new Map()
      const archiveRead = await tryArchiveRead(ctx, rawInput, cwd, suffixCache, signal)
      if (archiveRead) return archiveRead

      // Conflict selector: just annotate (no history in DSH port)
      const wantConflicts = parsed.kind === 'conflicts'

      // Resolve + stat via DSH fs; on a miss probe for a unique workspace
      // suffix match first (OMP read.ts plain-path behavior).
      let target: any
      let suffixResolution: { from: string; to: string } | undefined
      try {
        target = await ctx.fs.resolve(basePath, { cwd, signal })
      } catch (e: any) {
        if (!isNotFoundError(e)) {
          if (e instanceof FsError) throw new Error(e.message)
          throw e
        }
        const suffixHit = await findSuffixMatchCached(suffixCache, basePath, cwd, signal)
        if (!suffixHit) {
          if (e instanceof FsError) throw new Error(e.message)
          throw e
        }
        target = await ctx.fs.resolve(suffixHit.absolutePath, { cwd, signal })
        suffixResolution = { from: basePath, to: suffixHit.displayPath }
      }

      let info: any
      try {
        info = await ctx.fs.stat(target, signal)
      } catch (e: any) {
        if (e instanceof FsError) throw new Error(e.message)
        throw e
      }
      if (!info) {
        throw new Error(`Path '${basePath}' not found`)
      }

      // Emit observed if available (best-effort)
      try {
        const maybeEmit: any = (ctx as any).emit
        if (typeof maybeEmit === 'function' && info.version) {
          maybeEmit('fs/observed', { target, version: info.version })
        }
      } catch {}

      const displayPath: string = (target as any).displayPath ?? basePath
      const withNotice = (text: string): string => prependSuffixResolutionNotice(text, suffixResolution)

      // Directory
      if (info.type === 'directory') {
        if (isMultiRange(parsed)) throw new Error('Multi-range line selectors are not supported for directory listings.')
        const { offset, limit } = selToOffsetLimit(parsed)
        const entries: any[] = await (ctx.fs as any).listDir(target, signal)
        // entries sorted by name already in local backend
        const sliced = (() => {
          if (offset === undefined) return entries
          const start = Math.max(0, offset - 1)
          const end = limit !== undefined ? start + limit : undefined
          return entries.slice(start, end)
        })()
        const rendered = sliced.map((e: any) => `${e.type === 'directory' ? '📁' : '📄'} ${e.name}${e.type === 'directory' ? '/' : ''}`).join('\n') || '(empty directory)'
        const text = `Directory ${displayPath} (${entries.length} entries):\n${rendered}`
        return { path: displayPath, text: withNotice(text), truncated: false, totalLines: entries.length, offset: offset ?? 1 }
      }

      if (info.type !== 'file') {
        throw new Error(`Cannot read "${displayPath}": not a regular file (type: ${info.type})`)
      }

      // ── markit document conversion (plan 拍板#6): pdf/docx/pptx/xlsx/epub →
      // markdown, then flow through the normal selector pipeline so line-range
      // selectors apply against the converted output (OMP parity).
      const lowerDisplay = displayPath.toLowerCase()
      if (CONVERTIBLE_EXTENSIONS.has(path.extname(lowerDisplay))) {
        const realForConvert = (ctx.fs as any).processPath ? (ctx.fs as any).processPath(target) : displayPath
        const converted = await convertFileWithMarkit(realForConvert, signal)
        if (converted.ok) {
          const convertedLines = converted.content.replace(/\r\n/g, '\n').split('\n')
          const totalLines = convertedLines.length
          const { sliced, startLineByIndex } = applyRanges(convertedLines, parsed)
          if (parsed.kind === 'lines' && sliced.length === 0) {
            const first = parsed.ranges[0]!
            return { path: displayPath, text: `Range ${first.startLine}${first.endLine !== undefined ? `-${first.endLine}` : ''} is beyond end of converted document (${totalLines} lines total).`, truncated: false, totalLines }
          }
          const requestedOffset = selToOffsetLimit(parsed).offset
          const rendered = renderNumbered(sliced, startLineByIndex, isRawSelector(parsed), totalLines, requestedOffset)
          let text = rendered.text
          if (!isRawSelector(parsed) && rendered.cappedNotice) text += `\n\n[${rendered.cappedNotice}]`
          return { path: displayPath, text, truncated: rendered.truncatedByBytes, totalLines, ...(requestedOffset !== undefined ? { offset: requestedOffset } : {}) }
        }
        return { path: displayPath, text: `[Cannot read ${path.extname(lowerDisplay)} file: ${converted.error || 'conversion failed'}]`, truncated: false, totalLines: 0 }
      }

      // Binary guard is inside dsh-fs readText (FS_NOT_TEXT); surface OMP's
      // exact contract (read.ts ~1171): a successful bracketed notice, and
      // `:raw` is the escape hatch that bypasses the sniff entirely.
      let fullText: string
      try {
        fullText = await readAllText(ctx, target, info.size, signal)
      } catch (e: any) {
        // NOTE: `instanceof FsError` is unreliable here — @deepseek-ai/dsh-fs and
        // @deepseek-ai/dsh-fs-local resolve to different pnpm copies with distinct
        // class identities, so match by code/message instead of instanceof.
        const errCode = e?.code ?? e?.cause?.code
        const isBinary = errCode === 'FS_NOT_TEXT' || String(e?.message ?? '').toLowerCase().includes('binary')
        if (!isBinary) throw e
        if (isRawSelector(parsed)) {
          // OMP parity: `:raw` reads bytes verbatim (lossy UTF-8 decode), no guard.
          const bytes: Uint8Array = await (ctx.fs as any).readBytes(target, signal)
          fullText = new TextDecoder('utf-8').decode(bytes)
        } else {
          return {
            path: displayPath,
            text: `[Cannot read binary file '${displayPath}' (${formatBytes(info.size)}); not valid UTF-8 text. Use ':raw' to read bytes verbatim.]`,
            truncated: false,
            totalLines: 0,
          }
        }
      }

      // Notebook
      if (isNotebookPath(displayPath) && !isRawSelector(parsed)) {
        fullText = renderNotebook(fullText, displayPath)
      }

      // Normalize to LF for line slicing (preserve original for raw byte fidelity? LF is fine for display)
      const normalized = fullText.replace(/\r\n/g, '\n')
      const lines = normalized.split('\n')

      // ── Code summary (plan 拍板#4): selector-less reads of large code files
      // fold non-critical spans; the elision footer teaches the re-read
      // selector. Selector reads and prose paths stay verbatim (OMP parity).
      if (parsed.kind === 'none' && summarySettings.enabled && info.size !== undefined && info.size <= 2 * 1024 * 1024) {
        const realForSummary = realPathOf(ctx, basePath, cwd).catch(() => displayPath)
        const summary = trySummarizeCode(normalized, await realForSummary, {
          minBodyLines: summarySettings.minBodyLines,
          minCommentLines: summarySettings.minCommentLines,
          minTotalLines: summarySettings.minTotalLines,
          unfoldUntilLines: summarySettings.unfoldUntilLines,
          unfoldLimitLines: summarySettings.unfoldLimitLines,
        })
        if (summary) {
          const rendered = renderSummary(summary)
          const header = formatReadHeader(displayPath, normalized)
          const footer = formatSummaryElisionFooter(displayPath, rendered.elidedRanges, rendered.elidedLines)
          const text = footer ? `${header}\n${rendered.text}\n${footer}` : `${header}\n${rendered.text}`
          return { path: displayPath, text, truncated: false, totalLines: lines.length }
        }
      }

      // If file ends with newline, split creates trailing "" — keep as line for totalLines accuracy?
      // Official read keeps that semantics via streamLinesFromFile includeTerminalNewline; we keep simple: pop trailing empty if original ended with \n and raw not requested?
      // Keep as-is; totalLines = lines.length, but if file ends with \n the last element is "" — that's a line. Keep.

      if (wantConflicts) {
        const n = detectConflictLines(lines)
        if (n === 0) {
          return { path: displayPath, text: `No conflict markers found in ${displayPath}.`, truncated: false, totalLines: lines.length }
        }
        // Render conflict regions inline
        const conflictLines: string[] = []
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i]!
          if (l.startsWith('<<<<<<< ') || l.startsWith('=======') || l.startsWith('>>>>>>> ')) {
            conflictLines.push(`${String(i + 1).padStart(4, ' ')}: ${truncateLine(l)}`)
          }
        }
        const text = `Conflict markers in ${displayPath} (${n} marker lines):\n` + conflictLines.join('\n')
        return { path: displayPath, text, truncated: false, totalLines: lines.length }
      }

      const { sliced, startLineByIndex, totalLines } = applyRanges(lines, parsed)

      // Out-of-bounds check for single-range selectors
      if (parsed.kind === 'lines' && sliced.length === 0) {
        const first = parsed.ranges[0]!
        const suggestion = totalLines === 0 ? 'The file is empty.' : `Use :1 to read from the start, or :${totalLines} to read the last line.`
        return { path: displayPath, text: `Range ${first.startLine}${first.endLine !== undefined ? `-${first.endLine}` : ''} is beyond end of file (${totalLines} lines total). ${suggestion}`, truncated: false, totalLines }
      }

      const raw = isRawSelector(parsed)
      const { offset } = selToOffsetLimit(parsed)
      const rendered = renderNumbered(sliced, startLineByIndex, raw, totalLines, offset)

      // Conflict notice (if any markers present, append warning)
      let text = rendered.text
      if (!raw && !wantConflicts && detectConflictLines(lines) > 0) {
        const count = detectConflictLines(lines)
        text += `\n\n[Warning: ${count} conflict marker lines detected — run read with :conflicts to list them.]`
      }

      // Hashline anchor header — the real engine tag (4-hex FNV of content) so
      // a write-back `[path#TAG]` patch validates against the Patcher (plan 拍板#3).
      if (!raw && fullText.length < 1_000_000) {
        const rel = path.relative(cwd, displayPath)
        const anchor = rel.length > 0 && !rel.startsWith('..') ? rel.split(path.sep).join('/') : displayPath
        text = `${formatReadHeader(anchor, normalized)}\n` + text
      }

      return {
        path: displayPath,
        text,
        truncated: rendered.truncatedByBytes,
        totalLines,
        offset: offset ?? 1,
      }
    },
    presentCall: (args: any) => ({
      card: 'generic',
      title: `Read ${String(args.file_path).slice(0, 80)}`,
      kind: 'execute',
      rawInput: String(args.file_path),
    }),
    presentResult: (_args: any, result: any) => {
      if ((result as any)?.isError) return undefined
      return undefined
    },
  }))
}

// Aliases for integration
export const applyRead = registerRead
export const registerReadTool = registerRead
export default registerRead
