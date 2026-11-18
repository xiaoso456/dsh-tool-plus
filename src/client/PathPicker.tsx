/**
 * 「路径」字段的文件浏览弹窗。
 *
 * 浏览器把 `<input type="file">` 锁在 File 对象和文件名上，拿不到绝对路径；
 * 这一栏要的却是能落盘、能原样转发参数的完整路径，所以列目录只能问宿主：
 * `command/browse` 一次答一层（名字、大小、是不是文件夹）。
 *
 * 壳子不再自己画：遮罩、层级、Esc、Tab 圈定、关闭后焦点归还全部交给宿主的
 * `Modal`（`useModalLayer` 那套），标题排布、面包屑加铅笔进编辑态、行高与
 * 选中态、底部开关加取消/确定，逐项对齐宿主自己的「选择工作区目录」弹窗
 * （`dsh-client-ui-directory-picker-browse`）——同一套尺寸（680×500）、同一套
 * 原子（`Button`、`FileTypeIcon`、`fileSizeText`、图标）。
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

import { useCallback, useEffect, useInsertionEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  Button,
  FileTypeIcon,
  IconCheckOutlineRegular,
  IconChevronRightOutlineRegular,
  IconEditOutlineRegular,
  IconFolderCloseRegular,
  IconFolderOpenRegular,
  Modal,
  fileSizeText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  COMMAND_BROWSE_ENDPOINT,
  TOOL_PLUS_RPC_CHANNEL,
  type CommandBrowseEntry,
  type CommandBrowsePayload,
  type CommandBrowseValue,
} from '../tools/shared/browser-rpc-channel.ts'
import { createWebConnectionRpc } from './web-connection-rpc.ts'
import type { BashPlusLocaleKey } from './locales.ts'
import { crumbsOf, dirOfPath, firstMatchIndex, parentOfPath } from './path-text.ts'

/** Locale lookup the section passes down. */
type Translate = (key: BashPlusLocaleKey) => string

/** 读取超过这么久才承认「慢」：本地目录通常几毫秒就回来，提前压暗只会闪一下。 */
const SLOW_READ_MS = 300

/** 打字跳转的缓冲时间：这段时间内连按的字母算一个前缀。 */
const TYPE_AHEAD_MS = 700

/** 行高，与样式里的 .tpx-row 保持一致；PageUp/PageDown 按它算一屏几行。 */
const ROW_HEIGHT = 28

/**
 * 尺寸与间距直接照搬宿主自己的目录弹窗：卡片 680×500（短视口按 100dvh 收）、
 * 头部 16/14/8/24、内容 16/16/16/24、底栏 16/24、行高 28、间距 2。
 */
const CSS = `
/* Modal 的遮罩层是 1000，命令面板是 1300：不抬的话弹窗会被面板整个盖住。
   只能抬外层（z-index 会在遮罩那层生成新层叠上下文，抬卡片本身无效）。 */
div:has(> .tpx-dialog){z-index:1400}
.tpx-dialog.tpx-dialog{width:min(680px,100%);height:min(500px,calc(100dvh - 32px));padding:0;gap:0}
.tpx-scope{display:contents}
.tpx-head{display:flex;flex-direction:column;gap:8px;flex:none;padding:16px 14px 8px 24px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.tpx-title{display:flex;align-items:flex-end;min-height:28px;margin:0;font-size:16px;line-height:24px;font-weight:510;color:var(--dsw-alias-label-primary)}
/* 整条 bar 就是编辑框：边框和内边距挂在它身上，面包屑与输入框坐进去，
   悬停时亮的是整行，而不是「面包屑右边那一截」。负左距把边框和内边距还回去，
   文字才和标题同一条竖线。 */
.tpx-bar{display:flex;align-items:center;gap:4px;box-sizing:border-box;min-height:24px;margin-left:-9px;padding:0 8px;border:1px solid transparent;border-radius:var(--dsw-radius-sm)}
.tpx-bar:has(.tpx-editZone:enabled:hover),.tpx-bar:has(.tpx-editZone:focus-visible),.tpx-bar:has(.tpx-pathInput){border-color:var(--dsw-alias-border-l2)}
.tpx-crumbs{display:flex;align-items:center;gap:4px;flex:0 1 auto;min-width:0;overflow-x:auto;scrollbar-width:none}
.tpx-crumbs::-webkit-scrollbar{display:none}
.tpx-crumbSeat{display:inline-flex;align-items:center;gap:4px;flex:none;min-width:0}
.tpx-crumb{border:none;background:transparent;padding:0;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-tertiary);cursor:pointer}
/* 最后一段就是当前目录：和可点的上级区分开，一眼知道自己在哪。 */
.tpx-crumb[data-current='true']{color:var(--dsw-alias-label-primary)}
.tpx-crumb:hover{color:var(--dsw-alias-label-primary)}
.tpx-crumb:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.tpx-crumbChevron{flex:none;color:var(--dsw-alias-label-tertiary)}
/* bar 右侧剩下的空白是「改路径」的点击区，铅笔是它常年挂着的说明：
   看不见的热区只能靠用户猜，猜不到就等于没有。 */
.tpx-editZone{display:flex;align-items:center;justify-content:flex-end;flex:1 0 34px;min-width:34px;height:22px;padding:0;border:none;background:transparent;cursor:text;outline:none}
.tpx-editGlyph{flex:none;color:var(--dsw-alias-label-tertiary)}
.tpx-editZone:enabled:hover .tpx-editGlyph,.tpx-editZone:focus-visible .tpx-editGlyph{color:var(--dsw-alias-label-primary)}
/* 输入框自己不带框：框由外面那条 bar 画。 */
.tpx-pathInput{box-sizing:border-box;flex:1 1 0;min-width:0;height:22px;padding:0;border:none;outline:none;background:transparent;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.tpx-content{display:flex;flex-direction:column;flex:1 1 0;min-height:0;position:relative;padding:16px 16px 16px 24px}
/* 没有条目时这一栏收起来：空态与错误提示就跟在头部下面，而不是被推到
   卡片底部、离标题十万八千里。 */
.tpx-col{display:flex;flex-direction:column;gap:2px;flex:1 1 0;min-height:0;overflow-y:auto;padding-right:8px;outline:none}
.tpx-col[data-empty='true']{flex:0 0 auto}
/* 换层的瞬间旧行就不能再点：面包屑已经是新路径，列表还是上一层的，误点会选错文件。 */
.tpx-col[data-stale='true']{pointer-events:none}
.tpx-row{display:flex;align-items:center;gap:8px;box-sizing:border-box;height:28px;flex:none;padding:4px;border-radius:var(--dsw-radius-sm);background:transparent;text-align:left;cursor:pointer}
.tpx-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tpx-row[data-active='true'],.tpx-row[data-active='true']:hover{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover))}
.tpx-rowIcon{flex:none;color:var(--dsw-alias-label-secondary)}
.tpx-row[data-active='true'] .tpx-rowIconDir{color:var(--dsw-alias-button-info-fill)}
.tpx-rowName{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.tpx-rowSize{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.tpx-rowChevron{flex:none;color:var(--dsw-alias-label-tertiary)}
/* 状态行排在列表下面：列表自己滚，这几行不会把卡片撑高。 */
.tpx-status,.tpx-error{display:flex;align-items:center;gap:8px;padding:4px;padding-right:120px;font-size:12px;line-height:18px}
.tpx-status{color:var(--dsw-alias-label-secondary)}
.tpx-error{color:var(--dsw-alias-state-error-primary)}
.tpx-link{border:none;background:transparent;padding:0;font:inherit;color:var(--dsw-alias-state-business-primary);cursor:pointer;text-decoration:underline;text-underline-offset:2px}
/* 读取慢的提示浮在右下角，不占一行：等它出现时列表里还是旧内容，
   占一行会让行位置在读完的一瞬间跳一下。 */
.tpx-loading{position:absolute;right:16px;bottom:8px;padding:2px 8px;background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.tpx-foot{display:flex;align-items:center;flex-wrap:wrap;gap:8px;flex:none;padding:16px 24px;border-top:.5px solid var(--dsw-alias-border-l3)}
/* 开关是文字按钮：按下时在标签后面补一个勾（取 Menu 的选中词汇），
   文案本身不换，按下去时字不会跳。 */
.tpx-toggle{display:inline-flex;align-items:center;gap:4px;border:none;background:transparent;padding:0;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}
.tpx-toggle:hover{color:var(--dsw-alias-label-primary)}
.tpx-toggle[aria-pressed='true']{color:var(--dsw-alias-label-primary)}
.tpx-gap{flex:1 1 0}
.tpx-action{min-width:72px}
@media (prefers-reduced-motion: reduce){.tpx-crumb,.tpx-row,.tpx-toggle,.tpx-link{transition:none}}
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
 * 失败不清空上一次的列表，重试就从这里再来一次。弹窗关着时不再发请求。
 */
function useDirectory(dir: string | null, showAll: boolean, enabled: boolean): {
  value: CommandBrowseValue | null
  error: string | null
  loading: boolean
  reload: () => void
} {
  const [value, setValue] = useState<CommandBrowseValue | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!enabled) return
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
  }, [dir, showAll, attempt, enabled])

  const reload = useCallback(() => setAttempt(current => current + 1), [])
  return { value, error, loading, reload }
}

export interface PathPickerProps {
  t: Translate
  /** 开着才请求目录、才挂载遮罩；关着时整棵子树不渲染。 */
  open: boolean
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
 * Esc 关（编辑路径时先退出编辑态，由卡片自己拦下这次 Esc）。
 */
export function PathPicker(props: PathPickerProps): ReactNode {
  const { t, open, startAt, onPick, onRequestClose } = props
  // 绘制前注入：放在渲染体里会让首帧先按未定位的样式画一遍。
  useInsertionEffect(() => { injectCss() }, [])

  /** null = 没指定，由宿主给主目录。 */
  const [dir, setDir] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [active, setActive] = useState<string | null>(null)
  /** null = 面包屑态；字符串 = 正在手输路径。 */
  const [pathDraft, setPathDraft] = useState<string | null>(null)
  const { value, error, loading, reload } = useDirectory(dir, showAll, open)
  const [slow, setSlow] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)
  const crumbsRef = useRef<HTMLSpanElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const typeAhead = useRef({ text: '', timer: 0 })
  const lastStart = useRef<string | null>(null)

  /**
   * Esc 归这一层：编辑路径时先退出编辑态，再按一次才关弹窗。
   *
   * 注册在 document 的 capture 上并 stopPropagation：Modal 自己的 Esc 是
   * document 的冒泡监听，下面设置抽屉的也是；让事件继续走，两者都会跟着收掉
   * 整页。命令面板在浏览弹窗开着时已经让路（它只在没弹窗时才接管 Esc）。
   */
  useEffect(() => {
    if (!open) return
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.stopPropagation()
      event.preventDefault()
      if (pathDraft !== null) {
        setPathDraft(null)
        return
      }
      onRequestClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true) }
  }, [open, pathDraft, onRequestClose])

  // 每次打开都从输入框里的值重新起步；关着的时候不发请求。
  useEffect(() => {
    if (!open) return
    if (lastStart.current === startAt) return
    lastStart.current = startAt
    const seed = dirOfPath(startAt)
    if (seed !== undefined) setDir(seed)
    setActive(null)
    setPathDraft(null)
  }, [open, startAt])

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
  /** 读取慢到值得说一声：压不压暗都靠它。 */
  const busy = loading && slow

  // 路径一长，开头几级先被挤出可视区：始终让当前这一级看得见。
  useLayoutEffect(() => {
    const node = crumbsRef.current
    if (node === null) return
    node.scrollLeft = node.scrollWidth
  }, [currentDir, open])

  useLayoutEffect(() => {
    if (active === null) return
    const node = listRef.current?.querySelector('[data-active="true"]')
    if (node instanceof HTMLElement) node.scrollIntoView({ block: 'nearest' })
  }, [active])

  // 第一次读到目录就落在第一行：否则键盘用户看不出焦点在哪，回车也没反应。
  // 只在「这一层还没选过」时补，翻回来时不会把用户的选择顶掉。
  useEffect(() => {
    if (!open || loading || active !== null || entries.length === 0) return
    setActive(entries[0].path)
  }, [active, entries, loading, open])

  const go = useCallback((next: string | null): void => {
    setDir(next)
    setPathDraft(null)
  }, [])

  const enter = useCallback((entry: CommandBrowseEntry): void => {
    if (entry.kind === 'dir') {
      go(entry.path)
      return
    }
    onPick(entry.path)
  }, [go, onPick])

  /** 打字跳转：可打印字符攒进缓冲，700ms 内没再按就清空。 */
  const onTypeAhead = useCallback((event: KeyboardEvent<HTMLDivElement>): boolean => {
    const { key } = event
    if (key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return false
    const state = typeAhead.current
    window.clearTimeout(state.timer)
    state.text += key
    state.timer = window.setTimeout(() => { state.text = '' }, TYPE_AHEAD_MS)
    const index = firstMatchIndex(entries.map(entry => entry.name), state.text, activeIndex)
    if (index < 0) {
      // 没配上就把缓冲清掉：否则第一下按错，后面几下一个字都跳不动。
      state.text = ''
      return false
    }
    setActive(entries[index].path)
    return true
  }, [entries, activeIndex])

  /**
   * 列表的键盘。焦点始终留在列表容器上（listbox + aria-activedescendant），
   * 不逐行搬焦点：Modal 的 Tab 圈定会把每个按钮都算成一个落点，四百行就是
   * 四百个 Tab 站。
   */
  const onListKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing) return
    const count = entries.length
    const current = activeIndex
    const move = (next: number): void => {
      if (next < 0 || next >= count) return
      event.preventDefault()
      setActive(entries[next].path)
    }
    switch (event.key) {
      case 'ArrowDown': if (!stale) move(Math.min(count - 1, current + 1)); break
      case 'ArrowUp': if (!stale) move(current <= 0 ? 0 : current - 1); break
      case 'Home': if (!stale) move(0); break
      case 'End': if (!stale) move(count - 1); break
      case 'PageDown':
      case 'PageUp': {
        if (stale) break
        const box = listRef.current
        const page = box === null ? 10 : Math.max(1, Math.floor(box.clientHeight / ROW_HEIGHT) - 1)
        move(event.key === 'PageDown' ? Math.min(count - 1, current + page) : Math.max(0, current - page))
        break
      }
      case 'Enter': {
        if (stale) break
        event.preventDefault()
        const entry = activeEntry ?? entries[0] ?? null
        if (entry === null) break
        enter(entry)
        break
      }
      case 'ArrowRight': {
        if (stale) break
        if (activeEntry?.kind === 'dir') { event.preventDefault(); enter(activeEntry) }
        break
      }
      case 'ArrowLeft':
      case 'Backspace': {
        if (stale || parent === null) break
        event.preventDefault()
        go(parent)
        break
      }
      default: onTypeAhead(event)
    }
  }

  /** 从面包屑右边那块热区进编辑态：草稿带上分隔符，接着敲就是子目录名。 */
  const startEdit = (): void => {
    const base = dir ?? value?.dir ?? null
    if (base === null) {
      setPathDraft('')
      return
    }
    setPathDraft(base.endsWith('/') ? base : base + '/')
  }

  return (
    <Modal
      open={open}
      onClose={onRequestClose}
      title={t('cmdBrowseTitle')}
      className="tpx-dialog"
      headless
    >
      {/* display:contents：头部、内容、底栏仍然是 Modal 卡片的直接 flex 子项。 */}
      <div className="tpx-scope">
        <div className="tpx-head">
          <h2 className="tpx-title">{t('cmdBrowseTitle')}</h2>
          <div className="tpx-bar">
            {pathDraft === null
              ? (
                <>
                  <span className="tpx-crumbs" role="navigation" ref={crumbsRef}>
                    {crumbs.map((crumb, index) => (
                      <span key={crumb.path} className="tpx-crumbSeat">
                        {index > 0 && <IconChevronRightOutlineRegular size={12} className="tpx-crumbChevron" />}
                        <button
                          type="button"
                          className="tpx-crumb"
                          data-current={index === crumbs.length - 1 ? 'true' : undefined}
                          aria-current={index === crumbs.length - 1 ? 'page' : undefined}
                          disabled={stale}
                          onClick={() => { go(crumb.path) }}
                        >
                          {crumb.label}
                        </button>
                      </span>
                    ))}
                  </span>
                  <button
                    type="button"
                    className="tpx-editZone"
                    aria-label={t('cmdBrowsePath')}
                    title={t('cmdBrowsePath')}
                    disabled={stale}
                    onClick={startEdit}
                  >
                    <IconEditOutlineRegular size={14} className="tpx-editGlyph" />
                  </button>
                </>
              )
              : (
                <input
                  className="tpx-pathInput"
                  ref={inputRef}
                  autoFocus
                  value={pathDraft}
                  aria-label={t('cmdBrowsePath')}
                  onChange={(event) => { setPathDraft(event.target.value) }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                    event.preventDefault()
                    // 空白只用来判断「没写东西」；真目录名可能带空格，原样送给宿主。
                    if (pathDraft.trim() === '') return
                    go(pathDraft)
                  }}
                />
              )}
          </div>
        </div>

        <div className="tpx-content">
          <div
            className="tpx-col"
            ref={listRef}
            role="listbox"
            tabIndex={0}
            data-modal-autofocus
            aria-label={t('cmdBrowseTitle')}
            aria-busy={stale ? 'true' : undefined}
            aria-activedescendant={activeIndex < 0 ? undefined : 'tpx-opt-' + activeIndex}
            data-stale={stale ? 'true' : 'false'}
            data-empty={!loading && entries.length === 0 ? 'true' : 'false'}
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
                {entry.kind === 'dir'
                  ? (
                    activeIndex === index
                      ? <IconFolderOpenRegular size={16} className="tpx-rowIcon tpx-rowIconDir" />
                      : <IconFolderCloseRegular size={16} className="tpx-rowIcon tpx-rowIconDir" />
                  )
                  : <FileTypeIcon path={entry.name} size={16} className="tpx-rowIcon" />}
                <span className="tpx-rowName">{entry.name}</span>
                {entry.kind === 'dir'
                  ? <IconChevronRightOutlineRegular size={12} className="tpx-rowChevron" />
                  : <span className="tpx-rowSize">{entry.size === null ? '' : fileSizeText(entry.size)}</span>}
              </div>
            ))}
          </div>

          {busy && <div className="tpx-loading" role="status" aria-live="polite">{t('cmdBrowseLoading')}</div>}
          {value?.truncated === true && (
            <div className="tpx-status" role="status">{withCount(t('cmdBrowseTruncated'), entries.length)}</div>
          )}
          {error !== null && (
            <div className="tpx-error" role="alert">
              <span>{t('cmdBrowseFailed')}</span>
              <button type="button" className="tpx-link" onClick={reload}>{t('cmdBrowseRetry')}</button>
            </div>
          )}
          {error === null && !loading && value !== null && entries.length === 0 && (
            <div className="tpx-status" role="status">
              {showAll ? t('cmdBrowseEmptyAll') : t('cmdBrowseEmpty')}
            </div>
          )}
        </div>

        <div className="tpx-foot">
          <button
            type="button"
            className="tpx-toggle"
            aria-pressed={showAll}
            disabled={stale}
            onClick={() => { setShowAll(current => !current) }}
          >
            {t('cmdBrowseAll')}
            {showAll && <IconCheckOutlineRegular size={14} />}
          </button>
          <span className="tpx-gap" />
          <Button variant="outline" className="tpx-action" onClick={onRequestClose}>{t('cmdAddCancel')}</Button>
          <Button
            variant="primary"
            className="tpx-action"
            disabled={activeEntry === null || stale || error !== null}
            onClick={() => { if (activeEntry !== null) enter(activeEntry) }}
          >
            {activeEntry !== null && activeEntry.kind === 'dir' ? t('cmdBrowseEnter') : t('cmdBrowsePick')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
