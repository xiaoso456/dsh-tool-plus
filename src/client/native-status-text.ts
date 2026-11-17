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
    case 'foreign-addon': return 'nativeStatusReasonForeignAddon'
    case 'addon-not-loaded': return 'nativeStatusReasonAddonNotLoaded'
  }
}

/**
 * Short label for the collapsed row: one glance, no sentence.
 *
 * The full sentence (:func:`nativeStatusText`) is what the row shows once it is
 * expanded — the hint and the reason both live there, so the resting state stays
 * one line.
 */
export function nativeStatusShort(t: (key: BashPlusLocaleKey) => string, value: NativeStatusValue): string {
  if (value.status === 'active') return t('nativeStatusShortActive').replace('{version}', value.version)
  switch (value.reason) {
    case 'platform-unsupported': return t('nativeStatusShortPlatformUnsupported')
    case 'package-missing': return t('nativeStatusShortPackageMissing')
    case 'version-mismatch': return t('nativeStatusShortVersionMismatch')
    case 'foreign-addon': return t('nativeStatusShortForeignAddon')
    case 'addon-not-loaded': return t('nativeStatusShortAddonNotLoaded')
  }
}

/** Localized text of one native/status result. */
export function nativeStatusText(t: (key: BashPlusLocaleKey) => string, value: NativeStatusValue): string {
  if (value.status === 'active') {
    return t('nativeStatusActive').replace('{package}', value.packageName).replace('{version}', value.version)
  }
  // `foreign-addon` names the offending file: the whole point of that state is
  // that the package side looks healthy, so the path is the only evidence.
  const reason = t(nativeFallbackReasonKey(value.reason)).replace('{path}', value.loadedPath ?? '?')
  return t('nativeStatusFallback').replace('{reason}', reason)
}
