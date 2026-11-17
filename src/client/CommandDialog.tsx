/**
 * The command panel as a large modal.
 *
 * The settings pane is ~760px wide; a two-column list + detail with a 1337-row
 * virtual list needs more room than that. The panel therefore opens as its own
 * dialog (portal to `body`, above the settings drawer) sized to the viewport,
 * and the Bash tab keeps a one-row entry that launches it.
 * @module @xiaoso/dsh-tool-plus/client
 */

import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CommandPanel } from './CommandPanel.tsx'
import type { BashPlusLocaleKey } from './locales.ts'

/**
 * Render the command dialog.
 * @param props.t - locale lookup.
 * @param props.writable - whether this deployment can save choices.
 * @param props.onClose - close the dialog (Esc, backdrop, close button).
 */
export function CommandDialog(props: { t: (key: BashPlusLocaleKey) => string; writable: boolean; onClose: () => void }): ReactNode {
  const { t, writable, onClose } = props
  const closeRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Capture phase + stopPropagation: the settings dialog underneath listens
      // for Escape on its own and would close the whole page along with us.
      event.stopPropagation()
      event.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    const timer = window.setTimeout(() => closeRef.current?.focus(), 30)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      className="tpc-overlay"
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div className="tpc-dialog" role="dialog" aria-modal="true" aria-label={t('cmdPanelTitle')}>
        <div className="tpc-dialogHead">
          <h3 className="tpc-dialogTitle">{t('cmdPanelTitle')}</h3>
          <button ref={closeRef} type="button" className="tpc-btn" onClick={onClose}>{t('cmdClose')}</button>
        </div>
        <CommandPanel t={t} writable={writable} variant="dialog" />
      </div>
    </div>,
    document.body,
  )
}
