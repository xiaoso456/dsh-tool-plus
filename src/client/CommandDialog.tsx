/**
 * Mount the command panel as a modal.
 *
 * The settings pane is ~760px wide; a two-column list + detail over a 1337-row
 * virtual list needs more room than that, so the panel opens as its own dialog
 * (portal to `body`, above the settings drawer). This module owns only the
 * portal and the keyboard contract: while it is mounted, Tab cannot leave the
 * panel, and the element that opened it gets focus back on close. Everything
 * the user can see or dismiss lives in {@link CommandPanel}, which keeps the
 * three exit paths (Esc, backdrop, `关闭`) on one shared guard.
 * @module @xiaoso/dsh-tool-plus/client
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CommandPanel } from './CommandPanel.tsx'
import { isTopLayer, popLayer, pushLayer } from './layer-stack.ts'
import type { BashPlusLocaleKey } from './locales.ts'

/** Everything Tab is allowed to reach inside the dialog. */
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/**
 * Render the command dialog.
 * @param props.t - locale lookup.
 * @param props.writable - whether this deployment can save choices.
 * @param props.onClose - unmount the dialog.
 */
export function CommandDialog(props: { t: (key: BashPlusLocaleKey) => string; writable: boolean; onClose: () => void }): ReactNode {
  /** 本层在浮层栈里的身份：命令面板里还能再开浏览弹窗，键盘归属按栈顶算。 */
  const layer = useRef<object>({}).current
  useLayoutEffect(() => {
    pushLayer(layer)
    return () => popLayer(layer)
  }, [layer])

  const { t, writable, onClose } = props
  const hostRef = useRef<HTMLDivElement | null>(null)
  /** The control that opened the panel; focus returns here on close. */
  const opener = useRef<HTMLElement | null>(null)
  const [closing, setClosing] = useState(false)
  const closeTimer = useRef<number | null>(null)

  /**
   * Play the exit before unmounting.
   *
   * The panel used to vanish on the first frame (5ms after the click), which
   * reads as a glitch rather than a close. The dismissal is deferred by the
   * length of the exit animation; reduced-motion closes immediately.
   */
  const requestClose = useCallback((): void => {
    if (closing) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onClose()
      return
    }
    setClosing(true)
    // 退场交给 opacity 过渡本身：transitionend 一到就卸载。固定 sleep 的时长得
    // 猜，长了拖沓，短了会截断动画。
    const overlay = hostRef.current?.querySelector<HTMLElement>('.tpc-overlay') ?? null
    const finish = (): void => {
      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current)
        closeTimer.current = null
      }
      overlay?.removeEventListener('transitionend', onEnd)
      onClose()
    }
    const onEnd = (event: TransitionEvent): void => {
      if (event.target !== overlay || event.propertyName !== 'opacity') return
      finish()
    }
    overlay?.addEventListener('transitionend', onEnd)
    closeTimer.current = window.setTimeout(finish, 260)
  }, [closing, onClose])

  useEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const timer = window.setTimeout(() => {
      // The panel's main input, not the header's 关闭 button: a keyboard user
      // who opens this panel almost always came to type a command name.
      const target = hostRef.current?.querySelector<HTMLElement>('[data-autofocus]')
        ?? hostRef.current?.querySelector<HTMLElement>(FOCUSABLE)
      target?.focus()
    }, 30)
    return () => {
      window.clearTimeout(timer)
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
      const back = opener.current
      // Only steal focus back if the panel still owns it: the settings drawer
      // may have legitimately moved focus elsewhere in the meantime.
      const owned = document.activeElement === null
        || document.activeElement === document.body
        || hostRef.current?.contains(document.activeElement) === true
      if (owned && back !== null && back.isConnected) back.focus()
    }
  }, [])

  /**
   * Keep Tab inside the panel, in the capture phase on purpose.
   *
   * The settings dialog underneath runs its own Tab cycle at the document's
   * bubble phase and yanks focus back the moment it sees Tab, so the event is
   * stopped here before it can reach it. Both the wrap and the stop live in the
   * same capture handler: stopping the event in a separate capture listener
   * would also suppress this element's own bubble handler.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab') return
    // 上面还有一层（浏览弹窗）：它的焦点不在这棵子树里，这里既不能圈、也不能
    // 夺；否则外层的「不在我的可聚焦列表里就拽回第一个」会把焦点抢走。
    if (!isTopLayer(layer)) return
    event.stopPropagation()
    const nodes = [...(hostRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
      .filter(node => node.offsetParent !== null || node === document.activeElement)
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

  if (typeof document === 'undefined') return null

  return createPortal(
    <div ref={hostRef} onKeyDownCapture={onKeyDown}>
      <CommandPanel t={t} writable={writable} variant="dialog" onClose={requestClose} closing={closing} />
    </div>,
    document.body,
  )
}
