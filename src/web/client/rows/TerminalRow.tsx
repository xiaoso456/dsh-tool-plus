/**
 * `bash` row: a terminal card for foreground runs, a generic row for jobs.
 *
 * The card's command comes from the arguments, its working directory from the
 * arguments falling back to the Host projection and then the session root, and
 * its exit status from the Host projection — the trailing `[exit code: N]`
 * marker is only parsed to keep it out of the output pane (and to recover the
 * signal name the projection does not carry). A call the Host handed to a
 * background job shows the job id instead: its result is a hand-off notice,
 * not a finished command.
 * @module @xiaoso/dsh-tool-plus/web/client/rows/TerminalRow
 */

import { TerminalBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { narrowTerminalCardMeta } from '../../contract.ts'
import { CARD_LOCALE_NS } from '../labels.ts'
import {
  argText, cardMeta, cardState, cardTitle, parseCardArgs, parseShellStatus, resultText,
  terminalBlockLabels,
} from '../row-utils.ts'
import { CardBoundary, GenericCard, ToolCardShell } from '../ToolCardShell.tsx'
import { bashCardSummary } from './command-card-facts.ts'

/** Props the slot hands this row, plus its own locale seat. */
type RowProps = ToolCallViewProps & PropsLocale<typeof CARD_LOCALE_NS>

/**
 * Render a `bash` call as a terminal card.
 * @param props - the slot's owner props and this plugin's translate seat.
 * @returns the terminal card, the job hand-off row, or the generic shell.
 */
export default function TerminalRow(props: RowProps) {
  const { t, block } = props
  const title = cardTitle(props.toolName, t, 'title.bash')
  return (
    <CardBoundary t={t} title={title} block={block}>
      <TerminalCard {...props} title={title} />
    </CardBoundary>
  )
}

/**
 * The card itself, inside the boundary.
 * @param props - row props plus the resolved title.
 * @returns the terminal card or the generic shell.
 */
function TerminalCard(props: RowProps & { title: string }) {
  const { t, block, cwd: sessionCwd, home, inspect, title, toolName } = props
  const args = parseCardArgs(block)
  const meta = narrowTerminalCardMeta(cardMeta(block))
  const command = argText(args, 'command')
  const state = cardState(block)
  if (block.isError === true || command === null) {
    return <GenericCard t={t} title={title} block={block} args={args} toolName={toolName} cwd={sessionCwd} inspect={inspect} />
  }
  if (meta !== null && meta.mode === 'background') {
    return (
      <ToolCardShell
        t={t}
        state={state}
        title={title}
        tool={toolName}
        summary={t('bash.background', { jobId: meta.jobId })}
        text={resultText(block)}
        inspect={inspect}
      />
    )
  }
  const foreground = meta !== null && meta.mode === 'foreground' ? meta : null
  const status = parseShellStatus(resultText(block))
  const running = state === 'running'
  const timedOut = status.timedOut || foreground?.timedOut === true
  const aborted = foreground?.aborted === true
  const interrupted = timedOut || aborted
  // An interrupted run has no exit status to report: the deadline or the
  // cancellation is the outcome, and the row must not paint it as a clean exit.
  const exitCode = running || interrupted
    ? undefined
    : typeof foreground?.exitCode === 'number'
      ? foreground.exitCode
      : typeof status.exitCode === 'number' ? status.exitCode : undefined
  const workdir = argText(args, 'workdir') ?? foreground?.workingDir ?? sessionCwd
  // The head states the intent *and* the command: a description alone left the
  // reader expanding the card to learn what actually ran.
  const summary = bashCardSummary(
    argText(args, 'description'),
    command,
    interrupted ? (timedOut ? t('timedOut') : t('cancelled')) : null,
  )
  return (
    <ToolCardShell t={t} state={state} title={title} tool={toolName} summary={summary} inspect={inspect}>
      <TerminalBlock
        command={command}
        cwd={workdir}
        home={home}
        output={status.output}
        exitCode={exitCode}
        signal={status.signal}
        running={running}
        labels={terminalBlockLabels(t)}
        className="twc-body"
      />
    </ToolCardShell>
  )
}
