/**
 * `edit` row: a diff card.
 *
 * Two sources, in order: the Host projection (`meta.diffs`, built from the
 * engine's own unified diff — the change is already computed and needs no
 * extra I/O), then the replace-form arguments while the call is still running
 * (or when the Host could not project a diff). Every other edit mode (patch,
 * hashline, apply_patch) has no diff until it settles, so it falls back to the
 * generic shell rather than guessing from `patch`/`input` text.
 * @module @xiaoso/dsh-tool-plus/web/client/rows/FileMutationRow
 */

import { DiffBlock, diffTotals, type DiffHunk } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { narrowEditCardMeta } from '../../contract.ts'
import { CARD_LOCALE_NS } from '../labels.ts'
import {
  argText, cardMeta, cardState, cardTitle, diffBlockLabels, displayPath, isErrorResult, isSubCall,
  parseCardArgs,
} from '../row-utils.ts'
import { CardBoundary, GenericCard, ToolCardShell } from '../ToolCardShell.tsx'

/** Props the slot hands this row, plus its own locale seat. */
type RowProps = ToolCallViewProps & PropsLocale<typeof CARD_LOCALE_NS>

/**
 * Render an `edit` call as a diff card.
 * @param props - the slot's owner props and this plugin's translate seat.
 * @returns the diff card, or the generic shell for a mode with no diff yet.
 */
export default function FileMutationRow(props: RowProps) {
  const { t, block } = props
  const title = cardTitle(props.toolName, t, 'title.edit')
  return (
    <CardBoundary t={t} title={title} block={block}>
      <FileMutationCard {...props} title={title} />
    </CardBoundary>
  )
}

/**
 * The card itself, inside the boundary.
 * @param props - row props plus the resolved title.
 * @returns the diff card.
 */
function FileMutationCard(props: RowProps & { title: string }) {
  const { t, block, cwd, inspect, openFile, title, toolName } = props
  const args = parseCardArgs(block)
  const meta = narrowEditCardMeta(cardMeta(block))
  const replaceForm = replaceHunks(args)
  // A Code Dispatch child's diff is drawn by its parent card's own body; the
  // shipped rows keep those on the generic path and so do we.
  if (isSubCall(block) || isErrorResult(block) || (meta === null && replaceForm === null)) {
    return <GenericCard t={t} title={title} block={block} args={args} toolName={toolName} cwd={cwd} openFile={openFile} inspect={inspect} />
  }
  const diffs: DiffHunk[] = meta === null ? replaceForm ?? [] : meta.diffs
  const paths = [...new Set(diffs.map(hunk => hunk.path))]
  const single = paths.length === 1 ? paths[0] : undefined
  const totals = diffTotals(diffs)
  const summary = single === undefined
    ? t('files.other', { count: paths.length })
    : displayPath(single, cwd)
  return (
    <ToolCardShell
      t={t}
      state={cardState(block)}
      title={title}
      tool={toolName}
      summary={summary}
      summarySuffix={`+${totals.added} -${totals.removed}`}
      filePath={single}
      openFile={openFile}
      inspect={inspect}
    >
      <DiffBlock diffs={diffs} labels={diffBlockLabels(t)} className="twc-body" />
    </ToolCardShell>
  )
}

/**
 * The replace form's diff, straight from the call's arguments: one hunk for
 * `old_string` → `new_string`. The empty `new_string` is a real value (it
 * deletes), so only the path and `old_string` are required to be non-empty.
 * @param args - the call's parsed arguments, or `null`.
 * @returns one hunk, or `null` when the call is not the replace form.
 */
function replaceHunks(args: Record<string, unknown> | null): DiffHunk[] | null {
  const path = argText(args, 'file_path')
  const oldText = argText(args, 'old_string')
  const newText = args?.new_string
  if (path === null || oldText === null || typeof newText !== 'string') return null
  return [{ path, oldText, newText }]
}
