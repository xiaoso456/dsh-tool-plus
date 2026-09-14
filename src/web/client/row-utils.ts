/**
 * Defensive readers shared by the tool-card rows, plus the adapters that bind
 * this plugin's card dictionary onto the cordis-free UI primitives.
 *
 * The rows render data the model never sees: a call's frozen node, its raw
 * arguments, its result text, and the Host-projected metadata. Every read here
 * is written to survive a malformed input — a window-truncated call, a
 * hand-rolled argument payload, a metadata blob from another plugin version —
 * and to return a "no data" answer instead of throwing: an exception inside a
 * row reaches the slot, which retires the cell and hands the call back to the
 * shipped row with the failure surfaced in the console.
 *
 * Metadata is only ever read through `src/web/contract.ts`'s `narrow*` guards;
 * nothing here touches a raw `meta` field directly.
 * @module @xiaoso/dsh-tool-plus/web/client/row-utils
 */

import type {
  DiffBlockLabels,
  ReadBlockLabels,
  SearchBlockLabels,
  StateDotState,
  TerminalBlockLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { narrowTerminalCardMeta } from '../contract.ts'
import type { CARD_LOCALE_NS, ToolCardLocaleKey } from './labels.ts'

/** Translate seat of this plugin's card namespace. */
export type CardTranslate = TranslateNS<typeof CARD_LOCALE_NS>

/**
 * Structural view of the frozen running-or-settled node a row receives. It
 * names only the fields the cards actually read, so an upstream node shape
 * change degrades a card instead of breaking the row.
 */
export interface CardBlockView {
  readonly kind?: unknown
  readonly callId?: unknown
  readonly parentCallId?: unknown
  readonly name?: unknown
  readonly argsRaw?: unknown
  readonly call?: { readonly name?: unknown; readonly argsRaw?: unknown } | null
  readonly content?: unknown
  readonly isError?: unknown
  readonly meta?: unknown
}

/** Card run state, one step off the shipped `ToolRowState` (no `stopped`). */
export type CardState = 'running' | 'ok' | 'error' | 'warning'

/** Run state word the shell exposes to assistive technology; `ok` says nothing. */
const STATE_STATUS_KEY: Record<CardState, ToolCardLocaleKey | null> = {
  running: 'running',
  ok: null,
  error: 'failed',
  warning: 'failed',
}

/** Parsed-argument cache: the node is immutable, so one parse serves every render. */
const parsedArgs = new WeakMap<object, Record<string, unknown> | null>()

/** Whether a block is the settled half of a call pair. */
export function isSettled(block: CardBlockView): boolean {
  return block.kind === 'tool-result'
}

/**
 * The call head paired with a block: a running call is its own head; a settled
 * result carries the head backfilled from the in-window `tool/call`, which is
 * `null` when window truncation left that event outside.
 */
function callHead(block: CardBlockView): { readonly name?: unknown; readonly argsRaw?: unknown } | null {
  if (!isSettled(block)) return block
  const call = block.call
  return typeof call === 'object' && call !== null ? call : null
}

/** Whether `value` is a plain object, the only argument shape the cards accept. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse the call's raw argument JSON.
 *
 * The parsed object is memoized per node (the node is immutable), so repeated
 * renders of one card pay for a single parse.
 * @param block - the frozen running-or-settled call node.
 * @returns the argument object, or `null` when the head is missing or its JSON
 *   is not an object.
 */
export function parseCardArgs(block: CardBlockView): Record<string, unknown> | null {
  const cacheable: object | null = typeof block === 'object' && block !== null ? block : null
  if (cacheable !== null) {
    const hit = parsedArgs.get(cacheable)
    if (hit !== undefined || parsedArgs.has(cacheable)) return hit ?? null
  }
  const raw = callHead(block)?.argsRaw
  let parsed: Record<string, unknown> | null = null
  if (typeof raw === 'string') {
    try {
      const value: unknown = JSON.parse(raw)
      if (isRecord(value)) parsed = value
    } catch {
      parsed = null
    }
  }
  if (cacheable !== null) parsedArgs.set(cacheable, parsed)
  return parsed
}

/**
 * Run state of one call.
 *
 * A settled `isError` result is an error; a foreground command that timed out
 * or was cancelled is amber rather than green (the shipped terminal model
 * reads only the trailing exit marker, which is exactly what the card owner
 * was told not to trust). A non-zero exit stays `ok`: bash reports a failing
 * command as result data, and the card's own status pill carries the red.
 * @param block - the frozen running-or-settled call node.
 * @returns the card run state.
 */
export function cardState(block: CardBlockView): CardState {
  if (!isSettled(block)) return 'running'
  if (block.isError === true) return 'error'
  const terminal = narrowTerminalCardMeta(cardMeta(block))
  if (terminal !== null && terminal.mode === 'foreground' && (terminal.timedOut || terminal.aborted)) {
    return 'warning'
  }
  return 'ok'
}

/** Map a card run state onto the primitive's dot semantics. */
export function dotState(state: CardState): StateDotState {
  switch (state) {
    case 'running': return 'ongoing'
    case 'error': return 'error'
    case 'warning': return 'warning'
    default: return 'done'
  }
}

/**
 * The assistive-technology status word for a run state, or `null` when the
 * state is already carried by the row's content.
 */
export function stateStatus(state: CardState, t: CardTranslate): string | null {
  const key = STATE_STATUS_KEY[state]
  return key === null ? null : t(key)
}

/**
 * Flatten a settled result's text blocks.
 * @param block - the frozen call node.
 * @returns the joined text blocks (empty for a running call or non-text output).
 */
export function resultText(block: CardBlockView): string {
  if (!isSettled(block) || !Array.isArray(block.content)) return ''
  const parts: string[] = []
  for (const part of block.content) {
    if (!isRecord(part)) continue
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join('\n')
}

/**
 * The opaque metadata a call's result carried, exactly as the transport
 * delivered it. Callers must run it through a `narrow*` guard before reading.
 * @param block - the frozen call node.
 * @returns the raw metadata, or `undefined` while the call is running.
 */
export function cardMeta(block: CardBlockView): unknown {
  return isSettled(block) ? block.meta : undefined
}

/**
 * Whether the call was dispatched by another tool (a Code Dispatch child).
 * The card rows fall back to the generic shell for those, mirroring the
 * shipped rows: a child diff/read/search inside a parent card would nest a
 * surface inside the parent's own body.
 */
export function isSubCall(block: CardBlockView): boolean {
  return typeof block.parentCallId === 'string'
}

/** Longest summary the shell renders before it is clipped for the row. */
const FIRST_LINE_MAX = 200

/**
 * The first non-empty line of a text, trimmed — the collapsed summary of an
 * error, and the closing line of the generic shell's body.
 * @param text - the source text.
 * @returns the first line, clipped to a row-sized maximum (never throws).
 */
export function firstLine(text: string): string {
  if (typeof text !== 'string') return ''
  const line = text.trim().split('\n', 1)[0]?.trim() ?? ''
  return line.length > FIRST_LINE_MAX ? `${line.slice(0, FIRST_LINE_MAX - 1)}…` : line
}

/**
 * A string argument by name.
 * @param args - parsed arguments, or `null`.
 * @param name - the argument key.
 * @returns its value when it is a non-empty string, else `null`.
 */
export function argText(args: Record<string, unknown> | null, name: string): string | null {
  const value = args?.[name]
  return typeof value === 'string' && value !== '' ? value : null
}

/** Options object passed to the owner's `openFile` (a line to land on). */
export interface CardOpenFileOptions { line?: number }

/**
 * Shorten an absolute path against the session workspace so a summary stays
 * readable in a narrow row.
 * @param path - the path to display.
 * @param cwd - the session workspace root, when known.
 * @returns the path relative to `cwd`, or `path` unchanged.
 */
export function displayPath(path: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return path
  const root = cwd.endsWith('/') || cwd.endsWith('\\') ? cwd : `${cwd}/`
  const normalized = path.replace(/\\/g, '/')
  const prefix = root.replace(/\\/g, '/')
  if (!normalized.startsWith(prefix)) return path
  const rest = normalized.slice(prefix.length)
  return rest === '' ? path : rest
}

/**
 * The collapsed summary for a call whose card could not be built: how many
 * arguments the model sent, so the row is not blank.
 * @param args - parsed arguments, or `null`.
 * @param t - the card translate seat.
 * @returns the localized parameter count.
 */
export function argsSummary(args: Record<string, unknown> | null, t: CardTranslate): string {
  const count = args === null ? 0 : Object.keys(args).length
  return count === 0 ? t('generic.noDetail') : t('generic.params', { count })
}

/** Card title key of every wire tool name this plugin renders. */
const TITLE_KEYS: Record<string, ToolCardLocaleKey> = {
  bash: 'title.bash',
  read: 'title.read',
  write: 'title.write',
  edit: 'title.edit',
  grep: 'title.grep',
  glob: 'title.glob',
  ast_grep: 'title.astGrep',
  ast_edit: 'title.astEdit',
}

/**
 * The card title for a wire tool name.
 *
 * The same row component can be registered under several keys (one search row
 * serves `grep`, `glob`, and `ast_grep`), and a window-truncated call has no
 * name at all, so the caller names the key it was registered for as a fallback.
 * @param toolName - the node's wire tool name (empty when truncated).
 * @param t - the card translate seat.
 * @param fallback - title key to use when the name is unknown.
 * @returns the localized title.
 */
export function cardTitle(toolName: string, t: CardTranslate, fallback: ToolCardLocaleKey): string {
  const key = typeof toolName === 'string' ? TITLE_KEYS[toolName] : undefined
  return t(key ?? fallback)
}

/**
 * Count a preview's content lines, ignoring the single trailing newline that
 * terminates the last line.
 * @param text - the preview text.
 * @returns its line count (0 for empty text).
 */
export function lineCount(text: string): number {
  if (typeof text !== 'string' || text === '') return 0
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n').length
}

/** A shell result's trailing status markers, and the text they were stripped from. */
export interface ShellStatus {
  /** The output text with its trailing marker lines removed. */
  output: string
  /** Marked exit code; `null` when the marker itself carried no code. */
  exitCode: number | null | undefined
  /** Terminating signal name, when a marker named one. */
  signal: string | undefined
  /** A timeout marker was present. */
  timedOut: boolean
}

/** `[timed out after 30000ms]` — `@deepseek-ai/dsh-shell/render`'s own literal. */
const TIMEOUT_MARKER = /^\[timed out after [^\]\n]*\]$/
/** `[killed by signal: SIGTERM]`. */
const SIGNAL_MARKER = /^\[killed by signal: ([^\]\n]+)\]$/
/** `[exit code: 1]`, or `[exit code: null]` for an unknown status. */
const EXIT_MARKER = /^\[exit code: (\d+|null)\]$/

/**
 * Split a settled shell result into its output and the status markers the
 * renderer appended (timeout, terminating signal, exit code — in that order,
 * so every marker is at the end and any run of them is stripped).
 *
 * The Host metadata already carries the run state; parsing is what keeps the
 * markers out of the terminal card's output pane, and it is the only source
 * for a signal name the projection does not carry.
 * @param text - the result text.
 * @returns the marker-free output and the facts the markers named.
 */
export function parseShellStatus(text: string): ShellStatus {
  let rest = typeof text === 'string' ? text : ''
  let exitCode: number | null | undefined
  let signal: string | undefined
  let timedOut = false
  for (;;) {
    const trimmed = rest.endsWith('\n') ? rest.slice(0, -1) : rest
    const breakAt = trimmed.lastIndexOf('\n')
    const last = breakAt === -1 ? trimmed : trimmed.slice(breakAt + 1)
    const exit = EXIT_MARKER.exec(last)
    if (exit !== null) {
      exitCode = exit[1] === 'null' ? null : Number(exit[1])
      rest = breakAt === -1 ? '' : trimmed.slice(0, breakAt)
      continue
    }
    const killed = SIGNAL_MARKER.exec(last)
    if (killed !== null) {
      signal = killed[1]
      rest = breakAt === -1 ? '' : trimmed.slice(0, breakAt)
      continue
    }
    if (TIMEOUT_MARKER.test(last)) {
      timedOut = true
      rest = breakAt === -1 ? '' : trimmed.slice(0, breakAt)
      continue
    }
    break
  }
  return { output: rest, exitCode, signal, timedOut }
}

/** Bind the card dictionary to the diff primitive's chrome labels. */
export function diffBlockLabels(t: CardTranslate): DiffBlockLabels {
  return {
    copy: t('copy'),
    copied: t('copied'),
    collapseAria: t('collapseAria'),
    expandAria: count => t('expandAria', { count }),
    collapse: t('collapse'),
    expand: count => t('expandRest', { count }),
    files: count => t(count === 1 ? 'files.one' : 'files.other', { count }),
  }
}

/** Bind the card dictionary to the read primitive's chrome labels. */
export function readBlockLabels(t: CardTranslate): ReadBlockLabels {
  return {
    window: (shown, total) => t('read.window', { shown, total }),
    copy: t('copy'),
    copied: t('copied'),
    collapseAria: t('read.collapseAria'),
    expandAria: count => t('read.expandAria', { count }),
    collapse: t('collapse'),
    expand: count => t('read.expandRest', { count }),
  }
}

/** Bind the card dictionary to the search primitive's chrome labels. */
export function searchBlockLabels(t: CardTranslate): SearchBlockLabels {
  return {
    pathsSummary: (shown, total, truncated) => t(
      truncated ? 'search.paths.truncated' : 'search.paths',
      { shown, total },
    ),
    matchesSummary: (shown, total, files, truncated) => t(
      truncated ? 'search.matches.truncated' : 'search.matches',
      { shown, total, files },
    ),
    copy: t('copy'),
    copied: t('copied'),
    noResults: t('search.noResults'),
    collapseAria: t('search.collapseAria'),
    expandAria: count => t('search.expandAria', { count }),
    collapse: t('collapse'),
    expand: count => t('search.expandRest', { count }),
  }
}

/** Bind the card dictionary to the terminal primitive's chrome labels. */
export function terminalBlockLabels(t: CardTranslate): TerminalBlockLabels {
  return {
    signal: signal => t('terminal.signal', { signal }),
    exitCode: exitCode => t('terminal.exitCode', { code: exitCode }),
    running: t('terminal.running'),
    failed: t('terminal.failed'),
    done: t('terminal.done'),
    copy: t('copy'),
    copied: t('copied'),
    noOutput: t('terminal.noOutput'),
    collapseAria: t('collapseAria'),
    collapse: t('collapse'),
    expandAria: hidden => t('expandAria', { count: hidden }),
    expand: hidden => t('expandRest', { count: hidden }),
  }
}
