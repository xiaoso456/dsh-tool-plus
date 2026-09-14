/**
 * `read` row: a line-numbered window view.
 *
 * The card is drawn only from the Host's narrowed metadata — which carries the
 * window's lines with the file's own line numbers — so a read the projection
 * could not describe (an image, a directory, a sqlite or archive target, an
 * internal URL, a multi-range `:raw` read) keeps the generic shell and its
 * result text instead of a card with invented numbering.
 * @module @xiaoso/dsh-tool-plus/web/client/rows/ReadRow
 */

import { ReadBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { narrowReadCardMeta } from '../../contract.ts'
import { CARD_LOCALE_NS } from '../labels.ts'
import { cardMeta, cardState, cardTitle, displayPath, isSubCall, parseCardArgs, readBlockLabels } from '../row-utils.ts'
import { CardBoundary, GenericCard, ToolCardShell } from '../ToolCardShell.tsx'

/** Props the slot hands this row, plus its own locale seat. */
type RowProps = ToolCallViewProps & PropsLocale<typeof CARD_LOCALE_NS>

/**
 * Render a `read` call as a line-numbered window.
 * @param props - the slot's owner props and this plugin's translate seat.
 * @returns the read card, or the generic shell when no window was projected.
 */
export default function ReadRow(props: RowProps) {
  const { t, block } = props
  const title = cardTitle(props.toolName, t, 'title.read')
  return (
    <CardBoundary t={t} title={title} block={block}>
      <ReadCard {...props} title={title} />
    </CardBoundary>
  )
}

/**
 * The card itself, inside the boundary.
 * @param props - row props plus the resolved title.
 * @returns the read card.
 */
function ReadCard(props: RowProps & { title: string }) {
  const { t, block, cwd, inspect, openFile, title } = props
  const args = parseCardArgs(block)
  const meta = narrowReadCardMeta(cardMeta(block))
  // A Code Dispatch child's window is drawn by its parent card's own body.
  if (isSubCall(block) || block.isError === true || meta === null) {
    return <GenericCard t={t} title={title} block={block} args={args} inspect={inspect} />
  }
  return (
    <ToolCardShell
      t={t}
      state={cardState(block)}
      title={title}
      summary={displayPath(meta.path, cwd)}
      filePath={meta.path}
      filePathLine={meta.offset}
      openFile={openFile}
      inspect={inspect}
    >
      <ReadBlock
        label={displayPath(meta.path, cwd)}
        lines={meta.lines}
        totalLines={meta.totalLines}
        lang={meta.lang}
        labels={readBlockLabels(t)}
        className="twc-body"
      />
    </ToolCardShell>
  )
}
