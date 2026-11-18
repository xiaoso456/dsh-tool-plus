/**
 * Bash init-script row + editor dialog (issue #5).
 *
 * The row lives in the Bash tab and reports which content a shell would
 * source right now (built-in default vs. the user's copy). The dialog edits
 * that copy, offers 恢复默认, and 试运行 spawns a real shell that sources the
 * draft so PATH and bash resolution are visible before saving.
 *
 * 三条退出路径（Esc、遮罩、取消）统一走 `requestClose`：有未保存草稿时先问，
 * 请求进行中不让关；键盘契约（Tab 圈定、Esc 归属、焦点归还）在
 * `modal-shell.tsx`，这里只留业务。
 * @module @xiaoso/dsh-tool-plus/client
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
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
import { ModalShell } from './modal-shell.tsx'
import { ToggleRow, type ToggleControl } from './rows.tsx'
import type { BashPlusLocaleKey } from './locales.ts'

const CSS_LINES = [
  '.tpb-button{appearance:none;flex:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 12px;font:inherit;font-size:13px;line-height:1.5;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:color .16s ease,border-color .16s ease,background .16s ease,transform .1s ease}',
  '.tpb-button:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l4)}',
  '.tpb-button:active:not(:disabled){transform:scale(.97)}',
  '.tpb-button:disabled{opacity:.45;cursor:default}',
  '.tpb-button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
  '.tpb-button.tpb-primary{background:var(--dsw-alias-label-primary);border-color:transparent;color:var(--dsw-alias-bg-layer-3)}',
  '.tpb-button.tpb-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-bg-layer-3)}',
  /* 破坏性动作静止态与邻居同款，只在悬停时变危险色：重点靠二次确认文案说清，
     而不是在整排按钮里摆一个红按钮（宿主的 reject/remove 都是这么做的）。 */
  '.tpb-button.tpb-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);border-color:transparent}',
  '.tpb-statusLine{display:flex;align-items:center;gap:8px;min-width:0}',
  '.tpb-statusDot{flex:none;width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-label-tertiary)}',
  '.tpb-statusDot[data-error="true"]{background:var(--dsw-alias-state-error-primary)}',
  '.tpb-error{color:var(--dsw-alias-state-error-primary)}',
  '.tpb-dialog{position:relative;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;width:min(760px,100%);max-height:min(84vh,760px);overflow-y:auto;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1)}',
  '.tpb-dialogTitle{margin:0;font-size:15px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}',
  '.tpb-meta{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);word-break:break-all}',
  '.tpb-editor{box-sizing:border-box;flex:1;min-height:240px;resize:vertical;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-primary);tab-size:2}',
  '.tpb-editor:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
  '.tpb-result{display:flex;flex-direction:column;gap:6px;min-height:0}',
  '.tpb-resultTitle{margin:0;font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary)}',
  '.tpb-pre{flex:none;margin:0;max-height:200px;overflow:auto;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-all}',
  '.tpb-footer{display:flex;align-items:center;gap:8px;justify-content:flex-end;padding-top:4px;border-top:1px solid var(--dsw-alias-border-l1)}',
  '.tpb-footerSpacer{flex:1}',
  '.tpb-notice{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  /* 二次确认条绝对定位盖住 footer：不参与流式布局，出现/消失时对话框尺寸不动。
     和命令面板的 .tpc-confirmBar 同一个做法。 */
  '.tpb-confirmBar{position:absolute;left:16px;right:16px;bottom:16px;z-index:4;display:flex;align-items:center;gap:8px;box-sizing:border-box;padding:10px 12px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,var(--dsw-alias-border-l2));border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
  '.tpb-confirmText{flex:1;min-width:0;margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
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
  onToggle: (field: string, checked: boolean) => void
  onResetField: (field: string) => void
}): ReactNode {
  const { t, disabled, enable, onToggle, onResetField } = props
  const [status, setStatus] = useState<BashInitStatusValue | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<'save' | 'reset' | 'test' | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<BashInitTestValue | null>(null)
  /** 有未保存改动时点关闭：先问，不直接丢。 */
  const [closeConfirm, setCloseConfirm] = useState(false)
  /** 「恢复默认」会删磁盘上的脚本文件：原地二次确认。 */
  const [resetConfirm, setResetConfirm] = useState(false)
  const editorRef = useRef<HTMLTextAreaElement | null>(null)
  const keepEditingRef = useRef<HTMLButtonElement | null>(null)
  const resetRef = useRef<HTMLButtonElement | null>(null)
  const resetCancelRef = useRef<HTMLButtonElement | null>(null)

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

  const savedContent = status?.content ?? ''
  // The only definition of "unsaved": the draft no longer matches the bytes a
  // shell would source now. Saving/resetting updates status and draft together,
  // so the guard clears by itself after a successful write.
  const unsaved = draft !== savedContent

  const closeDialog = useCallback((): void => {
    setOpen(false)
    setCloseConfirm(false)
    setResetConfirm(false)
  }, [])

  // Esc, the 取消 button and a backdrop click all land here. With an edit in
  // flight the dialog asks first: the draft lives in React state only, so
  // closing would drop it without recovery.
  const requestClose = useCallback((): void => {
    // A request in flight owns the result: closing now would throw it away.
    if (busy !== null) return
    if (resetConfirm) {
      setResetConfirm(false)
      return
    }
    if (closeConfirm) {
      setCloseConfirm(false)
      return
    }
    if (unsaved) {
      setCloseConfirm(true)
      return
    }
    closeDialog()
  }, [busy, resetConfirm, closeConfirm, unsaved, closeDialog])

  useEffect(() => {
    if (!unsaved && closeConfirm) setCloseConfirm(false)
  }, [unsaved, closeConfirm])

  // The confirm bar covers the footer, whose buttons are disabled while it is
  // up; the focused node can therefore be unmounted or disabled at any moment.
  // Hand focus to the safe choice on the way in, and back to the editor (or the
  // 恢复默认 button) on the way out.
  const closeConfirmPrev = useRef(false)
  useEffect(() => {
    if (closeConfirm && !closeConfirmPrev.current) keepEditingRef.current?.focus()
    else if (!closeConfirm && closeConfirmPrev.current) editorRef.current?.focus()
    closeConfirmPrev.current = closeConfirm
  }, [closeConfirm])

  const resetConfirmPrev = useRef(false)
  useEffect(() => {
    if (resetConfirm && !resetConfirmPrev.current) resetCancelRef.current?.focus()
    else if (!resetConfirm && resetConfirmPrev.current) resetRef.current?.focus()
    resetConfirmPrev.current = resetConfirm
  }, [resetConfirm])

  const openDialog = async (): Promise<void> => {
    // The path field can change while the row is mounted, so read the script
    // before opening: the draft must be the bytes a shell would source now,
    // not whatever the row last saw.
    const fresh = await refresh()
    setDraft(fresh?.content ?? status?.content ?? '')
    setTestResult(null)
    setNotice(null)
    setActionError(null)
    setCloseConfirm(false)
    setResetConfirm(false)
    setOpen(true)
  }

  const save = async (): Promise<void> => {
    if (busy !== null) return
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
    // 确认条上的危险按钮在请求期间不禁用（禁用了被聚焦的节点会被摘掉焦点），
    // 双击由这里挡住。
    if (busy !== null) return
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
    setResetConfirm(false)
  }

  const runTest = async (): Promise<void> => {
    if (busy !== null) return
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

  /** 确认条占着 footer 时，footer 的按钮一并禁用：既防止落到被盖住的按钮上，
      也免得两个请求叠着发。 */
  const footerBusy = busy !== null || closeConfirm || resetConfirm

  return (
    <>
      {row}
      <ModalShell
        variant="dialog"
        role="dialog"
        ariaLabel={t('bashInitDialogTitle')}
        className="tpb-dialog"
        onRequestClose={requestClose}
        dismissible={busy === null}
        initialFocus={() => editorRef.current}
      >
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
          {notice !== null ? <p className="tpb-notice" role="status" aria-live="polite">{notice}</p> : null}
          {actionError !== null ? <p className="tpb-notice tpb-error" role="alert">{t('bashInitFailed')}: {actionError}</p> : null}
          <span className="tpb-footerSpacer" />
          <button type="button" className="tpb-button" onClick={requestClose} disabled={footerBusy}>
            {t('bashInitCancel')}
          </button>
          <button type="button" className="tpb-button" onClick={() => void runTest()} disabled={footerBusy}>
            {busy === 'test' ? t('bashInitRunning') : t('bashInitRun')}
          </button>
          <button ref={resetRef} type="button" className="tpb-button" onClick={() => setResetConfirm(true)} disabled={footerBusy}>
            {t('bashInitReset')}
          </button>
          <button type="button" className="tpb-button tpb-primary" onClick={() => void save()} disabled={footerBusy}>
            {busy === 'save' ? t('bashInitSaving') : t('bashInitSave')}
          </button>
        </div>
        {closeConfirm
          ? (
            <div className="tpb-confirmBar" role="group">
              <p className="tpb-confirmText" role="alert">{t('cmdCloseHint')}</p>
              <button ref={keepEditingRef} type="button" className="tpb-button" onClick={() => setCloseConfirm(false)}>
                {t('cmdCloseKeep')}
              </button>
              <button type="button" className="tpb-button tpb-danger" onClick={closeDialog}>
                {t('cmdCloseDiscard')}
              </button>
            </div>
          )
          : null}
        {resetConfirm
          ? (
            <div className="tpb-confirmBar" role="group">
              <p className="tpb-confirmText" role="alert">{t('bashInitResetConfirm')}</p>
              <button ref={resetCancelRef} type="button" className="tpb-button" onClick={() => setResetConfirm(false)}>
                {t('bashInitResetKeep')}
              </button>
              <button
                type="button"
                className="tpb-button tpb-danger"
                onClick={() => void reset()}
              >
                {busy === 'reset' ? t('bashInitRunning') : t('bashInitResetConfirmYes')}
              </button>
            </div>
          )
          : null}
      </ModalShell>
    </>
  )
}
