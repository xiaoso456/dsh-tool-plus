/**
 * Shared settings-row controls for the tool-plus settings surfaces: number
 * input, select pill, and toggle switch rows, styled against the app's
 * `--dsw-alias-*` design tokens. Extracted from the Bash card so the Plugins
 * card and the Tool Plus settings section render identical controls.
 * @module @xiaoso/dsh-tool-plus/client
 */

import { useId, type ReactNode } from 'react'
import type { BashPlusLocaleKey } from './locales.ts'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'

/** One rendered number control. */
export interface NumberControl {
  field: string
  labelKey: BashPlusLocaleKey
  hintKey: BashPlusLocaleKey
  text: string
  overridden: boolean
  invalid: boolean
}

/** One rendered select control. */
export interface SelectControl {
  field: string
  labelKey: BashPlusLocaleKey
  hintKey: BashPlusLocaleKey
  options: readonly { value: string; labelKey: BashPlusLocaleKey }[]
  value: string
  overridden: boolean
}

/** One rendered toggle control. */
export interface ToggleControl {
  field: string
  labelKey: BashPlusLocaleKey
  hintKey: BashPlusLocaleKey
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
 * Motion discipline: every moving control animates transform/opacity only
 * (GPU-composited); color transitions fire on hover/focus state changes
 * only. Everything is disabled under prefers-reduced-motion. All colors are
 * `--dsw-alias-*` host tokens (or color-mix of them), so light/dark themes
 * adapt automatically.
 */
export const SETTINGS_ROWS_CSS = `
.tp-row{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l1);transition:background .16s ease}
.tp-row:last-child{border-bottom:none}
.tp-rowClickable{cursor:pointer}
.tp-rowText{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;padding-right:24px}
.tp-rowTitle{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary)}
.tp-rowDesc{font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.tp-badges{display:inline-flex;align-items:center;gap:8px}
.tp-badge{display:inline-flex;align-items:center;gap:6px;padding:1px 0;font-size:11px;line-height:17px;white-space:nowrap;font-weight:500;color:var(--dsw-alias-label-tertiary)}
.tp-badge::before{content:'';flex:none;width:5px;height:5px;border-radius:999px;background:var(--dsw-alias-state-business-primary)}
.tp-reset{position:relative;border:none;background:none;padding:2px 0;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:color .16s ease}
.tp-reset::after{content:'';position:absolute;left:0;right:0;bottom:0;height:1px;border-radius:1px;background:currentColor;opacity:0;transform:scaleX(.6);transform-origin:left center;transition:opacity .16s ease,transform .2s cubic-bezier(.22,1,.36,1)}
.tp-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.tp-reset:hover:not(:disabled)::after{opacity:.6;transform:scaleX(1)}
.tp-reset:disabled{cursor:default}
.tp-reset:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:2px}
.tp-input{flex:none;width:128px;height:34px;padding:0 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);box-sizing:border-box;transition:border-color .16s ease}
.tp-input:hover:not(:disabled):not(:focus-visible){border-color:var(--dsw-alias-border-l3)}
.tp-input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px;border-color:var(--dsw-alias-border-l3)}
.tp-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.tp-input.tp-invalid{border-color:var(--dsw-alias-label-error)}
.tp-input.tp-invalid:focus-visible{outline-color:var(--dsw-alias-state-error-primary)}
.tp-invalidText{color:var(--dsw-alias-label-error);animation:tp-soft-in .18s ease both}
.tp-selectAnchor{display:inline-flex;flex-shrink:0}
.tp-selectTrigger{display:inline-flex;align-items:center;gap:8px;height:34px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-module-platform);font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);cursor:pointer;flex-shrink:0;transition:background .16s ease,border-color .16s ease,transform .1s ease}
.tp-selectTrigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}
.tp-selectTrigger:active:not(:disabled){transform:scale(.97)}
.tp-selectTrigger:disabled{opacity:.55;cursor:default}
.tp-selectTrigger:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.tp-selectChevron{flex:none;color:var(--dsw-alias-label-tertiary);display:inline-flex;transition:transform .2s cubic-bezier(.22,1,.36,1)}
.tp-selectTrigger[aria-expanded="true"] .tp-selectChevron{transform:rotate(180deg)}
.tp-switch{position:relative;width:40px;height:24px;flex:none}
.tp-switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer;z-index:1}
.tp-switchTrack{position:absolute;inset:0;border-radius:999px;background:var(--dsw-alias-border-l2);transition:background .18s ease;pointer-events:none}
.tp-row:hover .tp-switchTrack{background:var(--dsw-alias-border-l3)}
.tp-switch input:checked+.tp-switchTrack{background:var(--dsw-alias-brand-primary)}
.tp-row:hover .tp-switch input:checked+.tp-switchTrack{background:var(--dsw-alias-brand-primary)}
.tp-switch input:focus-visible+.tp-switchTrack{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.tp-thumb{position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);box-shadow:0 1px 3px rgba(0,0,0,.14),0 1px 1px rgba(0,0,0,.08);transition:transform .2s cubic-bezier(.34,1.3,.5,1);transform-origin:left center;pointer-events:none}
.tp-switch input:checked~.tp-thumb{transform:translateX(16px);transform-origin:right center}
.tp-switch input:active:not(:disabled)~.tp-thumb{transform:scaleX(1.2)}
.tp-switch input:checked:active:not(:disabled)~.tp-thumb{transform:translateX(16px) scaleX(1.2)}
.tp-switch input:disabled{cursor:default}
.tp-switch input:disabled~.tp-switchTrack,.tp-switch input:disabled~.tp-thumb{opacity:.45}
.tp-actionField{display:flex;flex-direction:column;gap:8px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.tp-actionField:last-child{border-bottom:none}
.tp-actionHead{display:flex;align-items:center;gap:12px}
.tp-actionInfo{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.tp-actionTitle{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary)}
.tp-actionDesc{font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.tp-actionButton{appearance:none;flex:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);cursor:pointer;transition:background .16s ease,border-color .16s ease,transform .1s ease}
.tp-actionButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}
.tp-actionButton:active:not(:disabled){transform:scale(.97)}
.tp-actionButton:disabled{opacity:.55;cursor:default}
.tp-actionButton:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.tp-actionResult{margin:0;font-size:12px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;animation:tp-soft-in .22s cubic-bezier(.22,1,.36,1) both}
.tp-actionResult[data-state="ok"]{color:var(--dsw-alias-label-secondary)}
.tp-actionResult[data-state="error"]{color:var(--dsw-alias-label-error)}
@keyframes tp-soft-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion: reduce){
  .tp-row,.tp-reset,.tp-reset::after,.tp-input,.tp-selectTrigger,.tp-selectChevron,.tp-switchTrack,.tp-thumb,.tp-actionButton{transition:none}
  .tp-invalidText,.tp-actionResult{animation:none}
}
`

/** Inject the shared row stylesheet once per page. */
let rowsCssInjected = false
export function injectSettingsRowsCss(): void {
  if (rowsCssInjected || typeof document === 'undefined') return
  rowsCssInjected = true
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
 * Number row: same left-text / right-control anatomy as toggle and select
 * rows, with the input right-aligned at a fixed width. The label is wired to
 * the input (htmlFor) and clicking anywhere on the row focuses the input.
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
  return (
    <div
      className={'tp-row' + (disabled ? '' : ' tp-rowClickable')}
      onClick={(event) => {
        const target = event.target as HTMLElement
        if (target.closest('input,button,select,textarea,a')) return
        event.currentTarget.querySelector<HTMLInputElement>('.tp-input')?.focus()
      }}
    >
      <div className="tp-rowText">
        <label className="tp-rowTitle" htmlFor={inputId}>{t(control.labelKey)}</label>
        <div className={'tp-rowDesc' + (control.invalid ? ' tp-invalidText' : '')} role={control.invalid ? 'status' : undefined}>
          {control.invalid ? t('invalidNumber') : t(control.hintKey)}
        </div>
      </div>
      {control.overridden
        ? (
          <span className="tp-badges">
            <span className="tp-badge">{t('overridden')}</span>
            <button
              type="button"
              className="tp-reset"
              disabled={disabled}
              onClick={() => onReset(control.field)}
            >
              {t('reset')}
            </button>
          </span>
        )
        : null}
      <input
        id={inputId}
        type="number"
        className={'tp-input' + (control.invalid ? ' tp-invalid' : '')}
        disabled={disabled}
        value={control.text}
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
  const current = control.options.find(opt => opt.value === control.value)
  const items = control.options.map(opt => ({ id: opt.value, label: t(opt.labelKey) }))
  const close = (): void => onOpenChange(null)

  return (
    <div
      className={'tp-row' + (disabled ? '' : ' tp-rowClickable')}
      onClick={(event) => {
        const target = event.target as HTMLElement
        if (target.closest('input,button,select,textarea,a')) return
        event.currentTarget.querySelector<HTMLButtonElement>('.tp-selectTrigger')?.click()
      }}
    >
      <div className="tp-rowText">
        <div className="tp-rowTitle">{t(control.labelKey)}</div>
        <div className="tp-rowDesc">{t(control.hintKey)}</div>
      </div>
      {control.overridden
        ? (
          <span className="tp-badges">
            <span className="tp-badge">{t('overridden')}</span>
            <button
              type="button"
              className="tp-reset"
              disabled={disabled}
              onClick={() => onReset(control.field)}
            >
              {t('reset')}
            </button>
          </span>
        )
        : null}
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
            type="button"
            className="tp-selectTrigger"
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={disabled}
            onClick={() => onOpenChange(open ? null : control.field)}
          >
            <span>{current ? t(current.labelKey) : control.value}</span>
            <IconChevronDownOutline14 className="tp-selectChevron" />
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
  return (
    <div
      className={'tp-row' + (disabled ? '' : ' tp-rowClickable')}
      onClick={(event) => {
        const target = event.target as HTMLElement
        if (target.closest('input,button,select,textarea,a')) return
        // Disabled inputs ignore programmatic clicks, so this is a no-op then.
        event.currentTarget.querySelector<HTMLInputElement>('.tp-switch input')?.click()
      }}
    >
      <div className="tp-rowText">
        <div className="tp-rowTitle">{t(control.labelKey)}</div>
        <div className="tp-rowDesc">{t(control.hintKey)}</div>
      </div>
      {control.overridden
        ? (
          <span className="tp-badges">
            <span className="tp-badge">{t('overridden')}</span>
            <button
              type="button"
              className="tp-reset"
              disabled={disabled}
              onClick={() => onReset(control.field)}
            >
              {t('reset')}
            </button>
          </span>
        )
        : null}
      <span className="tp-switch">
        <input
          type="checkbox"
          aria-label={t(control.labelKey)}
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
