/**
 * `grep` / `glob` / `ast_grep` row: a search result card.
 *
 * One component serves all three keys because the Host projects one
 * `shape`-discriminated metadata form for them: grouped matches for the two
 * grep engines, a flat path list for glob. The title follows the call's own
 * wire name, so the same component reads as Grep, Glob, or AST Grep.
 * @module @xiaoso/dsh-tool-plus/web/client/rows/SearchRow
 */

import { SearchBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { narrowSearchCardMeta } from '../../contract.ts'
import { CARD_LOCALE_NS } from '../labels.ts'
import { argText, argsSummary, cardMeta, cardState, cardTitle, isSubCall, parseCardArgs, searchBlockLabels } from '../row-utils.ts'
import { searchCardSuffix } from './search-card-facts.ts'
import { CardBoundary, GenericCard, ToolCardShell } from '../ToolCardShell.tsx'

/** Props the slot hands this row, plus its own locale seat. */
type RowProps = ToolCallViewProps & PropsLocale<typeof CARD_LOCALE_NS>

/**
 * Render a search call as a result card.
 * @param props - the slot's owner props and this plugin's translate seat.
 * @returns the search card, or the generic shell with the result text.
 */
export default function SearchRow(props: RowProps) {
  const { t, block } = props
  // The same row is registered for grep, glob, and ast_grep; grep is the
  // fallback for a window-truncated call that carries no name at all.
  const title = cardTitle(props.toolName, t, 'title.grep')
  return (
    <CardBoundary t={t} title={title} block={block}>
      <SearchCard {...props} title={title} />
    </CardBoundary>
  )
}

/**
 * The card itself, inside the boundary.
 * @param props - row props plus the resolved title.
 * @returns the search card.
 */
function SearchCard(props: RowProps & { title: string }) {
  const { t, block, cwd, inspect, title } = props
  const args = parseCardArgs(block)
  const meta = narrowSearchCardMeta(cardMeta(block))
  // A Code Dispatch child's result is drawn by its parent card's own body.
  if (isSubCall(block) || block.isError === true || meta === null) {
    return <GenericCard t={t} title={title} block={block} args={args} inspect={inspect} />
  }
  // The subject of the search — `pattern` for grep, `pat` for ast_grep, the
  // path for glob — is the most useful summary; the banner inside the block
  // carries the counts. The scope and the counts also ride the collapsed head,
  // where the subject alone cannot say which tree was searched.
  const subject = argText(args, 'pattern') ?? argText(args, 'pat') ?? argText(args, 'path')
  const labels = searchBlockLabels(t)
  return (
    <ToolCardShell
      t={t}
      state={cardState(block)}
      title={title}
      summary={subject ?? argsSummary(args, t)}
      summarySuffix={searchCardSuffix(args, meta, cwd, t)}
      inspect={inspect}
    >
      {meta.shape === 'matches'
        ? (
          <SearchBlock
            kind="matches"
            files={meta.files}
            truncated={meta.truncated}
            total={meta.total}
            labels={labels}
            className="twc-body"
          />
        )
        : (
          <SearchBlock
            kind="paths"
            paths={meta.paths}
            truncated={meta.truncated}
            total={meta.total}
            labels={labels}
            className="twc-body"
          />
        )}
    </ToolCardShell>
  )
}
