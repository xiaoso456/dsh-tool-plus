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
 *
 * The page is pinned to the host settings pane: the heading, intro and tablist
 * stay put, the save bar sits at the bottom, and the tab panel is the only
 * scroller — so the scrollbar spans just the band between them.
 * @module @xiaoso/dsh-tool-plus/client
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
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

/**
 * Page CSS, keyed by `data-plugin-css` and injected once.
 *
 * Design language: official settings-section rhythm (18/600 heading, 13px
 * tertiary intro, 760px content column) on the host's `--dsw-alias-*`
 * tokens, so both themes adapt automatically. Tab chrome is the official
 * underline tablist (like the Plugins section), upgraded with a single
 * sliding brand-blue underline; group cards float above the modal surface
 * (layer-3). No backdrop-filter anywhere — solid token colors only.
 * All motion is transform/opacity only (GPU-composited): the underline
 * FLIP is driven from JS, entrance stagger and panel fades are CSS
 * keyframes, and the unsaved dot pulses opacity/scale. Everything shuts
 * off under prefers-reduced-motion (CSS here, matchMedia for the
 * JS-driven underline).
 */
const CSS = `
.tps-section{box-sizing:border-box;display:flex;flex-direction:column;gap:16px;padding-top:2px}
.tps-heading{margin:0;font-size:18px;font-weight:600;line-height:26px;color:var(--dsw-alias-label-primary);animation:tps-rise .38s cubic-bezier(.22,1,.36,1) both}
.tps-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);max-width:64ch;animation:tps-rise .38s cubic-bezier(.22,1,.36,1) .05s both}
.tps-tabs{position:relative;display:flex;align-items:flex-end;gap:22px;border-bottom:1px solid var(--dsw-alias-border-l2);margin-top:2px;animation:tps-rise .38s cubic-bezier(.22,1,.36,1) .1s both}
.tps-tab{position:relative;appearance:none;border:none;background:none;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);padding:7px 1px 9px;cursor:pointer;white-space:nowrap;transition:color .16s ease}
.tps-tab:hover:not([data-active="true"]){color:var(--dsw-alias-label-primary)}
.tps-tab[data-active="true"]{color:var(--dsw-alias-label-primary)}
.tps-tab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:2px}
.tps-tabIndicator{position:absolute;bottom:-1px;left:0;height:2px;border-radius:2px 2px 0 0;background:var(--dsw-alias-state-business-primary);pointer-events:none;transform-origin:left center;will-change:transform}
.tps-panel{display:flex;flex:1 1 auto;flex-direction:column;gap:14px;min-width:0;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;scrollbar-width:thin;animation:tps-panel-in .24s cubic-bezier(.22,1,.36,1) both}
.tps-panel::-webkit-scrollbar{width:10px}
.tps-panel::-webkit-scrollbar-track{background:transparent}
.tps-panel::-webkit-scrollbar-thumb{border:3px solid transparent;border-radius:999px;background-color:color-mix(in srgb, var(--dsw-alias-label-tertiary) 45%, transparent);background-clip:content-box}
.tps-panel::-webkit-scrollbar-thumb:hover{background-color:color-mix(in srgb, var(--dsw-alias-label-tertiary) 75%, transparent)}
.tps-group{display:flex;flex-direction:column}
.tps-groupTitle{font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary);margin:0 0 6px;padding:0 2px}
.tps-card{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);padding:0 16px}
.tps-empty{border:1px dashed var(--dsw-alias-border-l3);border-radius:12px;padding:24px 16px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:4px}
.tps-emptyTitle{margin:0;font-size:14px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}
.tps-emptyHint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.tps-readOnly{margin:0;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.tps-footer{flex:none;display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l2)}
.tps-failed{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error)}
.tps-applies{flex:1;min-width:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.tps-unsaved{display:inline-flex;align-items:center;gap:6px;flex:none;border-radius:999px;padding:2px 10px;font-size:11px;line-height:17px;font-weight:500;color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}
.tps-unsavedDot{flex:none;width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-state-business-primary);animation:tps-pulse 1.8s ease-in-out infinite}
.tps-discard,.tps-save{appearance:none;border:1px solid transparent;border-radius:8px;padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;transition:transform .1s ease,background .16s ease,border-color .16s ease,color .16s ease}
.tps-discard:active:not(:disabled),.tps-save:active:not(:disabled){transform:scale(.97)}
.tps-discard{border-color:var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary)}
.tps-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l4)}
.tps-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.tps-save:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.tps-discard:disabled,.tps-save:disabled{opacity:.4;cursor:default}
.tps-discard:focus-visible,.tps-save:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
@keyframes tps-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes tps-panel-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes tps-pulse{0%,100%{opacity:.35;transform:scale(.85)}50%{opacity:1;transform:scale(1)}}
@media (prefers-reduced-motion: reduce){
  .tps-heading,.tps-intro,.tps-tabs,.tps-panel,.tps-unsavedDot{animation:none}
  .tps-tab,.tps-discard,.tps-save{transition:none}
  .tps-tabIndicator{will-change:auto}
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

/** Floor for the pinned page height, so an unusually short pane never collapses the panel. */
const MIN_PAGE_HEIGHT = 240

/**
 * Nearest ancestor that scrolls vertically — the host settings pane hosting
 * this section. The pane is app chrome with no stable class, so it is found by
 * walking up from the section root.
 */
function scrollPaneOf(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    if (/(auto|scroll|overlay)/.test(getComputedStyle(node).overflowY)) return node
  }
  return null
}

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
          <div className="tps-card">
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
          </div>
        </section>
      ))}
    </>
  )
}

/** Render the Tool Plus settings section. */
export function ToolPlusSection(props: ToolPlusSectionProps): ReactNode {
  const { t, scope } = props
  const form = useToolForm(scope, ALL_FIELDS)
  const sectionRef = useRef<HTMLDivElement | null>(null)
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

  const active = TOOL_TABS.find(row => row.id === activeId)?.id ?? TOOL_TABS[0]?.id

  // Sliding active-tab underline: a single 2px indicator element FLIP-animated
  // with transform only (translateX + scaleX), so tab switches stay on the
  // compositor. Position is measured from the active tab's offset geometry; a
  // ResizeObserver re-commits it instantly when labels resize (locale switch,
  // font load) without animation.
  const tabsRef = useRef<HTMLDivElement | null>(null)
  const indicatorRef = useRef<HTMLSpanElement | null>(null)
  const committedRect = useRef<{ left: number; width: number } | null>(null)

  const commitIndicator = useCallback((animate: boolean) => {
    const tabs = tabsRef.current
    const indicator = indicatorRef.current
    if (tabs === null || indicator === null || active === undefined) return
    const tab = tabs.querySelector<HTMLElement>(`[data-tps-tab="${active}"]`)
    if (tab === null) return
    const left = tab.offsetLeft
    const width = tab.offsetWidth
    const previous = committedRect.current
    committedRect.current = { left, width }
    // Position unchanged → touch nothing. A FLIP may be mid-flight; blindly
    // rewriting `transition: none` here (e.g. from a ResizeObserver ping that
    // fires for already-committed geometry) would kill it on frame zero.
    if (previous !== null && previous.left === left && previous.width === width) return
    const reduce = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!animate || reduce || previous === null) {
      indicator.style.transition = 'none'
      indicator.style.width = `${width}px`
      indicator.style.transform = `translateX(${left}px)`
      return
    }
    indicator.style.transition = 'none'
    indicator.style.width = `${width}px`
    indicator.style.transform = `translateX(${previous.left}px) scaleX(${previous.width / width})`
    // Force style flush so the inverted frame paints before we release it.
    void indicator.offsetWidth
    indicator.style.transition = 'transform .24s cubic-bezier(.22,1,.36,1)'
    indicator.style.transform = `translateX(${left}px) scaleX(1)`
  }, [active])

  useLayoutEffect(() => { commitIndicator(true) }, [commitIndicator])

  // Observe once at mount: the tab buttons are a static list, so re-creating
  // the observer on every commitIndicator identity change would re-fire
  // initial notifications mid-FLIP and snap the underline. The ref indirection
  // keeps the callback on the latest commit closure (latest `active`).
  const commitRef = useRef(commitIndicator)
  commitRef.current = commitIndicator
  useEffect(() => {
    const tabs = tabsRef.current
    if (tabs === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => commitRef.current(false))
    observer.observe(tabs)
    for (const tab of Array.from(tabs.querySelectorAll('[data-tps-tab]'))) observer.observe(tab)
    return () => { observer.disconnect() }
  }, [])

  // Pinned page: the heading/intro/tablist block and the save bar stay put and
  // the tab panel owns the scrollbar, so the scrollbar spans exactly the band
  // under the tab underline down to the save divider. The section height is
  // measured off the host pane's content box instead of written as
  // `height: 100%` — a percentage there computes to `auto` whenever the pane
  // sizes itself with `max-height` (as a settings dialog usually does).
  useLayoutEffect(() => {
    const root = sectionRef.current
    if (root === null || typeof ResizeObserver === 'undefined') return
    const pane = scrollPaneOf(root)
    if (pane === null) return
    let frame = 0
    const measure = (): void => {
      frame = 0
      const style = getComputedStyle(pane)
      const paddingTop = parseFloat(style.paddingTop) || 0
      const contentHeight = pane.clientHeight - paddingTop - (parseFloat(style.paddingBottom) || 0)
      // Section top relative to the pane's content box, scroll-position free.
      const offset = root.getBoundingClientRect().top - pane.getBoundingClientRect().top
        - (parseFloat(style.borderTopWidth) || 0) - paddingTop + pane.scrollTop
      const next = `${Math.max(MIN_PAGE_HEIGHT, Math.round(contentHeight - offset))}px`
      if (root.style.height !== next) root.style.height = next
    }
    const schedule = (): void => { if (frame === 0) frame = requestAnimationFrame(measure) }
    measure()
    const observer = new ResizeObserver(schedule)
    observer.observe(pane)
    window.addEventListener('resize', schedule)
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      root.style.height = ''
    }
  }, [form.shell.available])

  if (!form.shell.available) return null
  const selectTab = (id: string): void => setActiveId(id)
  const blocked = !form.shell.dirty || form.shell.invalid || form.shell.saving
  const writable = form.shell.writable

  return (
    <div ref={sectionRef} className="tps-section">
      <h2 className="tps-heading">{t('pageTitle')}</h2>
      <p className="tps-intro">{t('pageDescription')}</p>
      <div ref={tabsRef} className="tps-tabs" role="tablist" aria-label={t('pageTitle')}>
        <span ref={indicatorRef} className="tps-tabIndicator" aria-hidden="true" />
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
              data-tps-tab={row.id}
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
        {!form.shell.failed && form.shell.dirty
          ? <span className="tps-unsaved" role="status"><span className="tps-unsavedDot" aria-hidden="true" />{t('unsaved')}</span>
          : null}
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
