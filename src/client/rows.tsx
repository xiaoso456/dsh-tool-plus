/**
 * Shared settings-row controls for the tool-plus settings surfaces: number
 * input, select pill, and toggle switch rows, styled against the app's
 * `--dsw-alias-*` design tokens. Extracted from the Bash card so the Plugins
 * card and the Tool Plus settings section render identical controls.
 * @module @xiaoso/dsh-tool-plus/client
 */

import { useId, useLayoutEffect, type ReactNode, type RefObject } from 'react'
import type { BashPlusLocaleKey } from './locales.ts'
import { InfoTip } from './tooltip.tsx'
import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'

/** One rendered number control. */
export interface NumberControl {
  field: string
  labelKey: BashPlusLocaleKey
  hintKey: BashPlusLocaleKey
  /** Optional hover/focus explanation rendered behind an info icon. */
  tipKey?: BashPlusLocaleKey
  /** Staged text exactly as typed; blank stays blank. */
  text: string
  /** What a blank box falls back to, shown as the placeholder. */
  placeholder: string
  overridden: boolean
  invalid: boolean
}

/** One rendered select control. */
export interface SelectControl {
  field: string
  labelKey: BashPlusLocaleKey
  hintKey: BashPlusLocaleKey
  /** Optional hover/focus explanation rendered behind an info icon. */
  tipKey?: BashPlusLocaleKey
  options: readonly { value: string; labelKey: BashPlusLocaleKey }[]
  value: string
  overridden: boolean
}

/** One rendered toggle control. */
export interface ToggleControl {
  field: string
  labelKey: BashPlusLocaleKey
  hintKey: BashPlusLocaleKey
  /** Optional hover/focus explanation rendered behind an info icon. */
  tipKey?: BashPlusLocaleKey
  checked: boolean
  overridden: boolean
}

/** One rendered action control (button that calls a host RPC endpoint). */
export interface ActionControl {
  field: string
  labelKey: BashPlusLocaleKey
  hintKey: BashPlusLocaleKey
  actionKey: string
}

/**
 * Shared row control CSS, keyed by `data-plugin-css` and injected once.
 *
 * Geometry: text, then a badge cell of a constant width, then the control.
 * The badge cell is reserved even when a row has nothing to show, so the text
 * width (and therefore the wrapped line count and the row height) is identical
 * before and after "已覆盖 / 恢复默认" appears. The separator stays on the row
 * for the surfaces that render rows directly (BashInitPanel); the settings
 * section wraps rows in a collapsing slot that owns its own separator, so the
 * row border is dropped there by the shared `:last-child` rule.
 *
 * Contrast: body copy uses label-secondary (5.8:1 light / 8.0:1 dark), control
 * borders and the off switch use label-tertiary (3.7:1 / 5.7:1), and error text
 * mixes in label-primary so it clears 4.5:1 in the dark theme too (the host's
 * error token alone reaches only 3.68:1 there).
 *
 * Motion discipline: every moving control animates transform/opacity only
 * (GPU-composited); color transitions fire on hover/focus state changes
 * only. Everything is disabled under prefers-reduced-motion. All colors are
 * `--dsw-alias-*` host tokens (or color-mix of them), so light/dark themes
 * adapt automatically.
 */
export const SETTINGS_ROWS_CSS = `
.tp-row{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l1);transition:background .16s ease}
.tp-row:last-child{border-bottom:none}
.tp-rowText{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.tp-rowTitle{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary)}
.tp-rowTitleLine{display:flex;align-items:center;gap:2px;min-width:0}
.tp-rowTitleLine .tp-rowTitle{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tp-infoBtn{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;padding:0;border:0;background:none;color:var(--dsw-alias-label-tertiary);cursor:help;border-radius:50%;flex:none;transition:color .16s ease}
.tp-infoBtn:hover,.tp-infoBtn:focus-visible{color:var(--dsw-alias-label-primary)}
.tp-infoBtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.tp-rowDesc{font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-label-secondary)}
/* Hint and error stack in one cell: the box keeps the hint's height, so the
   row never shrinks when the shorter error text replaces it. */
.tp-descSwap{display:grid}
.tp-descSwap>*{grid-area:1/1;min-width:0}
.tp-descGhost{visibility:hidden}
.tp-srOnly{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.tp-badges{flex:none;width:120px;justify-content:flex-end;display:inline-flex;align-items:center;gap:8px;white-space:nowrap;min-height:18px}
.tp-badge{display:inline-flex;align-items:center;gap:6px;padding:1px 0;font-size:11px;line-height:17px;white-space:nowrap;font-weight:500;color:var(--dsw-alias-label-secondary)}
.tp-badge::before{content:'';flex:none;width:5px;height:5px;border-radius:999px;background:var(--dsw-alias-state-business-primary)}
.tp-reset{position:relative;border:none;background:none;padding:2px 0;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:color .16s ease}
.tp-reset::after{content:'';position:absolute;left:0;right:0;bottom:0;height:1px;border-radius:1px;background:currentColor;opacity:0;transform:scaleX(.6);transform-origin:left center;transition:opacity .16s ease,transform .2s cubic-bezier(.22,1,.36,1)}
.tp-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.tp-reset:hover:not(:disabled)::after{opacity:.6;transform:scaleX(1)}
.tp-reset:disabled{cursor:default}
.tp-reset:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:2px}
.tp-input{width:128px;height:34px;padding:0 11px;border:1px solid var(--dsw-alias-label-tertiary);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);box-sizing:border-box;transition:border-color .16s ease}
.tp-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:1}
.tp-input:hover:not(:disabled):not(:focus-visible){border-color:var(--dsw-alias-label-secondary)}
.tp-input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px;border-color:var(--dsw-alias-label-secondary)}
/* 文本框在 Chrome 里始终算 :focus-visible（因为它能打字），所以鼠标点进来也会
   画上键盘用的外圈。按最后一次输入方式区分：鼠标进来的只留边框，键盘 Tab 进来
   的照旧给完整焦点环。 */
html[data-tp-pointer] .tp-input:focus-visible,
html[data-tp-pointer] .tp-input.tp-invalid:focus-visible{outline:none}
.tp-input:disabled{color:var(--dsw-alias-label-secondary);cursor:default}
.tp-input.tp-invalid{border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 70%, var(--dsw-alias-label-primary))}
.tp-input.tp-invalid:focus-visible{outline-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 70%, var(--dsw-alias-label-primary))}
.tp-invalidText{color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 70%, var(--dsw-alias-label-primary));animation:tp-soft-in .18s ease both}
.tp-selectAnchor{display:inline-flex;flex-shrink:0}
.tp-selectTrigger{display:inline-flex;align-items:center;gap:8px;height:34px;padding:0 14px;border:1px solid var(--dsw-alias-label-tertiary);border-radius:999px;background:var(--dsw-alias-bg-module-platform);font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);cursor:pointer;flex-shrink:0;transition:background .16s ease,border-color .16s ease,transform .1s ease}
.tp-selectTrigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-label-secondary)}
.tp-selectTrigger:active:not(:disabled){transform:scale(.97)}
.tp-selectTrigger:disabled{opacity:.55;cursor:default}
.tp-selectTrigger:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.tp-selectChevron{flex:none;color:var(--dsw-alias-label-tertiary);display:inline-flex;transition:transform .2s cubic-bezier(.22,1,.36,1)}
.tp-selectTrigger[aria-expanded="true"] .tp-selectChevron{transform:rotate(180deg)}
.tp-switch{position:relative;width:40px;height:24px;flex:none}
.tp-switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer;z-index:1}
.tp-switchTrack{position:absolute;inset:0;border-radius:999px;background:var(--dsw-alias-border-l3);transition:background .18s ease;pointer-events:none}
.tp-row:hover .tp-switchTrack{background:var(--dsw-alias-border-l4)}
.tp-switch input:checked+.tp-switchTrack{background:var(--dsw-alias-brand-primary)}
.tp-row:hover .tp-switch input:checked+.tp-switchTrack{background:var(--dsw-alias-brand-primary)}
.tp-switch input:focus-visible+.tp-switchTrack{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.tp-thumb{position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:999px;background:var(--dsw-alias-switch-thumb);transition:transform .2s cubic-bezier(.34,1.3,.5,1),background .18s ease;transform-origin:left center;pointer-events:none}
.tp-switch input:checked~.tp-thumb{transform:translateX(16px);transform-origin:right center;background:var(--dsw-alias-label-primary-foreground)}
.tp-switch input:active:not(:disabled)~.tp-thumb{transform:scaleX(1.2)}
.tp-switch input:checked:active:not(:disabled)~.tp-thumb{transform:translateX(16px) scaleX(1.2)}
.tp-switch input:disabled{cursor:default}
.tp-switch input:disabled~.tp-switchTrack,.tp-switch input:disabled~.tp-thumb{opacity:.45}
.tp-actionField{display:flex;flex-direction:column;gap:8px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.tp-actionField:last-child{border-bottom:none}
.tp-actionHead{display:flex;align-items:center;gap:12px}
.tp-actionInfo{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.tp-actionTitle{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary)}
.tp-actionDesc{font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-label-secondary)}
.tp-actionButton{appearance:none;flex:none;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:transparent;padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);cursor:pointer;transition:background .16s ease,border-color .16s ease,transform .1s ease}
.tp-actionButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.tp-actionButton:active:not(:disabled){transform:scale(.97)}
.tp-actionButton:disabled{opacity:.55;cursor:default}
.tp-actionButton:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.tp-actionResult{margin:0;font-size:12px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;animation:tp-soft-in .22s cubic-bezier(.22,1,.36,1) both}
.tp-actionResult[data-state="ok"]{color:var(--dsw-alias-label-secondary)}
.tp-actionResult[data-state="error"]{color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 70%, var(--dsw-alias-label-primary))}
.tp-nativeSummary{appearance:none;flex:1;min-width:0;display:flex;align-items:center;gap:8px;padding:0;border:0;background:transparent;font:inherit;color:inherit;text-align:left;cursor:pointer;border-radius:4px}
.tp-nativeSummary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.tp-nativeState{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.tp-nativeState[data-state="pending"]{color:var(--dsw-alias-label-secondary)}
.tp-nativeState[data-state="error"]{color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 70%, var(--dsw-alias-label-primary))}
.tp-nativeChevron{flex:none;display:inline-flex;color:var(--dsw-alias-label-tertiary);transition:transform .2s cubic-bezier(.22,1,.36,1)}
.tp-nativeSummary[aria-expanded="true"] .tp-nativeChevron{transform:rotate(180deg)}
.tp-nativeDetail{display:flex;flex-direction:column;gap:4px}
@keyframes tp-soft-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion: reduce){
  .tp-row,.tp-reset,.tp-reset::after,.tp-input,.tp-selectTrigger,.tp-selectChevron,.tp-nativeChevron,.tp-switchTrack,.tp-thumb,.tp-actionButton,.tp-infoBtn{transition:none}
  .tp-invalidText,.tp-actionResult{animation:none}
}
`

/** Inject the shared row stylesheet once per page. */
let rowsCssInjected = false
/**
 * 记住最后一次是鼠标还是键盘在操作，挂在 `<html data-tp-pointer>` 上。
 *
 * 光靠 `:focus-visible` 区分不了：文本框在 Chrome 里永远算 focus-visible，
 * 鼠标点进去也会画键盘用的焦点环（蓝圈套灰边那种双层框）。这里只记意图，样式
 * 仍在 CSS 里决定，键位用户拿到的焦点环不变。
 */
/**
 * 把 `inert` 当 DOM 属性写进去。
 *
 * React 19 才认识 `inert` 属性；18 上给布尔值会被静默丢弃，于是折叠起来的行、
 * 收起的面板仍然能用 Tab 走进去。写属性对两个版本都一样。
 */
export function useInert(ref: RefObject<HTMLElement | null>, inert: boolean): void {
  useLayoutEffect(() => {
    if (ref.current !== null) ref.current.inert = inert
  }, [ref, inert])
}

export function installFocusModality(): void {
  if (typeof document === 'undefined' || focusModalityInstalled) return
  focusModalityInstalled = true
  const root = document.documentElement
  const onPointer = (): void => { root.dataset.tpPointer = '' }
  const onKey = (event: KeyboardEvent): void => {
    // 只有能移动焦点的键才算「切回键盘」；在框里打字不该让外圈冒出来。
    if (event.key === 'Tab' || event.key === 'Escape' || event.key.startsWith('Arrow')) delete root.dataset.tpPointer
  }
  document.addEventListener('pointerdown', onPointer, true)
  document.addEventListener('keydown', onKey, true)
}

/** 输入方式监听只装一次（多个注入点都会调）。 */
let focusModalityInstalled = false

export function injectSettingsRowsCss(): void {
  if (rowsCssInjected || typeof document === 'undefined') return
  rowsCssInjected = true
  installFocusModality()
  const id = 'tool-plus-rows'
  if (document.querySelector('style[data-plugin-css="' + id + '"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@xiaoso/dsh-tool-plus'
  tag.dataset.pluginCss = id
  tag.textContent = SETTINGS_ROWS_CSS
  document.head.appendChild(tag)
}

function hasOwn(obj: unknown, key: string): boolean {
  return typeof obj === 'object' && obj !== null && Object.prototype.hasOwnProperty.call(obj, key)
}

/**
 * The badge cell every row renders, overridden or not.
 *
 * Its width is a fixed cell, so a row does not reflow (and the rows below it
 * do not move) the moment "已覆盖 / 恢复默认" shows up.
 */
function RowBadges(props: {
  t: (key: BashPlusLocaleKey) => string
  overridden: boolean
  disabled: boolean
  onReset: () => void
}): ReactNode {
  const { t, overridden, disabled, onReset } = props
  return (
    <span className="tp-badges">
      {overridden
        ? (
          <>
            <span className="tp-badge">{t('overridden')}</span>
            <button type="button" className="tp-reset" disabled={disabled} onClick={onReset}>
              {t('reset')}
            </button>
          </>
        )
        : null}
    </span>
  )
}

/** 行标题：可选的信息图标，悬停/键盘聚焦时显示完整说明。 */
function RowTitle(props: {
  t: (key: BashPlusLocaleKey) => string
  labelKey: BashPlusLocaleKey
  tipKey?: BashPlusLocaleKey
  /** Text-entry/select rows: clicking the title focuses the control. */
  htmlFor?: string
  /** Switch rows: the title names the control via aria-labelledby instead of
   *  being a <label>, so clicking it stays inert and cannot flip the switch. */
  id?: string
}): ReactNode {
  const text = props.t(props.labelKey)
  return (
    <span className="tp-rowTitleLine">
      {props.htmlFor === undefined
        ? <span className="tp-rowTitle" id={props.id}>{text}</span>
        : <label className="tp-rowTitle" htmlFor={props.htmlFor}>{text}</label>}
      {props.tipKey === undefined ? null : <InfoTip text={props.t(props.tipKey)} label={text + ' ' + props.t('tipLabel')} />}
    </span>
  )
}

/**
 * Number row: same left-text / right-control anatomy as toggle and select
 * rows, with the input right-aligned at a fixed width. The title is wired to
 * the input (htmlFor), so clicking the title focuses the input; the
 * description and the rest of the row are inert — each side manages its own
 * interaction.
 */
export function NumberRow(props: {
  t: (key: BashPlusLocaleKey) => string
  control: NumberControl
  disabled: boolean
  onEdit: (field: string, text: string) => void
  onReset: (field: string) => void
}): ReactNode {
  const { t, control, disabled, onEdit, onReset } = props
  const inputId = useId()
  const descId = useId()
  return (
    <div className="tp-row">
      <div className="tp-rowText">
        <RowTitle t={t} labelKey={control.labelKey} tipKey={control.tipKey} htmlFor={inputId} />
        {/*
          Both texts share one grid cell so the row keeps the hint's line count
          while the error shows: swapping a two-line hint for a one-line error
          used to shorten the row and shove everything below it up 18px.
        */}
        <div id={descId} className={'tp-rowDesc tp-descSwap' + (control.invalid ? ' tp-invalidText' : '')}>
          <span className="tp-descGhost" aria-hidden="true">{t(control.hintKey)}</span>
          <span>{control.invalid ? t('invalidNumber') : t(control.hintKey)}</span>
        </div>
        {/* Announced on its own: the visible line's visibility flip is not a
            text change, so a live region there would stay silent. */}
        <span className="tp-srOnly" aria-live="polite">{control.invalid ? t('invalidNumber') : ''}</span>
      </div>
      <RowBadges t={t} overridden={control.overridden} disabled={disabled} onReset={() => onReset(control.field)} />
      {/*
        A text box, not `type="number"`: the native control rejects partial
        input (".", "1e", "-") by reporting an empty value, which used to look
        like the user had cleared the field. Text keeps the draft verbatim and
        lets the validation above actually run.
      */}
      <input
        id={inputId}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        className={'tp-input' + (control.invalid ? ' tp-invalid' : '')}
        disabled={disabled}
        value={control.text}
        placeholder={control.placeholder}
        aria-invalid={control.invalid || undefined}
        aria-describedby={descId}
        onChange={e => onEdit(control.field, e.target.value)}
      />
    </div>
  )
}

/** Select row: Title + desc stacked on left, selector pill on right. */
export function SelectRow(props: {
  t: (key: BashPlusLocaleKey) => string
  control: SelectControl
  disabled: boolean
  open: boolean
  onOpenChange: (field: string | null) => void
  onEdit: (field: string, value: string) => void
  onReset: (field: string) => void
}): ReactNode {
  const { t, control, disabled, open, onOpenChange, onEdit, onReset } = props
  const triggerId = useId()
  const descId = useId()
  const current = control.options.find(opt => opt.value === control.value)
  const items = control.options.map(opt => ({ id: opt.value, label: t(opt.labelKey) }))
  const close = (): void => onOpenChange(null)

  return (
    <div className="tp-row">
      <div className="tp-rowText">
        <RowTitle t={t} labelKey={control.labelKey} tipKey={control.tipKey} htmlFor={triggerId} />
        <div className="tp-rowDesc" id={descId}>{t(control.hintKey)}</div>
      </div>
      <RowBadges t={t} overridden={control.overridden} disabled={disabled} onReset={() => onReset(control.field)} />
      <Menu
        className="tp-selectAnchor"
        open={open}
        portal
        align="end"
        onClose={close}
        selectedId={control.value}
        onSelect={(id) => { onEdit(control.field, id); close() }}
        items={items}
        anchor={(
          <button
            id={triggerId}
            type="button"
            className="tp-selectTrigger"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-describedby={descId}
            disabled={disabled}
            onClick={() => onOpenChange(open ? null : control.field)}
          >
            <span>{current ? t(current.labelKey) : control.value}</span>
            <IconChevronDownOutlineRegular className="tp-selectChevron" />
          </button>
        )}
      />
    </div>
  )
}

/** Toggle row: Title + desc stacked on left, switch on right. */
export function ToggleRow(props: {
  t: (key: BashPlusLocaleKey) => string
  control: ToggleControl
  disabled: boolean
  onToggle: (field: string, checked: boolean) => void
  onReset: (field: string) => void
}): ReactNode {
  const { t, control, disabled, onToggle, onReset } = props
  const titleId = useId()
  const descId = useId()
  return (
    <div className="tp-row">
      <div className="tp-rowText">
        <RowTitle t={t} labelKey={control.labelKey} tipKey={control.tipKey} id={titleId} />
        <div className="tp-rowDesc" id={descId}>{t(control.hintKey)}</div>
      </div>
      <RowBadges t={t} overridden={control.overridden} disabled={disabled} onReset={() => onReset(control.field)} />
      <span className="tp-switch">
        <input
          type="checkbox"
          aria-labelledby={titleId}
          aria-describedby={descId}
          disabled={disabled}
          checked={control.checked}
          onChange={e => onToggle(control.field, e.target.checked)}
        />
        <span className="tp-switchTrack" />
        <span className="tp-thumb" />
      </span>
    </div>
  )
}

/**
 * Action row: Title + desc stacked on left, a button on the right that calls
 * the host RPC endpoint named by `control.actionKey` (via the Connection
 * channel; the caller owns the RPC). The result line renders below, colored
 * by outcome (`ok` / `error`).
 */
export function ActionRow(props: {
  t: (key: BashPlusLocaleKey) => string
  control: ActionControl
  disabled: boolean
  running: boolean
  result: { ok: boolean; text: string } | null
  onRun: (actionKey: string) => void
}): ReactNode {
  const { t, control, disabled, running, result, onRun } = props
  return (
    <div className="tp-actionField">
      <div className="tp-actionHead">
        <div className="tp-actionInfo">
          <div className="tp-actionTitle">{t(control.labelKey)}</div>
          <div className="tp-actionDesc">{t(control.hintKey)}</div>
        </div>
        <button
          type="button"
          className="tp-actionButton"
          disabled={disabled || running}
          onClick={() => onRun(control.actionKey)}
        >
          {running ? t('browserProbeRunning') : t(control.labelKey)}
        </button>
      </div>
      {result !== null
        ? (
          <p className="tp-actionResult" role="status" data-state={result.ok ? 'ok' : 'error'}>
            {result.text}
          </p>
        )
        : null}
    </div>
  )
}

export { hasOwn }
