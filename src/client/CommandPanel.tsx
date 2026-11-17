/**
 * 「命令」 sub-page of the Bash tab: the full list of commands this shell can
 * resolve, where each one comes from, and the three-way choice per name
 * (plugin builtin / system / my executable).
 *
 * Data is measured by the host on demand (`command/list`), never assumed; this
 * component only filters, renders and posts choices. The list is virtualized —
 * 1337 rows at a 34px row height, only the visible window mounted — so scrolling
 * and typing stay flat. Search filters in memory; grouping is by origin, which
 * is the same order the host sorts by.
 * @module @xiaoso/dsh-tool-plus/client
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  COMMAND_APPLY_ENDPOINT,
  COMMAND_LIST_ENDPOINT,
  COMMAND_PROBE_ENDPOINT,
  TOOL_PLUS_RPC_CHANNEL,
  type CommandApplyValue,
  type CommandEntryValue,
  type CommandListValue,
  type CommandProbeValue,
} from '../tools/shared/browser-rpc-channel.ts'
import { createWebConnectionRpc } from './web-connection-rpc.ts'
import type { BashPlusLocaleKey } from './locales.ts'

/** Locale lookup the section passes down. */
type Translate = (key: BashPlusLocaleKey) => string

/** Row height of the virtual list; group headers use the same stride. */
const ROW_H = 34

/** Origin → group heading and note suffix. */
const GROUP_ORDER: readonly { origin: CommandEntryValue['origin']; label: BashPlusLocaleKey }[] = [
  { origin: 'custom', label: 'cmdGroupCustom' },
  { origin: 'new', label: 'cmdGroupNew' },
  { origin: 'omp', label: 'cmdGroupOmp' },
  { origin: 'bash', label: 'cmdGroupBash' },
  { origin: 'fn', label: 'cmdGroupFn' },
  { origin: 'sys', label: 'cmdGroupSys' },
]

/** Rail selection: two cross-cutting filters plus each origin. */
type Filter = 'builtin' | 'conflict' | 'all' | CommandEntryValue['origin']

/** One rendered line of the list: a group heading or a command row. */
type Row = { kind: 'group'; key: string; label: string; count: number } | { kind: 'item'; entry: CommandEntryValue }

const CSS = `.tpc-root{display:flex;flex-direction:column;gap:0;min-height:0}
.tpc-overlay{position:fixed;inset:0;z-index:1300;display:flex;align-items:center;justify-content:center;padding:28px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 45%,transparent)}
.tpc-dialog{position:relative;box-sizing:border-box;display:flex;flex-direction:column;gap:0;width:min(1120px,96vw);height:min(760px,88vh);padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.tpc-dialogHead{display:flex;align-items:center;gap:12px;flex:none;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.tpc-dialogTitle{margin:0;font-size:15px;font-weight:600;line-height:23px;color:var(--dsw-alias-label-primary)}
.tpc-dialogHead .tpc-btn{margin-left:auto}
.tpc-root[data-variant='dialog']{flex:1;min-height:0}
.tpc-root[data-variant='dialog'] .tps-card{flex:1;min-height:0;overflow:hidden;padding:0;gap:0;border:0;border-radius:0;background:none}
.tpc-surface{flex:1;min-height:0;display:grid;grid-template-columns:176px 300px minmax(0,1fr);overflow:hidden}
.tpc-railCol{display:flex;flex-direction:column;gap:4px;min-height:0;padding:10px 8px;border-right:1px solid var(--dsw-alias-border-l2);overflow-y:auto}
.tpc-railGroup{display:flex;flex-direction:column;gap:2px}
.tpc-railGroup + .tpc-railGroup{margin-top:6px}
.tpc-railTitle{padding:4px 10px 2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.tpc-railBtn{appearance:none;display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid transparent;border-radius:9px;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;line-height:18px;text-align:left;cursor:pointer}
.tpc-railBtn:hover{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 10%,transparent);color:var(--dsw-alias-label-primary)}
.tpc-railBtn[aria-pressed='true']{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary)}
.tpc-railBtn em{margin-left:auto;font-style:normal;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.tpc-railBtn[aria-pressed='true'] em{color:inherit}
.tpc-railFoot{margin-top:auto;padding:8px 10px 2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.tpc-listCol{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l2)}
.tpc-listHead{flex:none;display:flex;align-items:center;gap:6px;padding:10px 12px}
.tpc-listHead .tpc-search{flex:1;min-width:0}
.tpc-listHead .tpc-btn{padding:5px 10px}
.tpc-search{height:32px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:0 11px}
.tpc-search:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.tpc-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;line-height:1.5;padding:5px 12px;cursor:pointer;white-space:nowrap}
.tpc-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l4)}
.tpc-btn:disabled{opacity:.4;cursor:default}
.tpc-btnPrimary{background:var(--dsw-alias-label-primary);border-color:transparent;color:var(--dsw-alias-bg-layer-1)}
.tpc-btnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-bg-layer-1)}
.tpc-btnDanger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,var(--dsw-alias-border-l2))}
.tpc-btnDanger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}
.tpc-addRow{appearance:none;display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;padding:9px 12px;border:0;border-bottom:1px solid var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer}
.tpc-addRow:hover:not(:disabled){background:var(--dsw-alias-state-business-tertiary)}
.tpc-addRow:disabled{opacity:.4;cursor:default}
.tpc-list{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.tpc-row{display:flex;align-items:center;gap:9px;padding:0 12px;box-sizing:border-box;cursor:pointer;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary)}
.tpc-row:hover{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 9%,transparent)}
.tpc-row[data-selected='true']{background:var(--dsw-alias-state-business-tertiary)}
.tpc-row[data-selected='true'] .tpc-rowName{color:var(--dsw-alias-state-business-primary)}
.tpc-rowName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.tpc-group{display:flex;align-items:center;gap:8px;padding:0 12px;box-sizing:border-box;font-size:11px;line-height:34px;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l2)}
.tpc-group em{margin-left:auto;font-style:normal;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}
.tpc-badge{flex:none;border-radius:999px;padding:0 7px;font-size:10.5px;line-height:17px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.tpc-badge[data-origin='new']{color:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 35%,var(--dsw-alias-border-l2))}
.tpc-badge[data-origin='custom']{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 35%,var(--dsw-alias-border-l2))}
.tpc-badge[data-origin='fn']{border-style:dashed}
.tpc-detailCol{display:flex;flex-direction:column;min-height:0}
.tpc-detailHead{flex:none;display:flex;align-items:flex-start;gap:12px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.tpc-who{flex:1 1 auto;min-width:0}
.tpc-name{margin:0;font-size:15px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}
.tpc-detailHead .tpc-name{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:17px;line-height:25px;letter-spacing:-.01em}
.tpc-path{min-width:0;margin:1px 0 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.tpc-badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}
.tpc-headActions{flex:none;display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}
.tpc-confirmBar{flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 16px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.tpc-detailScroll{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding:14px 16px}
.tpc-field{display:flex;flex-direction:column;gap:6px}
.tpc-fieldLabel{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.tpc-seg{display:flex;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;overflow:hidden}
.tpc-segBtn{flex:1 1 0;appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;padding:7px 8px;cursor:pointer;white-space:nowrap}
.tpc-segBtn+ .tpc-segBtn{border-left:1px solid var(--dsw-alias-border-l2)}
.tpc-segBtn[aria-pressed='true']{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary)}
.tpc-segBtn:disabled{opacity:.4;cursor:default}
.tpc-input{box-sizing:border-box;height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 10px}
.tpc-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.tpc-kv{display:grid;grid-template-columns:70px minmax(0,1fr);gap:8px 12px;margin:0;font-size:12px;line-height:18px}
.tpc-kv dt{color:var(--dsw-alias-label-tertiary)}
.tpc-kv dd{margin:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;word-break:break-word}
.tpc-impact{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.tpc-impactTitle{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.tpc-impactRow{display:flex;align-items:center;gap:8px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.tpc-impactRow i{flex:none;width:40px;font-style:normal;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.tpc-impactRow b{font-weight:400;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-state-business-primary)}
.tpc-impactRow em{margin-left:auto;font-style:normal;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.tpc-console{margin:0;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base);padding:10px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.7;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere;min-height:74px;max-height:180px;overflow-y:auto}
.tpc-detailScroll .tpc-console{flex:none;height:74px;max-height:none}
.tpc-formField{display:flex;flex-direction:column;gap:5px}
.tpc-formLabel{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.tpc-formHint{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.tpc-formField .tpc-input{width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.tpc-addNotes{margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);list-style:none;display:flex;flex-direction:column;gap:5px;font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary)}
.tpc-note{margin:0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.tpc-toast{margin:0;font-size:11.5px;line-height:17px}
.tpc-root[data-variant='dialog'] .tps-card > .tpc-toast{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);z-index:6;box-sizing:border-box;max-width:min(560px,calc(100% - 64px));margin:0;padding:8px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);font-size:12.5px;line-height:18px;text-align:center;pointer-events:none}
.tpc-toast[data-tone='ok']{color:var(--dsw-alias-state-success-primary)}
.tpc-toast[data-tone='error']{color:var(--dsw-alias-state-error-primary)}
.tpc-empty{padding:28px 14px;text-align:center;font-size:12.5px;color:var(--dsw-alias-label-tertiary)}
.tpc-skeleton{padding:28px 14px;text-align:center;font-size:12.5px;color:var(--dsw-alias-label-tertiary)}
@media (max-width:1000px){.tpc-surface{grid-template-columns:160px minmax(0,42%) minmax(0,1fr)}}
@media (prefers-reduced-motion: reduce){.tpc-row,.tpc-btn{transition:none}}`

let cssInjected = false
function injectCss(): void {
  if (cssInjected || typeof document === 'undefined') return
  cssInjected = true
  if (document.querySelector('style[data-plugin-css="tool-plus-commands"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@xiaoso/dsh-tool-plus'
  tag.dataset.pluginCss = 'tool-plus-commands'
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/** Interpolate the `{name}` placeholders the locale bundles use. */
function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole))
}

/** Badge label for a row: origin, not the effective state. */
function originLabel(t: Translate, origin: CommandEntryValue['origin']): string {
  return t(origin === 'custom' ? 'cmdGroupCustom' : origin === 'new' ? 'cmdGroupNew' : origin === 'omp' ? 'cmdGroupOmp' : origin === 'bash' ? 'cmdGroupBash' : origin === 'fn' ? 'cmdGroupFn' : 'cmdGroupSys')
}

/** Effective-state label shown in the detail. */
function activeLabel(t: Translate, entry: CommandEntryValue): string {
  return t(
    entry.active === 'custom' ? 'cmdActiveCustom'
      : entry.active === 'system' ? 'cmdActiveSystem'
        : entry.active === 'function' ? 'cmdActiveFunction'
          : entry.active === 'path' ? 'cmdActivePath'
            : 'cmdActiveBuiltin',
  )
}

/** Where this row is implemented, shown under the name. */
function implPathOf(entry: CommandEntryValue): string {
  if (entry.origin === 'new') return 'vendor/oh-my-pi/overlay/crates/pi-builtins/src/shellcmds/'
  if (entry.origin === 'omp') return 'vendor/oh-my-pi/upstream/crates/pi-builtins/src/factory.rs'
  if (entry.origin === 'bash') return 'vendor/oh-my-pi/upstream/crates/vendor/brush-core/src/builtins'
  if (entry.origin === 'custom') return entry.customPath ?? ''
  if (entry.origin === 'fn') return '~/.bashrc'
  return entry.systemPath ?? 'PATH'
}

/** Which source answers for this command right now, as the segment models it. */
function modeOf(entry: CommandEntryValue): 'builtin' | 'system' | 'custom' {
  if (entry.active === 'custom') return 'custom'
  if (entry.active === 'system' || entry.active === 'path') return 'system'
  return 'builtin'
}

/** One-line provenance for the detail header; the full path lives in the kv rows. */
function shortPathOf(entry: CommandEntryValue): string {
  if (entry.origin === 'custom') return entry.customPath ?? ''
  if (entry.origin === 'sys') return entry.systemPath ?? 'PATH'
  if (entry.origin === 'fn') return '~/.bashrc'
  if (entry.origin === 'new') return 'overlay/crates/pi-builtins/src/shellcmds/'
  if (entry.origin === 'omp') return 'upstream/crates/pi-builtins/src/factory.rs'
  return 'upstream/crates/vendor/brush-core/src/builtins'
}

/**
 * Render the command panel.
 * @param props.t - locale lookup.
 * @param props.writable - whether this deployment can save (no profile editor → read-only).
 */
export function CommandPanel(props: { t: Translate; writable: boolean; variant?: 'inline' | 'dialog' }): ReactNode {
  const { t, writable, variant = 'inline' } = props
  injectCss()

  const [catalog, setCatalog] = useState<CommandListValue | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('builtin')
  const [selected, setSelected] = useState<string | null>(null)
  const [mode, setMode] = useState<'builtin' | 'system' | 'custom'>('builtin')
  const [customPath, setCustomPath] = useState('')
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [probeLines, setProbeLines] = useState<string[] | null>(null)
  const [probing, setProbing] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [addName, setAddName] = useState('')
  const [addPath, setAddPath] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [removeConfirm, setRemoveConfirm] = useState(false)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(420)
  const listRef = useRef<HTMLDivElement | null>(null)
  const addNameRef = useRef<HTMLInputElement | null>(null)
  /** Keep the just-added confirmation through the selection change it causes. */
  const keepToast = useRef(false)

  // A success confirmation is transient and must never block the panel: the
  // pill floats above the content and clears itself. Errors stay put until
  // the next action so they cannot be missed.
  useEffect(() => {
    if (toast === null || toast.tone !== 'ok') return
    const timer = window.setTimeout(() => setToast(null), 2400)
    return () => window.clearTimeout(timer)
  }, [toast])

  const scan = useCallback(async (refresh: boolean): Promise<void> => {
    setScanning(true)
    setLoadError(null)
    try {
      const rpc = createWebConnectionRpc()
      const result = await rpc.call(TOOL_PLUS_RPC_CHANNEL, COMMAND_LIST_ENDPOINT, refresh ? { refresh: true } : {})
      if (!result.ok) {
        setLoadError(result.error.message)
        return
      }
      const value = result.value as CommandListValue
      setCatalog(value)
      setSelected(current => {
        if (current !== null && value.entries.some(entry => entry.name === current)) return current
        return value.entries[0]?.name ?? null
      })
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setScanning(false)
    }
  }, [])

  useEffect(() => {
    void scan(false)
  }, [scan])

  useEffect(() => {
    if (addOpen) addNameRef.current?.focus()
  }, [addOpen])

  useEffect(() => {
    const node = listRef.current
    if (node === null) return
    const observer = new ResizeObserver(() => setViewport(node.clientHeight))
    observer.observe(node)
    setViewport(node.clientHeight)
    return () => observer.disconnect()
  }, [])

  const entries = catalog?.entries ?? []
  const counts = catalog?.counts

  const originCounts = useMemo(() => {
    const out: Record<CommandEntryValue['origin'], number> = { custom: 0, new: 0, omp: 0, bash: 0, fn: 0, sys: 0 }
    for (const entry of entries) out[entry.origin] += 1
    return out
  }, [entries])

  const conflictCount = useMemo(() => entries.filter(entry => entry.systemPath !== undefined).length, [entries])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return entries.filter(entry => {
      if (filter === 'builtin' && entry.origin !== 'new' && entry.origin !== 'omp' && entry.origin !== 'bash') return false
      if (filter === 'conflict' && entry.systemPath === undefined) return false
      if (filter !== 'all' && filter !== 'builtin' && filter !== 'conflict' && entry.origin !== filter) return false
      if (needle.length === 0) return true
      return entry.name.toLowerCase().includes(needle)
    })
  }, [entries, filter, q])

  // Keep the detail in sync with what the list shows: a filter or query that
  // hides the current row would otherwise leave an invisible selection.
  useEffect(() => {
    if (filtered.length === 0) {
      setSelected(null)
      return
    }
    if (selected !== null && filtered.some(entry => entry.name === selected)) return
    setSelected(filtered[0].name)
  }, [filtered, selected])

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const group of GROUP_ORDER) {
      const items = filtered.filter(entry => entry.origin === group.origin)
      if (items.length === 0) continue
      out.push({ kind: 'group', key: group.origin, label: t(group.label), count: items.length })
      for (const entry of items) out.push({ kind: 'item', entry })
    }
    return out
  }, [filtered, t])

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 8)
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewport) / ROW_H) + 8)
  const window_ = rows.slice(start, end)

  const selectedEntry = entries.find(entry => entry.name === selected) ?? null

  const lastSelected = useRef<string | null>(null)
  useEffect(() => {
    if (selectedEntry === null) return
    // A rescan after saving replaces the entries array under the same name: the
    // per-command draft must follow that fresh state, otherwise "恢复默认"
    // leaves the segment on the old choice and 保存 stays lit for nothing.
    // Only the transient bits (probe, confirm, toast) are keyed to the name.
    if (lastSelected.current !== selectedEntry.name) {
      lastSelected.current = selectedEntry.name
      setProbeLines(null)
      setRemoveConfirm(false)
      if (keepToast.current) keepToast.current = false
      else setToast(null)
    }
    setMode(modeOf(selectedEntry))
    setCustomPath(selectedEntry.customPath ?? '')
  }, [selectedEntry])

  const apply = useCallback(async (name: string, nextMode: 'builtin' | 'system' | 'custom', path?: string): Promise<boolean> => {
    setSaving(true)
    setToast(null)
    try {
      const rpc = createWebConnectionRpc()
      const result = await rpc.call(TOOL_PLUS_RPC_CHANNEL, COMMAND_APPLY_ENDPOINT, {
        name,
        mode: nextMode,
        ...(path === undefined ? {} : { path }),
      })
      if (!result.ok) {
        setToast({ tone: 'error', text: fill(t('cmdSaveFailed'), { reason: result.error.message }) })
        return false
      }
      const value = result.value as CommandApplyValue
      if (!value.ok) {
        setToast({ tone: 'error', text: fill(t('cmdSaveFailed'), { reason: value.message ?? '' }) })
        return false
      }
      // Nothing was written: no rescan, no confirmation. Re-probing 1337
      // commands for a click that changes nothing is the bug this guards.
      if (value.changed === false) return true
      await scan(true)
      setToast({ tone: 'ok', text: t('cmdSaved') })
      return true
    } catch (error) {
      setToast({ tone: 'error', text: fill(t('cmdSaveFailed'), { reason: error instanceof Error ? error.message : String(error) }) })
      return false
    } finally {
      setSaving(false)
    }
  }, [scan, t])

  const runProbe = useCallback(async (): Promise<void> => {
    if (selected === null) return
    setProbing(true)
    setProbeLines(null)
    try {
      const rpc = createWebConnectionRpc()
      const result = await rpc.call(TOOL_PLUS_RPC_CHANNEL, COMMAND_PROBE_ENDPOINT, { name: selected })
      if (!result.ok) {
        setProbeLines([fill(t('cmdSaveFailed'), { reason: result.error.message })])
        return
      }
      setProbeLines((result.value as CommandProbeValue).lines)
    } catch (error) {
      setProbeLines([error instanceof Error ? error.message : String(error)])
    } finally {
      setProbing(false)
    }
  }, [selected, t])

  const openAdd = useCallback((): void => {
    setAddName('')
    setAddPath('')
    setAddError(null)
    setAddOpen(true)
  }, [])

  const cancelAdd = useCallback((): void => {
    setAddOpen(false)
    setAddError(null)
  }, [])

  const addCustom = useCallback(async (): Promise<void> => {
    const name = addName.trim()
    const path = addPath.trim()
    if (name.length === 0 || path.length === 0) {
      setAddError(t('cmdAddRequired'))
      return
    }
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) {
      setAddError(t('cmdAddInvalidName'))
      return
    }
    if (entries.some(entry => entry.name === name)) {
      setAddError(t('cmdAddDuplicate'))
      return
    }
    const ok = await apply(name, 'custom', path)
    if (!ok) return
    setAddOpen(false)
    setAddError(null)
    setAddName('')
    setAddPath('')
    setFilter('all')
    setQ('')
    keepToast.current = true
    setSelected(name)
    setToast({ tone: 'ok', text: fill(t('cmdAdded'), { name }) })
  }, [addName, addPath, apply, entries, t])

  const removeCustom = useCallback(async (name: string): Promise<void> => {
    const ok = await apply(name, 'builtin')
    if (!ok) return
    setRemoveConfirm(false)
    keepToast.current = true
    setToast({ tone: 'ok', text: fill(t('cmdRemoved'), { name }) })
  }, [apply, t])

  const railGroups: { title: string; items: { key: Filter; label: string; count: number }[] }[] = [
    {
      title: t('cmdRailFilter'),
      items: [
        { key: 'builtin', label: t('cmdFilterBuiltin'), count: counts?.builtin ?? 0 },
        { key: 'conflict', label: t('cmdFilterConflict'), count: conflictCount },
        { key: 'all', label: t('cmdFilterAll'), count: counts?.total ?? 0 },
      ],
    },
    {
      title: t('cmdRailOrigin'),
      items: GROUP_ORDER.map(group => ({ key: group.origin, label: t(group.label), count: originCounts[group.origin] })),
    },
  ]

  const nextLabel = selectedEntry === null ? ''
    : mode === 'custom' ? (customPath.trim().length > 0 ? customPath.trim() : t('cmdModeCustom'))
      : mode === 'system' ? (selectedEntry.systemPath ?? t('cmdModeSystem'))
        : t('cmdModeBuiltin')
  const currentMode: 'builtin' | 'system' | 'custom' = selectedEntry === null ? 'builtin' : modeOf(selectedEntry)
  const dirty = selectedEntry !== null
    && (mode !== currentMode || (mode === 'custom' && customPath.trim() !== (selectedEntry.customPath ?? '')))

  return (
    <section className="tps-group tpc-root" data-variant={variant}>
      {variant === 'inline' ? <h4 className="tps-groupTitle">{t('cmdTitle')}</h4> : null}
      <div className="tps-card" style={variant === 'inline' ? { paddingTop: 12, paddingBottom: 12, gap: 8 } : undefined}>
        {variant === 'inline' ? <p className="tpc-note">{t('cmdIntro')}</p> : null}
        {toast !== null ? <p className="tpc-toast" data-tone={toast.tone} role="status" aria-live="polite">{toast.text}</p> : null}

        <div className="tpc-surface">
          <div className="tpc-railCol" role="group" aria-label={t('cmdRailFilter')}>
            {railGroups.map(group => (
              <div className="tpc-railGroup" key={group.title}>
                <span className="tpc-railTitle">{group.title}</span>
                {group.items.map(item => (
                  <button
                    key={item.key}
                    type="button"
                    className="tpc-railBtn"
                    aria-pressed={filter === item.key}
                    onClick={() => setFilter(item.key)}
                  >
                    {item.label}<em>{item.count}</em>
                  </button>
                ))}
              </div>
            ))}
            <div className="tpc-railFoot">
              {catalog === null && loadError === null ? t('cmdLoading')
                : catalog !== null ? fill(t('cmdScanMeta'), { count: catalog.counts.total, ms: catalog.scanMs })
                  : fill(t('cmdFailed'), { reason: loadError ?? '' })}
            </div>
          </div>
          <div className="tpc-listCol">
            <div className="tpc-listHead">
              <input
                className="tpc-search"
                value={q}
                placeholder={t('cmdSearchShort')}
                spellCheck={false}
                onChange={event => setQ(event.target.value)}
                aria-label={t('cmdSearch')}
              />
              <button type="button" className="tpc-btn" disabled={scanning} onClick={() => { void scan(true) }}>
                {scanning ? t('cmdScanningShort') : t('cmdScanShort')}
              </button>
            </div>
            <button type="button" className="tpc-addRow" disabled={!writable} onClick={openAdd}>{t('cmdAdd')}</button>
            <div
              className="tpc-list"
              ref={listRef}
              onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
              role="listbox"
              aria-label={t('cmdTitle')}
            >
              {catalog === null && loadError === null
                ? <div className="tpc-skeleton">{t('cmdLoading')}</div>
                : rows.length === 0
                  ? <div className="tpc-empty">{t('cmdEmpty')}</div>
                  : (
                    <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
                      {window_.map((row, index) => {
                        const top = (start + index) * ROW_H
                        if (row.kind === 'group') {
                          return (
                            <div key={'g-' + row.key} className="tpc-group" style={{ position: 'absolute', top, left: 0, right: 0, height: ROW_H }}>
                              {row.label}<em>{row.count}</em>
                            </div>
                          )
                        }
                        const entry = row.entry
                        return (
                          <div
                            key={entry.name}
                            className="tpc-row"
                            role="option"
                            aria-selected={!addOpen && entry.name === selected}
                            data-selected={!addOpen && entry.name === selected}
                            style={{ position: 'absolute', top, left: 0, right: 0, height: ROW_H }}
                            onClick={() => { setAddOpen(false); setAddError(null); setSelected(entry.name) }}
                          >
                            <span className="tpc-rowName">{entry.name}</span>
                            <span className="tpc-badge" data-origin={entry.origin}>{originLabel(t, entry.origin)}</span>
                          </div>
                        )
                      })}
                    </div>
                  )}
            </div>
          </div>

          <div className="tpc-detailCol">
            {addOpen
              ? (
                <>
                  <div className="tpc-detailHead">
                    <div className="tpc-who">
                      <h5 className="tpc-name">{t('cmdAddTitle')}</h5>
                      <p className="tpc-path">{t('cmdAddIntro')}</p>
                    </div>
                    <div className="tpc-headActions">
                      <button type="button" className="tpc-btn" disabled={saving} onClick={cancelAdd}>{t('cmdAddCancel')}</button>
                      <button type="button" className="tpc-btn tpc-btnPrimary" disabled={!writable || saving} onClick={() => { void addCustom() }}>{saving ? t('cmdSaving') : t('cmdAddSubmit')}</button>
                    </div>
                  </div>
                  <div className="tpc-detailScroll">
                    <label className="tpc-formField">
                      <span className="tpc-formLabel">{t('cmdAddName')}</span>
                      <input
                        ref={addNameRef}
                        className="tpc-input"
                        value={addName}
                        spellCheck={false}
                        placeholder="z7"
                        onChange={event => { setAddName(event.target.value); setAddError(null) }}
                      />
                      <span className="tpc-formHint">{t('cmdAddNameHint')}</span>
                    </label>

                    <label className="tpc-formField">
                      <span className="tpc-formLabel">{t('cmdAddPath')}</span>
                      <input
                        className="tpc-input"
                        value={addPath}
                        spellCheck={false}
                        placeholder="D:/tools/7z.exe"
                        onChange={event => { setAddPath(event.target.value); setAddError(null) }}
                      />
                      <span className="tpc-formHint">{t('cmdPathHint')}</span>
                    </label>

                    {addError !== null ? <p className="tpc-toast" data-tone="error">{addError}</p> : null}

                    <div className="tpc-impact">
                      <span className="tpc-impactTitle">{t('cmdImpact')}</span>
                      <span className="tpc-impactRow"><i>{t('cmdImpactNow')}</i>{t('cmdAddNoCommand')}</span>
                      <span className="tpc-impactRow">
                        <i>{t('cmdImpactAfter')}</i>
                        <b>{addName.trim().length > 0 ? addName.trim() : '...'} → {addPath.trim().length > 0 ? addPath.trim() : '...'}</b>
                      </span>
                      <span className="tpc-formHint">{t('cmdImpactHint')}</span>
                    </div>

                    <ul className="tpc-addNotes">
                      <li>{t('cmdAddNoteWhere')}</li>
                      <li>{t('cmdAddNoteWhen')}</li>
                      <li>{t('cmdAddNoteArgs')}</li>
                    </ul>
                  </div>
                </>
              )
              : selectedEntry === null
                ? <div className="tpc-empty">{t('cmdEmpty')}</div>
                : (
                  <>
                    <div className="tpc-detailHead">
                      <div className="tpc-who">
                        <h5 className="tpc-name">{selectedEntry.name}</h5>
                        <p className="tpc-path">{shortPathOf(selectedEntry)}</p>
                        <div className="tpc-badges">
                          <span className="tpc-badge" data-origin={selectedEntry.origin}>{originLabel(t, selectedEntry.origin)}</span>
                          <span className="tpc-badge">{t('cmdCurrent')} {activeLabel(t, selectedEntry)}</span>
                        </div>
                      </div>
                      <div className="tpc-headActions">
                        {removeConfirm
                          ? null
                          : (
                            <>
                              <button
                                type="button"
                                className={'tpc-btn' + (dirty ? ' tpc-btnPrimary' : '')}
                                disabled={!writable || saving || !dirty || (mode === 'custom' && customPath.trim().length === 0) || (mode === 'system' && selectedEntry.systemPath === undefined)}
                                onClick={() => { void apply(selectedEntry.name, mode, mode === 'custom' ? customPath.trim() : undefined) }}
                              >
                                {saving ? t('cmdSaving') : t('cmdSave')}
                              </button>
                              {selectedEntry.origin === 'custom'
                                ? <button type="button" className="tpc-btn tpc-btnDanger" disabled={!writable || saving} onClick={() => setRemoveConfirm(true)}>{t('cmdRemove')}</button>
                                : selectedEntry.active === 'builtin'
                                  ? null
                                  : <button type="button" className="tpc-btn" disabled={!writable || saving} onClick={() => { void apply(selectedEntry.name, 'builtin') }}>{t('cmdReset')}</button>}
                              <button type="button" className="tpc-btn" disabled={probing} onClick={() => { void runProbe() }}>{probing ? t('cmdProbing') : t('cmdProbe')}</button>
                            </>
                          )}
                      </div>
                    </div>
                    {removeConfirm
                      ? (
                        <div className="tpc-confirmBar">
                          <span>{fill(t('cmdRemoveHint'), { name: selectedEntry.name })}</span>
                          <button type="button" className="tpc-btn tpc-btnDanger" disabled={!writable || saving} onClick={() => { void removeCustom(selectedEntry.name) }}>{fill(t('cmdRemoveConfirm'), { name: selectedEntry.name })}</button>
                          <button type="button" className="tpc-btn" disabled={saving} onClick={() => setRemoveConfirm(false)}>{t('cmdAddCancel')}</button>
                        </div>
                      )
                      : null}
                    <div className="tpc-detailScroll">
                      <div className="tpc-field">
                        <span className="tpc-fieldLabel">{t('cmdUse')}</span>
                        <div className="tpc-seg" role="group" aria-label={t('cmdUse')}>
                          {selectedEntry.origin === 'custom' ? null : <button type="button" className="tpc-segBtn" aria-pressed={mode === 'builtin'} disabled={!writable || saving} onClick={() => setMode('builtin')}>{t('cmdModeBuiltin')}</button>}
                          <button type="button" className="tpc-segBtn" aria-pressed={mode === 'system'} disabled={!writable || saving || selectedEntry.systemPath === undefined} onClick={() => setMode('system')}>{t('cmdModeSystem')}</button>
                          <button type="button" className="tpc-segBtn" aria-pressed={mode === 'custom'} disabled={!writable || saving} onClick={() => setMode('custom')}>{t('cmdModeCustom')}</button>
                        </div>
                        {selectedEntry.origin === 'custom' ? <p className="tpc-note">{t('cmdCustomNoBuiltin')}</p> : null}
                      </div>

                      {mode === 'custom'
                        ? (
                          <div className="tpc-field">
                            <span className="tpc-fieldLabel">{t('cmdPathLabel')}</span>
                            <input className="tpc-input" value={customPath} spellCheck={false} placeholder="D:/tools/zip.exe" onChange={event => setCustomPath(event.target.value)} />
                            <span className="tpc-formHint">{t('cmdPathHint')}</span>
                          </div>
                        )
                        : null}
                      {mode === 'system' && selectedEntry.systemPath === undefined
                        ? <p className="tpc-note">{t('cmdNoSystemTwin')}</p>
                        : null}

                      <div className="tpc-impact">
                        <span className="tpc-impactTitle">{t('cmdImpact')}</span>
                        <span className="tpc-impactRow"><i>{t('cmdImpactNow')}</i>{activeLabel(t, selectedEntry)}</span>
                        <span className="tpc-impactRow">
                          <i>{t('cmdImpactAfter')}</i>
                          <b>{nextLabel}</b>
                          {dirty ? null : <em>{t('cmdImpactSame')}</em>}
                        </span>
                        <span className="tpc-formHint">{t('cmdImpactHint')}</span>
                      </div>

                      <dl className="tpc-kv">
                        <dt>{t('cmdImpl')}</dt>
                        <dd>{implPathOf(selectedEntry)}</dd>
                        <dt>{t('cmdSource')}</dt>
                        <dd>{originLabel(t, selectedEntry.origin)}</dd>
                        <dt>{t('cmdShadow')}</dt>
                        <dd>{selectedEntry.systemPath === undefined ? t('cmdNoShadow') : fill(t('cmdShadowAt'), { path: selectedEntry.systemPath })}</dd>
                        <dt>{t('cmdActive')}</dt>
                        <dd>{activeLabel(t, selectedEntry)}</dd>
                      </dl>
                      <pre className="tpc-console">{probeLines === null ? t('cmdProbeEmpty') : probeLines.join('\n')}</pre>
                    </div>
                  </>
                )}
          </div>
        </div>
      </div>
    </section>
  )
}
