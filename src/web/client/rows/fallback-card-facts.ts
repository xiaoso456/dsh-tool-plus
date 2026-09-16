/**
 * Collapsed-summary facts for the generic card — every row's degradation path.
 *
 * A call lands on the generic shell when its own card cannot be built: it is
 * still running, its result carried no text, its metadata fell outside the
 * session window, it is a Code Dispatch child, or the Host projected an
 * interruption the card has no material for. In every one of those cases the
 * call's ARGUMENTS are the only material left, and the shipped generic row
 * answers them with the call's own fact: its variant's summary keys first, then
 * ANY string the payload carries, then the first line of the raw argument text
 * (`deriveSummary` in ui-tool's `tool-call-model.ts`). It never answers with an
 * argument count.
 *
 * That is the rule here. The count it replaces told the reader nothing: a
 * directory read, a `:raw` window, a running `grep` and a child call all
 * collapsed to "1 个参数" — the one thing a degraded row must not do, since the
 * head is then the only place the fact exists.
 *
 * The key preference follows THIS plugin's own tool schemas rather than the
 * shipped `SUMMARY_KEYS`: our tools replaced the built-in ones with the OMP
 * native parameter names (`read`/`write` take `path`, `ast_grep` takes `pat`,
 * `ast_edit` takes `paths`), and the shipped table's `file_path` is what the
 * built-in tools used. Both spellings are accepted, ours first, so a transcript
 * recorded before the takeover still states its path.
 * @module @xiaoso/dsh-tool-plus/web/client/rows/fallback-card-facts
 */

import { argText, argsSummary, displayPath, firstLine, type CardTranslate } from '../row-utils.ts'
import { bashCardSummary } from './command-card-facts.ts'
import { readCardSummary } from './read-card-facts.ts'

/**
 * First entry of a path-list argument (`ast_edit.paths`), tolerating the
 * single-string form some calls use.
 * @param args - the call's parsed arguments, or `null`.
 * @param name - the argument's name.
 * @returns the first non-empty path, or `null`.
 */
function firstPath(args: Record<string, unknown> | null, name: string): string | null {
  const value = args?.[name]
  if (typeof value === 'string' && value !== '') return value
  if (!Array.isArray(value)) return null
  for (const entry of value) {
    if (typeof entry === 'string' && entry !== '') return entry
  }
  return null
}

/**
 * The first non-empty string the payload carries under one of `keys` — the
 * shipped row's own key-preference rule, first line only (a payload's own
 * newlines never reach a one-line head).
 * @param args - the call's parsed arguments, or `null`.
 * @param keys - argument names, most significant first.
 * @returns the value, or `null` when none of them is a non-empty string.
 */
function pickKeys(args: Record<string, unknown> | null, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = argText(args, key)
    if (value !== null) return firstLine(value)
  }
  return null
}

/**
 * The `queries` a search call may carry, joined one query per line — the one
 * special case the shipped row makes before its key table.
 * @param args - the call's parsed arguments, or `null`.
 * @returns the joined subject, or `null` when there is no usable query.
 */
function queriesSubject(args: Record<string, unknown> | null): string | null {
  const queries = args?.['queries']
  if (!Array.isArray(queries)) return null
  const parts = queries
    .filter((query): query is string => typeof query === 'string' && query !== '')
    .map(firstLine)
  return parts.length === 0 ? null : parts.join(', ')
}

/**
 * The fact the call states for a key this plugin renders.
 * @param toolName - the call's wire tool name.
 * @param args - the call's parsed arguments, or `null`.
 * @param cwd - the session workspace root, for shortening an absolute path.
 * @returns the stated fact, or `null` when this key states nothing usable.
 */
function statedFact(
  toolName: string | null | undefined,
  args: Record<string, unknown> | null,
  cwd: string | undefined,
): string | null {
  switch (toolName) {
    case 'read': {
      // The call verbatim — selector, archive member and all — because that is
      // the question the model asked; a URL read has no path at all.
      const asked = pickKeys(args, ['path', 'file_path', 'url'])
      return asked === null ? null : readCardSummary(args, asked, cwd)
    }
    case 'bash': {
      // Same head the real terminal card builds: intent, then what ran.
      const command = argText(args, 'command')
      const description = argText(args, 'description')
      if (command === null) return description
      return bashCardSummary(description, command, null)
    }
    case 'write': {
      // Our write engine reads `path`; the built-in tool's spelling is the
      // fallback for a transcript recorded before the takeover.
      const path = pickKeys(args, ['path', 'file_path'])
      return path === null ? null : displayPath(path, cwd)
    }
    case 'edit': {
      // `file_path` FIRST, unlike the shipped table: our edit engine reads
      // `args.file_path ?? args.path` (and the shipped table can put `path`
      // first only because the built-in edit has no `path` parameter at all).
      // A call carrying both would otherwise name a file it never touched.
      const path = pickKeys(args, ['file_path', 'path'])
      return path === null ? null : displayPath(path, cwd)
    }
    case 'ast_edit': {
      const path = firstPath(args, 'paths')
      return path === null ? null : displayPath(path, cwd)
    }
    case 'grep':
    case 'glob':
    case 'ast_grep': {
      const subject = queriesSubject(args) ?? pickKeys(args, ['query', 'pattern', 'pat', 'url', 'path'])
      return subject === null ? null : displayPath(subject, cwd)
    }
    default:
      return null
  }
}

/**
 * The generic card's collapsed summary: the fact the call itself states.
 * @param toolName - the call's wire tool name (empty when truncated).
 * @param args - the call's parsed arguments, or `null` when its head is gone.
 * @param cwd - the session workspace root, for shortening an absolute path.
 * @param t - the card translate seat.
 * @param raw - the call's original argument text, for a payload that is not
 *   valid JSON yet (a call still streaming its arguments) or whose only values
 *   are non-strings.
 * @returns the collapsed summary text.
 */
export function fallbackCardSummary(
  toolName: string | null | undefined,
  args: Record<string, unknown> | null,
  cwd: string | undefined,
  t: CardTranslate,
  raw: string | null = null,
): string {
  const stated = statedFact(toolName, args, cwd)
  if (stated !== null) return stated
  // The shipped row's last two tries before it gives up: any string at all
  // (first line only — a payload's newlines never reach a one-line head), then
  // the raw argument text (which exists even when the parse does not).
  if (args !== null) {
    for (const value of Object.values(args)) {
      if (typeof value === 'string' && value !== '') return firstLine(value)
    }
  }
  const text = raw === null || raw === '' ? null : firstLine(raw)
  if (text !== null && text !== '') return text
  return argsSummary(args, t)
}

/**
 * Everything from the first colon is a read selector, not part of a filename.
 * The colon after a Windows drive letter is not one, and a URL is not a session
 * file at all.
 * @param value - the path argument, verbatim.
 * @returns the file the path names, or `null` when it names no openable file.
 */
function stripSelector(value: string): string | null {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) return null
  const start = /^[a-zA-Z]:[\\/]/.test(value) ? 2 : 0
  const colon = value.indexOf(':', start)
  const base = colon === -1 ? value : value.slice(0, colon)
  return base === '' ? null : base
}

/**
 * The real file a degraded file-backed row may offer to open — `null` when the
 * call names no single file.
 *
 * The head states the call verbatim (selector included) while the link has to
 * name a real file: the same split the read card itself makes between its
 * summary and its link. Whether that file then previews is the side bar's
 * decision, never this module's.
 * @param toolName - the call's wire tool name.
 * @param args - the call's parsed arguments, or `null`.
 * @returns the file to open, or `null` when there is nothing to open.
 */
export function fallbackCardLink(
  toolName: string | null | undefined,
  args: Record<string, unknown> | null,
): string | null {
  switch (toolName) {
    case 'read': {
      // A URL read is not a file in the session filesystem.
      const asked = pickKeys(args, ['path', 'file_path'])
      return asked === null ? null : stripSelector(asked)
    }
    case 'write':
      return pickKeys(args, ['path', 'file_path'])
    case 'edit':
      return pickKeys(args, ['file_path', 'path'])
    case 'ast_edit':
      return firstPath(args, 'paths')
    default:
      // A shell command's or a search's argument is a scope, not a file: the
      // shipped rows give a `filePath` only to the read / write / edit family.
      return null
  }
}
