/**
 * The shared card shell every row renders through.
 *
 * The shipped `ToolRow` is not reusable from a plugin (ui-tool is not part of
 * the client platform baseline), so this is our own: one 24px header line
 * (tool glyph + title + separator + ellipsized summary + optional `+N -M`
 * suffix + clickable path), a keyboard-reachable disclosure, and a body that
 * is either the card a row built or the flattened result text. The leading
 * glyph gives way to a state dot on a failed or interrupted call, and the row
 * sweeps while the call runs, as the shipped row does.
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
import {
  DisclosureRow, IconApiOutlineRegular, IconBrowseOutlineRegular, IconEditOutlineRegular,
  IconSearchOutlineRegular, IconSparkleRegular, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  cardArgsRaw, cardState, firstLine, resultText, stateStatus,
  type CardBlockView, type CardOpenFileOptions, type CardState, type CardTranslate,
} from './row-utils.ts'
import { leadingGlyph, leadingKind, type CardLeadingGlyph } from './rows/card-leading.ts'
import { fallbackCardLink, fallbackCardSummary } from './rows/fallback-card-facts.ts'

/** Leading glyphs (the shipped table): every glyph renders at 14 inside the 16px leading box. */
const LEADING_GLYPHS: Record<CardLeadingGlyph, ReactNode> = {
  bash: <IconApiOutlineRegular size={14} />,
  read: <IconBrowseOutlineRegular size={14} />,
  edit: <IconEditOutlineRegular size={14} />,
  search: <IconSearchOutlineRegular size={14} />,
  others: <IconSparkleRegular size={14} />,
}

/**
 * The leading mark of one row: the tool's glyph while the call is clean or
 * running, and the state dot a failure or an interrupt swaps in — the shipped
 * `leadingFor` rule, so a failed row gives up its identity for the state
 * exactly where the shipped row does.
 * @param state - the card's run state.
 * @param toolName - the call's wire tool name, when the node carries one.
 * @returns the node the leading box draws.
 */
function leadingFor(state: CardState, toolName: string | null | undefined): ReactNode {
  switch (leadingKind(state)) {
    case 'error': return <StateDot state="error" />
    case 'warning': return <StateDot state="warning" />
    default: return LEADING_GLYPHS[leadingGlyph(toolName)]
  }
}

/** Chrome CSS, keyed by `data-plugin-css` and injected once per page. */
const CSS = `
.twc-root{display:flex;flex-direction:column;min-width:0}
/* The sweep's own anchor and clip, repeated from the shipped sheet so the band
   cannot escape the row if the shared row chrome ever drops them. */
.twc-row{position:relative;min-width:0;overflow:hidden}
.twc-leading{flex-shrink:0}
/* Running sweep — the shipped row's own treatment (ui-tool/ToolRow.module.css),
   copied band for band: a 300px glare of the theme background glides from
   off-left to off-right, washing the glyph and the text toward the background
   as it passes. Same anchor as the shipped sheet puts it on: DisclosureRow's
   own row already carries the position:relative and the overflow:hidden that
   clips the band. */
.twc-root[data-state='running'] .twc-row::after{content:'';position:absolute;top:0;bottom:0;left:0;width:300px;background:linear-gradient(90deg,transparent 0%,color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent) 55%,transparent 100%);animation:twc-row-sweep 2.6s ease-out infinite;pointer-events:none}
@keyframes twc-row-sweep{0%{left:-300px}90%,100%{left:100%}}
.twc-chevron{color:var(--dsw-alias-label-secondary)}
.twc-title{font-weight:400}
.twc-sep{flex:none;width:2px;height:2px;border-radius:1px;margin:0 8px;background:var(--dsw-alias-label-caption)}
.twc-summary{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary)}
.twc-summarySuffix{flex:none;margin-left:4px;white-space:nowrap;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary)}
.twc-errorSummary{color:var(--dsw-alias-state-error-primary)}
.twc-fileLink{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0;padding:0;border:none;background:none;font:inherit;text-align:left;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-secondary);text-decoration:underline dotted;text-decoration-color:var(--dsw-alias-label-tertiary);text-decoration-thickness:1px;text-underline-offset:3px;cursor:pointer;border-radius:4px}
.twc-fileLink:hover{color:var(--dsw-alias-label-primary);text-decoration-color:currentColor}
.twc-fileLink:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.twc-bodyWrap{display:flex;flex-direction:column;min-width:0}
.twc-body{margin:4px 0 4px 4px;min-width:0}
.twc-text{margin:4px 0 4px 4px;padding:10px 14px;max-height:260px;overflow:auto;border-radius:12px;background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word}
.twc-note{margin:4px 0 4px 4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.twc-media{display:flex;flex-direction:column;align-items:flex-start;gap:8px;margin:4px 0 4px 4px;min-width:0}
/* Image gallery: the wrapping group the message gallery uses, so a card's
   images and a message's images wrap the same way. */
.twc-imgGallery{display:flex;flex-wrap:wrap;gap:10px;max-width:100%;min-width:0}
/* Thumbnail frame (figma message-image rule): a 16px-radius tile that crops
   with object-fit cover, sized inline for a lone image and 64×64 in a gallery. */
.twc-imgFrame{display:grid;flex:0 0 auto;place-items:center;box-sizing:border-box;min-width:44px;min-height:44px;padding:0;overflow:hidden;border:0.5px solid var(--dsw-alias-border-l2-darkmode-thin);border-radius:16px;background:var(--dsw-alias-interactive-bg-hover);cursor:zoom-in}
.twc-imgFrame[data-variant='tile']{width:64px;height:64px;min-width:64px;min-height:64px}
.twc-imgFrame:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.twc-mediaImg{display:block;width:100%;height:100%;object-fit:cover}
.twc-imgLoading{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
/* Failed load: the frame itself becomes the retry control (the official
   behaviour), so a transient failure costs one click instead of a reload. It
   carries the frame's own box model — border-box, same 44px floor — so the
   reserved box survives loading → loaded → failed unchanged (no jump). */
.twc-imgError{box-sizing:border-box;min-width:44px;min-height:44px;max-width:240px;padding:10px 12px;overflow:hidden;border:0.5px solid var(--dsw-alias-border-l2-darkmode-thin);border-radius:10px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;text-align:left;cursor:pointer}
.twc-imgError[data-variant='tile']{width:64px;height:64px;min-width:64px;min-height:64px;padding:4px;border-radius:16px}
.twc-imgError:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
/* Original-image lightbox: a body portal, a mask on its own layer (blurring
   the backdrop itself would blur the preview and the close control), and the
   preview stacked with its caption so the two always read as one object. */
.twc-lightbox{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:40px}
.twc-lightboxMask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}
.twc-lightboxStack{position:relative;display:flex;flex-direction:column;align-items:center;gap:10px;max-height:calc(100vh - 80px);min-width:0}
.twc-lightboxImg{max-width:min(100%,1600px);max-height:calc(100vh - 130px);object-fit:contain;border-radius:12px;background:var(--dsw-specific-input-major);box-shadow:var(--dsw-shadow-lv3)}
.twc-lightboxClose{position:fixed;top:20px;right:20px;z-index:1;display:grid;place-items:center;width:36px;height:36px;border:0.5px solid var(--dsw-alias-border-l2-darkmode-thin);border-radius:999px;background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);cursor:pointer}
.twc-lightboxClose:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}
.twc-lightboxClose:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
/* The caption carries the reference's own numbers — name, intrinsic size,
   byte length — so the enlarged view states what the file actually is. It sits
   in the stack under the image: fixed to the viewport it read as a separate
   object from a centred image, and a tall image could squeeze it out. */
.twc-lightboxCaption{margin:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:5px 14px;border:0.5px solid var(--dsw-alias-border-l2-darkmode-thin);border-radius:999px;background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
/* Motion is feedback, never decoration: the hover lift, the skeleton pulse,
   and the lightbox entrance all sit behind the user's motion preference. A
   reduced-motion reader keeps every state change, just without the glide. */
.twc-imgFrame:hover{box-shadow:var(--dsw-shadow-lv1-blur)}
@media (prefers-reduced-motion: no-preference){
  .twc-imgFrame{transition:transform 160ms ease,box-shadow 160ms ease}
  .twc-imgFrame:hover{transform:scale(1.01)}
  .twc-imgFrame:active{transform:scale(0.99)}
  .twc-imgLoading{animation:twc-img-pulse 1.6s ease-in-out infinite}
  .twc-lightbox{animation:twc-lightbox-in 160ms ease-out}
  .twc-lightboxImg{animation:twc-lightbox-img-in 180ms ease-out}
  @keyframes twc-img-pulse{0%,100%{opacity:.55}50%{opacity:1}}
  @keyframes twc-lightbox-in{from{opacity:0}to{opacity:1}}
  @keyframes twc-lightbox-img-in{from{opacity:0;transform:scale(.98)}to{opacity:1;transform:scale(1)}}
}
.twc-inspect{display:inline-flex;align-self:flex-start;align-items:center;gap:4px;margin:4px 0 2px 4px;padding:2px 8px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;cursor:pointer;opacity:0;transition:opacity 100ms ease}
.twc-root:hover .twc-inspect,.twc-inspect:focus-visible{opacity:1}
.twc-inspect:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}
.twc-visuallyHidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
/* Motion is feedback, never decoration: the running sweep is the one animation
   this shell borrows from the shipped row, which runs it with no motion query
   at all. A reduced-motion reader loses only the glide — the state itself is
   still announced through the visually-hidden status word. */
@media (prefers-reduced-motion: reduce){.twc-inspect{transition:none}.twc-root[data-state='running'] .twc-row::after{display:none}}
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
  /** Run state driving the leading mark and the status word. */
  state: CardState
  /** Wire tool name selecting the leading glyph; absent/unknown = the generic glyph. */
  tool?: string | null | undefined
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
  const { t, state, title, children, filePath, openFile, inspect, tool } = props
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
          /* The link carries its own colour, so a failure line that ever gains
             a path keeps the error tone instead of turning neutral. */
          <button
            type="button"
            className={errorTone ? 'twc-fileLink twc-errorSummary' : 'twc-fileLink'}
            onClick={openPath}
            onKeyDown={openPathKeyDown}
          >
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
        icon={leadingFor(state, tool)}
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
  /** Wire tool name selecting the leading glyph; absent/unknown = the generic glyph. */
  toolName?: string | null | undefined
  /** Session workspace root, so a stated path is shortened the rows' way. */
  cwd?: string | undefined
  /** Opens the call's file in the host's viewer; absent = the path is plain text. */
  openFile?: ((path: string, options?: CardOpenFileOptions) => void) | undefined
  /** Jump to this call in the trajectory view. */
  inspect?: (() => void) | undefined
}

/**
 * The generic card: every row's degradation path.
 *
 * A card is only drawn once its metadata passed a `narrow*` guard, so anything
 * else — a running call, a window-truncated call, a Code Dispatch child, a
 * failure, a payload from another plugin version — lands here with the call's
 * own title, run state, the fact its arguments state, and result text.
 * @param props - see {@link GenericCardProps}.
 * @returns the generic shell.
 */
export function GenericCard({ t, title, block, args, toolName, cwd, openFile, inspect }: GenericCardProps) {
  const state = cardState(block)
  const output = resultText(block)
  const failure = state === 'error' ? firstLine(output) : ''
  // Only a head that IS the call's own fact may become the link: a failure line
  // is not an argument, so it stays plain text (and keeps its error tone).
  const link = failure === '' ? fallbackCardLink(toolName, args) : null
  return (
    <ToolCardShell
      t={t}
      state={state}
      title={title}
      tool={toolName}
      summary={failure === '' ? fallbackCardSummary(toolName, args, cwd, t, cardArgsRaw(block)) : failure}
      summaryTone={failure === '' ? 'default' : 'error'}
      filePath={link}
      openFile={link === null ? undefined : openFile}
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
