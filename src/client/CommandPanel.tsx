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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
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
import { ClippedText } from './tooltip.tsx'
import { installFocusModality, useInert } from './rows.tsx'

/** Locale lookup the section passes down. */
type Translate = (key: BashPlusLocaleKey) => string

/** Row height of the virtual list; group headers use the same stride. */
const ROW_H = 34

/** What a command does when the user has not overridden it. */
function defaultActiveOf(entry: CommandEntryValue): CommandEntryValue['active'] {
  if (entry.origin === 'custom') return 'custom'
  if (entry.origin === 'sys') return 'system'
  if (entry.origin === 'fn') return 'function'
  return 'builtin'
}

/** Whether this command runs the way its origin implies, or was pointed elsewhere. */
function overridden(entry: CommandEntryValue): boolean {
  return entry.active !== defaultActiveOf(entry) || entry.customPath !== undefined
}

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

/**
 * 高度未知的折叠容器：外层跑 grid-template-rows，内层 overflow:hidden 让内容跟着
 * 收；收起时整棵子树 `inert`，Tab 与读屏都进不去。
 */
function Collapse(props: { open: boolean; children: ReactNode }): ReactNode {
  const { open, children } = props
  const ref = useRef<HTMLDivElement | null>(null)
  useInert(ref, !open)
  return (
    <div ref={ref} className="tpc-collapse" data-open={open ? 'true' : 'false'} aria-hidden={open ? undefined : true}>
      <div className="tpc-collapseInner">{children}</div>
    </div>
  )
}

/** 用户是否要求跳过非必要动效。 */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** One rendered line of the list: a group heading or a command row. */
type Row = { kind: 'group'; key: string; label: string; count: number } | { kind: 'item'; entry: CommandEntryValue }

// 字号变量要同时挂在浮层和内容根上：`.tpc-dialog` 与 `.tpc-root` 是兄弟节点，
// 只写在 `.tpc-root` 上时标题栏取不到值，会回落到继承的 16px。
const CSS = `.tpc-overlay,.tpc-root{--tpc-fs-lg:15px;--tpc-fs-md:13px;--tpc-fs-sm:12px;--tpc-fs-xs:11px}
.tpc-root{--tpc-ink-accent:color-mix(in srgb,var(--dsw-alias-state-business-primary) 62%,var(--dsw-alias-label-primary));display:flex;flex-direction:column;gap:0;min-height:0}
/* 进出场用 transition 而不是 keyframes：动画中途被打断时，transition 从当前
   计算值继续，而只有 to 的关键帧会跳回基础值（0.72 的不透明度会一帧跳到 1）。
   透明度只由遮罩负责，对话框只动 transform，避免两层各乘一次。 */
.tpc-overlay{position:fixed;inset:0;z-index:1300;display:flex;align-items:center;justify-content:center;padding:28px;background:var(--dsw-alias-bg-mask-3);opacity:1;transition:opacity .16s ease}
.tpc-dialog{position:relative;box-sizing:border-box;display:flex;flex-direction:column;gap:0;width:min(1120px,96vw);height:min(760px,88vh);padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;transition:transform .24s cubic-bezier(.22,1,.36,1)}
.tpc-overlay[data-opening='true'],.tpc-overlay[data-closing='true']{opacity:0;pointer-events:none}
.tpc-overlay[data-opening='true'] .tpc-dialog{transform:translateY(8px)}
.tpc-overlay[data-closing='true'] .tpc-dialog{transform:translateY(4px);transition-duration:.15s}
/* 详情换对象时的一次轻推：只碰 opacity 与 4px 位移，不动硬件布局。 */
@keyframes tpc-detail-in{from{opacity:0;transform:translateY(4px)}}
.tpc-detailBody{display:flex;flex:1 1 auto;flex-direction:column;min-height:0;animation:tpc-detail-in .16s cubic-bezier(.22,1,.36,1)}
/* 高度未知的折叠：grid-template-rows 0fr→1fr 是这里唯一改布局的手段，
   内层 overflow:hidden 让内容跟着收；关闭时该子树同时 inert。 */
.tpc-collapse{display:grid;grid-template-rows:0fr;transition:grid-template-rows .16s ease}
.tpc-collapse[data-open='true']{grid-template-rows:1fr}
/* 折叠态还占着 flex 的一个 gap，用负 margin 抵掉，收起来时不多出 12px 空隙。 */
.tpc-collapse[data-open='false']{margin-bottom:-12px}
.tpc-collapseInner{min-height:0;overflow:hidden}
/* 空态在详情列里居中，不要贴在列顶留一大片空。 */
.tpc-detailCol > .tpc-empty{flex:1;justify-content:center}
@keyframes tpc-toast-in{from{opacity:0;transform:translateY(4px)}}
/* 换筛选时列表整块换内容：淡入比瞬换自然，也不动任何行的位置。 */
@keyframes tpc-rows-in{from{opacity:.55}}
.tpc-rows{animation:tpc-rows-in .14s ease}
/* 移除确认条、试跑输出、空态：都是"出现"，用同一段 140ms 轻推。 */
.tpc-confirmBar{animation:tpc-detail-in .14s ease}
.tpc-console{animation:tpc-detail-in .16s ease}
.tpc-list .tpc-empty,.tpc-detailCol > .tpc-empty{animation:tpc-detail-in .14s ease}
.tpc-dialogHead{display:flex;align-items:center;gap:12px;flex:none;box-sizing:border-box;min-height:56px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.tpc-dialogTitle{margin:0;font-size:var(--tpc-fs-lg);font-weight:600;line-height:23px;color:var(--dsw-alias-label-primary)}
.tpc-dialogHead .tpc-btn{margin-left:auto}
.tpc-dialogHead .tpc-confirmText{margin-left:auto;font-size:var(--tpc-fs-sm);line-height:18px;color:var(--dsw-alias-label-secondary)}
.tpc-dialogHead .tpc-confirmText ~ .tpc-btn{margin-left:0}
.tpc-btnDanger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--dsw-alias-border-l3))}
.tpc-btnDanger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.tpc-root[data-variant='dialog']{flex:1;min-height:0}
.tpc-root[data-variant='dialog'] .tps-card{flex:1;min-height:0;overflow:hidden;padding:0;gap:0;border:0;border-radius:0;background:none}
.tpc-surface{flex:1;min-height:0;display:grid;grid-template-columns:176px 300px minmax(0,1fr);overflow:hidden}
.tpc-railCol{display:flex;flex-direction:column;gap:4px;min-height:0;padding:10px 8px;border-right:1px solid var(--dsw-alias-border-l2);overflow-y:auto}
.tpc-railGroup{display:flex;flex-direction:column;gap:2px}
.tpc-railGroup + .tpc-railGroup{margin-top:6px}
.tpc-railTitle{padding:4px 10px 2px;font-size:var(--tpc-fs-xs);line-height:16px;color:var(--dsw-alias-label-secondary)}
.tpc-railBtn{appearance:none;display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid transparent;border-radius:9px;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--tpc-fs-md);line-height:18px;text-align:left;cursor:pointer}
.tpc-railBtn{transition:background-color .12s ease,color .12s ease}
.tpc-railBtn:hover{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 14%,transparent);color:var(--dsw-alias-label-primary)}
.tpc-railBtn:active{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 20%,transparent)}
.tpc-railBtn[aria-pressed='true']{background:var(--dsw-alias-state-business-tertiary);color:var(--tpc-ink-accent)}
.tpc-railBtn em{min-width:3ch;margin-left:auto;font-style:normal;font-size:var(--tpc-fs-xs);text-align:right;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.tpc-railBtn[aria-pressed='true'] em{color:inherit}
.tpc-railFoot{margin-top:auto;padding:8px 10px 2px;font-size:var(--tpc-fs-xs);line-height:16px;color:var(--dsw-alias-label-secondary)}
.tpc-listCol{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l2)}
.tpc-listHead{flex:none;display:flex;align-items:center;gap:6px;padding:10px 12px}
.tpc-listHead .tpc-search{flex:1;min-width:0}
.tpc-listHead .tpc-btn{padding:0 10px}
.tpc-search{height:32px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l3);border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 2%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--tpc-fs-md);padding:0 11px}
.tpc-search:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
/* 鼠标点进来的文本框不画焦点环（文本框永远算 focus-visible，见 rows.tsx）。 */
html[data-tp-pointer] .tpc-search:focus-visible{outline:none}
.tpc-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;height:32px;border:1px solid var(--dsw-alias-border-l3);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--tpc-fs-sm);line-height:1;padding:0 12px;cursor:pointer;white-space:nowrap;transition:background-color .12s ease,color .12s ease,border-color .12s ease,transform .1s ease}
.tpc-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l4)}
.tpc-btn:active:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 14%,transparent);transform:scale(.98)}
.tpc-btn:disabled{opacity:.4;cursor:default}
.tpc-btnPrimary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-inverted)}
.tpc-btnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-label-primary-inverted)}
.tpc-btnDanger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,var(--dsw-alias-border-l2))}
.tpc-btnDanger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}
.tpc-addRow{appearance:none;display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;padding:9px 12px;border:0;border-bottom:1px solid var(--dsw-alias-border-l2);background:none;color:var(--tpc-ink-accent);font:inherit;font-size:var(--tpc-fs-md);line-height:18px;text-align:left;cursor:pointer;transition:background-color .12s ease}
.tpc-addRow:hover:not(:disabled){background:var(--dsw-alias-state-business-tertiary)}
.tpc-addRow:active:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent)}
.tpc-addRow:disabled{opacity:.4;cursor:default}
.tpc-list{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.tpc-row{display:flex;align-items:center;gap:9px;padding:0 12px;box-sizing:border-box;cursor:pointer;font-size:var(--tpc-fs-md);line-height:18px;color:var(--dsw-alias-label-primary)}
/* 行高亮跟手一点：滚动时指针压着行，120ms 的渐变会明显慢半拍。 */
.tpc-row{transition:background-color .08s ease}
.tpc-row:hover{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 14%,transparent)}
.tpc-row:active{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,transparent)}
.tpc-row[data-selected='true']{background:var(--dsw-alias-state-business-tertiary)}
.tpc-row[data-selected='true'] .tpc-rowName{color:var(--tpc-ink-accent)}
.tpc-ovdot{flex:none;box-sizing:border-box;width:5px;height:5px;border-radius:50%;background:var(--tpc-ink-accent)}
.tpc-rowName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:var(--tpc-fs-sm)}
.tpc-group{display:flex;align-items:center;gap:8px;padding:0 12px;box-sizing:border-box;font-size:var(--tpc-fs-xs);line-height:34px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l2)}
.tpc-group em{margin-left:auto;font-style:normal;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.tpc-badge{flex:none;border-radius:999px;padding:0 7px;font-size:var(--tpc-fs-xs);line-height:17px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.tpc-badge[data-origin='new']{color:var(--tpc-ink-accent);border-color:color-mix(in srgb,var(--tpc-ink-accent) 35%,var(--dsw-alias-border-l2))}
.tpc-badge[data-origin='custom']{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 35%,var(--dsw-alias-border-l2))}
.tpc-badge[data-origin='fn']{border-style:dashed}
.tpc-detailCol{position:relative;display:flex;flex-direction:column;min-height:0}
.tpc-detailHead{flex:none;display:flex;align-items:flex-start;gap:12px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.tpc-who{flex:1 1 auto;min-width:0}
.tpc-name{margin:0;font-size:var(--tpc-fs-lg);font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}
.tpc-detailHead .tpc-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:var(--tpc-fs-lg);line-height:22px;letter-spacing:-.01em}
.tpc-path{display:block;min-width:0;margin:1px 0 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--tpc-fs-xs);line-height:16px;color:var(--dsw-alias-label-secondary)}
.tpc-badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}
.tpc-headActions{flex:none;display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}
.tpc-headActions .tpc-btn{min-width:76px}
.tpc-confirmBar{position:absolute;left:12px;right:12px;bottom:12px;z-index:5;display:flex;align-items:center;gap:8px;flex-wrap:wrap;box-sizing:border-box;padding:10px 12px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,var(--dsw-alias-border-l2));border-radius:10px;background:var(--dsw-alias-bg-layer-1);font-size:var(--tpc-fs-sm);line-height:18px;color:var(--dsw-alias-label-secondary)}
.tpc-detailScroll{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding:14px 16px}
.tpc-field{display:flex;flex-direction:column;gap:6px}
.tpc-fieldLabel{font-size:var(--tpc-fs-xs);color:var(--dsw-alias-label-secondary)}
/* 三个互斥选项用一组药丸，宽度贴合文字：拉满整行会看成表格行，不像控件。 */
.tpc-seg{display:flex;flex-wrap:wrap;align-self:flex-start;gap:8px}
.tpc-segBtn{flex:1 1 0;display:inline-flex;align-items:center;justify-content:center;appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--tpc-fs-sm);padding:0 8px;cursor:pointer;white-space:nowrap;transition:background-color .12s ease,color .12s ease}
.tpc-segBtn{appearance:none;display:inline-flex;align-items:center;border:0;border-radius:999px;padding:6px 14px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--tpc-fs-sm);line-height:18px;cursor:pointer;white-space:nowrap;transition:background-color .12s ease,color .12s ease}
.tpc-segBtn:hover:not(:disabled):not([aria-pressed='true']){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.tpc-segBtn[aria-pressed='true']{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-label-primary);font-weight:500}
.tpc-segBtn:disabled{opacity:.4;cursor:default}
.tpc-input{box-sizing:border-box;height:32px;border:1px solid var(--dsw-alias-border-l3);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--tpc-fs-sm);padding:0 10px}
.tpc-input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
html[data-tp-pointer] .tpc-input:focus-visible{outline:none}
.tpc-kv{display:grid;grid-template-columns:70px minmax(0,1fr);gap:8px 12px;margin:0;font-size:var(--tpc-fs-sm);line-height:18px}
.tpc-kv dt{color:var(--dsw-alias-label-secondary)}
.tpc-kv dd{margin:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;word-break:break-word}
.tpc-impact{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-layer-1));padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.tpc-impactTitle{font-size:var(--tpc-fs-xs);line-height:17px;color:var(--dsw-alias-label-secondary)}
.tpc-impactRow{display:flex;align-items:center;gap:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:var(--tpc-fs-xs);line-height:17px;color:var(--dsw-alias-label-secondary)}
.tpc-impactRow i{flex:none;width:40px;font-style:normal;font-size:var(--tpc-fs-xs);color:var(--dsw-alias-label-secondary)}
.tpc-impactRow b{font-weight:400;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--tpc-ink-accent)}
.tpc-impactRow em{margin-left:auto;font-style:normal;font-size:var(--tpc-fs-xs);color:var(--dsw-alias-label-secondary)}
.tpc-console{margin:0;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-top-color:color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,var(--dsw-alias-bg-layer-1));padding:10px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:var(--tpc-fs-sm);line-height:1.7;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere;min-height:74px;max-height:180px;overflow-y:auto}
.tpc-detailScroll .tpc-console{flex:none;height:74px;max-height:none}
.tpc-formField{display:flex;flex-direction:column;gap:5px}
.tpc-formLabel{font-size:var(--tpc-fs-sm);color:var(--dsw-alias-label-tertiary)}
.tpc-formHint{font-size:var(--tpc-fs-xs);line-height:17px;color:var(--dsw-alias-label-tertiary)}
.tpc-formField .tpc-input{width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.tpc-addNotes{margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);list-style:none;display:flex;flex-direction:column;gap:5px;font-size:var(--tpc-fs-sm);line-height:19px;color:var(--dsw-alias-label-secondary)}
.tpc-note{margin:0;font-size:var(--tpc-fs-xs);line-height:17px;color:var(--dsw-alias-label-tertiary)}
.tpc-toast{margin:0;font-size:var(--tpc-fs-sm);line-height:17px;animation:tpc-toast-in .16s ease}
.tpc-root[data-variant='dialog'] .tps-card > .tpc-toast{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);z-index:6;box-sizing:border-box;max-width:min(560px,calc(100% - 64px));margin:0;padding:8px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);font-size:var(--tpc-fs-sm);line-height:18px;text-align:center;pointer-events:none}
.tpc-toast[data-tone='ok']{color:var(--dsw-alias-state-success-primary)}
.tpc-toast[data-tone='error']{color:var(--dsw-alias-state-error-primary)}
.tpc-empty{display:flex;flex-direction:column;align-items:center;gap:10px;padding:28px 14px;text-align:center;font-size:var(--tpc-fs-sm);color:var(--dsw-alias-label-secondary)}
.tpc-skeleton{padding:28px 14px;text-align:center;font-size:var(--tpc-fs-sm);color:var(--dsw-alias-label-secondary)}
@media (max-width:1000px){.tpc-surface{grid-template-columns:160px clamp(200px,32vw,300px) minmax(0,1fr)}}
@media (prefers-reduced-motion: reduce){.tpc-overlay,.tpc-dialog,.tpc-collapse,.tpc-detailBody,.tpc-toast,.tpc-rows,.tpc-confirmBar,.tpc-console,.tpc-empty,.tpc-overlay[data-closing='true'],.tpc-dialog[data-closing='true']{animation:none}.tpc-row,.tpc-railBtn,.tpc-segBtn,.tpc-btn,.tpc-addRow,.tpc-overlay,.tpc-dialog,.tpc-collapse{transition:none}
.tpc-btn:active:not(:disabled){transform:none}}`

let cssInjected = false
function injectCss(): void {
  if (cssInjected || typeof document === 'undefined') return
  cssInjected = true
  installFocusModality()
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
 * @param props.onClose - unmount the dialog; only the dialog variant closes itself, and
 *   only through {@link requestClose}, so every exit path shares the unsaved-draft guard.
 */
export function CommandPanel(props: { t: Translate; writable: boolean; variant?: 'inline' | 'dialog'; onClose?: () => void; closing?: boolean }): ReactNode {
  const { t, writable, variant = 'inline', onClose, closing = false } = props
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
  const [closeConfirm, setCloseConfirm] = useState(false)
  /** 关闭按钮与确认条的安全项：替换节点时焦点要有地方去，不能掉到 body 上。 */
  const closeBtnRef = useRef<HTMLButtonElement | null>(null)
  const keepEditingRef = useRef<HTMLButtonElement | null>(null)
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

  // Filtering replaces the row set under a virtual window that keeps its own
  // scroll offset: without this the offset outlives the rows and the selected
  // command sits hundreds of pixels below the fold (82/82 frames off-screen).
  useLayoutEffect(() => {
    const node = listRef.current
    if (node !== null && node.scrollTop !== 0) node.scrollTop = 0
    setScrollTop(0)
  }, [filter, q])

  const emptyText = q.trim().length > 0
    ? fill(t('cmdEmptyQuery'), { q: q.trim() })
    : filter === 'custom' ? t('cmdEmptyCustom')
      : filter === 'conflict' ? t('cmdEmptyConflict')
        : t('cmdEmptyFilter')

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

  // Keep the selected row physically visible: keyboard selection, a fresh scan
  // and a filter change all move the highlight without touching scrollTop.
  useLayoutEffect(() => {
    const node = listRef.current
    if (node === null || selected === null) return
    const index = rows.findIndex(row => row.kind === 'item' && row.entry.name === selected)
    if (index < 0) return
    const top = index * ROW_H
    const bottom = top + ROW_H
    if (top < node.scrollTop) {
      node.scrollTop = top
      setScrollTop(top)
      return
    }
    const visibleBottom = node.scrollTop + node.clientHeight
    if (bottom > visibleBottom) {
      const next = Math.max(0, bottom - node.clientHeight)
      node.scrollTop = next
      setScrollTop(next)
    }
  }, [selected, rows])

  const lastSelected = useRef<string | null>(null)
  // 绘制前回填：放在 useEffect 里时会先画一帧「新命令 + 旧模式」，详情区看得见地
  // 跳一下（实测 1 帧、88px）。
  useLayoutEffect(() => {
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
      setToast({ tone: 'ok', text: nextMode === 'builtin' ? t('cmdResetDone') : t('cmdSaved') })
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

  const onListKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (rows.length === 0) return
    const items = rows.flatMap(row => (row.kind === 'item' ? [row.entry.name] : []))
    if (items.length === 0) return
    const at = selected === null ? -1 : items.indexOf(selected)
    let next: string | null = null
    if (event.key === 'ArrowDown') next = items[Math.min(items.length - 1, at + 1)]
    else if (event.key === 'ArrowUp') next = items[Math.max(0, at - 1)]
    else if (event.key === 'Home') next = items[0]
    else if (event.key === 'End') next = items[items.length - 1]
    else if (event.key === 'Enter' && selected !== null) {
      event.preventDefault()
      void runProbe()
      return
    }
    if (next === null) return
    event.preventDefault()
    setAddOpen(false)
    setAddError(null)
    setSelected(next)
  }, [rows, selected, runProbe])

  // Mirrors the state the 保存 button reads: the segment no longer matches what
  // the host has stored, so leaving now would silently drop the choice.
  const dirty = selectedEntry !== null
    && (mode !== modeOf(selectedEntry) || (mode === 'custom' && customPath.trim() !== (selectedEntry.customPath ?? '')))
  const draftDirty = addOpen && (addName.trim().length > 0 || addPath.trim().length > 0)
  const unsaved = dirty || draftDirty

  // Esc, the 关闭 button and a backdrop click all land here: with an edit in
  // flight the dialog asks first, because the segment and the path field are
  // not persisted until 保存 and there is no draft recovery behind them.
  const requestClose = useCallback((): void => {
    if (unsaved) {
      setCloseConfirm(true)
      return
    }
    onClose?.()
  }, [unsaved, onClose])

  useEffect(() => {
    if (!unsaved && closeConfirm) setCloseConfirm(false)
  }, [unsaved, closeConfirm])

  // The confirm replaces the 关闭 button in place, so the focused node is
  // unmounted the moment the bar appears. Hand focus to the safe choice, and
  // give it back to 关闭 when the bar goes away, otherwise the keyboard is
  // stranded on <body> and Tab escapes into the settings drawer.
  const confirmPrev = useRef(false)
  useEffect(() => {
    if (closeConfirm && !confirmPrev.current) keepEditingRef.current?.focus()
    else if (!closeConfirm && confirmPrev.current) closeBtnRef.current?.focus()
    confirmPrev.current = closeConfirm
  }, [closeConfirm])

  useEffect(() => {
    if (variant !== 'dialog') return
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Capture + stopPropagation: the settings dialog underneath listens for
      // Escape too and would tear down the whole page along with this panel.
      event.stopPropagation()
      event.preventDefault()
      if (closeConfirm) {
        setCloseConfirm(false)
        return
      }
      requestClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [variant, closeConfirm, requestClose])

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

  // 进场走 transition：第一帧必须真的画在初始态，第二帧再放开，否则浏览器会把
  // 「初始态 → 终态」合并成一帧，动画根本不播。减弱动效下直接跳过。
  const [opening, setOpening] = useState(variant === 'dialog' && !prefersReducedMotion())
  useLayoutEffect(() => {
    if (!opening) return
    const frame = requestAnimationFrame(() => { setOpening(false) })
    return () => { cancelAnimationFrame(frame) }
  }, [opening])

  const shell = (
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
                    {item.label}<em>{catalog === null ? '' : item.count}</em>
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
                data-autofocus
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
              onKeyDown={onListKeyDown}
              tabIndex={0}
              role="listbox"
              aria-activedescendant={selected === null ? undefined : 'tpc-opt-' + selected}
              aria-label={t('cmdTitle')}
            >
              {catalog === null && loadError !== null
                ? (
                  <div className="tpc-empty">
                    <span>{fill(t('cmdFailed'), { reason: loadError })}</span>
                    <button type="button" className="tpc-btn" disabled={scanning} onClick={() => { void scan(true) }}>{t('cmdScanShort')}</button>
                  </div>
                )
                : catalog === null
                  ? <div className="tpc-skeleton">{t('cmdLoading')}</div>
                : rows.length === 0
                  ? (
                    <div className="tpc-empty">
                      <span>{emptyText}</span>
                      {q.trim().length > 0
                        ? <button type="button" className="tpc-btn" onClick={() => setQ('')}>{t('cmdEmptyClear')}</button>
                        : null}
                    </div>
                  )
                  : (
                    // key 跟着筛选走：换筛选时这层重挂，播一次淡入；搜索输入不
                    // 动 key，逐字过滤不会一直闪。
                    <div key={filter} className="tpc-rows" style={{ height: rows.length * ROW_H, position: 'relative' }}>
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
                            id={'tpc-opt-' + entry.name}
                            className="tpc-row"
                            role="option"
                            aria-selected={!addOpen && entry.name === selected}
                            data-selected={!addOpen && entry.name === selected}
                            style={{ position: 'absolute', top, left: 0, right: 0, height: ROW_H }}
                            onClick={() => { setAddOpen(false); setAddError(null); setSelected(entry.name) }}
                          >
                            <ClippedText className="tpc-rowName" text={entry.name} />
                            {overridden(entry) ? <span className="tpc-ovdot" aria-label={t('cmdOverridden')} role="img" /> : null}
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
                <div className="tpc-detailBody" key="add">
                  <div className="tpc-detailScroll">
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
                </div>
              )
              : selectedEntry === null
                ? <div className="tpc-empty"><span>{t('cmdPickOne')}</span></div>
                : (
                  // key 挂在命令名上：换一行时整块重挂，结构上不可能再露上一行的
                  // 模式/路径（之前那 1 帧就是这么来的），顺带播一次进场。
                  <div className="tpc-detailBody" key={selectedEntry.name}>
                    <div className="tpc-detailHead">
                      <div className="tpc-who">
                        <h5 className="tpc-name">{selectedEntry.name}</h5>
                        <ClippedText className="tpc-path" always text={implPathOf(selectedEntry)}>{shortPathOf(selectedEntry)}</ClippedText>
                        <div className="tpc-badges">
                          <span className="tpc-badge" data-origin={selectedEntry.origin}>{originLabel(t, selectedEntry.origin)}</span>
                          <span className="tpc-badge">{t('cmdCurrent')} · {activeLabel(t, selectedEntry)}</span>
                          {dirty ? <span className="tpc-badge" data-origin="custom">{t('cmdUnsaved')}</span> : null}
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

                      {/* 路径字段常驻、靠 grid-template-rows 收放：条件渲染会让下面
                          整块内容一帧跳 88px。收起时子树同时 inert，键盘走不进去。 */}
                      <Collapse open={mode === 'custom'}>
                        <div className="tpc-field">
                          <span className="tpc-fieldLabel">{t('cmdPathLabel')}</span>
                          <input className="tpc-input" value={customPath} spellCheck={false} placeholder="D:/tools/zip.exe" onChange={event => setCustomPath(event.target.value)} />
                          <span className="tpc-formHint">{t('cmdPathHint')}</span>
                        </div>
                      </Collapse>
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
                      <pre key={probeLines === null ? 'idle' : probeLines.join('\n')} className="tpc-console">{probeLines === null ? t('cmdProbeEmpty') : probeLines.join('\n')}</pre>
                    </div>
                  </div>
                )}
          </div>
        </div>
      </div>
    </section>
  )

  if (variant !== 'dialog') return shell
  return (
    <div
      className="tpc-overlay"
      data-opening={opening ? 'true' : undefined}
      data-closing={closing ? 'true' : undefined}
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return
        // Same reason as modal-shell: a backdrop press must not drop focus to <body>.
        event.preventDefault()
        requestClose()
      }}
    >
      <div className="tpc-dialog" data-closing={closing ? 'true' : undefined} role="dialog" aria-modal="true" aria-label={t('cmdPanelTitle')}>
        <div className="tpc-dialogHead">
          <h3 className="tpc-dialogTitle">{t('cmdPanelTitle')}</h3>
          {closeConfirm
            ? (
              <>
                <span className="tpc-confirmText">{t('cmdCloseHint')}</span>
                <button ref={keepEditingRef} type="button" className="tpc-btn" onClick={() => setCloseConfirm(false)}>{t('cmdCloseKeep')}</button>
                <button type="button" className="tpc-btn tpc-btnDanger" onClick={() => { setCloseConfirm(false); onClose?.() }}>{t('cmdCloseDiscard')}</button>
              </>
            )
            : <button ref={closeBtnRef} type="button" className="tpc-btn" onClick={requestClose}>{t('cmdClose')}</button>}
        </div>
        {shell}
      </div>
    </div>
  )
}
