/**
 * 被截断文本的悬停提示（自绘，不用原生 `title`）。
 *
 * 原生 title 有三个毛病：只在真被截断时才该出现却总是出现、要等约一秒、样式和
 * 位置不受控。这里只在 `scrollWidth > clientWidth` 时才出提示，走门户 + fixed
 * 定位，不会被浮层的 `overflow:hidden` 裁掉，亮暗都只用宿主 token。
 *
 * 只用于**只读的、被 ellipsis 截断的**文本（命令名、路径）。可交互元素不要套，
 * 会吞掉 hover 语义。
 * @module @xiaoso/dsh-tool-plus/client
 */

import { useEffect, useInsertionEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const CSS = `
.tpt-tip{position:fixed;z-index:1400;box-sizing:border-box;max-width:320px;padding:5px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;line-height:17px;white-space:normal;overflow-wrap:anywhere;pointer-events:none;animation:tpt-in .12s ease both}
@keyframes tpt-in{from{opacity:0}}
@media (prefers-reduced-motion: reduce){.tpt-tip{animation:none}}
`

let cssInjected = false
function injectCss(): void {
  if (cssInjected || typeof document === 'undefined') return
  cssInjected = true
  const id = 'tool-plus-tooltip'
  if (document.querySelector('style[data-plugin-css="' + id + '"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@xiaoso/dsh-tool-plus'
  tag.dataset.pluginCss = id
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/** 提示卡相对视口的位置；`above` 为真时用 translateY(-100%) 向上收。 */
type TipBox = { left: number; top: number; above: boolean }

/** 悬停后多久出提示，跟系统 tooltip 的节奏对齐，但不至于要等一秒。 */
const SHOW_DELAY_MS = 320

/** 提示卡最大宽度 + 视口边距，用于夹取 left。 */
const TIP_MAX_WIDTH = 320
const VIEWPORT_PAD = 8

/**
 * 一段可能被 ellipsis 截断的文本：真截断了才在悬停/聚焦时出提示。
 *
 * @param props.text - 完整文本（提示里显示这一份）。
 * @param props.className - 作用在文本元素上的类（该元素负责 ellipsis）。
 * @param props.children - 元素里要显示的（可能是缩短版）；不给就用 `text`。
 * @param props.always - 元素里显示的是 `text` 的缩写（长度上不会溢出 CSS），
 *   所以「有没有被截断」量不出来：给真就一直出提示。路径行就是这种。
 */
export function ClippedText(props: { text: string; className?: string; always?: boolean; children?: ReactNode }): ReactNode {
  const { text, className, always = false, children } = props
  const ref = useRef<HTMLSpanElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [box, setBox] = useState<TipBox | null>(null)
  useInsertionEffect(injectCss, [])

  const clearTimer = (): void => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }

  const hide = (): void => {
    clearTimer()
    setBox(null)
  }

  const measure = (): void => {
    const element = ref.current
    if (element === null) return
    // 没被截断就不出提示：这是换成自绘之后最实的收益。
    if (!always && element.scrollWidth <= element.clientWidth + 1) return
    const rect = element.getBoundingClientRect()
    const above = rect.bottom + 48 > window.innerHeight
    setBox({
      left: Math.max(VIEWPORT_PAD, Math.min(rect.left, window.innerWidth - TIP_MAX_WIDTH - VIEWPORT_PAD)),
      top: above ? rect.top - 6 : rect.bottom + 6,
      above,
    })
  }

  const schedule = (): void => {
    clearTimer()
    timer.current = setTimeout(measure, SHOW_DELAY_MS)
  }

  // 提示卡是 fixed 的：滚动或改尺寸后原来的坐标就失效了，直接收起。
  useEffect(() => {
    if (box === null) return
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [box])

  useEffect(() => clearTimer, [])

  return (
    <>
      <span
        ref={ref}
        className={className}
        onPointerEnter={schedule}
        onPointerLeave={hide}
        onFocus={schedule}
        onBlur={hide}
      >
        {children ?? text}
      </span>
      {box === null
        ? null
        : createPortal(
            <span
              className="tpt-tip"
              role="tooltip"
              style={{ left: `${box.left}px`, top: `${box.top}px`, transform: box.above ? 'translateY(-100%)' : undefined }}
            >
              {text}
            </span>,
            document.body,
          )}
    </>
  )
}
