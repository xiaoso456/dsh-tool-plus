/**
 * Bash init-script row + editor dialog (issue #5).
 *
 * The row lives in the Bash tab and reports which content a shell would
 * source right now (built-in default vs. the user's copy). The dialog edits
 * that copy, offers 恢复默认, and 试运行 spawns a real shell that sources the
 * draft so PATH and bash resolution are visible before saving.
 * @module @xiaoso/dsh-tool-plus/client
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  BASH_INIT_RESET_ENDPOINT,
  BASH_INIT_SAVE_ENDPOINT,
  BASH_INIT_STATUS_ENDPOINT,
  BASH_INIT_TEST_ENDPOINT,
  TOOL_PLUS_RPC_CHANNEL,
  type BashInitStatusValue,
  type BashInitTestValue,
} from '../tools/shared/browser-rpc-channel.ts'
import { createWebConnectionRpc } from './web-connection-rpc.ts'
import { TextRow, ToggleRow, type TextControl, type ToggleControl } from './rows.tsx'
import type { BashPlusLocaleKey } from './locales.ts'

const CSS_LINES = [
  '.tpb-button{appearance:none;flex:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 12px;font:inherit;font-size:13px;line-height:1.5;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:color .16s ease,border-color .16s ease,background .16s ease,transform .1s ease}',
  '.tpb-button:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l4)}',
  '.tpb-button:active:not(:disabled){transform:scale(.97)}',
  '.tpb-button:disabled{opacity:.45;cursor:default}',
  '.tpb-button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
  '.tpb-button.tpb-primary{background:var(--dsw-alias-label-primary);border-color:transparent;color:var(--dsw-alias-bg-layer-3)}',
  '.tpb-button.tpb-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-bg-layer-3)}',
  '.tpb-statusLine{display:flex;align-items:center;gap:8px;min-width:0}',
  '.tpb-statusDot{flex:none;width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-label-tertiary)}',
  '.tpb-statusDot[data-error="true"]{background:var(--dsw-alias-state-error-primary)}',
  '.tpb-error{color:var(--dsw-alias-state-error-primary)}',
  '.tpb-overlay{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 45%, transparent)}',
  '.tpb-dialog{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;width:min(760px,100%);max-height:min(84vh,760px);padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1)}',
  '.tpb-dialogTitle{margin:0;font-size:15px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}',
  '.tpb-meta{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);word-break:break-all}',
  '.tpb-editor{box-sizing:border-box;flex:1;min-height:240px;resize:vertical;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-primary);tab-size:2}',
  '.tpb-editor:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
  '.tpb-result{display:flex;flex-direction:column;gap:6px;min-height:0}',
  '.tpb-resultTitle{margin:0;font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary)}',
  '.tpb-pre{margin:0;max-height:200px;overflow:auto;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-all}',
  '.tpb-footer{display:flex;align-items:center;gap:8px;justify-content:flex-end;padding-top:4px;border-top:1px solid var(--dsw-alias-border-l1)}',
  '.tpb-footerSpacer{flex:1}',
  '.tpb-notice{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  '@media (prefers-reduced-motion: reduce){.tpb-button{transition:none}}',
]
const CSS = CSS_LINES.join('\n')

let cssInjected = false
function injectCss(): void {
  if (cssInjected || typeof document === 'undefined') return
  cssInjected = true
  if (document.querySelector('style[data-plugin-css="tool-plus-bash-init"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@xiaoso/dsh-tool-plus'
  tag.dataset.pluginCss = 'tool-plus-bash-init'
  tag.textContent = CSS
  document.head.appendChild(tag)
}

type RpcResult<T> = { ok: true; value: T } | { ok: false; message: string }

async function callRpc<T>(endpoint: string, payload: unknown): Promise<RpcResult<T>> {
  const rpc = createWebConnectionRpc()
  const result = await rpc.call(TOOL_PLUS_RPC_CHANNEL, endpoint, payload)
  if (!result.ok) return { ok: false, message: result.error.message }
  return { ok: true, value: result.value as T }
}

/**
 * One group in the Bash tab: the feature's own switch and script path, the
 * effective-script row, and the editor dialog.
 */
export function BashInitPanel(props: {
  t: (key: BashPlusLocaleKey) => string
  disabled: boolean
  /** Enable switch, rendered here instead of the generic 行为 group. */
  enable?: ToggleControl
  /** Script path field, same reason. */
  scriptPath?: TextControl
  onToggle: (field: string, checked: boolean) => void
  onEditText: (field: string, text: string) => void
  onResetField: (field: string) => void
}): ReactNode {
  const { t, disabled, enable, scriptPath, onToggle, onEditText, onResetField } = props
  const [status, setStatus] = useState<BashInitStatusValue | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<'save' | 'reset' | 'test' | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<BashInitTestValue | null>(null)
  const editorRef = useRef<HTMLTextAreaElement | null>(null)

  const refresh = useCallback(async (): Promise<BashInitStatusValue | null> => {
    const result = await callRpc<BashInitStatusValue>(BASH_INIT_STATUS_ENDPOINT, {})
    if (!result.ok) {
      setLoadError(result.message)
      return null
    }
    setLoadError(null)
    setStatus(result.value)
    return result.value
  }, [])

  useEffect(() => {
    injectCss()
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    const timer = window.setTimeout(() => editorRef.current?.focus(), 30)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.clearTimeout(timer)
    }
  }, [open])

  const openDialog = async (): Promise<void> => {
    // The path field can change while the row is mounted, so read the script
    // before opening: the draft must be the bytes a shell would source now,
    // not whatever the row last saw.
    const fresh = await refresh()
    setDraft(fresh?.content ?? status?.content ?? '')
    setTestResult(null)
    setNotice(null)
    setActionError(null)
    setOpen(true)
  }

  const save = async (): Promise<void> => {
    setBusy('save')
    setActionError(null)
    const result = await callRpc<BashInitStatusValue>(BASH_INIT_SAVE_ENDPOINT, { content: draft })
    setBusy(null)
    if (!result.ok) {
      setActionError(result.message)
      return
    }
    // The endpoint answers with the post-write state: one round trip, no
    // second read that could observe a different file.
    setLoadError(null)
    setStatus(result.value)
    setNotice(t('bashInitSaved'))
  }

  const reset = async (): Promise<void> => {
    setBusy('reset')
    setActionError(null)
    const result = await callRpc<BashInitStatusValue>(BASH_INIT_RESET_ENDPOINT, {})
    setBusy(null)
    if (!result.ok) {
      setActionError(result.message)
      return
    }
    setLoadError(null)
    setStatus(result.value)
    setDraft(result.value.content)
    setNotice(t('bashInitResetDone'))
    setTestResult(null)
  }

  const runTest = async (): Promise<void> => {
    setBusy('test')
    setActionError(null)
    const result = await callRpc<BashInitTestValue>(BASH_INIT_TEST_ENDPOINT, { content: draft })
    setBusy(null)
    if (!result.ok) {
      setActionError(result.message)
      return
    }
    setTestResult(result.value)
  }

  const statusText = ((): string => {
    if (loadError !== null) return loadError
    if (status === null) return t('bashInitLoading')
    if (!status.enabled) return t('bashInitStatusDisabled')
    const label = status.source === 'user' ? t('bashInitStatusUser') : t('bashInitStatusDefault')
    return label + ' · ' + status.path
  })()

  const row = (
    <section className="tps-group">
      <h4 className="tps-groupTitle">{t('bashInitGroup')}</h4>
      <div className="tps-card">
        {enable !== undefined
          ? <ToggleRow t={t} control={enable} disabled={disabled} onToggle={onToggle} onReset={onResetField} />
          : null}
        {scriptPath !== undefined
          ? <TextRow t={t} control={scriptPath} disabled={disabled} onEdit={onEditText} onReset={onResetField} />
          : null}
        <div className="tp-row">
          <div className="tp-rowText">
            <span className="tp-rowTitle">{t('bashInitRowTitle')}</span>
            <span className={'tp-rowDesc' + (loadError !== null || status?.lastError !== undefined ? ' tpb-error' : '')}>
              {statusText}
            </span>
          </div>
          <button type="button" className="tpb-button" onClick={openDialog} disabled={status === null && loadError === null}>
            {t('bashInitEdit')}
          </button>
        </div>
      </div>
    </section>
  )

  if (!open || typeof document === 'undefined') return row

  const dialog = createPortal(
    <div
      className="tpb-overlay"
      onClick={(event) => { if (event.target === event.currentTarget) setOpen(false) }}
    >
      <div className="tpb-dialog" role="dialog" aria-modal="true" aria-label={t('bashInitDialogTitle')}>
        <h3 className="tpb-dialogTitle">{t('bashInitDialogTitle')}</h3>
        <p className="tpb-meta">
          {t('bashInitPath')}: {status?.path ?? ''}
        </p>
        {status !== null && !status.enabled ? <p className="tpb-meta">{t('bashInitEnableHint')}</p> : null}
        {status?.lastError ? <pre className="tpb-pre">{status.lastError}</pre> : null}
        <textarea
          ref={editorRef}
          className="tpb-editor"
          spellCheck={false}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        {testResult !== null
          ? (
            <div className="tpb-result">
              <p className="tpb-resultTitle">
                {t('bashInitResultTitle')} · exit {testResult.exitCode ?? '-'} · {testResult.durationMs}ms
              </p>
              {testResult.output.trim().length > 0
                ? <pre className="tpb-pre">{testResult.output}</pre>
                : <p className="tpb-meta">{testResult.exitCode === 0 ? t('bashInitNoOutput') : t('bashInitNoOutputNonZero')}</p>}
            </div>
          )
          : null}
        <div className="tpb-footer">
          {notice !== null ? <p className="tpb-notice">{notice}</p> : null}
          {actionError !== null ? <p className="tpb-notice tpb-error">{t('bashInitFailed')}: {actionError}</p> : null}
          <span className="tpb-footerSpacer" />
          <button type="button" className="tpb-button" onClick={() => { setOpen(false) }} disabled={busy !== null}>
            {t('bashInitCancel')}
          </button>
          <button type="button" className="tpb-button" onClick={() => void runTest()} disabled={busy !== null}>
            {busy === 'test' ? t('bashInitRunning') : t('bashInitRun')}
          </button>
          <button type="button" className="tpb-button" onClick={() => void reset()} disabled={busy !== null}>
            {t('bashInitReset')}
          </button>
          <button type="button" className="tpb-button tpb-primary" onClick={() => void save()} disabled={busy !== null}>
            {busy === 'save' ? t('bashInitSaving') : t('bashInitSave')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )

  return (
    <>
      {row}
      {dialog}
    </>
  )
}
