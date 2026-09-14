/**
 * Web tool-card contract: the payload this plugin's Host half projects into
 * `output.presentationMeta` and its browser half narrows back before drawing.
 *
 * Dependency-free by design (no React, no cordis, no Node built-ins): the Node
 * half imports it to build metadata, the browser half imports it to validate
 * it, and because it carries no React import it can never drag the browser
 * bundle into the Node build.
 *
 * `edit` / `read` / `search` mirror the exact shapes the shipped
 * `@deepseek-ai/dsh-client-ui-tool` card models accept — a `kind` tag rides on
 * top, and those models ignore unknown keys — so the same payload stays
 * readable if this plugin ever stops shadowing those rows. `write`,
 * `ast_edit` and `terminal` are this plugin's own shapes: the shipped rows have
 * no equivalent (their write card is a diff card; ours is a content preview,
 * matching the OMP card the model already sees).
 *
 * Everything here is defensive: a card never throws. The browser half turns any
 * malformed, oversized or foreign payload into `null`, and the row falls back
 * to the generic shell.
 *
 * @module @xiaoso/dsh-tool-plus/web/contract
 */

/**
 * Cell-shadowing rank of every card entry this plugin registers.
 *
 * The shipped `tool.call.toolview` entries all register at the default
 * priority 0, and the lowest live entry of a cell renders. A large negative
 * constant keeps this plugin first even if a future release starts ranking its
 * own rows below zero — the gap is deliberate, not a tuned value.
 */
export const CARD_TAKEOVER_PRIORITY = -1000

/**
 * Wire tool names whose `tool.call.toolview` cell this plugin renders.
 *
 * `ast_grep` / `ast_edit` are this plugin's own tool names (no shipped entry
 * claims those keys), so registering them is purely additive; the other six
 * shadow a shipped row.
 */
export const CARD_TOOL_KEYS = [
  'bash', 'read', 'write', 'edit', 'grep', 'glob', 'ast_grep', 'ast_edit',
] as const

/** One of {@link CARD_TOOL_KEYS}. */
export type CardToolKey = (typeof CARD_TOOL_KEYS)[number]

/**
 * Cap on the serialized `edit` metadata. The engine's unified diff is already
 * bounded per file but unbounded across files; past this budget whole trailing
 * files are dropped, and once nothing is left the call falls back to the
 * generic shell rather than writing an oversized session entry.
 */
export const EDIT_META_MAX_BYTES = 128 * 1024

/** Cap on the `ast_edit` change preview (the engine's own display text). */
export const AST_EDIT_META_MAX_BYTES = 64 * 1024

/** Cap on the serialized `read` metadata (the returned window's lines). */
export const READ_META_MAX_BYTES = 256 * 1024

/**
 * Cap on the serialized search metadata. Same value and meaning as the shipped
 * search card's own `searchMetaMaxBytes`.
 */
export const SEARCH_META_MAX_BYTES = 64 * 1024

/** UTF-8 byte length of `text`, without allocating an encoder. */
export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4
      index += 1
    } else bytes += 3
  }
  return bytes
}

/** UTF-8 byte length of a value's JSON form; the unit every cap above uses. */
export function jsonByteLength(value: unknown): number {
  const json = JSON.stringify(value)
  return json === undefined ? 0 : utf8ByteLength(json)
}

/**
 * Longest prefix of `text` that fits in `cap` UTF-8 bytes, never splitting a
 * surrogate pair.
 * @param text - the text to bound.
 * @param cap - the byte budget.
 * @returns `text` when it already fits, otherwise its longest fitting prefix.
 */
export function capText(text: string, cap: number): string {
  if (utf8ByteLength(text) <= cap) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (utf8ByteLength(text.slice(0, mid)) <= cap) low = mid
    else high = mid - 1
  }
  if (low > 0 && low < text.length) {
    const code = text.charCodeAt(low - 1)
    if (code >= 0xd800 && code <= 0xdbff) low -= 1
  }
  return text.slice(0, low)
}

/**
 * Drop entries from the tail until the payload `wrap(retained)` serializes
 * within `cap`.
 *
 * `wrap` receives the retained slice only, so the caller measures the real
 * payload — including its fixed fields — and a single oversized entry ends as
 * an empty list rather than an oversized one.
 * @param items - the ordered entries to bound.
 * @param cap - byte budget for `wrap`'s result.
 * @param wrap - builds the payload that would be emitted for a retained slice.
 * @returns the retained head, in input order.
 */
export function capTail<T>(
  items: readonly T[],
  cap: number,
  wrap: (retained: readonly T[]) => unknown,
): T[] {
  const retained = [...items]
  while (retained.length > 0 && jsonByteLength(wrap(retained)) > cap) retained.pop()
  return retained
}

/** One file's change, in the shape the shipped diff card consumes. */
export type CardDiffHunk = { /** The file's model-facing path, drawn verbatim as the hunk header. */
path: string
/** Prior content, or `null` for a new file / an overwrite. */
oldText: string | null
/** Content after the change. */
newText: string }

/** One line of a read window, in the shape `ReadBlock` consumes. */
export type CardReadLine = { /** 1-based line number in the file. */
number: number
/** The line's text, without its newline. */
text: string }

/** One matched line inside a {@link CardSearchFileGroup}. */
export type CardSearchMatchLine = {
  /** 1-based line number of the match within its file. */
  lineNumber: number
  /** The matched line's text. */
  line: string
}

/** One file's grouped matches, in first-seen order. */
export type CardSearchFileGroup = {
  /** The file the matches belong to (display path). */
  path: string
  /** The file's matched lines, in output order. */
  matches: CardSearchMatchLine[]
}

/** `write` card metadata: a content preview, so only the header needs data. */
export type WriteCardMeta = {
  kind: 'write'
  /** The written file's model-facing path. */
  path: string
  /** Grammar hint for the preview; omitted when the path names no language. */
  lang?: string
  /** The write set the file's executable bit; omitted otherwise. */
  madeExecutable?: boolean
}

/** `edit` card metadata: the engine's own unified diff, already computed. */
export type EditCardMeta = {
  kind: 'edit'
  /** One entry per applied hunk, in file order; never empty. */
  diffs: CardDiffHunk[]
}

/** `ast_edit` card metadata: the engine's change preview plus its counters. */
export type AstEditCardMeta = {
  kind: 'ast_edit'
  /** The engine's display text for the applied replacements. */
  preview: string
  /** Files touched, with their replacement counts. */
  files: { path: string; count: number }[]
  /** Total replacements applied. */
  replacements: number
  /** Whether the edit was applied (`false` previews a dry run). */
  applied: boolean
}

/** `read` card metadata, in the shape the shipped read card consumes. */
export type ReadCardMeta = {
  kind: 'read'
  /** The read file's path, selector already stripped. */
  path: string
  /** 1-based first line of the returned window. */
  offset: number
  /** The returned window's lines, strictly increasing by number. */
  lines: CardReadLine[]
  /** Total line count in the file (the window's last line when unknown). */
  totalLines: number
  /** Grammar hint for the file; omitted when the path names no language. */
  lang?: string
}

/** `grep` / `ast_grep` search metadata. */
export type SearchMatchesCardMeta = {
  kind: 'search'
  shape: 'matches'
  /** Matched lines grouped by file, in first-seen order. */
  files: CardSearchFileGroup[]
  /** Whether the payload was capped (the counts below are pre-cap totals). */
  truncated: boolean
  /** Total matches the search found before capping. */
  total: number
}

/** `glob` search metadata. */
export type SearchPathsCardMeta = {
  kind: 'search'
  shape: 'paths'
  /** The discovered paths, in result order. */
  paths: string[]
  /** Whether the payload was capped (the counts below are pre-cap totals). */
  truncated: boolean
  /** Total paths the search found before capping. */
  total: number
}

/** Search metadata: one card, two `shape`-discriminated forms. */
export type SearchCardMeta = SearchMatchesCardMeta | SearchPathsCardMeta

/** `bash` metadata for a foreground call that ran to completion. */
export type TerminalForegroundCardMeta = {
  kind: 'terminal'
  mode: 'foreground'
  /** Settled exit code; `null` when the process died from a timeout/abort. */
  exitCode: number | null
  /** The command hit its deadline. */
  timedOut: boolean
  /** The call was cancelled before the command settled. */
  aborted: boolean
  /** The working directory the command actually ran in, when known. */
  workingDir?: string
}

/** `bash` metadata for a call handed off to a background job. */
export type TerminalBackgroundCardMeta = {
  kind: 'terminal'
  mode: 'background'
  /** The managed job's id. */
  jobId: string
}

/** `bash` metadata: the run state the terminal card's status pill needs. */
export type TerminalCardMeta = TerminalForegroundCardMeta | TerminalBackgroundCardMeta

/** Any card metadata this plugin emits. */
export type CardMeta =
  | WriteCardMeta
  | EditCardMeta
  | AstEditCardMeta
  | ReadCardMeta
  | SearchCardMeta
  | TerminalCardMeta

/** Whether `value` is a plain object (never an array or `null`). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Non-blank string, or `null`. */
function nonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** 1-based integer, or `null` (the shipped card models' own line rule). */
function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null
}

/** Non-negative integer, or `null`. */
function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/** Optional grammar hint: a non-empty string stays, anything else drops. */
function lang(value: unknown): { lang?: string } {
  return typeof value === 'string' && value !== '' ? { lang: value } : {}
}

/**
 * Narrow opaque metadata to a {@link WriteCardMeta}.
 * @param meta - the result node's `meta` field.
 * @returns the narrowed metadata, or `null` when it is not a usable write card.
 */
export function narrowWriteCardMeta(meta: unknown): WriteCardMeta | null {
  if (!isRecord(meta) || meta.kind !== 'write') return null
  const path = nonBlankString(meta.path)
  if (path === null) return null
  return {
    kind: 'write',
    path,
    ...lang(meta.lang),
    ...meta.madeExecutable === true ? { madeExecutable: true } : {},
  }
}

/**
 * Narrow opaque metadata to an {@link EditCardMeta}.
 *
 * Mirrors the shipped diff card's own validation (a hunk needs a non-blank
 * `path`, an explicit `null` or string `oldText`, and a string `newText`) and
 * additionally rejects a payload past {@link EDIT_META_MAX_BYTES}.
 * @param meta - the result node's `meta` field.
 * @returns the narrowed metadata, or `null` when it is not a usable diff card.
 */
export function narrowEditCardMeta(meta: unknown): EditCardMeta | null {
  if (!isRecord(meta) || meta.kind !== 'edit') return null
  if (jsonByteLength(meta) > EDIT_META_MAX_BYTES) return null
  const raw = meta.diffs
  if (!Array.isArray(raw) || raw.length === 0) return null
  const diffs: CardDiffHunk[] = []
  for (const hunk of raw) {
    if (!isRecord(hunk)) return null
    const path = nonBlankString(hunk.path)
    if (path === null) return null
    const { oldText, newText } = hunk
    if (oldText !== null && typeof oldText !== 'string') return null
    if (typeof newText !== 'string') return null
    diffs.push({ path, oldText, newText })
  }
  return { kind: 'edit', diffs }
}

/**
 * Narrow opaque metadata to an {@link AstEditCardMeta}.
 * @param meta - the result node's `meta` field.
 * @returns the narrowed metadata, or `null` when it is not a usable preview.
 */
export function narrowAstEditCardMeta(meta: unknown): AstEditCardMeta | null {
  if (!isRecord(meta) || meta.kind !== 'ast_edit') return null
  if (jsonByteLength(meta) > AST_EDIT_META_MAX_BYTES) return null
  if (typeof meta.preview !== 'string') return null
  const replacements = nonNegativeInteger(meta.replacements)
  if (replacements === null || typeof meta.applied !== 'boolean') return null
  if (!Array.isArray(meta.files)) return null
  const files: { path: string; count: number }[] = []
  for (const file of meta.files) {
    if (!isRecord(file)) return null
    const path = nonBlankString(file.path)
    const count = nonNegativeInteger(file.count)
    if (path === null || count === null) return null
    files.push({ path, count })
  }
  return { kind: 'ast_edit', preview: meta.preview, files, replacements, applied: meta.applied }
}

/**
 * Narrow opaque metadata to a {@link ReadCardMeta}.
 *
 * Mirrors the shipped read card's own validation: a 1-based `offset`, lines
 * strictly increasing in `number` and never past `totalLines`. A window whose
 * lines were all elided therefore narrows to a card with an empty body, not to
 * a malformed one.
 * @param meta - the result node's `meta` field.
 * @returns the narrowed metadata, or `null` when it is not a usable read card.
 */
export function narrowReadCardMeta(meta: unknown): ReadCardMeta | null {
  if (!isRecord(meta) || meta.kind !== 'read') return null
  if (jsonByteLength(meta) > READ_META_MAX_BYTES) return null
  const path = nonBlankString(meta.path)
  const offset = positiveInteger(meta.offset)
  const totalLines = nonNegativeInteger(meta.totalLines)
  if (path === null || offset === null || totalLines === null) return null
  if (!Array.isArray(meta.lines)) return null
  const lines: CardReadLine[] = []
  let previous = offset - 1
  for (const line of meta.lines) {
    if (!isRecord(line)) return null
    const number = positiveInteger(line.number)
    if (number === null || number <= previous || number > totalLines) return null
    if (typeof line.text !== 'string') return null
    previous = number
    lines.push({ number, text: line.text })
  }
  return { kind: 'read', path, offset, lines, totalLines, ...lang(meta.lang) }
}

/** Narrow one grouped-matches file entry, or `null` when malformed. */
function narrowSearchFile(file: unknown): CardSearchFileGroup | null {
  if (!isRecord(file)) return null
  const path = nonBlankString(file.path)
  if (path === null || !Array.isArray(file.matches)) return null
  const matches: CardSearchMatchLine[] = []
  for (const match of file.matches) {
    if (!isRecord(match)) return null
    const lineNumber = positiveInteger(match.lineNumber)
    if (lineNumber === null || typeof match.line !== 'string') return null
    matches.push({ lineNumber, line: match.line })
  }
  return { path, matches }
}

/**
 * Narrow opaque metadata to a {@link SearchCardMeta}.
 * @param meta - the result node's `meta` field.
 * @returns the narrowed metadata, or `null` when it is not a usable search card.
 */
export function narrowSearchCardMeta(meta: unknown): SearchCardMeta | null {
  if (!isRecord(meta) || meta.kind !== 'search') return null
  if (jsonByteLength(meta) > SEARCH_META_MAX_BYTES) return null
  if (typeof meta.truncated !== 'boolean') return null
  const total = nonNegativeInteger(meta.total)
  if (total === null) return null
  if (meta.shape === 'matches') {
    if (!Array.isArray(meta.files)) return null
    const files: CardSearchFileGroup[] = []
    for (const file of meta.files) {
      const narrowed = narrowSearchFile(file)
      if (narrowed === null) return null
      files.push(narrowed)
    }
    return { kind: 'search', shape: 'matches', files, truncated: meta.truncated, total }
  }
  if (meta.shape !== 'paths' || !Array.isArray(meta.paths)) return null
  const paths: string[] = []
  for (const path of meta.paths) {
    if (typeof path !== 'string') return null
    paths.push(path)
  }
  return { kind: 'search', shape: 'paths', paths, truncated: meta.truncated, total }
}

/**
 * Narrow opaque metadata to a {@link TerminalCardMeta}.
 * @param meta - the result node's `meta` field.
 * @returns the narrowed metadata, or `null` when it is not a usable terminal card.
 */
export function narrowTerminalCardMeta(meta: unknown): TerminalCardMeta | null {
  if (!isRecord(meta) || meta.kind !== 'terminal') return null
  if (meta.mode === 'background') {
    const jobId = nonBlankString(meta.jobId)
    return jobId === null ? null : { kind: 'terminal', mode: 'background', jobId }
  }
  if (meta.mode !== 'foreground') return null
  const { exitCode, timedOut, aborted, workingDir } = meta
  if (exitCode !== null && (typeof exitCode !== 'number' || !Number.isInteger(exitCode))) return null
  if (typeof timedOut !== 'boolean' || typeof aborted !== 'boolean') return null
  if (workingDir !== undefined && typeof workingDir !== 'string') return null
  return {
    kind: 'terminal',
    mode: 'foreground',
    exitCode,
    timedOut,
    aborted,
    ...typeof workingDir === 'string' && workingDir !== '' ? { workingDir } : {},
  }
}
