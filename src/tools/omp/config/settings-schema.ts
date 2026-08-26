/**
 * DSH adapter for OMP's `config/settings-schema.ts`.
 *
 * The OMP schema is a ~5900-line settings registry. The edit engine only
 * needs `getDefault(path)` for a handful of keys; defaults are taken from the
 * OMP schema values (verbatim) so engine behavior matches upstream. Full
 * schema metadata (tabs, UI descriptors) is DSH-side and not replicated.
 */
export type SettingPath = string
import { OMP_DEFAULTS } from '../../../config/omp-settings.ts'

export type SettingValue<P extends string = string> = unknown


/** Schema default for a setting path (verbatim OMP values; unknown -> undefined). */
export function getDefault<P extends SettingPath>(path: P): any {
  return OMP_DEFAULTS[path] as SettingValue<P>
}
