/**
 * Tool Plus settings section — the plugin's own page in the Settings panel,
 * registered into the `settings.section` slot (nav id `tool-plus`). The page
 * renders one tab per tool (Bash / Read / Write & Edit / Grep /
 * Ast Edit / Read Image); switching a tab shows that tool's configurable
 * fields, while tools without global settings show a placeholder. Only the
 * active tool's panel is rendered; the shared staged form over the
 * `tool-plus` namespace lives at the page level, so drafts survive switching
 * without keeping hidden panels mounted — the same flat schema the Bash card
 * edits, from the same single-source field table.
 *
 * `action`-kind fields (e.g. 探测浏览器) are not part of the staged form:
 * they run a host RPC endpoint over the official Connection channel
 * (`/tool-plus`), with per-field running/result state kept at the page level.
 *
 * Tab chrome mirrors the official Plugins settings section
 * (ui-settings-plugins): `role="tablist"` + tab/panel roles, aria wiring,
 * and arrow/Home/End keyboard roaming.
 * @module @xiaoso/dsh-tool-plus/client
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { TOOL_PLUS_FIELDS, TOOL_PLUS_GROUP_LABELS, TOOL_PLUS_TABS, type ToolPlusField, type ToolPlusTab } from '../config/fields.ts'
import { TOOL_PLUS_RPC_CHANNEL } from '../tools/shared/browser-rpc-channel.ts'
import { createWebConnectionRpc } from './web-connection-rpc.ts'
import { useToolForm, type ToolSettingsValue } from './forms.ts'
import { injectSettingsRowsCss, NumberRow, SelectRow, ToggleRow, ActionRow, type ActionControl, type NumberControl, type SelectControl, type ToggleControl } from './rows.tsx'
import type { BashPlusLocaleKey } from './locales.ts'

/** Registration-side face: the bound settings scope. */
export interface ToolPlusSectionInjected {
  scope: SettingsScope<ToolSettingsValue>
}

/** Props the renderer binds for the section (owner + locale + injected face). */
export type ToolPlusSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'tool-plus'>
  & InjectFace<ToolPlusSectionInjected>

/** Page CSS, keyed by `data-plugin-css` and injected once. */
const CSS = `
.tps{display:flex;flex-direction:column;gap:16px;padding:20px 24px}
.tps-heading{margin:0;font-size:18px;font-weight:600;line-height:26px;color:var(--dsw-alias-label-primary)}
.tps-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.tps-tabs{display:flex;flex-wrap:wrap;gap:4px;padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3)}
.tps-tab{appearance:none;border:none;background:none;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);padding:6px 14px;border-radius:8px;cursor:pointer;transition:background .14s,color .14s}
.tps-tab:hover:not([data-active="true"]){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.tps-tab[data-active="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px var(--dsw-alias-border-l2)}
.tps-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.tps-panel{display:flex;flex-direction:column;gap:12px}
.tps-group{display:flex;flex-direction:column;gap:0;padding:4px 0}
.tps-groupTitle{font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary);margin:0 0 4px}
.tps-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;padding:20px 16px;display:flex;flex-direction:column;gap:4px;background:var(--dsw-alias-bg-layer-3)}
.tps-emptyTitle{margin:0;font-size:14px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}
.tps-emptyHint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.tps-readOnly{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.tps-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 0 0;border-top:1px solid var(--dsw-alias-border-l2)}
.tps-failed{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error)}
.tps-applies{flex:1;min-width:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.tps-discard,.tps-save{appearance:none;border:1px solid transparent;border-radius:8px;padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;transition:transform .1s ease}
.tps-discard:active:not(:disabled),.tps-save:active:not(:disabled){transform:scale(.97)}
.tps-discard{border-color:var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary)}
.tps-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.tps-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.tps-discard:disabled,.tps-save:disabled{opacity:.4;cursor:default}
.tps-discard:focus-visible,.tps-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
@media (prefers-reduced-motion: reduce){
  .tps-tab,.tps-discard,.tps-save{transition:none}
}
`

/** Inject the section stylesheet once per page. */
let cssInjected = false
function injectSectionCss(): void {
  if (cssInjected || typeof document === 'undefined') return
  cssInjected = true
  const id = 'tool-plus-section'
  if (document.querySelector('style[data-plugin-css="' + id + '"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@xiaoso/dsh-tool-plus'
  tag.dataset.pluginCss = id
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/** Tool tabs with their owned fields, derived from the single-source table. */
const TOOL_TABS = TOOL_PLUS_TABS

/** All fields the page edits (one shared form). */
const ALL_FIELDS = TOOL_PLUS_FIELDS

/** Current effective value of a boolean/select control (staged or resolved). */
function controlValue(form: ReturnType<typeof useToolForm>, field: string): number | boolean | string | undefined {
  for (const group of form.groups) {
    for (const c of group.toggles) if (c.field === field) return c.checked
    for (const c of group.selects) if (c.field === field) return c.value
  }
  return undefined
}

/** Whether a field should render, given the form's current control values. */
function isFieldVisible(field: ToolPlusField, form: ReturnType<typeof useToolForm>): boolean {
  const visibility = field.visibility
  if (!visibility) return true
  if (visibility.requiresEnabled !== undefined && controlValue(form, visibility.requiresEnabled) !== true) return false
  if (visibility.requiresSelect !== undefined && controlValue(form, visibility.requiresSelect.field) !== visibility.requiresSelect.value) return false
  if (visibility.hideWhenSelect !== undefined && controlValue(form, visibility.hideWhenSelect.field) === visibility.hideWhenSelect.value) return false
  return true
}

/**
 * Render one tool tab's panel content: fields in table order (master
 * switches first, per their declaration order), grouped under their group
 * heading, or the no-config placeholder for tools without global settings.
 * Fields whose visibility condition is unmet are omitted. `action` fields
 * render their own button row (host RPC via the caller's `run`).
 */
function ToolTabPanel(props: {
  tab: ToolPlusTab
  t: (key: BashPlusLocaleKey) => string
  form: ReturnType<typeof useToolForm>
  writable: boolean
  openSelect: string | null
  onOpenChange: (field: string | null) => void
  actionState: Record<string, 'idle' | 'running' | 'done'>
  actionResults: Record<string, { ok: boolean; text: string } | null>
  runAction: (field: ToolPlusField) => void
}): ReactNode {
  const { tab, t, form, writable, openSelect, onOpenChange, actionState, actionResults, runAction } = props
  if (tab.fields.length === 0) {
    return (
      <div className="tps-empty">
        <p className="tps-emptyTitle">{t('noConfigTitle')}</p>
        <p className="tps-emptyHint">{t('noConfigHint')}</p>
      </div>
    )
  }
  const owned = new Set(tab.fields)
  const visible = TOOL_PLUS_FIELDS.filter(field => owned.has(field.name) && isFieldVisible(field, form))

  // Group visible fields by their group id, preserving table order inside
  // each group — master toggles (e.g. readSummarizeEnabled) render above the
  // options they gate even though controls are stored by kind.
  const groups: { group: string; fields: ToolPlusField[] }[] = []
  for (const field of visible) {
    const group = groups.find(g => g.group === field.group)
    if (group !== undefined) group.fields.push(field)
    else groups.push({ group: field.group, fields: [field] })
  }

  const controlOf = (field: ToolPlusField): { kind: 'number' | 'select' | 'toggle'; control: NumberControl | SelectControl | ToggleControl } | undefined => {
    for (const group of form.groups) {
      if (field.kind === 'number') {
        const control = group.numbers.find(c => c.field === field.name)
        if (control !== undefined) return { kind: 'number', control }
      } else if (field.kind === 'select') {
        const control = group.selects.find(c => c.field === field.name)
        if (control !== undefined) return { kind: 'select', control }
      } else {
        const control = group.toggles.find(c => c.field === field.name)
        if (control !== undefined) return { kind: 'toggle', control }
      }
    }
    return undefined
  }

  return (
    <>
      {groups.map(group => (
        <section key={group.group} className="tps-group">
          <h4 className="tps-groupTitle">{t(TOOL_PLUS_GROUP_LABELS[group.group] ?? 'title')}</h4>
          {group.fields.map(field => {
            // Action fields are not part of the staged form: render the
            // button row directly (host RPC via the section-level runAction).
            if (field.kind === 'action') {
              const actionControl: ActionControl = {
                field: field.name,
                labelKey: field.labelKey,
                hintKey: field.hintKey,
                actionKey: field.actionKey ?? '',
              }
              return (
                <ActionRow
                  key={field.name}
                  t={t}
                  control={actionControl}
                  disabled={!writable}
                  running={actionState[field.name] === 'running'}
                  result={actionResults[field.name] ?? null}
                  onRun={(_actionKey) => runAction(field)}
                />
              )
            }
            const entry = controlOf(field)
            if (entry === undefined) return null
            if (entry.kind === 'number') {
              return (
                <NumberRow
                  key={field.name}
                  t={t}
                  control={entry.control as NumberControl}
                  disabled={!writable}
                  onEdit={form.actions.edit}
                  onReset={form.actions.resetField}
                />
              )
            }
            if (entry.kind === 'select') {
              return (
                <SelectRow
                  key={field.name}
                  t={t}
                  control={entry.control as SelectControl}
                  disabled={!writable}
                  open={openSelect === field.name}
                  onOpenChange={onOpenChange}
                  onEdit={form.editSelect}
                  onReset={form.actions.resetField}
                />
              )
            }
            return (
              <ToggleRow
                key={field.name}
                t={t}
                control={entry.control as ToggleControl}
                disabled={!writable}
                onToggle={form.onToggle}
                onReset={form.actions.resetField}
              />
            )
          })}
        </section>
      ))}
    </>
  )
}

/** Render the Tool Plus settings section. */
export function ToolPlusSection(props: ToolPlusSectionProps): ReactNode {
  const { t, scope } = props
  const form = useToolForm(scope, ALL_FIELDS)
  const tabsId = useRef(`tps-${Math.random().toString(36).slice(2, 8)}`)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [activeId, setActiveId] = useState<string | undefined>()
  const [openSelect, setOpenSelect] = useState<string | null>(null)
  // Action controls (`kind: 'action'`) run host RPC endpoints; their state is
  // per-field here at the section level so drafts and panel switches survive.
  const [actionState, setActionState] = useState<Record<string, 'idle' | 'running' | 'done'>>({})
  const [actionResults, setActionResults] = useState<Record<string, { ok: boolean; text: string } | null>>({})

  const runAction = useCallback((field: ToolPlusField) => {
    const actionKey = field.actionKey
    if (!actionKey) return
    setActionState(prev => ({ ...prev, [field.name]: 'running' }))
    setActionResults(prev => ({ ...prev, [field.name]: null }))
    void (async () => {
      try {
        const rpc = createWebConnectionRpc()
        const result = await rpc.call(TOOL_PLUS_RPC_CHANNEL, actionKey, {})
        if (!result.ok) {
          setActionResults(prev => ({ ...prev, [field.name]: { ok: false, text: result.error.message } }))
        } else {
          const value = result.value as { found?: Array<{ name: string; path: string }> } | undefined
          const found = value?.found ?? []
          const text = found.length === 0
            ? t('browserProbeNone')
            : found.map(browser => `${browser.name}: ${browser.path}`).join('\n')
          setActionResults(prev => ({ ...prev, [field.name]: { ok: found.length > 0, text } }))
        }
      } catch {
        setActionResults(prev => ({ ...prev, [field.name]: { ok: false, text: t('browserProbeUnavailable') } }))
      } finally {
        setActionState(prev => ({ ...prev, [field.name]: 'done' }))
      }
    })()
  }, [t])

  useEffect(() => { injectSectionCss(); injectSettingsRowsCss() }, [])

  if (!form.shell.available) return null
  const active = TOOL_TABS.find(row => row.id === activeId)?.id ?? TOOL_TABS[0]?.id
  const selectTab = (id: string): void => setActiveId(id)
  const blocked = !form.shell.dirty || form.shell.invalid || form.shell.saving
  const writable = form.shell.writable

  return (
    <div className="tps-section">
      <h2 className="tps-heading">{t('pageTitle')}</h2>
      <p className="tps-intro">{t('pageDescription')}</p>
      <div className="tps-tabs" role="tablist" aria-label={t('pageTitle')}>
        {TOOL_TABS.map((row, index) => {
          const selected = row.id === active
          return (
            <button
              key={row.id}
              ref={(element) => { tabRefs.current[index] = element }}
              id={`${tabsId.current}-tab-${row.id}`}
              type="button"
              role="tab"
              className="tps-tab"
              aria-selected={selected}
              aria-controls={`${tabsId.current}-panel-${row.id}`}
              data-active={selected ? 'true' : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => selectTab(row.id)}
              onKeyDown={(event) => {
                let nextIndex: number
                switch (event.key) {
                  case 'ArrowRight': nextIndex = (index + 1) % TOOL_TABS.length; break
                  case 'ArrowLeft': nextIndex = (index - 1 + TOOL_TABS.length) % TOOL_TABS.length; break
                  case 'Home': nextIndex = 0; break
                  case 'End': nextIndex = TOOL_TABS.length - 1; break
                  default: return
                }
                event.preventDefault()
                const nextRow = TOOL_TABS[nextIndex] as ToolPlusTab
                const nextTab = tabRefs.current[nextIndex] as HTMLButtonElement
                selectTab(nextRow.id)
                nextTab.focus()
              }}
            >
              {t(row.labelKey)}
            </button>
          )
        })}
      </div>
      {/* Only the active tool's panel is rendered — the shared form lives at
          the page level, so drafts survive switching without keeping hidden
          panels mounted (which the panel's own CSS would re-expose). */}
      {TOOL_TABS
        .filter(row => row.id === active)
        .map((row) => (
          <div
            key={row.id}
            id={`${tabsId.current}-panel-${row.id}`}
            className="tps-panel"
            role="tabpanel"
            aria-labelledby={`${tabsId.current}-tab-${row.id}`}
          >
            {!writable ? <p className="tps-readOnly" role="status">{t('readOnly')}</p> : null}
            <ToolTabPanel
              tab={row}
              t={t}
              form={form}
              writable={writable}
              openSelect={openSelect}
              onOpenChange={setOpenSelect}
              actionState={actionState}
              actionResults={actionResults}
              runAction={runAction}
            />
          </div>
        ))}
      <div className="tps-footer">
        {form.shell.failed ? <p className="tps-failed" role="status">{t('saveFailed')}</p> : null}
        {!form.shell.failed ? <span className="tps-applies">{t('appliesTo')}</span> : null}
        <button
          type="button"
          className="tps-discard"
          disabled={!form.shell.dirty || form.shell.saving}
          onClick={form.actions.discard}
        >
          {t('discard')}
        </button>
        <button
          type="button"
          className="tps-save"
          disabled={blocked}
          onClick={() => void form.actions.save()}
        >
          {form.shell.saving ? t('saving') : t('save')}
        </button>
      </div>
    </div>
  )
}
