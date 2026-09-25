/**
 * 设置页「全局」tab 的第二个分组：**选一份预设、选一份模板、看两件事**。
 *
 * 交互（用户定稿）：
 *   ① 两个选择器 —— 「预设」挑一份既有预设，「对比模板」挑我们随包的哪个模板；
 *   ② 两个状态点 —— 工具行是否已接入本插件（绿/黄/红），以及内容与所选模板
 *      差多少（绿/黄/红）；
 *   ③ 有差异时点「查看差异」开一个弹窗，逐行列出两边各自的值；
 *   ④ 动作按钮与结果行照旧（更新只动冲突行，重置整份覆盖并先备份）。
 *
 * 刻意不显示预设描述（太占地方），也不在正文里铺开差异清单（那是弹窗的活）。
 *
 * 设计约束（设置页是产品界面）：控件全用宿主既有原语（`rows.tsx` 的 `.tp-*`、
 * `Menu` 药丸选择器、`Modal` 弹窗），颜色只用 `--dsw-alias-*` token（状态点是
 * `state-{success,warn,error}-primary`），动效只用 opacity/transform、
 * `prefers-reduced-motion` 下全关；文案里不出现破折号。
 * @module @xiaoso/dsh-tool-plus/client
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  IconChevronDownOutlineRegular,
  IconQuestionOutlineRegular,
  Menu,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { TOOL_PLUS_GROUP_LABELS } from '../config/fields.ts'
import { TOOL_PLUS_RPC_CHANNEL } from '../tools/shared/browser-rpc-channel.ts'
import { createWebConnectionRpc } from './web-connection-rpc.ts'
import { injectSettingsRowsCss } from './rows.tsx'
import type { BashPlusLocaleKey } from './locales.ts'
import {
  PRESET_ACTION_ENDPOINT,
  PRESET_COMPARE_ENDPOINT,
  PRESET_STATUS_ENDPOINT,
  presetActionHint,
  presetActionNeedsConfirm,
  presetActionText,
  presetActions,
  presetCompareIndicator,
  presetConfirmText,
  presetDiffRows,
  presetNotes,
  presetOptionLabel,
  presetPendingText,
  presetResultText,
  presetTemplateLabel,
  presetToolIndicator,
  resolveSelectedPresetId,
  resolveSelectedTemplateId,
  type PresetAction,
  type PresetActionResult,
  type PresetCompare,
  type PresetStatus,
  type PresetStatusResult,
  type PresetTemplate,
} from './preset-panel.ts'

/**
 * 这个分组自有的少量样式：状态点、差异弹窗的表格、以及详情块的节奏。
 * 选择器与按钮/徽标全走宿主 `.tp-*`；颜色一律宿主 token。
 */
const CSS = `
.tpp-detail{display:flex;flex-direction:column;gap:8px;padding:12px 0}
.tpp-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}
.tpp-info{flex:1;min-width:min(100%,240px);display:flex;flex-direction:column;gap:2px}
.tpp-name{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary)}
.tpp-id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.tpp-body{margin:0;max-width:65ch;font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-label-tertiary)}
/* 动作一行排开、左对齐（保持原来的节奏）；提示卡相对这一行定位。 */
.tpp-actions{position:relative;display:inline-flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap}
/* 说明卡：位置我们自己定（宿主悬浮卡只会开在锚点右侧，这里右边就是面板边缘），
   外观照宿主 tooltip：底色 --dsw-alias-tooltip-bg + 固定浅色文字（两套主题的 tooltip
   底都是深色，用会翻转的别名前景会在浅色主题下糊成 2:1 对比度）。 */
.tpp-tip{position:fixed;z-index:1100;max-width:44ch;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-tooltip-bg);color:var(--dsw-static-neutral-bluish-50);font-size:12px;line-height:18px;pointer-events:none;animation:tpp-in .16s cubic-bezier(.22,1,.36,1) both}
.tpp-actionButton{display:inline-flex;align-items:center;gap:6px}
.tpp-helpIcon{flex:none;opacity:.72}
/* 危险动作跟宿主自己的写法（approval 的 reject）：静止态与邻居**完全一样**（同为
   次级按钮），只有悬停时才给危险色填充 + 错误色文字；破坏性由「二次确认 + 提示文案」
   明说，而不是在静止态摆一个红按钮出来（那会显得和整排按钮格格不入）。 */
.tpp-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);border-color:transparent}
.tpp-status{display:flex;align-items:center;gap:16px 20px;flex-wrap:wrap;padding:10px 0 2px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.tpp-indicator{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.tpp-dot{flex:none;width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-label-tertiary)}
.tpp-dot[data-tone="ok"]{background:var(--dsw-alias-state-success-primary)}
.tpp-dot[data-tone="warn"]{background:var(--dsw-alias-state-warn-primary)}
.tpp-dot[data-tone="error"]{background:var(--dsw-alias-state-error-primary)}
.tpp-diffButton{margin-left:auto}
.tpp-confirm{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);animation:tpp-in .2s cubic-bezier(.22,1,.36,1) both}
.tpp-confirmText{margin:0;max-width:65ch;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.tpp-confirmActions{display:inline-flex;align-items:center;gap:8px}
.tpp-state{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.tpp-diffBody{max-height:min(62vh,560px);overflow:auto}
.tpp-diffTable{width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px;line-height:18px}
.tpp-diffTable th{position:sticky;top:0;padding:8px 10px;text-align:left;font-weight:500;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}
.tpp-diffTable th:nth-child(1){width:52%}
.tpp-diffTable th:nth-child(2),.tpp-diffTable th:nth-child(3){width:24%}
.tpp-diffTable td{padding:8px 10px;vertical-align:top;color:var(--dsw-alias-label-primary);border-top:1px solid var(--dsw-alias-border-l1);overflow-wrap:anywhere}
.tpp-diffPath{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.tpp-diffDialog.tpp-diffDialog{width:min(880px,92vw);max-width:min(880px,92vw)}
@keyframes tpp-in{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion: reduce){.tpp-confirm{animation:none}}
`

/** 注入预设分组样式一次（沿用仓库既有的 `data-plugin-css` 手法）。 */
let presetCssInjected = false
function injectPresetPanelCss(): void {
  if (presetCssInjected || typeof document === 'undefined') return
  presetCssInjected = true
  const id = 'tool-plus-preset-panel'
  if (document.querySelector('style[data-plugin-css="' + id + '"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@xiaoso/dsh-tool-plus'
  tag.dataset.pluginCss = id
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/** 面板加载阶段；`unavailable` = 读不到状态（不可用时静默降级）。 */
type PresetPhase = 'loading' | 'ready' | 'unavailable'

/** 打开中的选择器（同时最多一个）。 */
type OpenPicker = 'preset' | 'template' | null

/** Render the preset group: two pickers, two status dots, diff dialog, actions. */
export function PresetPanel(props: { t: (key: BashPlusLocaleKey) => string }): ReactNode {
  const { t } = props
  const [phase, setPhase] = useState<PresetPhase>('loading')
  const [presets, setPresets] = useState<readonly PresetStatus[]>([])
  const [templates, setTemplates] = useState<readonly PresetTemplate[]>([])
  /**
   * 本部署有没有可编辑的 profile（宿主 `configEditor` 是否在场）。没有时面板
   * 只读 —— 一个动作都不给，说明行会讲清原因。
   */
  const [writable, setWritable] = useState(true)
  /**
   * 旧版目录机制留下的 `~/.dsh/.agent-presets`（0.1.7 起没有任何代码读它）。
   * 只作为"可以安全删除"的提示展示，不参与任何读写。
   */
  const [legacyRoot, setLegacyRoot] = useState<string | undefined>(undefined)
  const [presetId, setPresetId] = useState<string | undefined>(undefined)
  const [templateId, setTemplateId] = useState<string | undefined>(undefined)
  /** 用户手动挑过模板之后就不再自动跟随预设（否则他刚选的会被覆盖掉）。 */
  const [templatePinned, setTemplatePinned] = useState(false)
  const [compare, setCompare] = useState<PresetCompare | null>(null)
  const [diffOpen, setDiffOpen] = useState(false)
  const [openPicker, setOpenPicker] = useState<OpenPicker>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, { ok: boolean; text: string } | null>>({})
  /** 待二次确认的动作（动作 + 目标预设）；`align` / `revert` 会动到已有内容。 */
  const [confirming, setConfirming] = useState<{ id: string; action: PresetAction } | null>(null)
  /**
   * 悬浮说明：portal 到 body 的 fixed 浮层 + 按按钮实时矩形算出的坐标。
   * 位置不能像之前那样用绝对定位挂在卡片里：设置面板的滚动容器是 `overflow-y:auto`，
   * 长文案换行后超出可视区就被裁掉（用户实测"被遮挡/看不全"）。fixed + portal 才不会
   * 被任何祖先裁切；层高 1100 也在抽屉遮罩（1000）之上。
   */
  const [hinted, setHinted] = useState<{ action: PresetAction; top: number; right: number; above: boolean } | null>(null)

  /** 把说明卡放到按钮下方（视口底部放不下时翻到上方），右缘与按钮右缘对齐。 */
  const showHint = (action: PresetAction, target: HTMLElement): void => {
    const rect = target.getBoundingClientRect()
    const above = rect.bottom + 110 > window.innerHeight
    setHinted({
      action,
      top: above ? rect.top - 6 : rect.bottom + 6,
      right: Math.max(8, window.innerWidth - rect.right),
      above,
    })
  }
  /** 动过一次动作就加一：比较结果据此重拉（内容变了）。 */
  const [revision, setRevision] = useState(0)

  useEffect(() => { injectSettingsRowsCss(); injectPresetPanelCss() }, [])

  /** 拉一次预设状态 + 可选模板；任何失败都降级为「不可用」，不进控制台刷屏。 */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await createWebConnectionRpc().call(TOOL_PLUS_RPC_CHANNEL, PRESET_STATUS_ENDPOINT, {})
      const value = result.ok ? result.value as PresetStatusResult | undefined : undefined
      if (value === undefined || !Array.isArray(value.presets)) {
        setPhase('unavailable')
        return
      }
      // 宿主已经把我们声明的两份（无论 roster 里有没有）按 ours 排在前面，
      // 客户端不再合成"未安装"行：那种行现在写不了，只会误导。
      setPresets(value.presets)
      setTemplates(Array.isArray(value.templates) ? value.templates : [])
      setWritable(value.writable !== false)
      setLegacyRoot(typeof value.legacyPresetRoot === 'string' && value.legacyPresetRoot.length > 0 ? value.legacyPresetRoot : undefined)
      setPhase('ready')
    } catch {
      setPhase('unavailable')
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  // 选中项按数据回落：默认选随包那份；模板默认跟同名模板（ptc 就比 ptc），
  // 用户手动挑过之后不再跟随。
  useEffect(() => { setPresetId(current => resolveSelectedPresetId(presets, current)) }, [presets])
  useEffect(() => {
    setTemplateId(current => resolveSelectedTemplateId(templates, templatePinned ? current : undefined, presetId))
  }, [templates, presetId, templatePinned])

  /** 比较当前这对（预设 × 模板）。只读，失败即无比较结果（两个点回到"检查中"）。 */
  useEffect(() => {
    if (presetId === undefined || templateId === undefined) {
      setCompare(null)
      return
    }
    let cancelled = false
    setCompare(null)
    void (async () => {
      try {
        const result = await createWebConnectionRpc().call(TOOL_PLUS_RPC_CHANNEL, PRESET_COMPARE_ENDPOINT, {
          presetId,
          templateId,
        })
        if (!cancelled) setCompare(result.ok ? result.value as PresetCompare : null)
      } catch {
        if (!cancelled) setCompare(null)
      }
    })()
    return () => { cancelled = true }
  }, [presetId, templateId, revision])

  /** 执行一个动作；成功后重新拉状态与比较（结果行保留，直到下一次动作）。 */
  const runAction = useCallback((preset: PresetStatus, action: PresetAction): void => {
    setConfirming(null)
    setBusyId(preset.id)
    setResults(prev => ({ ...prev, [preset.id]: null }))
    void (async () => {
      try {
        const result = await createWebConnectionRpc().call(
          TOOL_PLUS_RPC_CHANNEL,
          PRESET_ACTION_ENDPOINT,
          { id: preset.id, action, templateId },
        )
        if (!result.ok) {
          setResults(prev => ({
            ...prev,
            [preset.id]: {
              ok: false,
              text: presetResultText(t, {
                ok: false,
                changed: false,
                changes: [],
                reason: result.error.message,
              }, action),
            },
          }))
          return
        }
        const value = result.value as PresetActionResult
        setResults(prev => ({ ...prev, [preset.id]: { ok: value.ok, text: presetResultText(t, value, action) } }))
        if (value.ok) {
          void refresh()
          setRevision(current => current + 1)
        }
      } catch {
        setResults(prev => ({ ...prev, [preset.id]: { ok: false, text: t('presetUnavailable') } }))
      } finally {
        setBusyId(null)
      }
    })()
  }, [t, refresh, templateId])

  const selected = presets.find(preset => preset.id === presetId)
  const selectedTemplate = templates.find(template => template.id === templateId)
  const selectedTemplateLabel = selectedTemplate === undefined ? t('presetEmpty') : presetTemplateLabel(selectedTemplate)
  const toolDot = presetToolIndicator(t, compare)
  const compareDot = presetCompareIndicator(t, compare)
  const diffRows = presetDiffRows(t, compare)
  const canDiff = compare !== null && compare.status === 'ok' && !compare.identical

  /** 一个选择器行：标题 + 宿主药丸下拉。 */
  const picker = (
    key: Exclude<OpenPicker, null>,
    title: string,
    current: string,
    options: readonly { id: string; label: string }[],
    onPick: (id: string) => void,
  ): ReactNode => (
    <div className="tp-row">
      <div className="tp-rowText">
        <div className="tp-rowTitle">{title}</div>
      </div>
      <Menu
        className="tp-selectAnchor"
        open={openPicker === key}
        portal
        align="end"
        onClose={() => setOpenPicker(null)}
        selectedId={current}
        onSelect={(id) => { onPick(id); setOpenPicker(null) }}
        items={options}
        anchor={(
          <button
            type="button"
            className="tp-selectTrigger"
            aria-haspopup="menu"
            aria-expanded={openPicker === key}
            onClick={() => setOpenPicker(open => (open === key ? null : key))}
          >
            <span>{current}</span>
            <IconChevronDownOutlineRegular className="tp-selectChevron" />
          </button>
        )}
      />
    </div>
  )

  /** 选中那份的详情：名称/来源 → 动作 → 说明 → 待改 → 二次确认 → 结果。 */
  const detail = (preset: PresetStatus): ReactNode => {
    const notes = presetNotes(t, preset, writable)
    const actions = presetActions(preset, writable)
    const pending = presetPendingText(t, preset)
    const result = results[preset.id] ?? null
    const running = busyId === preset.id
    const templateLabel = selectedTemplateLabel
    return (
      <div className="tpp-detail" key={preset.id}>
        <div className="tpp-head">
          <div className="tpp-info">
            <div className="tpp-name">{preset.name ?? preset.id}</div>
            <div className="tpp-id">{preset.id}</div>
          </div>
          {actions.length > 0
            ? (
              /* 动作与左侧说明同一行、靠右对齐（原来的排布）；说明卡是 body 上的 fixed
                 浮层（见 showHint），不受这里任何祖先的裁切影响。 */
              <div className="tpp-actions" onMouseLeave={() => setHinted(null)}>
                {actions.map(action => (
                  <button
                    key={action}
                    type="button"
                    className={'tp-actionButton tpp-actionButton' + (action === 'align' ? ' tpp-danger' : '')}
                    disabled={running}
                    {...{ 'aria-description': presetActionHint(t, action, preset, templateLabel) }}
                    onMouseEnter={event => showHint(action, event.currentTarget)}
                    onFocus={event => showHint(action, event.currentTarget)}
                    onBlur={() => setHinted(null)}
                    onClick={() => {
                      // 会动到已有内容的两个动作先原地二次确认：对齐会覆盖你改过的
                      // 插件列表，恢复随包会删掉你的覆盖。最小更新是纯加法，直接执行。
                      if (presetActionNeedsConfirm(action)) setConfirming({ id: preset.id, action })
                      else runAction(preset, action)
                    }}
                  >
                    <span>{running ? t('presetActionWorking') : presetActionText(t, action)}</span>
                    <IconQuestionOutlineRegular className="tpp-helpIcon" />
                  </button>
                ))}
              </div>
            )
            : null}
        </div>
        {notes.map((note, index) => (
          <p className="tpp-body" key={`${preset.id}-note-${index}`}>{note}</p>
        ))}
        {/* 一个位置按优先级轮转：动作结果 > 待改摘要。 */}
        {result !== null
          ? (
            <p className="tp-actionResult" role="status" data-state={result.ok ? 'ok' : 'error'}>
              {result.text}
            </p>
          )
          : null}
        {result === null && pending !== null ? <p className="tpp-state">{pending}</p> : null}
        {confirming !== null && confirming.id === preset.id
          ? (
            <div className="tpp-confirm" role="group" aria-label={t('presetConfirmTitle')}>
              <p className="tpp-confirmText">{presetConfirmText(t, preset, confirming.action, selectedTemplateLabel)}</p>
              <div className="tpp-confirmActions">
                <button
                  type="button"
                  className="tp-actionButton tpp-danger"
                  onClick={() => runAction(preset, confirming.action)}
                >
                  {t('presetConfirmYes')}
                </button>
                <button
                  type="button"
                  className="tp-actionButton"
                  onClick={() => setConfirming(null)}
                >
                  {t('presetConfirmNo')}
                </button>
              </div>
            </div>
          )
          : null}
      </div>
    )
  }

  return (
    <section className="tps-group">
      <h4 className="tps-groupTitle">{t(TOOL_PLUS_GROUP_LABELS.preset ?? 'groupPresets')}</h4>
      {/* 说明卡浮层：挂在 body 上、按按钮矩形算坐标，不被面板滚动容器裁切。 */}
      {hinted !== null && selected !== undefined
        ? createPortal(
          <span
            className="tpp-tip"
            role="tooltip"
            style={{
              top: hinted.top,
              right: hinted.right,
              transform: hinted.above ? 'translateY(-100%)' : undefined,
            }}
          >
            {presetActionHint(t, hinted.action, selected, selectedTemplateLabel)}
          </span>,
          document.body,
        )
        : null}
      <div className="tps-card">
        {phase === 'unavailable'
          ? <p className="tpp-state" role="status">{t('presetUnavailable')}</p>
          : null}
        {phase === 'loading' ? <p className="tpp-state">{t('presetLoading')}</p> : null}
        {phase === 'ready' && presets.length === 0
          ? <p className="tpp-state">{t('presetEmpty')}</p>
          : null}
        {phase === 'ready' && presets.length > 0
          ? (
            <>
              {picker(
                'preset',
                t('presetPickPreset'),
                selected === undefined ? t('presetEmpty') : presetOptionLabel(selected),
                presets.map(preset => ({ id: preset.id, label: presetOptionLabel(preset) })),
                (id) => {
                  setPresetId(id)
                  setConfirming(null)
                  setDiffOpen(false)
                },
              )}
              {templates.length > 0
                ? picker(
                  'template',
                  t('presetPickTemplate'),
                  selectedTemplate === undefined ? t('presetEmpty') : presetTemplateLabel(selectedTemplate),
                  templates.map(template => ({ id: template.id, label: presetTemplateLabel(template) })),
                  (id) => {
                    setTemplateId(id)
                    setTemplatePinned(true)
                    setDiffOpen(false)
                  },
                )
                : null}
              <div className="tpp-status">
                <span className="tpp-indicator" data-tone={toolDot.tone}>
                  <span className="tpp-dot" data-tone={toolDot.tone} aria-hidden="true" />
                  {toolDot.label}
                </span>
                <span className="tpp-indicator" data-tone={compareDot.tone}>
                  <span className="tpp-dot" data-tone={compareDot.tone} aria-hidden="true" />
                  {compareDot.label}
                </span>
                {canDiff
                  ? (
                    <button
                      type="button"
                      className="tp-reset tpp-diffButton"
                      onClick={() => setDiffOpen(true)}
                    >
                      {t('presetDiffOpen')}
                    </button>
                  )
                  : null}
              </div>
              {selected !== undefined ? detail(selected) : null}
              {legacyRoot !== undefined
                ? <p className="tpp-state">{t('presetNoteLegacy').replace('{path}', legacyRoot)}</p>
                : null}
            </>
          )
          : null}
      </div>
      <Modal
        open={diffOpen}
        onClose={() => setDiffOpen(false)}
        className="tpp-diffDialog"
        title={t('presetDiffTitle')}
        closeLabel={t('presetDiffClose')}
        description={t('presetDiffHint')}
        contentClassName="tpp-diffBody"
      >
        {diffRows.length === 0
          ? <p className="tpp-state">{t('presetDiffEmpty')}</p>
          : (
            <table className="tpp-diffTable">
              <thead>
                <tr>
                  <th>{t('presetDiffColumnPath')}</th>
                  <th>{t('presetDiffColumnYours')}</th>
                  <th>{t('presetDiffColumnTemplate')}</th>
                </tr>
              </thead>
              <tbody>
                {diffRows.map((row, index) => (
                  <tr key={`${row.path}-${index}`}>
                    <td className="tpp-diffPath">{row.path}</td>
                    <td>{row.yours}</td>
                    <td>{row.template}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Modal>
    </section>
  )
}
