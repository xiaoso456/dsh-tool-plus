/**
 * `write` row: a content preview card.
 *
 * The engine's write card is a preview of what was written, not a diff, and
 * the content is in the arguments — so the card is complete while the call is
 * still running, and the line count is counted on the client exactly as the
 * engine's own header does. The language hint comes from the Host projection
 * (`meta.lang`), which is the only part the arguments cannot supply.
 * @module @xiaoso/dsh-tool-plus/web/client/rows/WriteRow
 */

import { CodeBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { narrowWriteCardMeta } from '../../contract.ts'
import { CARD_LOCALE_NS } from '../labels.ts'
import {
  argText, cardMeta, cardState, cardTitle, displayPath, lineCount, isSubCall, parseCardArgs, resultText,
} from '../row-utils.ts'
import { CardBoundary, GenericCard, ToolCardShell } from '../ToolCardShell.tsx'

/** Props the slot hands this row, plus its own locale seat. */
type RowProps = ToolCallViewProps & PropsLocale<typeof CARD_LOCALE_NS>

/**
 * Render a `write` call as a content preview.
 * @param props - the slot's owner props and this plugin's translate seat.
 * @returns the card, or the generic shell when the arguments are unusable.
 */
export default function WriteRow(props: RowProps) {
  const { t, block } = props
  const title = cardTitle(props.toolName, t, 'title.write')
  return (
    <CardBoundary t={t} title={title} block={block}>
      <WriteCard {...props} title={title} />
    </CardBoundary>
  )
}

/**
 * The card itself, inside the boundary.
 * @param props - row props plus the resolved title.
 * @returns the preview card.
 */
function WriteCard(props: RowProps & { title: string }) {
  const { t, block, cwd, inspect, openFile, title, toolName } = props
  const args = parseCardArgs(block)
  const meta = narrowWriteCardMeta(cardMeta(block))
  const content = argText(args, 'content')
  const path = meta?.path ?? argText(args, 'path')
  // A Code Dispatch child's write preview is drawn by its parent card's own
  // body, so it stays on the generic path (as the shipped diff rows do).
  if (isSubCall(block) || block.isError === true || content === null || path === null) {
    return <GenericCard t={t} title={title} block={block} args={args} toolName={toolName} cwd={cwd} openFile={openFile} inspect={inspect} />
  }
  const lines = t('write.lines', { count: lineCount(content) })
  const skip = meta?.madeExecutable === true ? ` · ${t('write.madeExecutable')}` : ''
  const output = resultText(block)
  return (
    <ToolCardShell
      t={t}
      state={cardState(block)}
      title={title}
      tool={toolName}
      summary={displayPath(path, cwd)}
      summarySuffix={lines + skip}
      filePath={path}
      openFile={openFile}
      inspect={inspect}
    >
      <div className="twc-body">
        <CodeBlock
          code={content}
          lang={meta?.lang}
          lineNumbers
          copyLabel={t('copy')}
          copiedLabel={t('copied')}
        />
        {output !== '' && <p className="twc-note">{output}</p>}
      </div>
    </ToolCardShell>
  )
}
