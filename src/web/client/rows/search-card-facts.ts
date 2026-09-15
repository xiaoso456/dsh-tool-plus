/**
 * Collapsed-summary facts for the `grep` / `ast_grep` / `glob` cards.
 *
 * The row's summary is the search's *subject* — `pattern` for grep, `pat` for
 * ast_grep, the path pattern for glob — so the one question the collapsed head
 * could not answer is "which tree was searched?", and the counts sat in the
 * folded body. That reads worst on an empty result: a bare `Grep · zzz` looks
 * like a bad pattern rather than like a search of the wrong directory.
 *
 * Two facts therefore ride the head as a trailing fragment, after the summary
 * and outside its ellipsis, because they are the parts a narrow row must never
 * clip:
 *  - the scope, taken from the call's own `path` argument. Only `matches`
 *    shapes take it: a glob's `path` argument *is* its pattern, which the
 *    summary already shows, so repeating it as a scope would claim a second
 *    fact out of one argument. A call without `path` searched the workspace
 *    root — naming no scope is honest, inventing one is not;
 *  - the count, or "no results" instead of a zero count (a zero count is what
 *    the empty-state failure reads as, not what it says).
 *
 * The counting labels are the {@link searchBlockLabels} adapter the block body
 * already uses, so the head and the body say the same thing in the same words,
 * including the "showing N of M" wording of a capped payload.
 * @module @xiaoso/dsh-tool-plus/web/client/rows/search-card-facts
 */

import type { SearchCardMeta } from '../../contract.ts'
import type { CardTranslate } from '../row-utils.ts'
import { argText, displayPath, searchBlockLabels } from '../row-utils.ts'

/** Separator between the suffix's facts; the shell adds the summary's own. */
const FACT_SEPARATOR = ' · '

/**
 * A target may be a `;`-delimited list of paths. Shortening the whole list in
 * one pass would cut the workspace prefix off its first entry only — the rest
 * stay absolute, and the same scope then reads as two unrelated places — so
 * each entry is shortened on its own and the list is rejoined.
 * @param scope - the call's own target argument.
 * @param cwd - the session workspace root, when known.
 * @returns the workspace-shortened target.
 */
function displayScope(scope: string, cwd: string | undefined): string {
  if (!scope.includes(';')) return displayPath(scope, cwd)
  return scope.split(';').map(entry => displayPath(entry.trim(), cwd)).join('; ')
}

/**
 * The search card's collapsed trailing fragment: the scope the call searched,
 * then what the search found.
 * @param args - the call's parsed arguments, or `null` when its head is gone.
 * @param meta - the Host-projected search metadata (already narrowed).
 * @param cwd - the session workspace root, for shortening an absolute scope.
 * @param t - the card translate seat.
 * @returns the joined fragment, or `null` when there is no fact to add.
 */
export function searchCardSuffix(
  args: Record<string, unknown> | null,
  meta: SearchCardMeta,
  cwd: string | undefined,
  t: CardTranslate,
): string | null {
  const facts: string[] = []

  if (meta.shape === 'matches') {
    const scope = argText(args, 'path')
    if (scope !== null) facts.push(t('search.scope', { path: displayScope(scope, cwd) }))
  }

  if (meta.total === 0) {
    // "No results" rather than "0 matches": the empty state is the failure the
    // head has to read as, and a zero count does not say which failure it was.
    facts.push(t('search.noResults'))
  } else if (meta.shape === 'matches') {
    const shown = meta.files.reduce((count, file) => count + file.matches.length, 0)
    facts.push(searchBlockLabels(t).matchesSummary(shown, meta.total, meta.files.length, meta.truncated))
  } else {
    facts.push(searchBlockLabels(t).pathsSummary(meta.paths.length, meta.total, meta.truncated))
  }

  // The fragment opens with the row's own dot: the subject and what came back
  // are two facts, and the dot is how this head separates its facts. Without it
  // the subject runs straight into the scope (`export 范围 src`).
  return facts.length === 0 ? null : `· ${facts.join(FACT_SEPARATOR)}`
}
