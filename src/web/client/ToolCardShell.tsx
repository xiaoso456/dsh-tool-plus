/**
 * The shared card shell every row renders through.
 *
 * The shipped `ToolRow` is not reusable from a plugin (ui-tool is not part of
 * the client platform baseline), so this is our own: one 24px header line
 * (state dot + title + separator + ellipsized summary + optional `+N -M`
 * suffix + clickable path), a keyboard-reachable disclosure, and a body that
 * is either the card a row built or the flattened result text.
 *
 * Two properties matter more than the visuals:
 * - **Never throw.** Every value is coerced defensively, and {@link CardBoundary}
 *   turns a crash inside a card into the same generic shell, because an
 *   exception reaching the slot retires the cell and abdicates the call to the
 *   shipped row.
 * - **Theme tokens only.** The sheet below reads `--dsw-alias-*` (plus the two
 *   published content-font vars) and hard-codes no colour, so light and dark
 *   both come out right.
 * @module @xiaoso/dsh-tool-plus/web/client/ToolCardShell
 */

import { Component, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { DisclosureRow, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  argsSummary, cardState, dotState, firstLine, resultText, stateStatus,
  type CardBlockView, type CardOpenFileOptions, type CardState, type CardTranslate,
} from './row-utils.ts'

/** Chrome CSS, keyed by `data-plugin-css` and injected once per page. */
const CSS = `
.twc-root{display:flex;flex-direction:column;min-width:0}
.twc-row{position:relative;min-width:0}
.twc-leading{flex-shrink:0}
.twc-chevron{color:var(--dsw-alias-label-secondary)}
.twc-title{font-weight:400}
.twc-sep{flex:none;width:2px;height:2px;border-radius:1px;margin:0 8px;background:var(--dsw-alias-label-caption)}
.twc-summary{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary)}
.twc-summarySuffix{flex:none;margin-left:4px;white-space:nowrap;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary)}
.twc-diffStat{margin-left:10px;font-family:var(--ds-font-family-code);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 2px);color:var(--dsw-alias-label-caption)}
.twc-errorSummary{color:var(--dsw-alias-state-error-primary)}
.twc-fileLink{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0;padding:0;border:none;background:none;font:inherit;text-align:left;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-secondary);text-decoration:underline dotted;text-decoration-color:var(--dsw-alias-label-tertiary);text-decoration-thickness:1px;text-underline-offset:3px;cursor:pointer;border-radius:4px}
.twc-fileLink:hover{color:var(--dsw-alias-label-primary);text-decoration-color:currentColor}
.twc-fileLink:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.twc-bodyWrap{display:flex;flex-direction:column;min-width:0}
.twc-body{margin:4px 0 4px 4px;min-width:0}
.twc-text{margin:4px 0 4px 4px;padding:10px 14px;max-height:260px;overflow:auto;border-radius:12px;background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word}
.twc-note{margin:4px 0 4px 4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.twc-inspect{display:inline-flex;align-self:flex-start;align-items:center;gap:4px;margin:4px 0 2px 4px;padding:2px 8px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;cursor:pointer;opacity:0;transition:opacity 100ms ease}
.twc-root:hover .twc-inspect,.twc-inspect:focus-visible{opacity:1}
.twc-inspect:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}
.twc-visuallyHidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.twc-fallbackDot{flex:none;width:8px;height:8px;border-radius:999px;background:var(--dsw-alias-state-error-primary)}
@media (prefers-reduced-motion: reduce){.twc-inspect{transition:none}}
`

/** Inject the card stylesheet once per page; the loader drops plugin style tags on unload. */
let cssInjected = false
function injectCss(): void {
  if (cssInjected) return
  // Non-browser import (SSR, a Node-side test): nothing to inject, and the flag
  // stays false so a later browser mount still gets the sheet.
  if (typeof document === 'undefined') return
  cssInjected = true
  const id = 'tool-plus-cards'
  if (document.querySelector('style[data-plugin-css="' + id + '"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@xiaoso/dsh-tool-plus'
  tag.dataset.pluginCss = id
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/** Props of {@link ToolCardShell}. */
export interface ToolCardShellProps {
  /** Card translate seat. */
  t: CardTranslate
  /** Run state driving the leading dot and the status word. */
  state: CardState
  /** Single-line title (the tool name). */
  title: string
  /** Collapsed summary after the separator; empty renders no separator. */
  summary?: string | null | undefined
  /** Trailing fragment kept outside the summary's ellipsis (e.g. `+3 -1`). */
  summarySuffix?: string | null | undefined
  /** Render the summary in the error tone (a failure line, not a description). */
  summaryTone?: 'default' | 'error' | undefined
  /** Filesystem path to offer as a clickable link; requires `openFile`. */
  filePath?: string | null | undefined
  /** 1-based line the call was about; absent opens the file at its start. */
  filePathLine?: number | null | undefined
  /** Opens `filePath` in the host's file viewer. */
  openFile?: ((path: string, options?: CardOpenFileOptions) => void) | undefined
  /** Jump to this call in the trajectory view; absent renders no affordance. */
  inspect?: (() => void) | undefined
  /** Body text used when no `children` card is supplied. */
  text?: string | null | undefined
  /** Start expanded. */
  defaultOpen?: boolean | undefined
  /** Card body; wins over `text` when supplied. */
  children?: ReactNode
}

/** Whether a React node would draw anything. */
function hasContent(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false
}

/**
 * Render the shared card shell.
 * @param props - see {@link ToolCardShellProps}.
 * @returns the card row and, when expanded, its body.
 */
export function ToolCardShell(props: ToolCardShellProps) {
  injectCss()
  const { t, state, title, children, filePath, openFile, inspect } = props
  const [expanded, setExpanded] = useState(props.defaultOpen === true)
  const bodyCard = hasContent(children) ? children : null
  const bodyText = typeof props.text === 'string' && props.text !== '' ? props.text : null
  const expandable = bodyCard !== null || bodyText !== null
  const open = expanded && expandable
  const status = stateStatus(state, t)
  const summaryText = typeof props.summary === 'string' ? props.summary : ''
  const suffix = typeof props.summarySuffix === 'string' && props.summarySuffix !== ''
    ? props.summarySuffix
    : null
  const fileLink = filePath !== undefined && filePath !== null && filePath !== '' && openFile !== undefined
  const errorTone = props.summaryTone === 'error'
  const toggle = (): void => { setExpanded(value => !value) }

  const openPath = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    if (!fileLink || openFile === undefined) return
    const line = props.filePathLine
    if (typeof line === 'number') openFile(filePath, { line })
    else openFile(filePath)
  }
  // The row (not the link) owns Enter/Space; without this the key would toggle
  // the disclosure before the focused link's own click fires.
  const openPathKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
  }

  const collapsed = summaryText === '' ? null : (
    <>
      <span className="twc-sep" aria-hidden />
      {fileLink
        ? (
          <button type="button" className="twc-fileLink" onClick={openPath} onKeyDown={openPathKeyDown}>
            {summaryText}
          </button>
        )
        : <span className={errorTone ? 'twc-summary twc-errorSummary' : 'twc-summary'}>{summaryText}</span>}
      {suffix !== null && <span className="twc-summarySuffix">{suffix}</span>}
    </>
  )

  return (
    <div className="twc-root" data-state={state} data-tool={title}>
      {status !== null && <span className="twc-visuallyHidden">{status}</span>}
      <DisclosureRow
        rowClassName="twc-row"
        leadingClassName="twc-leading"
        titleClassName="twc-title"
        chevronClassName="twc-chevron"
        icon={<StateDot state={dotState(state)} />}
        title={title}
        open={open}
        expandable={expandable}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={toggle}
        collapsedContent={collapsed}
      >
        <div className="twc-bodyWrap">
          {bodyCard ?? <pre className="twc-text">{bodyText}</pre>}
          {inspect !== undefined && (
            <button type="button" className="twc-inspect" onClick={inspect}>{t('inspect')}</button>
          )}
        </div>
      </DisclosureRow>
    </div>
  )
}

/** Props of {@link GenericCard}. */
export interface GenericCardProps {
  /** Card translate seat. */
  t: CardTranslate
  /** Localized card title. */
  title: string
  /** The frozen call node. */
  block: CardBlockView
  /** The call's parsed arguments, when there are any. */
  args: Record<string, unknown> | null
  /** Jump to this call in the trajectory view. */
  inspect?: (() => void) | undefined
}

/**
 * The generic card: every row's degradation path.
 *
 * A card is only drawn once its metadata passed a `narrow*` guard, so anything
 * else — a running call, a window-truncated call, a Code Dispatch child, a
 * failure, a payload from another plugin version — lands here with the call's
 * own title, run state, argument count, and result text.
 * @param props - see {@link GenericCardProps}.
 * @returns the generic shell.
 */
export function GenericCard({ t, title, block, args, inspect }: GenericCardProps) {
  const state = cardState(block)
  const output = resultText(block)
  const failure = state === 'error' ? firstLine(output) : ''
  return (
    <ToolCardShell
      t={t}
      state={state}
      title={title}
      summary={failure === '' ? argsSummary(args, t) : failure}
      summaryTone={failure === '' ? 'default' : 'error'}
      text={output}
      inspect={inspect}
    />
  )
}

/** Props of {@link CardBoundary}. */
export interface CardBoundaryProps {
  /** Card translate seat, forwarded to the fallback shell. */
  t: CardTranslate
  /** Title the fallback shell shows. */
  title: string
  /** The call node, so the fallback can still offer its result text. */
  block?: CardBlockView | undefined
  /** Summary the fallback shell shows before the failure line replaces it. */
  summary?: string | null | undefined
  /** The card to protect. */
  children: ReactNode
}

/** State of {@link CardBoundary}: the caught failure, once there is one. */
interface CardBoundaryState { failure: string | null }

/** Best-effort message for a thrown value; never throws itself. */
function failureText(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === 'string' && error.message !== '') return error.message
    if (typeof error === 'string' && error !== '') return error
  } catch {
    // A hostile `message` getter is not worth a second failure.
  }
  return 'Unknown card error'
}

/**
 * Contain a card's render failure: the fallback is a generic shell (never the
 * card's own chrome), so one malformed payload cannot take the call's cell —
 * or the whole slot — down with it.
 */
export class CardBoundary extends Component<CardBoundaryProps, CardBoundaryState> {
  override state: CardBoundaryState = { failure: null }

  /** React's error-boundary hook: record the failure and render the fallback. */
  static getDerivedStateFromError(error: unknown): CardBoundaryState {
    return { failure: failureText(error) }
  }

  /** Report the failure without rethrowing. */
  override componentDidCatch(error: unknown): void {
    console.error('[tool-plus] a web tool card failed to render; showing the generic card instead.', error)
  }

  override render(): ReactNode {
    const { failure } = this.state
    if (failure === null) return this.props.children
    const { t, title, block, summary } = this.props
    let text: string | null = null
    try {
      const output = block === undefined ? '' : resultText(block)
      text = output === '' ? null : output
    } catch {
      text = null
    }
    return (
      <ToolCardShell
        t={t}
        state="error"
        title={title}
        summary={failure === '' ? summary ?? null : firstLine(failure)}
        summaryTone="error"
        text={text}
      />
    )
  }
}
