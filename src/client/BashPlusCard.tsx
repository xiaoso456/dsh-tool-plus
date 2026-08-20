/**
 * The bash-plus settings card — a collapsible disclosure card in the Plugins
 * settings tab styled against the app's `--dsw-alias-*` design tokens and the
 * official card interaction (header button with unsaved badge + rotating
 * chevron, smooth expand/collapse respecting reduced-motion, staged edits that
 * survive collapsing, one Save write, nothing rendered while the namespace is
 * unavailable). Copy is fully localized through the slot-injected `t` seat
 * (`locale: 'bash-plus'`), which re-renders on a locale switch.
 *
 * The card edits the FLAT settings surface (OMP `bash*`-style scalar keys) —
 * the client scope only writes scalar fields — grouped as timeouts,
 * backgrounding, output, completion truncation (subdivided into byte and line
 * settings), and behavior. Officially exported seams only: the
 * `settings.plugin.item` slot type, the bound {@link SettingsScope}, the
 * `CardShell` type, and `PropsLocale`/`Translate`. The card's CSS is this
 * package's own (injected as one style element), referenced to the same
 * `--dsw-alias-*` tokens the shipped cards use.
 * @module @xiaoso/dsh-bash-plus/client
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { CardShell } from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
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
  & PropsLocale<'bash-plus'>
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

const TIMING_FIELDS: NumberFieldDef[] = [
  { field: 'autoBackgroundMs', labelKey: 'autoBackgroundMs', hintKey: 'autoBackgroundMsHint' },
  { field: 'defaultTimeoutMs', labelKey: 'defaultTimeoutMs', hintKey: 'defaultTimeoutMsHint' },
  { field: 'maxTimeoutMs', labelKey: 'maxTimeoutMs', hintKey: 'maxTimeoutMsHint' },
  { field: 'maxBackgroundJobs', labelKey: 'maxBackgroundJobs', hintKey: 'maxBackgroundJobsHint' },
]

const OUTPUT_FIELDS: NumberFieldDef[] = [
  { field: 'outputMaxBytes', labelKey: 'outputMaxBytes', hintKey: 'outputMaxBytesHint' },
  { field: 'outputSinkTailBytes', labelKey: 'outputSinkTailBytes', hintKey: 'outputSinkTailBytesHint' },
  { field: 'outputSinkHeadBytes', labelKey: 'outputSinkHeadBytes', hintKey: 'outputSinkHeadBytesHint' },
]

const STRATEGY_SELECT: SelectFieldDef = {
  field: 'outputTruncateStrategy',
  labelKey: 'outputTruncateStrategy',
  hintKey: 'outputTruncateStrategyHint',
  options: [
    { value: 'bytes', labelKey: 'optBytes' },
    { value: 'lines', labelKey: 'optLines' },
  ],
}

const BYTE_SELECT: SelectFieldDef = {
  field: 'outputTruncateByteMode',
  labelKey: 'outputTruncateByteMode',
  hintKey: 'outputTruncateByteModeHint',
  options: [
    { value: 'head', labelKey: 'optHead' },
    { value: 'tail', labelKey: 'optTail' },
    { value: 'middle', labelKey: 'optMiddle' },
  ],
}

const BYTE_NUMBER_FIELDS: NumberFieldDef[] = [
  { field: 'outputTruncateTriggerBytes', labelKey: 'outputTruncateTriggerBytes', hintKey: 'outputTruncateTriggerBytesHint' },
  { field: 'outputTruncateByteHeadBytes', labelKey: 'outputTruncateByteHeadBytes', hintKey: 'outputTruncateByteHeadBytesHint' },
  { field: 'outputTruncateByteTailBytes', labelKey: 'outputTruncateByteTailBytes', hintKey: 'outputTruncateByteTailBytesHint' },
]

const LINE_SELECT: SelectFieldDef = {
  field: 'outputTruncateLineMode',
  labelKey: 'outputTruncateLineMode',
  hintKey: 'outputTruncateLineModeHint',
  options: [
    { value: 'head', labelKey: 'optHead' },
    { value: 'tail', labelKey: 'optTail' },
    { value: 'middle', labelKey: 'optMiddle' },
  ],
}

const LINE_NUMBER_FIELDS: NumberFieldDef[] = [
  { field: 'outputTruncateTriggerLines', labelKey: 'outputTruncateTriggerLines', hintKey: 'outputTruncateTriggerLinesHint' },
  { field: 'outputTruncateLineHeadLines', labelKey: 'outputTruncateLineHeadLines', hintKey: 'outputTruncateLineHeadLinesHint' },
  { field: 'outputTruncateLineTailLines', labelKey: 'outputTruncateLineTailLines', hintKey: 'outputTruncateLineTailLinesHint' },
]

const TOGGLE_FIELDS: ToggleFieldDef[] = [
  { field: 'enableRunInBackground', labelKey: 'enableRunInBackground', hintKey: 'enableRunInBackgroundHint' },
  { field: 'minimizerEnabled', labelKey: 'minimizerEnabled', hintKey: 'minimizerEnabledHint' },
  { field: 'interceptorEnabled', labelKey: 'interceptorEnabled', hintKey: 'interceptorEnabledHint' },
  { field: 'nonInteractiveEnv', labelKey: 'nonInteractiveEnv', hintKey: 'nonInteractiveEnvHint' },
  { field: 'snapshotEnabled', labelKey: 'snapshotEnabled', hintKey: 'snapshotEnabledHint' },
  { field: 'useShellCommandWrapper', labelKey: 'useShellCommandWrapper', hintKey: 'useShellCommandWrapperHint' },
]

/** Schema defaults mirrored from src/config/settings.ts: what a cleared field reverts to. */
const SCHEMA_DEFAULTS: Record<string, number | boolean | string> = {
  autoBackgroundMs: 60_000,
  defaultTimeoutMs: 3_600_000,
  maxTimeoutMs: 3_600_000,
  maxBackgroundJobs: 15,
  outputMaxBytes: 51_200,
  outputSinkTailBytes: 51_200,
  outputSinkHeadBytes: 20_480,
  outputTruncateTriggerBytes: 10_240,
  outputTruncateTriggerLines: 100,
  outputTruncateByteHeadBytes: 4_096,
  outputTruncateByteTailBytes: 4_096,
  outputTruncateLineHeadLines: 50,
  outputTruncateLineTailLines: 100,
  enableRunInBackground: true,
  minimizerEnabled: true,
  interceptorEnabled: false,
  nonInteractiveEnv: true,
  snapshotEnabled: true,
  useShellCommandWrapper: false,
  outputTruncateStrategy: 'bytes',
  outputTruncateByteMode: 'middle',
  outputTruncateLineMode: 'middle',
}

/** Value a cleared field will revert to: the composition base when present, else the schema default. */
function revertValue(snap: SettingsScopeSnapshot<BashPlusSettings>, field: string): number | boolean | string | undefined {
  if (hasOwn(snap.base, field)) return (snap.base as Record<string, unknown>)[field] as number | boolean | string
  return SCHEMA_DEFAULTS[field]
}

/** Card CSS, keyed by `data-plugin-css` and injected once (design-token driven). */
const CSS = `
.bpc-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);transition:border-color .16s,background .16s;margin:0 0 8px}
.bpc-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.bpc-card.bpc-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.bpc-header{width:100%;appearance:none;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:12px}
.bpc-header:active{background:var(--dsw-alias-bg-layer-2)}
.bpc-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.bpc-headText{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.bpc-name{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}
.bpc-desc{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.bpc-pending{flex:none;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.bpc-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s;display:inline-flex}
.bpc-chevron.bpc-open{transform:rotate(180deg)}
.bpc-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-top:4px;display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .22s cubic-bezier(.22,.61,.36,1),opacity .16s ease}
.bpc-body.bpc-open{grid-template-rows:1fr;opacity:1}
.bpc-bodyInner{overflow:hidden}
.bpc-readOnly{margin:12px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}

/* Groups */
.bpc-group{display:flex;flex-direction:column;gap:0;padding:12px 0 4px}
.bpc-group+.bpc-group{border-top:1px solid var(--dsw-alias-border-l2)}
.bpc-groupTitle{font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary);margin:0 0 4px}

/* Sub-groups (for related options like byte/line truncation) */
.bpc-subgroup{display:flex;flex-direction:column;gap:0;margin:6px 0 10px;padding:8px 12px 6px;border-left:2px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:0 8px 8px 0}
.bpc-subgroupTitle{font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary);margin:0 0 4px}

/* Row-style settings (selects, switches): label left, control right */
.bpc-row{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.bpc-row:last-child{border-bottom:none}
.bpc-rowText{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;padding-right:24px}
.bpc-rowTitle{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary)}
.bpc-rowDesc{font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-label-tertiary)}

/* Overridden badges & reset */
.bpc-badges{display:inline-flex;align-items:center;gap:8px}
.bpc-badge{border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;white-space:nowrap;font-weight:500;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.bpc-reset{border:none;background:none;padding:0;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer}
.bpc-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.bpc-reset:disabled{cursor:default}

/* Number field: label + override right, input full-width, hint below */
.bpc-numberField{display:flex;flex-direction:column;gap:6px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.bpc-numberField:last-child{border-bottom:none}
.bpc-numberHead{display:flex;align-items:center;gap:8px}
.bpc-numberLabel{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
.bpc-input{height:34px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);width:100%;box-sizing:border-box}
.bpc-input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}
.bpc-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.bpc-input.bpc-invalid{border-color:var(--dsw-alias-label-error)}
.bpc-invalidMsg{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error)}
.bpc-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}

/* Official-style pill selector */
.bpc-selectTrigger{display:inline-flex;align-items:center;gap:12px;height:36px;padding:0 14px;border:none;border-radius:18px;background:var(--dsw-alias-bg-module-platform);font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);cursor:pointer;flex-shrink:0}
.bpc-selectAnchor{display:inline-flex;flex-shrink:0}
.bpc-selectTrigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.bpc-selectTrigger:disabled{cursor:default}
.bpc-selectTrigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.bpc-selectChevron{flex:none;color:var(--dsw-alias-label-tertiary);display:inline-flex;transition:transform .16s}
.bpc-selectTrigger[aria-expanded="true"] .bpc-selectChevron{transform:rotate(180deg)}

/* Switch component */
.bpc-switch{position:relative;width:36px;height:20px;flex:none}
.bpc-switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}
.bpc-switchTrack{position:absolute;inset:0;border-radius:999px;background:var(--dsw-alias-border-l2);transition:background .16s;pointer-events:none}
.bpc-switch input:checked+.bpc-switchTrack{background:var(--dsw-alias-brand-primary)}
.bpc-switch input:focus-visible+.bpc-switchTrack{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.bpc-thumb{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);transition:transform .16s;pointer-events:none}
.bpc-switch input:checked~.bpc-thumb{transform:translateX(16px)}

/* Card footer */
.bpc-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 0 4px;border-top:1px solid var(--dsw-alias-border-l2)}
.bpc-failed{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error)}
.bpc-applies{flex:1;min-width:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.bpc-discard,.bpc-save{appearance:none;border:1px solid transparent;border-radius:8px;padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;transition:transform .1s ease}
.bpc-discard:active:not(:disabled),.bpc-save:active:not(:disabled){transform:scale(.97)}
.bpc-discard{border-color:var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary)}
.bpc-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.bpc-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.bpc-discard:disabled,.bpc-save:disabled{opacity:.4;cursor:default}
.bpc-discard:focus-visible,.bpc-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
@media (prefers-reduced-motion: reduce){
  .bpc-card,.bpc-header,.bpc-chevron,.bpc-body,.bpc-thumb,.bpc-switchTrack,.bpc-discard,.bpc-save{transition:none}
}
`

/** Inject the card stylesheet once per page; the loader removes plugin-owned style tags on unload. */
let cssInjected = false
function injectCardCss(): void {
  if (cssInjected || typeof document === 'undefined') return
  cssInjected = true
  const id = 'bash-plus'
  if (document.querySelector('style[data-plugin-css="' + id + '"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@xiaoso/dsh-bash-plus'
  tag.dataset.pluginCss = id
  tag.textContent = CSS
  document.head.appendChild(tag)
}

interface NumberControl {
  field: string
  labelKey: BashPlusLocaleKey
  hintKey: BashPlusLocaleKey
  text: string
  overridden: boolean
  invalid: boolean
}

interface SelectControl {
  field: string
  labelKey: BashPlusLocaleKey
  hintKey: BashPlusLocaleKey
  options: readonly { value: string; labelKey: BashPlusLocaleKey }[]
  value: string
  overridden: boolean
}

interface ToggleControl {
  field: string
  labelKey: BashPlusLocaleKey
  hintKey: BashPlusLocaleKey
  checked: boolean
  overridden: boolean
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

  useEffect(injectCardCss, [])

  if (!form.shell.available) return null
  const blocked = !form.shell.dirty || form.shell.invalid || form.shell.saving
  return (
    <li data-plugin-settings="bash-plus" className={'bpc-card' + (open ? ' bpc-open' : '')}>
      <button
        type="button"
        className="bpc-header"
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${t('title')}`}
        onClick={() => setOpen(o => !o)}
      >
        <span className="bpc-headText">
          <span className="bpc-name">{t('title')}</span>
          <span className="bpc-desc">{t('description')}</span>
        </span>
        {form.shell.dirty ? <span className="bpc-pending" role="status">{t('unsaved')}</span> : null}
        <span aria-hidden="true" className={'bpc-chevron' + (open ? ' bpc-open' : '')}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M3.5 5.25 L7 8.75 L10.5 5.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      <div className={'bpc-body' + (open ? ' bpc-open' : '')} aria-hidden={!open}>
        <div className="bpc-bodyInner">
          {!form.shell.writable ? <p className="bpc-readOnly" role="status">{t('readOnly')}</p> : null}

          {/* 超时与后台 */}
          <section className="bpc-group">
            <h4 className="bpc-groupTitle">{t('groupTiming')}</h4>
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
          <section className="bpc-group">
            <h4 className="bpc-groupTitle">{t('groupOutput')}</h4>
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
          <section className="bpc-group">
            <h4 className="bpc-groupTitle">{t('groupTruncation')}</h4>
            
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

          {/* 行为与特性 */}
          <section className="bpc-group">
            <h4 className="bpc-groupTitle">{t('groupBehavior')}</h4>
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

          <div className="bpc-footer">
            {form.shell.failed ? <p className="bpc-failed" role="status">{t('saveFailed')}</p> : null}
            {!form.shell.failed ? <span className="bpc-applies">{t('appliesTo')}</span> : null}
            <button
              type="button"
              className="bpc-discard"
              disabled={!form.shell.dirty || form.shell.saving}
              onClick={form.actions.discard}
            >
              {t('discard')}
            </button>
            <button
              type="button"
              className="bpc-save"
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

/** Number field: Header (label + override badge + reset), Input, Hint below. */
function NumberRow(props: {
  t: (key: BashPlusLocaleKey) => string
  control: NumberControl
  disabled: boolean
  onEdit: (field: string, text: string) => void
  onReset: (field: string) => void
}): ReactNode {
  const { t, control, disabled, onEdit, onReset } = props
  return (
    <div className="bpc-numberField">
      <div className="bpc-numberHead">
        <label className="bpc-numberLabel">{t(control.labelKey)}</label>
        {control.overridden
          ? (
            <span className="bpc-badges">
              <span className="bpc-badge">{t('overridden')}</span>
              <button
                type="button"
                className="bpc-reset"
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
        className={'bpc-input' + (control.invalid ? ' bpc-invalid' : '')}
        disabled={disabled}
        value={control.text}
        onChange={e => onEdit(control.field, e.target.value)}
      />
      {control.invalid
        ? <p className="bpc-invalidMsg" role="status">{t('invalidNumber')}</p>
        : <p className="bpc-hint">{t(control.hintKey)}</p>}
    </div>
  )
}

/** Select row: Title + desc stacked on left, selector pill on right (matching official PermissionRow). */
function SelectRow(props: {
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
    <div className="bpc-row">
      <div className="bpc-rowText">
        <div className="bpc-rowTitle">{t(control.labelKey)}</div>
        <div className="bpc-rowDesc">{t(control.hintKey)}</div>
      </div>
      {control.overridden
        ? (
          <span className="bpc-badges">
            <span className="bpc-badge">{t('overridden')}</span>
            <button
              type="button"
              className="bpc-reset"
              disabled={disabled}
              onClick={() => onReset(control.field)}
            >
              {t('reset')}
            </button>
          </span>
        )
        : null}
      <Menu
        className="bpc-selectAnchor"
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
            className="bpc-selectTrigger"
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={disabled}
            onClick={() => onOpenChange(open ? null : control.field)}
          >
            <span>{current ? t(current.labelKey) : control.value}</span>
            <IconChevronDownOutline14 className="bpc-selectChevron" />
          </button>
        )}
      />
    </div>
  )
}

/** Toggle row: Title + desc stacked on left, switch on right. */
function ToggleRow(props: {
  t: (key: BashPlusLocaleKey) => string
  control: ToggleControl
  disabled: boolean
  onToggle: (field: string, checked: boolean) => void
  onReset: (field: string) => void
}): ReactNode {
  const { t, control, disabled, onToggle, onReset } = props
  return (
    <div className="bpc-row">
      <div className="bpc-rowText">
        <div className="bpc-rowTitle">{t(control.labelKey)}</div>
        <div className="bpc-rowDesc">{t(control.hintKey)}</div>
      </div>
      {control.overridden
        ? (
          <span className="bpc-badges">
            <span className="bpc-badge">{t('overridden')}</span>
            <button
              type="button"
              className="bpc-reset"
              disabled={disabled}
              onClick={() => onReset(control.field)}
            >
              {t('reset')}
            </button>
          </span>
        )
        : null}
      <span className="bpc-switch">
        <input
          type="checkbox"
          aria-label={t(control.labelKey)}
          disabled={disabled}
          checked={control.checked}
          onChange={e => onToggle(control.field, e.target.checked)}
        />
        <span className="bpc-switchTrack" />
        <span className="bpc-thumb" />
      </span>
    </div>
  )
}

function hasOwn(obj: unknown, key: string): boolean {
  return typeof obj === 'object' && obj !== null && Object.prototype.hasOwnProperty.call(obj, key)
}
