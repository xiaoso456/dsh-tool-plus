/**
 * 「路径」字段的文件浏览弹窗。
 *
 * 浏览器把 `<input type="file">` 锁在 File 对象和文件名上，拿不到绝对路径；
 * 这一栏要的却是能落盘、能原样转发参数的完整路径，所以列目录只能问宿主：
 * `command/browse` 一次答一层（名字、大小、是不是文件夹）。
 *
 * 三条硬约束（改之前先看）：
 * - **高度不随内容变**。弹窗定高，列表区自己滚；加载、空、出错三种状态都画在
 *   列表区里，不撑页。换一层目录时整窗位置也不许动。
 * - **翻目录立即生效**。面包屑和「上一级」按用户点的那层算，不等宿主回包；
 *   回包慢了才压暗列表并显示「读取中」，本地读取（几毫秒）不留痕迹。
 * - **挑选前不做校验**。能不能执行仍由写入路径（`statSync` + isFile）把关，
 *   这里只负责把路径填对。
 *
 * 类名前缀用 `tpx-`：宿主的排版样式里有一份 `.tpp-body`（max-width 65ch），
 * 原来的 `tpp-` 前缀被它压到过，列表宽度莫名只剩 420px。
 * @module @xiaoso/dsh-tool-plus/client
 */

import { Fragment, useCallback, useEffect, useInsertionEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  COMMAND_BROWSE_ENDPOINT,
  TOOL_PLUS_RPC_CHANNEL,
  type CommandBrowseEntry,
  type CommandBrowsePayload,
  type CommandBrowseValue,
} from '../tools/shared/browser-rpc-channel.ts'
import { ModalShell } from './modal-shell.tsx'
import { createWebConnectionRpc } from './web-connection-rpc.ts'
import type { BashPlusLocaleKey } from './locales.ts'
import { crumbsOf, dirOfPath, firstMatchIndex, formatSize, parentOfPath } from './path-text.ts'
import { useInert } from './rows.tsx'

/** Locale lookup the section passes down. */
type Translate = (key: BashPlusLocaleKey) => string

/** 弹窗盖在命令面板（1300）之上，点遮罩只关这一层。 */
const PICKER_Z_INDEX = 1400

/** 读取超过这么久才承认「慢」：本地目录通常几毫秒就回来，提前压暗只会闪一下。 */
const SLOW_READ_MS = 300

/** 打字跳转的缓冲时间：这段时间内连按的字母算一个前缀。 */
const TYPE_AHEAD_MS = 700

/** 行高，与样式里的 .tpx-row 保持一致；PageUp/PageDown 按它算一屏几行。 */
const ROW_HEIGHT = 32

const CSS = `
.tpx-dialog{box-sizing:border-box;display:flex;flex-direction:column;width:min(620px,calc(100vw - 48px));height:min(520px,calc(100vh - 96px));border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.tpx-head{flex:none;display:flex;align-items:center;gap:12px;box-sizing:border-box;height:48px;padding:0 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.tpx-title{margin:0;font-size:14px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}
.tpx-close{appearance:none;margin-left:auto;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:26px;height:26px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:16px;line-height:1;cursor:pointer;transition:background-color .12s ease,color .12s ease}
.tpx-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.tpx-close:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.tpx-bar{flex:none;display:flex;align-items:center;gap:8px;box-sizing:border-box;height:44px;padding:0 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}
/* 工具条上的两个开关做成有边框的小片：纯文字读起来像标签，看不出能点。 */
/* 字号与面包屑同档（12px），bar 里三种字的基线才对得齐；圆角跟按钮同档 8。 */
.tpx-ghost{appearance:none;display:inline-flex;align-items:center;justify-content:center;flex:none;box-sizing:border-box;height:26px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;padding:0 9px;cursor:pointer;white-space:nowrap;transition:background-color .12s ease,color .12s ease,border-color .12s ease}
.tpx-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l4)}
.tpx-ghost:disabled{opacity:.4;cursor:default}
.tpx-ghost:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.tpx-ghost[aria-pressed='true']{background:var(--dsw-alias-state-business-tertiary);border-color:transparent;color:var(--dsw-alias-label-primary);font-weight:500}
/* 路径一长，开头几级会被裁掉：左缘做一道渐隐，让「还有上一级」看得出来，
   而不是半截字符硬切在那里。 */
.tpx-crumbs{display:flex;align-items:center;gap:1px;flex:1;min-width:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.tpx-crumbs[data-overflow='true']{-webkit-mask-image:linear-gradient(90deg,transparent 0,#000 22px);mask-image:linear-gradient(90deg,transparent 0,#000 22px)}
.tpx-crumbs::-webkit-scrollbar{display:none}
.tpx-crumb{appearance:none;flex:none;max-width:170px;border:0;border-radius:6px;padding:1px 5px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:16px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:background-color .12s ease,color .12s ease}
.tpx-crumb:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.tpx-crumb:disabled{color:var(--dsw-alias-label-primary);cursor:default;padding-right:0}
.tpx-crumb:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.tpx-sep{flex:none;color:var(--dsw-alias-label-tertiary)}
/* 固定高度：列表自己滚，三种状态都画在里面，换目录时整窗不动。 */
.tpx-body{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
.tpx-body:focus{outline:none}
.tpx-list{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:6px;outline:none;transition:opacity .12s ease}
/* 整个列表画一圈焦点环会像个蓝框 bug；键盘位置由选中的那一行自己表达，
   与 VS Code 的快速选择一致（listbox + aria-activedescendant 的常规画法）。 */
.tpx-list:focus{outline:none}
/* 换层的瞬间旧行就不能再点：面包屑已经是新路径，列表还是上一层的，误点会选错文件。
   压暗仍然等 200ms，本地读取快到看不见。 */
.tpx-body[data-stale='true'] .tpx-list{pointer-events:none}
.tpx-body[data-busy='true'] .tpx-list{opacity:.4}
.tpx-row{display:flex;align-items:center;gap:8px;box-sizing:border-box;height:32px;padding:0 10px;border-radius:6px;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-primary);cursor:pointer;transition:background-color .08s ease}
.tpx-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
/* 亮色下选中底与悬停底的 ΔE 只有 2.9（门槛 8），只靠底色分不出来：
   左缘加一道 2px 竖条当第二种线索，和资源管理器/VS Code 的列表选择一致。 */
.tpx-row[data-active='true']{background:var(--dsw-alias-state-business-tertiary);box-shadow:inset 2px 0 0 var(--dsw-alias-state-business-primary)}
.tpx-row[data-active='true'] .tpx-name{font-weight:500}
.tpx-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 行尾一列：文件放大小、文件夹放箭头，共用一格，右边缘才对得齐。 */
/* 次要信息用 secondary 而不是 tertiary：tertiary 在亮色下只有 3.7:1，
   11.5px 的小字读起来发虚。 */
.tpx-trail{flex:none;display:flex;align-items:center;justify-content:flex-end;width:88px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:18px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.tpx-chevron{appearance:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;margin-right:-4px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:1;cursor:pointer;transition:background-color .12s ease,color .12s ease}
.tpx-chevron:hover{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-label-primary)}
.tpx-state{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;background:var(--dsw-alias-bg-layer-1);text-align:center;font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary)}
.tpx-state > span:last-child{display:flex;gap:8px}
/* 截断提示放列表上方：塞在滚动区末尾时，四百行要滚到底才看得见。 */
.tpx-note{flex:none;display:flex;align-items:center;justify-content:center;box-sizing:border-box;height:26px;margin:0;padding:0 16px;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.tpx-state b{margin:0;font-weight:500;color:var(--dsw-alias-label-primary)}
.tpx-state[data-tone='error'] b{color:var(--dsw-alias-state-error-primary)}
.tpx-msg{max-width:44ch;overflow-wrap:anywhere}
.tpx-foot{flex:none;display:flex;align-items:center;gap:8px;box-sizing:border-box;height:52px;padding:0 16px;border-top:1px solid var(--dsw-alias-border-l2)}
.tpx-picked{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.tpx-picked[data-empty='true']{font-family:inherit;font-size:12px;color:var(--dsw-alias-label-secondary)}
.tpx-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;flex:none;box-sizing:border-box;min-width:64px;height:30px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;line-height:1;padding:0 14px;cursor:pointer;white-space:nowrap;transition:background-color .12s ease,color .12s ease,border-color .12s ease}
.tpx-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l4)}
.tpx-btn:disabled{opacity:.4;cursor:default}
.tpx-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.tpx-btnPrimary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-inverted);font-weight:500}
.tpx-btnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-label-primary-inverted)}
@media (prefers-reduced-motion: reduce){.tpx-close,.tpx-ghost,.tpx-crumb,.tpx-row,.tpx-btn,.tpx-list{transition:none}}
`

/**
 * 注入样式。重复调用用最新一份覆盖旧标签：热更新时旧的样式表不能被「见过就跳过」
 * 留在页面里，否则改了半天看到的是上一版。
 */
let cssInjected = false
function injectCss(): void {
  if (typeof document === 'undefined') return
  cssInjected = true
  const id = 'tool-plus-path-picker'
  const existing = document.querySelector('style[data-plugin-css="' + id + '"]')
  if (existing !== null) {
    if (existing.textContent !== CSS) existing.textContent = CSS
    return
  }
  const tag = document.createElement('style')
  tag.dataset.plugin = '@xiaoso/dsh-tool-plus'
  tag.dataset.pluginCss = id
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/** 截断提示里只有数量会变，自己拼，别为一句模板多开一个占位符工具。 */
function withCount(template: string, count: number): string {
  return template.replace('{count}', String(count))
}

/**
 * 一层目录的读取状态。
 *
 * 只认最后一次请求：连续翻两下时，先发的那次回来得晚也不能盖掉后发的结果。
 * 失败不清空上一次的列表，重试就从这里再来一次。
 */
function useDirectory(dir: string | null, showAll: boolean): {
  value: CommandBrowseValue | null
  error: string | null
  loading: boolean
  reload: () => void
} {
  const [value, setValue] = useState<CommandBrowseValue | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const mine = ++seq.current
    setLoading(true)
    // 换层立刻清掉上一层的错：否则「上一个目录不存在」会盖在正在读的新目录上。
    setError(null)
    void (async () => {
      try {
        const rpc = createWebConnectionRpc()
        const payload: CommandBrowsePayload = {
          ...(dir === null ? {} : { dir }),
          showAll,
        }
        const result = await rpc.call(TOOL_PLUS_RPC_CHANNEL, COMMAND_BROWSE_ENDPOINT, payload)
        if (mine !== seq.current) return
        if (!result.ok) {
          setError(result.error.message)
          return
        }
        setValue(result.value as CommandBrowseValue)
        setError(null)
      } catch (caught) {
        if (mine !== seq.current) return
        setError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        if (mine === seq.current) setLoading(false)
      }
    })()
  }, [dir, showAll, attempt])

  const reload = useCallback(() => setAttempt(current => current + 1), [])
  return { value, error, loading, reload }
}

export interface PathPickerProps {
  t: Translate
  /** 打开时输入框里已有的值；用它决定从哪一层开始。 */
  startAt: string
  /** 选中一个文件：完整路径，宿主侧的口径。 */
  onPick: (path: string) => void
  onRequestClose: () => void
}

/**
 * Render the browse dialog.
 *
 * 键盘：↑↓ 选行，打字跳转，Enter 进目录或确认文件，Backspace / ← 上一级，
 * Esc 关（由浮层壳统一处理）。
 */
export function PathPicker(props: PathPickerProps): ReactNode {
  const { t, startAt, onPick, onRequestClose } = props
  // 绘制前注入：放在渲染体里会让首帧先按未定位的样式画一遍。
  useInsertionEffect(() => { injectCss() }, [])

  /** null = 没指定，由宿主给主目录。 */
  const [dir, setDir] = useState<string | null>(() => dirOfPath(startAt) ?? null)
  const [showAll, setShowAll] = useState(false)
  const [active, setActive] = useState<string | null>(null)
  const { value, error, loading, reload } = useDirectory(dir, showAll)
  const [slow, setSlow] = useState(false)
  const [overflow, setOverflow] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)
  const crumbsRef = useRef<HTMLDivElement | null>(null)
  const typeAhead = useRef({ text: '', timer: 0 })

  // 「慢」要等一会儿才承认：本地目录几毫秒就回来，提前压暗只会闪一下。
  useEffect(() => {
    if (!loading) {
      setSlow(false)
      return
    }
    const timer = window.setTimeout(() => setSlow(true), SLOW_READ_MS)
    return () => window.clearTimeout(timer)
  }, [loading])

  // 换一层就清掉选中与打字缓冲：上一层的文件名、上一层的「z 前缀」都不再成立。
  useEffect(() => {
    setActive(null)
    typeAhead.current.text = ''
  }, [dir, showAll])

  // 面包屑与「上一级」按用户点的那层算，不等回包；这样连点也不会走岔。
  const entries = value?.entries ?? []
  const currentDir = dir ?? value?.dir ?? null
  const parent = currentDir === null ? null : parentOfPath(currentDir)
  const crumbs = currentDir === null ? [] : crumbsOf(currentDir)
  const activeIndex = active === null ? -1 : entries.findIndex(entry => entry.path === active)
  const activeEntry = activeIndex < 0 ? null : entries[activeIndex]
  /** 有未完成的读取：旧行不可点，回车也不生效。 */
  const stale = loading
  /** 读取超过 200ms：才值得压暗并显示「读取中」。 */
  const busy = loading && slow

  // 路径一长，开头几级先被挤出可视区：始终让当前这一级看得见。
  useLayoutEffect(() => {
    const node = crumbsRef.current
    if (node === null) return
    node.scrollLeft = node.scrollWidth
    setOverflow(node.scrollWidth > node.clientWidth + 1)
  }, [currentDir])

  useLayoutEffect(() => {
    if (active === null) return
    const node = listRef.current?.querySelector('[data-active="true"]')
    if (node instanceof HTMLElement) node.scrollIntoView({ block: 'nearest' })
  }, [active])

  const go = useCallback((next: string | null): void => {
    setDir(next)
  }, [])

  // 第一次读到目录就落在第一行：否则键盘用户看不出焦点在哪，回车也没反应。
  // 只在「这一层还没选过」时补，翻回来时不会把用户的选择顶掉。
  useEffect(() => {
    if (loading || active !== null || entries.length === 0) return
    setActive(entries[0].path)
  }, [active, entries, loading])

  // 状态层盖住列表时列表就不该再收键盘：否则 Tab 进去的是看不见的行。
  const blocked = error !== null || (!loading && value !== null && entries.length === 0)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  useInert(listRef, blocked)
  // 列表被 inert 之后浏览器会把焦点丢到 body 上：把键盘交给状态层，
  // 否则「重试」「看全部文件」这些唯一的出路都按不到。解除时再交回列表。
  useLayoutEffect(() => {
    if (blocked) {
      bodyRef.current?.focus()
      return
    }
    const active = document.activeElement
    if (active === null || active === document.body || active === bodyRef.current) listRef.current?.focus()
  }, [blocked])

  const enter = useCallback((entry: CommandBrowseEntry): void => {
    if (entry.kind === 'dir') {
      go(entry.path)
      return
    }
    onPick(entry.path)
  }, [go, onPick])

  const onListKey = useCallback((event: React.KeyboardEvent<HTMLDivElement>): void => {
    const count = entries.length
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (count === 0) return
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next = activeIndex < 0 ? (step === 1 ? 0 : count - 1) : (activeIndex + step + count) % count
      setActive(entries[next].path)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      if (count === 0) return
      event.preventDefault()
      setActive(entries[event.key === 'Home' ? 0 : count - 1].path)
      return
    }
    if (event.key === 'Enter') {
      if (activeEntry === null || stale) return
      event.preventDefault()
      enter(activeEntry)
      return
    }
    if (event.key === 'Backspace' || event.key === 'ArrowLeft') {
      if (parent === null) return
      event.preventDefault()
      go(parent)
      return
    }
    if (event.key === 'ArrowRight') {
      if (activeEntry === null || activeEntry.kind !== 'dir' || stale) return
      event.preventDefault()
      enter(activeEntry)
      return
    }
    if (event.key === 'PageDown' || event.key === 'PageUp') {
      if (count === 0 || listRef.current === null) return
      event.preventDefault()
      const visible = Math.max(1, Math.floor(listRef.current.clientHeight / ROW_HEIGHT))
      const from = activeIndex < 0 ? 0 : activeIndex
      const next = Math.min(count - 1, Math.max(0, from + (event.key === 'PageDown' ? visible : -visible)))
      setActive(entries[next].path)
      return
    }
    // 打字跳转：名字前缀，大小写不敏感，连按算一个前缀。输入法组合中的按键不算。
    // `nativeEvent`：React 的 KeyboardEvent 类型上没有 isComposing。
    if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.nativeEvent.isComposing) {
      const buffer = typeAhead.current
      window.clearTimeout(buffer.timer)
      buffer.text += event.key
      buffer.timer = window.setTimeout(() => { buffer.text = '' }, TYPE_AHEAD_MS)
      const index = firstMatchIndex(entries.map(entry => entry.name), buffer.text, activeIndex)
      if (index >= 0) {
        event.preventDefault()
        setActive(entries[index].path)
      } else {
        // 没命中就从头再来：留着旧前缀，后面几秒的按键会一直被拖去搜那个死串。
        buffer.text = ''
      }
    }
  }, [activeEntry, activeIndex, entries, enter, go, parent, stale])

  return (
    <ModalShell
      variant="dialog"
      role="dialog"
      ariaLabel={showAll ? t('cmdBrowseTitleAll') : t('cmdBrowseTitle')}
      className="tpx-dialog"
      zIndex={PICKER_Z_INDEX}
      onRequestClose={onRequestClose}
      initialFocus={() => listRef.current}
    >
      <div className="tpx-head">
        <h4 className="tpx-title">{showAll ? t('cmdBrowseTitleAll') : t('cmdBrowseTitle')}</h4>
        <button type="button" className="tpx-close" aria-label={t('cmdClose')} onClick={onRequestClose}>×</button>
      </div>

      <div className="tpx-bar">
        <button
          type="button"
          className="tpx-ghost"
          disabled={parent === null}
          onClick={() => { if (parent !== null) go(parent) }}
        >
          ‹ {t('cmdBrowseUp')}
        </button>
        <div
          className="tpx-crumbs"
          ref={crumbsRef}
          role="navigation"
          aria-label={t('cmdBrowsePath')}
          data-overflow={overflow ? 'true' : 'false'}
          onWheel={(event) => {
            // 触控板横滑之外，普通滚轮也让它能翻：竖着滚改成横着滚。
            const node = crumbsRef.current
            if (node === null || node.scrollWidth <= node.clientWidth) return
            node.scrollLeft += event.deltaY
          }}
        >
          {crumbs.map((crumb, index) => {
            const current = index === crumbs.length - 1
            return (
              <Fragment key={crumb.path}>
                {index > 0 ? <span className="tpx-sep" aria-hidden="true">/</span> : null}
                <button
                  type="button"
                  className="tpx-crumb"
                  disabled={current}
                  title={crumb.path}
                  onClick={() => go(crumb.path)}
                >
                  {crumb.label}
                </button>
              </Fragment>
            )
          })}
          {currentDir === null && loading ? <span className="tpx-sep">{t('cmdBrowseLoading')}</span> : null}
        </div>
        <button
          type="button"
          className="tpx-ghost"
          aria-pressed={showAll}
          onClick={() => setShowAll(current => !current)}
        >
          {t('cmdBrowseAll')}
        </button>
      </div>

      {value !== null && value.truncated && entries.length > 0
        ? <p className="tpx-note">{withCount(t('cmdBrowseTruncated'), entries.length)}</p>
        : null}

      <div
        className="tpx-body"
        ref={bodyRef}
        tabIndex={-1}
        data-busy={busy ? 'true' : 'false'}
        data-stale={stale ? 'true' : 'false'}
      >
        <div
          className="tpx-list"
          ref={listRef}
          role="listbox"
          tabIndex={0}
          aria-label={t('cmdBrowseTitle')}
          aria-busy={stale ? 'true' : undefined}
          aria-activedescendant={activeIndex < 0 ? undefined : 'tpx-opt-' + activeIndex}
          onKeyDown={onListKey}
        >
          {entries.map((entry, index) => (
            <div
              key={entry.path}
              id={'tpx-opt-' + index}
              className="tpx-row"
              role="option"
              aria-selected={activeIndex === index}
              data-active={activeIndex === index ? 'true' : undefined}
              onClick={() => setActive(entry.path)}
              onDoubleClick={() => { if (!stale) enter(entry) }}
            >
              <span className="tpx-name">{entry.name}</span>
              <span className="tpx-trail">
                {entry.kind === 'dir'
                  ? (
                    // 箭头本身就是「进入」：只靠双击太隐蔽，单击整行又只是选中。
                    <button
                      type="button"
                      className="tpx-chevron"
                      aria-label={t('cmdBrowseEnter')}
                      tabIndex={-1}
                      onClick={(event) => { event.stopPropagation(); if (!stale) enter(entry) }}
                    >
                      ›
                    </button>
                  )
                  : formatSize(entry.size)}
              </span>
            </div>
          ))}
        </div>

        {error !== null
          ? (
            <div className="tpx-state" data-tone="error" role="alert">
              <b>{t('cmdBrowseFailed')}</b>
              <span className="tpx-msg">{error}</span>
              <span>
                <button type="button" className="tpx-btn" onClick={reload}>{t('cmdBrowseRetry')}</button>
                <button type="button" className="tpx-btn" onClick={() => go(null)}>{t('cmdBrowseHome')}</button>
              </span>
            </div>
          )
          : error === null && !loading && value !== null && entries.length === 0
            ? (
              <div className="tpx-state">
                <b>{showAll ? t('cmdBrowseEmptyAll') : t('cmdBrowseEmpty')}</b>
                {showAll
                  ? null
                  : <button type="button" className="tpx-btn" onClick={() => setShowAll(true)}>{t('cmdBrowseShowAll')}</button>}
              </div>
            )
            : busy
              ? <div className="tpx-state" role="status" aria-live="polite"><span>{t('cmdBrowseLoading')}</span></div>
              : null}
      </div>

      <div className="tpx-foot">
        <span className="tpx-picked" data-empty={activeEntry === null ? 'true' : 'false'}>
          {busy ? t('cmdBrowseLoading') : activeEntry === null ? t('cmdBrowseHint') : activeEntry.path}
        </span>
        <button type="button" className="tpx-btn" onClick={onRequestClose}>{t('cmdAddCancel')}</button>
        <button
          type="button"
          className="tpx-btn tpx-btnPrimary"
          disabled={activeEntry === null || stale || error !== null}
          onClick={() => { if (activeEntry !== null) enter(activeEntry) }}
        >
          {activeEntry !== null && activeEntry.kind === 'dir' ? t('cmdBrowseEnter') : t('cmdBrowsePick')}
        </button>
      </div>
    </ModalShell>
  )
}
