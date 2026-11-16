/**
 * native/status 结果 → 本地化文案的纯映射（无 React/DOM 依赖，可单测）。
 * @module @xiaoso/dsh-tool-plus/client/native-status-text
 */
import type { NativeStatusValue } from '../tools/shared/browser-rpc-channel.ts'
import type { BashPlusLocaleKey } from './locales.ts'

/** Locale key of one fallback reason. */
export function nativeFallbackReasonKey(
  reason: Extract<NativeStatusValue, { status: 'fallback' }>['reason'],
): BashPlusLocaleKey {
  switch (reason) {
    case 'platform-unsupported': return 'nativeStatusReasonPlatformUnsupported'
    case 'package-missing': return 'nativeStatusReasonPackageMissing'
    case 'version-mismatch': return 'nativeStatusReasonVersionMismatch'
  }
}

/** Localized text of one native/status result. */
export function nativeStatusText(t: (key: BashPlusLocaleKey) => string, value: NativeStatusValue): string {
  if (value.status === 'active') {
    return t('nativeStatusActive').replace('{package}', value.packageName).replace('{version}', value.version)
  }
  return t('nativeStatusFallback').replace('{reason}', t(nativeFallbackReasonKey(value.reason)))
}
