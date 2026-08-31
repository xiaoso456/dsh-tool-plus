/**
 * rmSafe/status 结果 → 本地化文案的纯映射（无 React/DOM 依赖，可单测）。
 * @module @xiaoso/dsh-tool-plus/client/rm-safe-status-text
 */
import type { RmSafeStatusValue } from '../tools/shared/browser-rpc-channel.ts'
import type { BashPlusLocaleKey } from './locales.ts'

/** Locale key of one rmSafe failure reason. */
export function rmSafeReasonKey(reason: Extract<RmSafeStatusValue, { status: 'failed' }>['reason']): BashPlusLocaleKey {
  switch (reason) {
    case 'snapshot-unavailable': return 'rmSafeReasonSnapshotUnavailable'
    case 'cli-missing': return 'rmSafeReasonCliMissing'
    case 'script-write-failed': return 'rmSafeReasonScriptWriteFailed'
    case 'snapshot-write-failed': return 'rmSafeReasonSnapshotWriteFailed'
    case 'runtime-not-effective': return 'rmSafeReasonRuntimeNotEffective'
  }
}

/**
 * Localized text of one rmSafe/status result. `disabled` maps to the empty
 * string — the caller decides not to surface it.
 */
export function rmSafeStatusText(t: (key: BashPlusLocaleKey) => string, value: RmSafeStatusValue): string {
  if (value.status === 'failed') {
    return t('rmSafeStatusFailed').replace('{reason}', t(rmSafeReasonKey(value.reason)))
  }
  if (value.status === 'disabled') return ''
  return value.runtime === 'function' ? t('rmSafeStatusInjected') : t('rmSafeStatusInjectedUnverified')
}
