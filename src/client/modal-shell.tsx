/**
 * 设置页浮层共用的薄壳：遮罩、焦点圈定、Esc 归属、关闭后焦点归还、进场。
 *
 * 三个浮层原来是三套写法（初始化脚本自绘、命令面板自绘、预设二次确认是页内块），
 * 结果是同一件事各有各的毛病：Tab 跑出浮层、一次 Esc 关两层、关完焦点落到 body、
 * 暗色遮罩反白、确认卡把正文顶下去。这里只抽**行为**，外观（底色、圆角、内边距）
 * 仍归调用方，所以壳里没有一个业务选择器。
 *
 * 一期拆分：`CommandDialog.tsx` 自带一份同样的门户与键盘契约，主 agent 正在改那
 * 两个文件，暂不并入；等命令面板这一轮收尾后，它应该换成这个壳（届时把它的
 * data-closing 退场也一并接进来）。
 * @module @xiaoso/dsh-tool-plus/client
 */

import { useEffect, useInsertionEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** Everything Tab may reach inside a layer. */
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/** 当前真的能落焦点的按钮/输入框（fixed 元素自己的 offsetParent 是 null，用布局盒判断）。 */
function focusablesIn(layer: HTMLElement | null): HTMLElement[] {
  return [...(layer?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
    .filter(node => node.getClientRects().length > 0)
}

/**
 * 遮罩用宿主的 `bg-mask-3`（亮暗同值 #0000007a）。**不要**再用
 * `label-primary` 调透明度：那枚 token 暗色下是近白，整页会被洗成中灰。
 * 进场只动 transform / opacity，reduce 下全关。
 */
const CSS = `
.tpm-overlay{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-3);animation:tpm-fade .16s ease both}
.tpm-dialog{animation:tpm-rise .2s cubic-bezier(.22,1,.36,1) both}
.tpm-anchor{position:fixed;z-index:1200}
.tpm-pop{animation:tpm-pop .16s cubic-bezier(.22,1,.36,1) both}
@keyframes tpm-fade{from{opacity:0}}
@keyframes tpm-rise{from{opacity:0;transform:translateY(8px)}}
@keyframes tpm-pop{from{opacity:0;transform:translateY(-3px)}}
@media (prefers-reduced-motion: reduce){.tpm-overlay,.tpm-dialog,.tpm-pop{animation:none}}
`

let cssInjected = false
function injectCss(): void {
  if (cssInjected || typeof document === 'undefined') return
  cssInjected = true
  const id = 'tool-plus-modal-shell'
  if (document.querySelector('style[data-plugin-css="' + id + '"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@xiaoso/dsh-tool-plus'
  tag.dataset.pluginCss = id
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/** 锚定位置（视口坐标）：卡片右缘到视口右缘的距离、上缘到视口上缘、是否向上翻。 */
export interface ModalPosition {
  top: number
  right: number
  above: boolean
}

export type ModalShellProps = {
  role: 'dialog' | 'alertdialog' | 'group'
  /** 读屏用的名字（没有可见标题的确认卡尤其需要）。 */
  ariaLabel: string
  /** 调用方自己的外观类；壳只负责行为与进出场。 */
  className?: string
  /** 额外样式（popover 用来限制卡片宽度）。 */
  style?: CSSProperties
  /** Esc、点遮罩（dialog）、点外面（popover）都走这里。 */
  onRequestClose: () => void
  /**
   * 有请求在飞时传 false：Esc 仍然被吞掉（不能穿透去关设置抽屉），但不关闭；
   * 遮罩/外面也不响应。默认 true。
   */
  dismissible?: boolean
  /** 打开后焦点落在哪；默认第一个可聚焦元素。 */
  initialFocus?: () => HTMLElement | null | undefined
  children: ReactNode
} & (
  | { variant: 'dialog' }
  | {
    variant: 'popover'
    /** 锚点位置；坐标为视口坐标，由调用方按锚点矩形实时算。 */
    position: ModalPosition
  }
)

/**
 * Render a layer that owns the keyboard while it is open.
 *
 * - Tab 在 capture 阶段被接管：宿主设置抽屉在 document 冒泡阶段做自己的 Tab
 *   圈定，晚一步焦点就被拽回抽屉。
 * - Esc 在 document 的 capture 阶段停掉：抽屉也听 Esc，不拦会一层 Esc 关两层。
 * - 卸载时把焦点还给打开它的控件（焦点若已被人挪走则不动）。
 */
export function ModalShell(props: ModalShellProps): ReactNode {
  const { role, ariaLabel, className, style, onRequestClose, dismissible = true, initialFocus, children } = props
  const layerRef = useRef<HTMLDivElement | null>(null)
  /** 打开浮层的控件；关闭时焦点回到这里。 */
  const opener = useRef<HTMLElement | null>(null)
  /** 每轮渲染取最新回调，键盘监听只注册一次，避免开着时反复摘挂。 */
  const closeCallback = useRef(onRequestClose)
  closeCallback.current = onRequestClose
  const dismissibleRef = useRef(dismissible)
  dismissibleRef.current = dismissible
  const focusTarget = useRef(initialFocus)
  focusTarget.current = initialFocus

  // useInsertionEffect：样式必须在首帧绘制前就位，否则浮层会先以未定位的
  // 普通 div 画一帧再跳到居中。
  useInsertionEffect(() => { injectCss() }, [])

  useLayoutEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // 同步聚焦：等到下一帧再聚焦的话，第一帧的 Tab 会漏到背后的设置页。
    const target = focusTarget.current?.() ?? layerRef.current?.querySelector<HTMLElement>(FOCUSABLE)
    target?.focus()
    return () => {
      const back = opener.current
      // 只有焦点还在浮层里、或者已经掉到 body 上时才抢回来：别的时候
      // （例如抽屉自己把焦点挪去了别处）说明有别的意图，不能覆盖。
      const active = document.activeElement
      const owned = active === null
        || active === document.body
        || layerRef.current?.contains(active) === true
      if (owned && back !== null && back.isConnected) back.focus()
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // 输入法组合中的 Esc 属于输入法（撤销候选）：既不关浮层，也不让它冒到
      // 设置抽屉去关整页。只 stopPropagation 不 preventDefault，输入法自己的
      // 默认处理（撤掉候选）照常发生。
      if (event.isComposing || event.keyCode === 229) {
        event.stopPropagation()
        return
      }
      // capture + stopPropagation：宿主抽屉也在 document 上听 Esc。
      event.stopPropagation()
      event.preventDefault()
      if (!dismissibleRef.current) return
      closeCallback.current()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  // 锚在控件旁的小卡没有遮罩：点别处就收起，否则它会一直挂在页面上。
  useEffect(() => {
    if (props.variant !== 'popover') return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && layerRef.current?.contains(target) === true) return
      if (!dismissibleRef.current) return
      closeCallback.current()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [props.variant])

  /**
   * Keep Tab inside the layer, in the capture phase on purpose.
   *
   * 和 CommandDialog 同一套写法：stop 与 wrap 必须在同一个 capture handler
   * 里完成——另开一个 capture 监听去 stopPropagation，会连带把本元素的冒泡
   * 处理器一起掐掉，两个监听器互相看不见。
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab') return
    event.stopPropagation()
    const nodes = focusablesIn(layerRef.current)
    if (nodes.length === 0) return
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    const current = document.activeElement as HTMLElement | null
    if (event.shiftKey && (current === first || current === null || !nodes.includes(current))) {
      event.preventDefault()
      last.focus()
      return
    }
    if (!event.shiftKey && (current === last || current === null || !nodes.includes(current))) {
      event.preventDefault()
      first.focus()
    }
  }

  /**
   * Focus can still fall to <body> without any Tab: a focused button that gets
   * disabled (the in-flight request) is detached from focus by the browser. The
   * element-level handler above never sees that event, because it targets body,
   * so pull the keyboard back in from here. When the target is inside the layer
   * this listener does nothing and lets the handler above own the event.
   */
  useEffect(() => {
    const onTab = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const host = layerRef.current
      if (host === null) return
      const target = event.target
      if (target instanceof Node && host.contains(target)) return
      const nodes = focusablesIn(host)
      if (nodes.length === 0) return
      event.stopPropagation()
      event.preventDefault()
      const next = event.shiftKey ? nodes[nodes.length - 1] : nodes[0]
      next.focus()
    }
    document.addEventListener('keydown', onTab, true)
    return () => document.removeEventListener('keydown', onTab, true)
  }, [])

  if (typeof document === 'undefined') return null

  if (props.variant === 'popover') {
    const { position } = props
    return createPortal(
      <div
        className="tpm-anchor"
        style={{
          top: position.top,
          right: position.right,
          // 位置层与动画层分开：向上翻的位移挂在锚点壳上，动画在里层。
          // 两者挤在同一个元素上时，animation 的 transform 会覆盖定位位移
          // （预设说明卡向上翻失效就是这么来的）。
          transform: position.above ? 'translateY(-100%)' : undefined,
          ...style,
        }}
        onKeyDownCapture={onKeyDown}
      >
        <div className="tpm-pop">
          <div ref={layerRef} role={role} aria-label={ariaLabel} className={className}>
            {children}
          </div>
        </div>
      </div>,
      document.body,
    )
  }

  return createPortal(
    <div
      className="tpm-overlay"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return
        // Keep focus where it was: the default mousedown blurs the editor and
        // the confirm bar then opens on <body>, so the keyboard path (Esc) and
        // the pointer path would land in different places.
        event.preventDefault()
        if (!dismissibleRef.current) return
        closeCallback.current()
      }}
    >
      <div
        ref={layerRef}
        className={className === undefined ? 'tpm-dialog' : className + ' tpm-dialog'}
        role={role}
        aria-modal="true"
        aria-label={ariaLabel}
        onKeyDownCapture={onKeyDown}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}
