/**
 * The tool-plus settings card — a collapsible disclosure card in the Plugins
 * settings tab styled against the app's `--dsw-alias-*` design tokens and the
 * official card interaction (header button with unsaved badge + rotating
 * chevron, smooth expand/collapse respecting reduced-motion, staged edits that
 * survive collapsing, one Save write, nothing rendered while the namespace is
 * unavailable). Copy is fully localized through the slot-injected `t` seat
 * (`locale: 'tool-plus'`), which re-renders on a locale switch.
 *
 * The card edits the FLAT settings surface (OMP `bash*`-style scalar keys) —
 * the client scope only writes scalar fields — grouped as timeouts,
 * backgrounding, output, completion truncation (subdivided into byte and line
 * settings), and behavior. Field definitions, defaults, and copy keys come
 * from the single-source field table (`src/config/fields.ts`), shared with
 * the Tool Plus settings section.
 * @module @xiaoso/dsh-tool-plus/client
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { CardShell } from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { TOOL_PLUS_FIELDS, toolPlusFieldsOf, toolPlusField, type ToolPlusField } from '../config/fields.ts'
import {
  injectSettingsRowsCss,
  hasOwn,
  NumberRow,
  SelectRow,
  ToggleRow,
  type NumberControl,
  type SelectControl,
  type ToggleControl,
} from './rows.tsx'
import type { BashPlusLocaleKey } from './locales.ts'
import type { OutputRetentionMode, OutputTruncateStrategy } from '../config/settings.ts'

/** The flat, scalar-editable fields this card edits (mirrors the settings schema). */
export interface BashPlusSettings {
  enableRunInBackground?: boolean
  autoBackgroundMs?: number
  defaultTimeoutMs?: number
  maxTimeoutMs?: number
  outputMaxBytes?: number
  outputSinkTailBytes?: number
  outputSinkHeadBytes?: number
  minimizerEnabled?: boolean
  interceptorEnabled?: boolean
  nonInteractiveEnv?: boolean
  snapshotEnabled?: boolean
  useShellCommandWrapper?: boolean
  maxBackgroundJobs?: number
  outputTruncateStrategy?: OutputTruncateStrategy
  outputTruncateTriggerBytes?: number
  outputTruncateTriggerLines?: number
  outputTruncateByteMode?: OutputRetentionMode
  outputTruncateByteHeadBytes?: number
  outputTruncateByteTailBytes?: number
  outputTruncateLineMode?: OutputRetentionMode
  outputTruncateLineHeadLines?: number
  outputTruncateLineTailLines?: number
}

/** Business face the slot registration injects: the bound scope. */
export interface BashPlusCardFace {
  scope: SettingsScope<BashPlusSettings>
}

/** Props the renderer binds: runtime seat, the `t` locale seat, and the scope face. */
export type BashPlusCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'tool-plus'>
  & BashPlusCardFace

interface NumberFieldDef {
  field: string
  labelKey: BashPlusLocaleKey
  hintKey: BashPlusLocaleKey
}

interface SelectFieldDef {
  field: string
  labelKey: BashPlusLocaleKey
  hintKey: BashPlusLocaleKey
  /** Option value + its shared label key. */
  options: readonly { value: string; labelKey: BashPlusLocaleKey }[]
}

interface ToggleFieldDef {
  field: string
  labelKey: BashPlusLocaleKey
  hintKey: BashPlusLocaleKey
}

/** Bash fields derived from the single-source table, split by subgroup. */
const BASH_FIELDS = toolPlusFieldsOf('bash')

const TIMING_FIELDS: NumberFieldDef[] = BASH_FIELDS
  .filter(f => f.group === 'timing')
  .map(f => ({ field: f.name, labelKey: f.labelKey, hintKey: f.hintKey }))

const OUTPUT_FIELDS: NumberFieldDef[] = BASH_FIELDS
  .filter(f => f.group === 'output')
  .map(f => ({ field: f.name, labelKey: f.labelKey, hintKey: f.hintKey }))

const TRUNCATION_FIELDS = BASH_FIELDS.filter(f => f.group === 'truncation')

const STRATEGY_SELECT: SelectFieldDef = {
  field: 'outputTruncateStrategy',
  labelKey: 'outputTruncateStrategy',
  hintKey: 'outputTruncateStrategyHint',
  options: toolPlusField('outputTruncateStrategy')?.options ?? [],
}

const BYTE_SELECT: SelectFieldDef = {
  field: 'outputTruncateByteMode',
  labelKey: 'outputTruncateByteMode',
  hintKey: 'outputTruncateByteModeHint',
  options: toolPlusField('outputTruncateByteMode')?.options ?? [],
}

const BYTE_NUMBER_FIELDS: NumberFieldDef[] = TRUNCATION_FIELDS
  .filter(f => f.name.startsWith('outputTruncateByte') && f.name !== 'outputTruncateByteMode')
  .map(f => ({ field: f.name, labelKey: f.labelKey, hintKey: f.hintKey }))

const LINE_SELECT: SelectFieldDef = {
  field: 'outputTruncateLineMode',
  labelKey: 'outputTruncateLineMode',
  hintKey: 'outputTruncateLineModeHint',
  options: toolPlusField('outputTruncateLineMode')?.options ?? [],
}

const LINE_NUMBER_FIELDS: NumberFieldDef[] = TRUNCATION_FIELDS
  .filter(f => f.name.startsWith('outputTruncateLine') && f.name !== 'outputTruncateLineMode')
  .map(f => ({ field: f.name, labelKey: f.labelKey, hintKey: f.hintKey }))

const TOGGLE_FIELDS: ToggleFieldDef[] = BASH_FIELDS
  .filter(f => f.group === 'behavior')
  .map(f => ({ field: f.name, labelKey: f.labelKey, hintKey: f.hintKey }))

/** Schema defaults sourced from the single-source field table. */
const SCHEMA_DEFAULTS: Record<string, number | boolean | string> = Object.fromEntries(
  TOOL_PLUS_FIELDS.map(f => [f.name, f.default]),
)

/** Value a cleared field will revert to: the composition base when present, else the schema default. */
function revertValue(snap: SettingsScopeSnapshot<BashPlusSettings>, field: string): number | boolean | string | undefined {
  if (hasOwn(snap.base, field)) return (snap.base as Record<string, unknown>)[field] as number | boolean | string
  return SCHEMA_DEFAULTS[field]
}

/** Card chrome CSS, keyed by `data-plugin-css` and injected once (design-token driven). */
const CSS = `
.tp-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);transition:border-color .16s,background .16s;margin:0 0 8px}
.tp-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.tp-card.tp-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.tp-header{width:100%;appearance:none;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:12px}
.tp-header:active{background:var(--dsw-alias-bg-layer-2)}
.tp-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.tp-headText{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.tp-name{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}
.tp-desc{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.tp-pending{flex:none;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.tp-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s;display:inline-flex}
.tp-chevron.tp-open{transform:rotate(180deg)}
.tp-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-top:4px;display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .22s cubic-bezier(.22,.61,.36,1),opacity .16s ease}
.tp-body.tp-open{grid-template-rows:1fr;opacity:1}
.tp-bodyInner{overflow:hidden}
.tp-readOnly{margin:12px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.tp-group{display:flex;flex-direction:column;gap:0;padding:12px 0 4px}
.tp-group+.tp-group{border-top:1px solid var(--dsw-alias-border-l2)}
.tp-groupTitle{font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary);margin:0 0 4px}
.tp-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 0 4px;border-top:1px solid var(--dsw-alias-border-l2)}
.tp-failed{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error)}
.tp-applies{flex:1;min-width:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.tp-discard,.tp-save{appearance:none;border:1px solid transparent;border-radius:8px;padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;transition:transform .1s ease}
.tp-discard:active:not(:disabled),.tp-save:active:not(:disabled){transform:scale(.97)}
.tp-discard{border-color:var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary)}
.tp-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.tp-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.tp-discard:disabled,.tp-save:disabled{opacity:.4;cursor:default}
.tp-discard:focus-visible,.tp-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
@media (prefers-reduced-motion: reduce){
  .tp-card,.tp-header,.tp-chevron,.tp-body,.tp-thumb,.tp-switchTrack,.tp-discard,.tp-save{transition:none}
}
`

/** Inject the card stylesheet once per page; the loader removes plugin-owned style tags on unload. */
let cssInjected = false
function injectCardCss(): void {
  if (cssInjected || typeof document === 'undefined') return
  cssInjected = true
  const id = 'tool-plus-card'
  if (document.querySelector('style[data-plugin-css="' + id + '"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@xiaoso/dsh-tool-plus'
  tag.dataset.pluginCss = id
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/** Text of a staged (or resolved) value for the number controls. */
function numberText(staged: string | undefined, hasStaged: boolean, resolved: number | boolean | string | undefined, snap: SettingsScopeSnapshot<BashPlusSettings>, field: string): string {
  if (hasStaged) return (staged ?? '').trim() === '' ? String(revertValue(snap, field) ?? '') : (staged ?? '')
  return resolved === undefined || typeof resolved === 'boolean' ? '' : String(resolved)
}

/** Stage card edits over the bound scope; only a Save writes the document. */
function useBashPlusForm(scope: SettingsScope<BashPlusSettings>) {
  const [snap, setSnap] = useState<SettingsScopeSnapshot<BashPlusSettings>>(() => scope.getSnapshot())
  const [numbers, setNumbers] = useState<Record<string, string>>({})
  const [selects, setSelects] = useState<Record<string, string | null>>({})
  const [toggles, setToggles] = useState<Record<string, boolean | null>>({})
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => scope.subscribe(() => {
    setSnap(scope.getSnapshot())
    setFailed(false)
  }), [scope])

  const value = snap.value ?? {}
  const writable = snap.writable

  const timing = useMemo<NumberControl[]>(() => TIMING_FIELDS.map(def => renderNumber(def, numbers, value, snap)), [numbers, snap])
  const output = useMemo<NumberControl[]>(() => OUTPUT_FIELDS.map(def => renderNumber(def, numbers, value, snap)), [numbers, snap])

  const strategySelect = useMemo<SelectControl>(() => renderSelect(STRATEGY_SELECT, selects, value, snap), [selects, snap])
  const byteSelect = useMemo<SelectControl>(() => renderSelect(BYTE_SELECT, selects, value, snap), [selects, snap])
  const byteNumbers = useMemo<NumberControl[]>(() => BYTE_NUMBER_FIELDS.map(def => renderNumber(def, numbers, value, snap)), [numbers, snap])

  const lineSelect = useMemo<SelectControl>(() => renderSelect(LINE_SELECT, selects, value, snap), [selects, snap])
  const lineNumbers = useMemo<NumberControl[]>(() => LINE_NUMBER_FIELDS.map(def => renderNumber(def, numbers, value, snap)), [numbers, snap])

  const togglesView = useMemo<ToggleControl[]>(() => TOGGLE_FIELDS.map(def => {
    const hasStaged = Object.prototype.hasOwnProperty.call(toggles, def.field)
    const staged = toggles[def.field as string]
    const baseVal = Boolean(revertValue(snap, def.field))
    const userStored = hasOwn(snap.user, def.field)
    const userVal = (snap.user as Record<string, unknown> | undefined)?.[def.field]
    const effectiveVal = hasStaged ? (staged ?? baseVal) : Boolean(value[def.field as keyof BashPlusSettings])

    // An override means the field's resulting value on save will be stored in user layer
    let overridden = false
    if (hasStaged) {
      if (staged === null || staged === baseVal) overridden = false
      else overridden = true
    } else {
      overridden = userStored
    }

    return { field: def.field, labelKey: def.labelKey, hintKey: def.hintKey, checked: effectiveVal, overridden }
  }), [toggles, snap])

  const allNumbers = useMemo(() => [...timing, ...output, ...byteNumbers, ...lineNumbers], [timing, output, byteNumbers, lineNumbers])
  const invalid = allNumbers.some(c => c.invalid)

  // Calculate whether any write is planned
  const isDirty = useMemo(() => {
    for (const [field, staged] of Object.entries(selects)) {
      const baseVal = String(revertValue(snap, field) ?? '')
      const userStored = hasOwn(snap.user, field)
      const userVal = (snap.user as Record<string, unknown> | undefined)?.[field]
      if (staged === null) {
        if (userStored) return true
      } else if (staged === baseVal) {
        if (userStored) return true
      } else {
        if (!userStored || userVal !== staged) return true
      }
    }
    for (const [field, staged] of Object.entries(numbers)) {
      const baseVal = revertValue(snap, field)
      const userStored = hasOwn(snap.user, field)
      const userVal = (snap.user as Record<string, unknown> | undefined)?.[field]
      const trimmed = staged.trim()
      if (trimmed === '') {
        if (userStored) return true
      } else {
        const num = Number(trimmed)
        if (Number.isFinite(num)) {
          if (num === baseVal) {
            if (userStored) return true
          } else {
            if (!userStored || userVal !== num) return true
          }
        } else {
          return true // invalid draft keeps dirty
        }
      }
    }
    for (const [field, staged] of Object.entries(toggles)) {
      const baseVal = Boolean(revertValue(snap, field))
      const userStored = hasOwn(snap.user, field)
      const userVal = (snap.user as Record<string, unknown> | undefined)?.[field]
      if (staged === null) {
        if (userStored) return true
      } else if (staged === baseVal) {
        if (userStored) return true
      } else {
        if (!userStored || userVal !== staged) return true
      }
    }
    return false
  }, [selects, numbers, toggles, snap])

  const edit = useCallback((field: string, text: string) => {
    setFailed(false)
    setNumbers(prev => ({ ...prev, [field]: text }))
  }, [])

  const editSelect = useCallback((field: string, value: string) => {
    setFailed(false)
    setSelects(prev => ({ ...prev, [field]: value }))
  }, [])

  const onToggle = useCallback((field: string, checked: boolean) => {
    setFailed(false)
    setToggles(prev => ({ ...prev, [field]: checked }))
  }, [])

  const resetField = useCallback((field: string) => {
    setFailed(false)
    setNumbers(prev => ({ ...prev, [field]: '' }))
    setSelects(prev => ({ ...prev, [field]: null }))
    setToggles(prev => ({ ...prev, [field]: null }))
  }, [])

  const save = useCallback(async () => {
    if (!writable || invalid) return
    setSaving(true)
    setFailed(false)
    try {
      for (const [field, staged] of Object.entries(numbers)) {
        const baseVal = revertValue(snap, field)
        const trimmed = staged.trim()
        if (trimmed === '' || Number(trimmed) === baseVal) {
          if (hasOwn(snap.user, field)) await scope.unset(field)
        } else {
          await scope.set(field, Number(trimmed))
        }
      }
      for (const [field, staged] of Object.entries(selects)) {
        const baseVal = String(revertValue(snap, field) ?? '')
        if (staged === null || staged === baseVal) {
          if (hasOwn(snap.user, field)) await scope.unset(field)
        } else {
          await scope.set(field, staged)
        }
      }
      for (const [field, staged] of Object.entries(toggles)) {
        const baseVal = Boolean(revertValue(snap, field))
        if (staged === null || staged === baseVal) {
          if (hasOwn(snap.user, field)) await scope.unset(field)
        } else {
          await scope.set(field, staged)
        }
      }
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
      setNumbers({})
      setSelects({})
      setToggles({})
    }
  }, [scope, writable, invalid, numbers, selects, toggles, snap])

  const discard = useCallback(() => {
    setFailed(false)
    setNumbers({})
    setSelects({})
    setToggles({})
  }, [])

  const shell: CardShell = { available: snap.status === 'ready', writable, dirty: isDirty, invalid, saving, failed }
  return {
    shell,
    timing,
    output,
    strategySelect,
    byteSelect,
    byteNumbers,
    lineSelect,
    lineNumbers,
    toggles: togglesView,
    actions: { edit, resetField, save, discard },
    editSelect,
    onToggle,
  }
}

function renderNumber(def: NumberFieldDef, numbers: Record<string, string>, value: BashPlusSettings, snap: SettingsScopeSnapshot<BashPlusSettings>): NumberControl {
  const hasStaged = Object.prototype.hasOwnProperty.call(numbers, def.field)
  const staged = numbers[def.field]
  const resolved = value[def.field as keyof BashPlusSettings]
  const text = numberText(staged, hasStaged, typeof resolved === 'boolean' ? undefined : resolved, snap, def.field)
  const baseVal = revertValue(snap, def.field)
  const userStored = hasOwn(snap.user, def.field)

  let overridden = false
  let invalid = false
  if (hasStaged) {
    const trimmed = (staged ?? '').trim()
    if (trimmed === '') {
      overridden = false
    } else {
      const num = Number(trimmed)
      if (Number.isFinite(num)) {
        overridden = num !== baseVal
      } else {
        invalid = true
      }
    }
  } else {
    overridden = userStored
  }

  return { field: def.field, labelKey: def.labelKey, hintKey: def.hintKey, text, overridden, invalid }
}

function renderSelect(def: SelectFieldDef, selects: Record<string, string | null>, value: BashPlusSettings, snap: SettingsScopeSnapshot<BashPlusSettings>): SelectControl {
  const hasStaged = Object.prototype.hasOwnProperty.call(selects, def.field)
  const staged = selects[def.field as string]
  const resolved = value[def.field as keyof BashPlusSettings]
  const baseVal = String(revertValue(snap, def.field) ?? '')
  const v = hasStaged ? (staged ?? baseVal) : (typeof resolved === 'string' ? resolved : baseVal)
  const userStored = hasOwn(snap.user, def.field)

  let overridden = false
  if (hasStaged) {
    if (staged === null || staged === baseVal) overridden = false
    else overridden = true
  } else {
    overridden = userStored
  }

  return {
    field: def.field,
    labelKey: def.labelKey,
    hintKey: def.hintKey,
    options: def.options,
    value: v,
    overridden,
  }
}

export function BashPlusCard(props: BashPlusCardProps): ReactNode {
  const { t, scope } = props
  const form = useBashPlusForm(scope)
  const [open, setOpen] = useState(false)
  const [openSelect, setOpenSelect] = useState<string | null>(null)

  useEffect(() => { injectCardCss(); injectSettingsRowsCss() }, [])

  if (!form.shell.available) return null
  const blocked = !form.shell.dirty || form.shell.invalid || form.shell.saving
  return (
    <li data-plugin-settings="tool-plus" className={'tp-card' + (open ? ' tp-open' : '')}>
      <button
        type="button"
        className="tp-header"
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${t('title')}`}
        onClick={() => setOpen(o => !o)}
      >
        <span className="tp-headText">
          <span className="tp-name">{t('title')}</span>
          <span className="tp-desc">{t('description')}</span>
        </span>
        {form.shell.dirty ? <span className="tp-pending" role="status">{t('unsaved')}</span> : null}
        <span aria-hidden="true" className={'tp-chevron' + (open ? ' tp-open' : '')}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M3.5 5.25 L7 8.75 L10.5 5.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      <div className={'tp-body' + (open ? ' tp-open' : '')} aria-hidden={!open}>
        <div className="tp-bodyInner">
          {!form.shell.writable ? <p className="tp-readOnly" role="status">{t('readOnly')}</p> : null}

          {/* 行为与特性 */}
          <section className="tp-group">
            <h4 className="tp-groupTitle">{t('groupBehavior')}</h4>
            {form.toggles.map(c => (
              <ToggleRow
                key={c.field}
                t={t}
                control={c}
                disabled={!form.shell.writable}
                onToggle={form.onToggle}
                onReset={form.actions.resetField}
              />
            ))}
          </section>

          {/* 超时与后台 */}
          <section className="tp-group">
            <h4 className="tp-groupTitle">{t('groupTiming')}</h4>
            {form.timing.map(c => (
              <NumberRow
                key={c.field}
                t={t}
                control={c}
                disabled={!form.shell.writable}
                onEdit={form.actions.edit}
                onReset={form.actions.resetField}
              />
            ))}
          </section>

          {/* 输出 */}
          <section className="tp-group">
            <h4 className="tp-groupTitle">{t('groupOutput')}</h4>
            {form.output.map(c => (
              <NumberRow
                key={c.field}
                t={t}
                control={c}
                disabled={!form.shell.writable}
                onEdit={form.actions.edit}
                onReset={form.actions.resetField}
              />
            ))}
          </section>

          {/* 完成消息截断（按策略动态展示生效项，无需内部嵌套子组） */}
          <section className="tp-group">
            <h4 className="tp-groupTitle">{t('groupTruncation')}</h4>

            {/* 顶级截断按选择器（按字节 / 按行） */}
            <SelectRow
              t={t}
              control={form.strategySelect}
              disabled={!form.shell.writable}
              open={openSelect === form.strategySelect.field}
              onOpenChange={setOpenSelect}
              onEdit={form.editSelect}
              onReset={form.actions.resetField}
            />

            {/* 当选择按字节截断时：直接平铺展示字节相关配置 */}
            {form.strategySelect.value !== 'lines' ? (
              <>
                <NumberRow
                  t={t}
                  control={form.byteNumbers[0]}
                  disabled={!form.shell.writable}
                  onEdit={form.actions.edit}
                  onReset={form.actions.resetField}
                />
                <SelectRow
                  t={t}
                  control={form.byteSelect}
                  disabled={!form.shell.writable}
                  open={openSelect === form.byteSelect.field}
                  onOpenChange={setOpenSelect}
                  onEdit={form.editSelect}
                  onReset={form.actions.resetField}
                />
                {form.byteSelect.value !== 'tail' ? (
                  <NumberRow
                    t={t}
                    control={form.byteNumbers[1]}
                    disabled={!form.shell.writable}
                    onEdit={form.actions.edit}
                    onReset={form.actions.resetField}
                  />
                ) : null}
                {form.byteSelect.value !== 'head' ? (
                  <NumberRow
                    t={t}
                    control={form.byteNumbers[2]}
                    disabled={!form.shell.writable}
                    onEdit={form.actions.edit}
                    onReset={form.actions.resetField}
                  />
                ) : null}
              </>
            ) : null}

            {/* 当选择按行截断时：直接平铺展示行相关配置 */}
            {form.strategySelect.value === 'lines' ? (
              <>
                <NumberRow
                  t={t}
                  control={form.lineNumbers[0]}
                  disabled={!form.shell.writable}
                  onEdit={form.actions.edit}
                  onReset={form.actions.resetField}
                />
                <SelectRow
                  t={t}
                  control={form.lineSelect}
                  disabled={!form.shell.writable}
                  open={openSelect === form.lineSelect.field}
                  onOpenChange={setOpenSelect}
                  onEdit={form.editSelect}
                  onReset={form.actions.resetField}
                />
                {form.lineSelect.value !== 'tail' ? (
                  <NumberRow
                    t={t}
                    control={form.lineNumbers[1]}
                    disabled={!form.shell.writable}
                    onEdit={form.actions.edit}
                    onReset={form.actions.resetField}
                  />
                ) : null}
                {form.lineSelect.value !== 'head' ? (
                  <NumberRow
                    t={t}
                    control={form.lineNumbers[2]}
                    disabled={!form.shell.writable}
                    onEdit={form.actions.edit}
                    onReset={form.actions.resetField}
                  />
                ) : null}
              </>
            ) : null}
          </section>

          <div className="tp-footer">
            {form.shell.failed ? <p className="tp-failed" role="status">{t('saveFailed')}</p> : null}
            {!form.shell.failed ? <span className="tp-applies">{t('appliesTo')}</span> : null}
            <button
              type="button"
              className="tp-discard"
              disabled={!form.shell.dirty || form.shell.saving}
              onClick={form.actions.discard}
            >
              {t('discard')}
            </button>
            <button
              type="button"
              className="tp-save"
              disabled={blocked}
              onClick={() => void form.actions.save()}
            >
              {form.shell.saving ? t('saving') : t('save')}
            </button>
          </div>
        </div>
      </div>
    </li>
  )
}
