/**
 * `ast_edit` row: the engine's own change preview.
 *
 * The AST engine already renders a grouped preview (file header, replacement
 * count, the first line of each change) and hands it to the Host as
 * `displayContent`; that text is what this card shows, because the exact
 * before/after hunks are dropped inside the ported tool and the write happens
 * in the native engine. No diff is computed here, and no `±` totals are shown.
 * @module @xiaoso/dsh-tool-plus/web/client/rows/AstEditRow
 */

import { CodeBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { narrowAstEditCardMeta } from '../../contract.ts'
import { CARD_LOCALE_NS } from '../labels.ts'
import {
  cardMeta, cardState, cardTitle, displayPath, isErrorResult, isSubCall, parseCardArgs, resultText,
} from '../row-utils.ts'
import { CardBoundary, GenericCard, ToolCardShell } from '../ToolCardShell.tsx'
import { astEditRuleLine } from './command-card-facts.ts'

/** Props the slot hands this row, plus its own locale seat. */
type RowProps = ToolCallViewProps & PropsLocale<typeof CARD_LOCALE_NS>

/** The engine reports parse failures in its result text, not in the metadata. */
const PARSE_ERROR = /parse error/i

/**
 * Render an `ast_edit` call as a change preview.
 * @param props - the slot's owner props and this plugin's translate seat.
 * @returns the preview card, or the generic shell when there is no preview.
 */
export default function AstEditRow(props: RowProps) {
  const { t, block } = props
  const title = cardTitle(props.toolName, t, 'title.astEdit')
  return (
    <CardBoundary t={t} title={title} block={block}>
      <AstEditCard {...props} title={title} />
    </CardBoundary>
  )
}

/**
 * The card itself, inside the boundary.
 * @param props - row props plus the resolved title.
 * @returns the preview card.
 */
function AstEditCard(props: RowProps & { title: string }) {
  const { t, block, cwd, inspect, openFile, title, toolName } = props
  const args = parseCardArgs(block)
  const meta = narrowAstEditCardMeta(cardMeta(block))
  // A Code Dispatch child's preview is drawn by its parent card's own body.
  if (isSubCall(block) || isErrorResult(block) || meta === null || meta.preview === '') {
    return <GenericCard t={t} title={title} block={block} args={args} toolName={toolName} cwd={cwd} openFile={openFile} inspect={inspect} />
  }
  const files = meta.files.length
  const single = files === 1 ? meta.files[0]?.path : undefined
  const output = resultText(block)
  const parseErrors = PARSE_ERROR.test(output)
  // The body previews the *result*; the rule that produced it is only in the
  // call's own arguments, so it is stated above the preview.
  const rule = astEditRuleLine(args, t)
  const summary = single !== undefined && single !== '' ? displayPath(single, cwd) : t('astEdit.files', { count: files })
  return (
    <ToolCardShell
      t={t}
      state={cardState(block)}
      title={title}
      tool={toolName}
      summary={summary}
      summarySuffix={`${t('astEdit.replacements', { count: meta.replacements })} · ${t('astEdit.files', { count: files })}`}
      filePath={single}
      openFile={openFile}
      inspect={inspect}
    >
      <div className="twc-body">
        {rule !== null && <p className="twc-note">{rule}</p>}
        <CodeBlock code={meta.preview} copyLabel={t('copy')} copiedLabel={t('copied')} />
        {output !== '' && (
          <p className="twc-note">{parseErrors ? `${t('astEdit.parseErrors')}: ${output}` : output}</p>
        )}
      </div>
    </ToolCardShell>
  )
}
