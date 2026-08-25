/**
 * Shared settings-row controls for the tool-plus settings surfaces: number
 * input, select pill, and toggle switch rows, styled against the app's
 * `--dsw-alias-*` design tokens. Extracted from the Bash card so the Plugins
 * card and the Tool Plus settings section render identical controls.
 * @module @xiaoso/dsh-tool-plus/client
 */

import { type ReactNode } from 'react'
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

/** Shared row control CSS, keyed by `data-plugin-css` and injected once. */
export const SETTINGS_ROWS_CSS = `
.tp-row{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.tp-row:last-child{border-bottom:none}
.tp-rowText{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;padding-right:24px}
.tp-rowTitle{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary)}
.tp-rowDesc{font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.tp-badges{display:inline-flex;align-items:center;gap:8px}
.tp-badge{border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;white-space:nowrap;font-weight:500;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.tp-reset{border:none;background:none;padding:0;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer}
.tp-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.tp-reset:disabled{cursor:default}
.tp-numberField{display:flex;flex-direction:column;gap:6px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.tp-numberField:last-child{border-bottom:none}
.tp-numberHead{display:flex;align-items:center;gap:8px}
.tp-numberLabel{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
.tp-input{height:34px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);width:100%;box-sizing:border-box}
.tp-input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}
.tp-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.tp-input.tp-invalid{border-color:var(--dsw-alias-label-error)}
.tp-invalidMsg{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error)}
.tp-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.tp-selectTrigger{display:inline-flex;align-items:center;gap:12px;height:36px;padding:0 14px;border:none;border-radius:18px;background:var(--dsw-alias-bg-module-platform);font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);cursor:pointer;flex-shrink:0}
.tp-selectAnchor{display:inline-flex;flex-shrink:0}
.tp-selectTrigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.tp-selectTrigger:disabled{cursor:default}
.tp-selectTrigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.tp-selectChevron{flex:none;color:var(--dsw-alias-label-tertiary);display:inline-flex;transition:transform .16s}
.tp-selectTrigger[aria-expanded="true"] .tp-selectChevron{transform:rotate(180deg)}
.tp-switch{position:relative;width:36px;height:20px;flex:none}
.tp-switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}
.tp-switchTrack{position:absolute;inset:0;border-radius:999px;background:var(--dsw-alias-border-l2);transition:background .16s;pointer-events:none}
.tp-switch input:checked+.tp-switchTrack{background:var(--dsw-alias-brand-primary)}
.tp-switch input:focus-visible+.tp-switchTrack{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.tp-thumb{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);transition:transform .16s;pointer-events:none}
.tp-switch input:checked~.tp-thumb{transform:translateX(16px)}
@media (prefers-reduced-motion: reduce){
  .tp-switch,.tp-switchTrack,.tp-thumb,.tp-selectTrigger,.tp-selectChevron{transition:none}
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

/** Number field: Header (label + override badge + reset), Input, Hint below. */
export function NumberRow(props: {
  t: (key: BashPlusLocaleKey) => string
  control: NumberControl
  disabled: boolean
  onEdit: (field: string, text: string) => void
  onReset: (field: string) => void
}): ReactNode {
  const { t, control, disabled, onEdit, onReset } = props
  return (
    <div className="tp-numberField">
      <div className="tp-numberHead">
        <label className="tp-numberLabel">{t(control.labelKey)}</label>
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
      </div>
      <input
        type="number"
        aria-label={t(control.labelKey)}
        className={'tp-input' + (control.invalid ? ' tp-invalid' : '')}
        disabled={disabled}
        value={control.text}
        onChange={e => onEdit(control.field, e.target.value)}
      />
      {control.invalid
        ? <p className="tp-invalidMsg" role="status">{t('invalidNumber')}</p>
        : <p className="tp-hint">{t(control.hintKey)}</p>}
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
    <div className="tp-row">
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
    <div className="tp-row">
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

export { hasOwn }
