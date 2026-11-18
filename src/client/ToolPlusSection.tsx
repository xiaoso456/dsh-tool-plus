/**
 * Tool Plus settings section — the plugin's own page in the Settings panel,
 * registered into the `settings.section` slot (nav id `tool-plus`). The page
 * renders one tab per tool (Bash / Read / Write & Edit / Grep / Glob /
 * Ast Grep / Ast Edit) plus a leading 全局 / Global tab — the plugin-level
 * container, holding two groups: 对话卡片 (the plugin-wide browser-card
 * switch) and 预设 (the agent-preset roster: status, difference summary and
 * the manual upgrade/reset actions); switching a tab shows that tool's configurable
 * fields, while tools without global settings show a placeholder. The
 * shared staged form over the `tool-plus` namespace lives at the page level,
 * so drafts survive switching without keeping hidden panels mounted — the
 * same flat schema the Bash card edits, from the same single-source field
 * table. The panel a switch replaces stays mounted for one 150ms fade, so the
 * two panels crossfade instead of the old one vanishing into a blank frame;
 * its unsaved draft is also parked in sessionStorage, so hopping to another
 * settings section and back restores it while the document baseline stands.
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

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { IconChevronDownOutlineRegular, IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { TOOL_PLUS_FIELDS, TOOL_PLUS_GROUP_LABELS, TOOL_PLUS_TABS, type ToolPlusField, type ToolPlusTab } from '../config/fields.ts'
import { TOOL_PLUS_RPC_CHANNEL, NATIVE_STATUS_ENDPOINT, RM_SAFE_STATUS_ENDPOINT, type NativeStatusValue, type RmSafeStatusValue } from '../tools/shared/browser-rpc-channel.ts'
import { createWebConnectionRpc } from './web-connection-rpc.ts'
import { useToolForm, type ToolSettingsValue } from './forms.ts'
import { useInert, injectSettingsRowsCss, NumberRow, SelectRow, ToggleRow, ActionRow, type ActionControl, type NumberControl, type SelectControl, type ToggleControl } from './rows.tsx'
import { rmSafeStatusText } from './rm-safe-status-text.ts'
import { nativeStatusShort, nativeStatusText } from './native-status-text.ts'
import { PresetPanel } from './PresetPanel.tsx'
import { BashInitPanel } from './BashInitPanel.tsx'
import { CommandDialog } from './CommandDialog.tsx'
import type { BashPlusLocaleKey } from './locales.ts'

/** Registration-side face: the `tool-plus` entry's shared configuration form. */
export interface ToolPlusSectionInjected {
  form: ConfigForm<ToolSettingsValue>
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
.tps-section{box-sizing:border-box;display:flex;flex-direction:column;gap:16px;padding-top:2px;--tps-gutter:10px}
.tps-heading{margin:0;font-size:18px;font-weight:600;line-height:26px;color:var(--dsw-alias-label-primary);animation:tps-rise .38s cubic-bezier(.22,1,.36,1) both}
.tps-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);max-width:64ch;animation:tps-rise .38s cubic-bezier(.22,1,.36,1) .05s both}
.tps-tabs{position:relative;display:flex;align-items:flex-end;gap:22px;border-bottom:1px solid var(--dsw-alias-border-l2);margin:2px var(--tps-gutter) 0 0;animation:tps-rise .38s cubic-bezier(.22,1,.36,1) .1s both}
.tps-tab{position:relative;appearance:none;border:none;background:none;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);padding:7px 1px 9px;cursor:pointer;white-space:nowrap;transition:color .16s ease,transform .1s ease}
.tps-tab:hover:not([data-active="true"]){color:var(--dsw-alias-label-primary)}
.tps-tab[data-active="true"]{color:var(--dsw-alias-label-primary)}
.tps-tab:active:not(:disabled){transform:scale(.97)}
.tps-tab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:2px}
.tps-tabIndicator{position:absolute;bottom:-1px;left:0;height:2px;border-radius:2px 2px 0 0;background:var(--dsw-alias-state-business-primary);pointer-events:none;transform-origin:left center}
.tps-panels{position:relative;display:flex;flex:1 1 auto;flex-direction:column;min-width:0;min-height:0}
.tps-panel{display:flex;flex:1 1 auto;flex-direction:column;gap:14px;min-width:0;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;scrollbar-width:thin}
.tps-panel[data-exit="false"]{position:relative;z-index:1;animation:tps-panel-in .14s cubic-bezier(.22,1,.36,1) both}
.tps-panel[data-exit="true"]{position:absolute;inset:0;z-index:0;pointer-events:none;animation:tps-panel-out .14s ease both}
.tps-panel::-webkit-scrollbar{width:10px}
.tps-panel::-webkit-scrollbar-track{background:transparent}
.tps-panel::-webkit-scrollbar-thumb{border:3px solid transparent;border-radius:999px;background-color:color-mix(in srgb, var(--dsw-alias-label-tertiary) 45%, transparent);background-clip:content-box}
.tps-panel::-webkit-scrollbar-thumb:hover{background-color:color-mix(in srgb, var(--dsw-alias-label-tertiary) 75%, transparent)}
.tps-rowSlot{display:grid;grid-template-rows:1fr;opacity:1;transition:grid-template-rows .2s cubic-bezier(.22,1,.36,1),opacity .16s ease}
/* Collapsed rows keep their 1px separator transparent: a zero-height box still
   paints its border, and three stacked collapsed slots showed up as a 3px line. */
.tps-rowSlot[data-open="false"]{grid-template-rows:0fr;opacity:0}
.tps-rowSlot[data-open="false"] .tps-rowSlotInner{border-bottom-color:transparent}
/* The 4px horizontal padding keeps the focused control's outline inside the
   clipping box; the matching negative margin keeps every column exactly where
   it was, so only the hairline runs 4px wider on each side. */
.tps-rowSlotInner{min-width:0;min-height:0;overflow:hidden;padding:0 4px;margin:0 -4px;border-bottom:1px solid transparent;border-bottom-color:var(--dsw-alias-border-l1);transition:border-bottom-color .2s ease}
.tps-rowSlot[data-last="true"] .tps-rowSlotInner{border-bottom:none}
.tps-subpanel{display:flex;flex-direction:column;gap:14px;min-width:0}
.tps-group{display:flex;flex-direction:column}
.tps-groupTitle{font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary);margin:0 0 6px;padding:0 2px}
.tps-card{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);padding:0 16px}
.tps-empty{border:1px dashed var(--dsw-alias-border-l3);border-radius:12px;padding:24px 16px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:4px}
.tps-emptyTitle{margin:0;font-size:14px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}
.tps-emptyHint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.tps-readOnly{margin:0;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.tps-footer{flex:none;display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:12px 0;margin-right:var(--tps-gutter);border-top:1px solid var(--dsw-alias-border-l2)}
.tps-failed{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5;color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 70%, var(--dsw-alias-label-primary))}
.tps-applies{flex:1;min-width:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.tps-pageNote{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.tps-unsaved{display:inline-flex;align-items:center;gap:6px;flex:none;border-radius:999px;padding:2px 10px;font-size:11px;line-height:17px;font-weight:500;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-state-business-tertiary)}
.tps-unsavedDot{flex:none;width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-state-business-primary);animation:tps-pulse 1.8s ease-in-out infinite}
/* 二级页签：和主页签同一套下划线语言，靠字号小一号、位置低一层表明层级。
   胶囊版的问题是三条 1px 边框在暗色下发灰、选中只换底色没有位置感。 */
.tps-subtabs{position:relative;display:flex;flex:none;gap:22px;flex-wrap:wrap;margin:-4px var(--tps-gutter) 0 0}
.tps-subtab{appearance:none;border:0;background:none;padding:0 0 7px;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:color .16s ease}
.tps-subtab:hover:not([aria-selected="true"]){color:var(--dsw-alias-label-primary)}
.tps-subtab[aria-selected="true"]{color:var(--dsw-alias-label-primary);font-weight:500}
.tps-subtab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:3px;border-radius:3px}
.tps-subtabIndicator{position:absolute;bottom:0;left:0;height:2px;border-radius:2px;background:var(--dsw-alias-state-business-primary);pointer-events:none;transform-origin:left center}
.tps-skeleton{display:flex;flex:1 1 auto;flex-direction:column;gap:14px;min-height:0}
.tps-skeletonLabel{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.tps-skeletonCard{flex:none;height:96px;border-radius:12px;background:var(--dsw-alias-bg-skeleton);animation:tps-breathe 1.4s ease-in-out infinite}
.tps-skeletonCard[data-tall="true"]{height:168px}
.tps-discard,.tps-save{appearance:none;border:1px solid transparent;border-radius:8px;padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;transition:transform .1s ease,background .16s ease,border-color .16s ease,color .16s ease}
.tps-discard:active:not(:disabled),.tps-save:active:not(:disabled){transform:scale(.97)}
.tps-discard{border-color:var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary)}
.tps-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l4)}
/* Reserved for the widest label ("Save" vs "Saving…"), so the button pair
   does not shift left while a save is running. */
.tps-save{min-width:84px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.tps-save:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.tps-discard:disabled,.tps-save:disabled{opacity:.4;cursor:default}
.tps-discard:focus-visible,.tps-save:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
@keyframes tps-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes tps-panel-in{from{opacity:.6;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes tps-panel-out{from{opacity:1}to{opacity:0}}
@keyframes tps-pulse{0%,100%{opacity:.35;transform:scale(.85)}50%{opacity:1;transform:scale(1)}}
@keyframes tps-breathe{0%,100%{opacity:.55}50%{opacity:1}}
@media (prefers-reduced-motion: reduce){
  /* The exit-state rules below are more specific than a bare class, so they
     have to be named here too or reduce-motion keeps animating the panel. */
  .tps-heading,.tps-intro,.tps-tabs,.tps-unsavedDot,.tps-skeletonCard,
  .tps-panel,.tps-panel[data-exit="false"],.tps-panel[data-exit="true"]{animation:none}
  .tps-tab,.tps-subtab,.tps-discard,.tps-save,.tps-rowSlot{transition:none}
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

/** Which sub-page of the Bash tab is showing. */
type BashSubtab = 'behavior' | 'output' | 'commands'

/** Sub-page strip of the Bash tab, in render order. */
const BASH_SUBTABS: readonly { id: BashSubtab; labelKey: BashPlusLocaleKey }[] = [
  { id: 'behavior', labelKey: 'cmdSubtabBehavior' },
  { id: 'output', labelKey: 'cmdSubtabOutput' },
  { id: 'commands', labelKey: 'cmdSubtabCommands' },
]

/** All fields the page edits (one shared form). */
const ALL_FIELDS = TOOL_PLUS_FIELDS

/**
 * Fields rendered by {@link BashInitPanel} itself, inside the feature's own
 * group: the enable switch only makes sense next to the script row, not in the
 * generic 行为 group with unrelated settings.
 */
const BASH_INIT_FIELDS = new Set(['bashInitEnabled'])

/** Floor for the pinned page height, so an unusually short pane never collapses the panel. */
const MIN_PAGE_HEIGHT = 240

/** Outgoing panel's crossfade window; kept in step with `.tps-panel[data-exit="true"]`. */
const PANEL_FADE_MS = 150

/** sessionStorage slot for the page's unsaved draft (one page, one draft). */
const DRAFT_KEY = 'dsh-tool-plus:settings-draft'

/** Whether the user asked the system to skip non-essential motion. */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 一条 2px 下划线跟着选中的页签滑动。
 *
 * 只动 transform（translateX + scaleX），全程在合成层；位置没变时连样式都不碰
 * （ResizeObserver 会对已对齐的几何反复通知，碰一下就会打断在途的 FLIP）。减弱
 * 动效下直接落位。
 *
 * @param activeKey - 选中页签的 key，对应容器里的 `data-tps-tab`。
 * @param durationMs - 滑动时长。
 */
function useSlidingUnderline(activeKey: string | undefined, durationMs: number): {
  containerRef: RefObject<HTMLDivElement | null>
  indicatorRef: RefObject<HTMLSpanElement | null>
} {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const indicatorRef = useRef<HTMLSpanElement | null>(null)
  const committed = useRef<{ left: number; width: number } | null>(null)

  const commit = useCallback((animate: boolean) => {
    const container = containerRef.current
    const indicator = indicatorRef.current
    if (container === null || indicator === null || activeKey === undefined) return
    const target = container.querySelector<HTMLElement>(`[data-tps-tab="${activeKey}"]`)
    if (target === null) return
    const left = target.offsetLeft
    const width = target.offsetWidth
    const previous = committed.current
    committed.current = { left, width }
    if (previous !== null && previous.left === left && previous.width === width) return
    const place = (): void => {
      indicator.style.willChange = ''
      indicator.style.transition = 'none'
      indicator.style.width = `${width}px`
      indicator.style.transform = `translateX(${left}px)`
    }
    if (!animate || prefersReducedMotion() || previous === null || previous.width === 0) {
      place()
      return
    }
    indicator.style.willChange = 'transform'
    indicator.style.transition = 'none'
    indicator.style.width = `${width}px`
    indicator.style.transform = `translateX(${previous.left}px) scaleX(${previous.width / width})`
    // 先让反算出来的那一帧落地，再放开过渡。
    void indicator.offsetWidth
    indicator.style.transition = `transform ${durationMs}ms cubic-bezier(.22,1,.36,1)`
    indicator.style.transform = `translateX(${left}px) scaleX(1)`
    indicator.addEventListener('transitionend', function settle() {
      indicator.removeEventListener('transitionend', settle)
      indicator.style.willChange = ''
    })
  }, [activeKey, durationMs])

  useLayoutEffect(() => { commit(true) }, [commit])

  // 只在挂载时观察一次：容器里的页签是静态列表，重建观察者会在 FLIP 中途收到
  // 初始通知，把下划线钉在起点。
  const commitRef = useRef(commit)
  commitRef.current = commit
  useEffect(() => {
    const container = containerRef.current
    if (container === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => commitRef.current(false))
    observer.observe(container)
    for (const node of Array.from(container.querySelectorAll('[data-tps-tab]'))) observer.observe(node)
    return () => { observer.disconnect() }
  }, [])

  return { containerRef, indicatorRef }
}

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
 * One field row, in the slot that owns its separator and its height.
 *
 * Conditional fields stay mounted and collapse to zero height instead of
 * vanishing, so showing or hiding a field (a strategy switch, a master toggle)
 * eases the card to its new height instead of cutting 36px out of the layout.
 * A collapsed slot is `inert`: its controls are neither focusable nor read out.
 */
function RowSlot(props: { open: boolean; last: boolean; children: ReactNode }): ReactNode {
  const { open, last, children } = props
  const slotRef = useRef<HTMLDivElement | null>(null)
  useInert(slotRef, !open)
  return (
    <div
      ref={slotRef}
      className="tps-rowSlot"
      data-open={open ? 'true' : 'false'}
      data-last={last ? 'true' : undefined}
    >
      <div className="tps-rowSlotInner">{children}</div>
    </div>
  )
}

/**
 * Render one tool tab's panel content: fields in table order (master
 * switches first, per their declaration order), grouped under their group
 * heading, or the no-config placeholder for tools without global settings.
 * A field whose visibility condition is unmet stays mounted but collapsed, so
 * showing or hiding it eases the card to its new height. `action` fields
 * render their own button row (host RPC via the caller's `run`). The 全局 tab
 * appends its preset group (roster/status/actions) after the field groups.
 */
function ToolTabPanel(props: {
  tab: ToolPlusTab
  /** Page-chrome id prefix, so tab and panel ids stay paired across remounts. */
  tabsId: string
  t: (key: BashPlusLocaleKey) => string
  form: ReturnType<typeof useToolForm>
  writable: boolean
  openSelect: string | null
  onOpenChange: (field: string | null) => void
  actionState: Record<string, 'idle' | 'running' | 'done'>
  actionResults: Record<string, { ok: boolean; text: string } | null>
  runAction: (field: ToolPlusField) => void
  bashSubtab: BashSubtab
  onOpenCommands: () => void
}): ReactNode {
  const { tab, tabsId, t, form, writable, openSelect, onOpenChange, actionState, actionResults, runAction, bashSubtab, onOpenCommands } = props
  // Controls stay put but stop accepting input while a save is in flight: an
  // edit made mid-save would otherwise race the write it is not part of.
  const disabled = !writable || form.shell.saving
  const commandsView = tab.id === 'bash' && bashSubtab === 'commands'
  const outputView = tab.id === 'bash' && bashSubtab === 'output'
  if (tab.fields.length === 0) {
    return (
      <div className="tps-empty">
        <p className="tps-emptyTitle">{t('noConfigTitle')}</p>
        <p className="tps-emptyHint">{t('noConfigHint')}</p>
      </div>
    )
  }
  const owned = new Set(tab.fields)
  const subtabGroups = tab.id !== 'bash' ? undefined : outputView ? new Set(['output', 'truncation']) : new Set(['behavior', 'timing', 'warmShell'])
  // Every field this sub-page owns — hidden conditional ones included, because
  // they render collapsed rather than disappear.
  const candidates = TOOL_PLUS_FIELDS.filter(
    field => owned.has(field.name)
      && !(tab.id === 'bash' && BASH_INIT_FIELDS.has(field.name))
      && (subtabGroups === undefined || subtabGroups.has(field.group))
      && !commandsView,
  )
  const toggleControl = (name: string): ToggleControl | undefined =>
    form.groups.flatMap(group => group.toggles).find(control => control.field === name)

  // Group fields by their group id, preserving table order inside each group —
  // master toggles (e.g. readSummarizeEnabled) render above the options they
  // gate even though controls are stored by kind.
  const groups: { group: string; fields: ToolPlusField[] }[] = []
  for (const field of candidates) {
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

  // The last row that is actually showing in each group owns the absence of a
  // trailing separator; collapsed slots are zero-height and draw nothing.
  const lastOpenOf = (fields: readonly ToolPlusField[]): string | undefined => {
    let last: string | undefined
    for (const field of fields) {
      if (field.kind === 'action' || isFieldVisible(field, form)) last = field.name
    }
    return last
  }

  const content = (
    <>
      {commandsView ? (
        <>
          {/* 命令页不写这套设置表单：先说明保存条为什么在这里无事可做，
              以及命令的改动写到哪里去。说明放页面里而不是保存条里，避免
              两种文案换行高度不同让底栏跳。 */}
          <p className="tps-pageNote">{t('commandsPageNote')}</p>
          <section className="tps-group">
            <h4 className="tps-groupTitle">{t('cmdTitle')}</h4>
            <div className="tps-card">
              <div className="tp-actionField">
                <div className="tp-actionHead">
                  <div className="tp-actionInfo">
                    <div className="tp-actionTitle">{t('cmdPanelTitle')}</div>
                    <div className="tp-actionDesc">{t('cmdIntro')}</div>
                  </div>
                  <button type="button" className="tp-actionButton" disabled={!writable} onClick={onOpenCommands}>{t('cmdOpenPanel')}</button>
                </div>
              </div>
            </div>
          </section>
        </>
      ) : groups.map((group) => {
        const lastOpen = lastOpenOf(group.fields)
        return (
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
                      disabled={disabled}
                      running={actionState[field.name] === 'running'}
                      result={actionResults[field.name] ?? null}
                      onRun={(_actionKey) => runAction(field)}
                    />
                  )
                }
                const entry = controlOf(field)
                if (entry === undefined) return null
                const open = isFieldVisible(field, form)
                let row: ReactNode
                if (entry.kind === 'number') {
                  row = (
                    <NumberRow
                      t={t}
                      control={entry.control as NumberControl}
                      disabled={disabled}
                      onEdit={form.actions.edit}
                      onReset={form.actions.resetField}
                    />
                  )
                } else if (entry.kind === 'select') {
                  row = (
                    <SelectRow
                      t={t}
                      control={entry.control as SelectControl}
                      disabled={disabled}
                      open={openSelect === field.name}
                      onOpenChange={onOpenChange}
                      onEdit={form.editSelect}
                      onReset={form.actions.resetField}
                    />
                  )
                } else {
                  row = (
                    <ToggleRow
                      t={t}
                      control={entry.control as ToggleControl}
                      disabled={disabled}
                      onToggle={form.onToggle}
                      onReset={form.actions.resetField}
                    />
                  )
                }
                return (
                  <RowSlot key={field.name} open={open} last={lastOpen === field.name}>
                    {row}
                  </RowSlot>
                )
              })}
            </div>
          </section>
        )
      })}
      {/* 「全局」tab 的第二个分组：预设清单。它不进表单（没有设置键），自带
          RPC 状态与动作，所以在这里单独挂，而不是在字段表里插一个假字段。 */}
      {tab.id === 'bash' && !commandsView
        ? (
          <BashInitPanel
            t={t}
            disabled={!writable || form.shell.saving}
            enable={toggleControl('bashInitEnabled')}
            onToggle={form.onToggle}
            onResetField={form.actions.resetField}
          />
        )
        : null}
      {tab.id === 'web' ? <NativeStatusPanel t={t} /> : null}
      {tab.id === 'web' ? <PresetPanel t={t} /> : null}
    </>
  )

  return (
    <>
      {tab.id === 'bash'
        ? (
          <div
            className="tps-subpanel"
            id={`${tabsId}-subpanel`}
            role="tabpanel"
            aria-labelledby={`${tabsId}-subtab-${bashSubtab}`}
          >
            {content}
          </div>
        )
        : content}
    </>
  )
}

/**
 * Bash 子页签（行为 / 输出 / 命令）。
 *
 * 它是**页面家具**，不是面板内容：挂在下划线主页签正下方，跟着页面固定，滚动的
 * 只有下面的 `.tps-panel`。以前它渲染在面板里，滚一下就跟着走了。
 */
function BashSubtabs(props: {
  tabsId: string
  t: (key: BashPlusLocaleKey) => string
  value: BashSubtab
  onChange: (next: BashSubtab) => void
}): ReactNode {
  const { tabsId, t, value, onChange } = props
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const { containerRef, indicatorRef } = useSlidingUnderline(value, 180)
  return (
    <div ref={containerRef} className="tps-subtabs" role="tablist" aria-label={t('tabBash')}>
      <span ref={indicatorRef} className="tps-subtabIndicator" aria-hidden="true" />
      {BASH_SUBTABS.map((sub, index) => {
        const selected = value === sub.id
        return (
          <button
            key={sub.id}
            ref={(element) => { refs.current[index] = element }}
            id={`${tabsId}-subtab-${sub.id}`}
            type="button"
            role="tab"
            className="tps-subtab"
            data-tps-tab={sub.id}
            aria-selected={selected}
            aria-controls={selected ? `${tabsId}-subpanel` : undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(sub.id)}
            onKeyDown={(event) => {
              let nextIndex: number
              switch (event.key) {
                case 'ArrowRight': nextIndex = (index + 1) % BASH_SUBTABS.length; break
                case 'ArrowLeft': nextIndex = (index - 1 + BASH_SUBTABS.length) % BASH_SUBTABS.length; break
                case 'Home': nextIndex = 0; break
                case 'End': nextIndex = BASH_SUBTABS.length - 1; break
                default: return
              }
              event.preventDefault()
              const next = BASH_SUBTABS[nextIndex] as { id: BashSubtab; labelKey: BashPlusLocaleKey }
              onChange(next.id)
              refs.current[nextIndex]?.focus()
            }}
          >
            {t(sub.labelKey)}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Which native addon this install runs. Read-only host state (`native/status`),
 * not a setting: it sits in the plugin-level tab next to the preset panel
 * because it belongs to the package as a whole rather than to one tool.
 *
 * Same shell as the other panels (group heading + bordered card), one row inside.
 * Collapsed the row is a single line that only states the result; the sentence
 * explaining what the addon buys you and which package/version was actually loaded
 * stay behind the toggle.
 */
function NativeStatusPanel(props: { t: (key: BashPlusLocaleKey) => string }): ReactNode {
  const { t } = props
  // `pending` is "installed but nothing loaded yet" — neither success nor failure.
  // Collapsed, the row is one line: title + short state + chevron. The hint and
  // the full sentence (package, loaded path, what to do) sit behind the toggle —
  // this row is a status readout, not something to read every time.
  const [state, setState] = useState<{
    tone: 'ok' | 'pending' | 'error'
    short: string
    detail: string
  } | null>(null)
  const [open, setOpen] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const rpc = createWebConnectionRpc()
      const result = await rpc.call(TOOL_PLUS_RPC_CHANNEL, NATIVE_STATUS_ENDPOINT, {})
      if (!result.ok) {
        const failed = t('nativeStatusCheckFailed')
        setState({ tone: 'error', short: failed, detail: failed })
        return
      }
      const value = result.value as NativeStatusValue
      const tone = value.status === 'active' ? 'ok' : value.reason === 'addon-not-loaded' ? 'pending' : 'error'
      setState({ tone, short: nativeStatusShort(t, value), detail: nativeStatusText(t, value) })
    } catch {
      // No RPC channel (CLI-only deployment): stay silent rather than guess.
    }
  }, [t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const tone = state?.tone ?? 'pending'

  return (
    <section className="tps-group">
      <h4 className="tps-groupTitle">{t('nativeStatus')}</h4>
      <div className="tps-card">
        <div className="tp-actionField">
          <div className="tp-actionHead">
            <button
              type="button"
              className="tp-nativeSummary"
              aria-expanded={open}
              aria-label={state !== null ? `${t('nativeStatus')} ${state.short}` : t('nativeStatus')}
              onClick={() => setOpen(value => !value)}
              data-testid="native-status-toggle"
            >
              {state !== null
                ? (
                  <span className="tp-nativeState" role="status" data-state={tone}>
                    {state.short}
                  </span>
                )
                : null}
              <IconChevronDownOutlineRegular className="tp-nativeChevron" />
            </button>
            <button
              type="button"
              className="tp-actionButton"
              onClick={() => {
                void refresh()
              }}
            >
              {t('nativeStatusRefresh')}
            </button>
          </div>
          {open
            ? (
              <div className="tp-nativeDetail">
                <p className="tp-actionDesc">{t('nativeStatusHint')}</p>
                {state !== null
                  ? (
                    <p className="tp-actionResult" data-state={tone}>
                      {state.detail}
                    </p>
                  )
                  : null}
              </div>
            )
            : null}
        </div>
      </div>
    </section>
  )
}

/**
 * One tool tab's scrolling panel.
 *
 * The panel is keyed by tab, so demoting it to the outgoing layer for one fade
 * does not remount it: its RPC effects keep running and its scroll offset
 * survives. `scrollMemory` restores the offset when the tab comes back after
 * being unmounted (the page remembers where the user was, not where the
 * scrollbar happens to be).
 */
function ToolPanel(props: {
  tab: ToolPlusTab
  tabsId: string
  exiting: boolean
  t: (key: BashPlusLocaleKey) => string
  form: ReturnType<typeof useToolForm>
  writable: boolean
  openSelect: string | null
  onOpenChange: (field: string | null) => void
  actionState: Record<string, 'idle' | 'running' | 'done'>
  actionResults: Record<string, { ok: boolean; text: string } | null>
  runAction: (field: ToolPlusField) => void
  bashSubtab: BashSubtab
  onOpenCommands: () => void
  scrollMemory: { current: Record<string, number> }
}): ReactNode {
  const { tab, tabsId, exiting, scrollMemory, ...rest } = props
  const panelRef = useRef<HTMLDivElement | null>(null)
  useInert(panelRef, exiting)
  useLayoutEffect(() => {
    const element = panelRef.current
    if (element === null) return
    element.scrollTop = scrollMemory.current[tab.id] ?? 0
  }, [tab.id, scrollMemory])
  return (
    <div
      ref={panelRef}
      id={`${tabsId}-panel-${tab.id}`}
      className="tps-panel"
      data-exit={exiting ? 'true' : 'false'}
      role="tabpanel"
      aria-labelledby={`${tabsId}-tab-${tab.id}`}
      aria-hidden={exiting || undefined}
      onScroll={(event) => { scrollMemory.current[tab.id] = event.currentTarget.scrollTop }}
    >
      {!rest.writable ? <p className="tps-readOnly" role="status">{rest.t('readOnly')}</p> : null}
      <ToolTabPanel tab={tab} tabsId={tabsId} {...rest} />
    </div>
  )
}

/** Render the Tool Plus settings section. */
export function ToolPlusSection(props: ToolPlusSectionProps): ReactNode {
  const { t, form: configForm } = props
  const form = useToolForm(configForm, ALL_FIELDS, DRAFT_KEY)
  const sectionRef = useRef<HTMLDivElement | null>(null)
  const tabsId = useRef(`tps-${Math.random().toString(36).slice(2, 8)}`)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [activeId, setActiveId] = useState<string | undefined>()
  const [openSelect, setOpenSelect] = useState<string | null>(null)
  // The tab that is fading out while the new one fades in; null when idle.
  const [exitingId, setExitingId] = useState<string | null>(null)
  const exitTimer = useRef<number | null>(null)
  // Per-tab scroll offsets: panels are unmounted on a tab switch, so the
  // position has to live outside them to come back where the user left it.
  const panelScroll = useRef<Record<string, number>>({})
  // Action controls (`kind: 'action'`) run host RPC endpoints; their state is
  // per-field here at the section level so drafts and panel switches survive.
  const [actionState, setActionState] = useState<Record<string, 'idle' | 'running' | 'done'>>({})
  const [actionResults, setActionResults] = useState<Record<string, { ok: boolean; text: string } | null>>({})
  // One transient banner for save results and dropped drafts (the host Toast
  // handles its own lifetime); `seq` remounts it so the same text can re-show.
  const [toast, setToast] = useState<{ text: string; ok: boolean; seq: number } | null>(null)
  const toastSeq = useRef(0)
  const showToast = useCallback((text: string, ok: boolean) => {
    toastSeq.current += 1
    setToast({ text, ok, seq: toastSeq.current })
  }, [])
  // 命令面板体量大，放进独立弹窗（设置面板只有 760px 宽）。
  const [commandDialogOpen, setCommandDialogOpen] = useState(false)
  // Bash 子页：行为 / 输出 / 命令。命令页是独立面板，不参与暂存表单。
  const [bashSubtab, setBashSubtab] = useState<BashSubtab>('behavior')

  // Save, then announce it. When the rmSafe switch actually changed and is now
  // on, the banner reports the injection check instead (query = ensure +
  // verify); turning it off, a failed save, or an unchanged save stays quiet.
  const handleSave = useCallback(async () => {
    const before = Boolean(configForm.getSnapshot().value?.rmSafe ?? true)
    const saved = await form.actions.save()
    if (!saved) return
    const after = Boolean(configForm.getSnapshot().value?.rmSafe ?? true)
    if (before !== after && after) {
      try {
        const rpc = createWebConnectionRpc()
        const result = await rpc.call(TOOL_PLUS_RPC_CHANNEL, RM_SAFE_STATUS_ENDPOINT, {})
        if (result.ok) {
          const value = result.value as RmSafeStatusValue
          if (value.status !== 'disabled') {
            showToast(rmSafeStatusText(t, value), value.status === 'injected')
            return
          }
        }
      } catch {
        // RPC unavailable (non-web deployment): fall through to the save notice.
      }
    }
    showToast(t('saved'), true)
  }, [configForm, form, t, showToast])

  // A draft parked against an older document cannot be replayed safely; say so
  // once instead of restoring text that would overwrite newer values.
  const announcedDrop = useRef(false)
  useEffect(() => {
    if (!form.draftDropped || announcedDrop.current) return
    announcedDrop.current = true
    showToast(t('draftDropped'), false)
  }, [form.draftDropped, t, showToast])

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

  // 下划线跟着选中的工具页签滑动（实现见 useSlidingUnderline）。
  const { containerRef: tabsRef, indicatorRef } = useSlidingUnderline(active, 240)

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

  // The panel's scrollbar eats into its content box; reserve exactly that much
  // on the chrome that sits outside the scroller (tab strip, save bar), so
  // their right edge lines up with the cards. Measured rather than assumed so
  // overlay scrollbars (which report 0) do not get a phantom gap.
  useLayoutEffect(() => {
    const root = sectionRef.current
    if (root === null) return
    const panel = root.querySelector<HTMLElement>('.tps-panel')
    if (panel === null) return
    root.style.setProperty('--tps-gutter', `${Math.max(0, panel.offsetWidth - panel.clientWidth)}px`)
  }, [form.shell.available, active])

  useEffect(() => () => {
    if (exitTimer.current !== null) window.clearTimeout(exitTimer.current)
  }, [])

  const writable = form.shell.writable
  const blocked = !form.shell.dirty || form.shell.invalid || form.shell.saving

  // Loading and unavailable get a real state instead of an empty page: a blank
  // section reads as "nothing to configure", which is not what happened.
  if (form.status !== 'ready') {
    return (
      <div ref={sectionRef} className="tps-section">
        <h2 className="tps-heading">{t('pageTitle')}</h2>
        <p className="tps-intro">{t('pageDescription')}</p>
        {form.status === 'loading'
          ? (
            <div className="tps-skeleton" role="status" aria-live="polite">
              <p className="tps-skeletonLabel">{t('settingsLoading')}</p>
              <div className="tps-skeletonCard" data-tall="true" />
              <div className="tps-skeletonCard" />
            </div>
          )
          : <div className="tps-empty"><p className="tps-emptyHint">{t('settingsUnavailable')}</p></div>}
      </div>
    )
  }

  const selectTab = (id: string): void => {
    if (id === active) return
    setOpenSelect(null)
    if (active !== undefined && !prefersReducedMotion()) {
      // Keep the outgoing panel mounted for one fade so the switch crossfades:
      // the old content leaves while the new one arrives, with no all-blank
      // frame in between. The same element is reused (keyed by tab), so the
      // panel's RPC effects and scroll offset survive the demotion.
      setExitingId(active)
      if (exitTimer.current !== null) window.clearTimeout(exitTimer.current)
      exitTimer.current = window.setTimeout(() => {
        exitTimer.current = null
        setExitingId(null)
      }, PANEL_FADE_MS)
    }
    setActiveId(id)
  }
  const outgoing = exitingId !== null && exitingId !== active
    ? TOOL_TABS.find(row => row.id === exitingId)
    : undefined
  const activeTab = TOOL_TABS.find(row => row.id === active)

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
      {/* 子页签固定在页签条下面，只让面板内容滚动。 */}
      {active === 'bash'
        ? <BashSubtabs tabsId={tabsId.current} t={t} value={bashSubtab} onChange={setBashSubtab} />
        : null}
      {/* The active panel plus, for the length of one fade, the panel it
          replaced. Both are keyed by tab, so the outgoing one is the same
          element it was a moment ago (state, scroll offset and RPC effects
          intact), and drafts — which live at the page level — never move. */}
      <div className="tps-panels">
        {outgoing !== undefined
          ? (
            <ToolPanel
              key={outgoing.id}
              tab={outgoing}
              tabsId={tabsId.current}
              exiting
              t={t}
              form={form}
              writable={writable}
              openSelect={openSelect}
              onOpenChange={setOpenSelect}
              actionState={actionState}
              actionResults={actionResults}
              runAction={runAction}
              bashSubtab={bashSubtab}
              onOpenCommands={() => setCommandDialogOpen(true)}
              scrollMemory={panelScroll}
            />
          )
          : null}
        {activeTab !== undefined
          ? (
            <ToolPanel
              key={activeTab.id}
              tab={activeTab}
              tabsId={tabsId.current}
              exiting={false}
              t={t}
              form={form}
              writable={writable}
              openSelect={openSelect}
              onOpenChange={setOpenSelect}
              actionState={actionState}
              actionResults={actionResults}
              runAction={runAction}
              bashSubtab={bashSubtab}
              onOpenCommands={() => setCommandDialogOpen(true)}
              scrollMemory={panelScroll}
            />
          )
          : null}
      </div>
      {/*
        The save bar is page furniture, not a per-sub-page control: it stays
        mounted on every tab and sub-page (so the panel height never jumps) and
        saves the page-level draft wherever the user is standing. The command
        sub-page has no settings of its own, so it says so instead of vanishing.
      */}
      <div className="tps-footer">
        {form.shell.failed
          ? <p className="tps-failed" role="status">{t('saveFailed')}</p>
          : <span className="tps-applies">{t('appliesTo')}</span>}
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
          onClick={() => void handleSave()}
        >
          {form.shell.saving ? t('saving') : t('save')}
        </button>
      </div>
      {commandDialogOpen
        ? <CommandDialog t={t} writable={writable} onClose={() => setCommandDialogOpen(false)} />
        : null}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          tone={toast.ok ? 'success' : undefined}
          icon={toast.ok ? undefined : <IconWarningOutlineRegular />}
          holdMs={4000}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}
