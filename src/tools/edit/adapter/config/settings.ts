/**
 * DSH adapter for OMP's `config/settings.ts` Settings surface.
 *
 * OMP edit engine reads session settings through `settings.get("edit.*")`,
 * `settings.get("lsp.*")`, etc. DSH has its own configuration (fields.ts +
 * dsh settings); this adapter maps the OMP dotted keys onto the resolved
 * tool-plus config, so the verbatim OMP engine code compiles and runs
 * without modification.
 *
 * Only the surface the edit engine actually touches is provided:
 * - `Settings` class with `get(path)` and `getEditVariantForModel(model)`
 * - `settings` singleton (uninitialized until `installGlobalSettings` runs)
 * - `isSettingsInitialized()`
 *
 * LSP keys are not wired: the LSP integration was cut from the DSH port
 * (plan.md §3), so those reads fall back to the schema default (their
 * `enableLsp` gate is `false` at the call sites), never to a degraded
 * edit path.
 */
import type { RuntimeConfig } from '../../../../config/settings.ts'
import { OMP_KEY_TO_FIELD } from '../../../../config/omp-settings.ts'

export type SettingPath = string

export interface SettingsOptions {
  cwd?: string
  agentDir?: string
  inMemory?: boolean
  readOnly?: boolean
  overrides?: Partial<Record<string, unknown>>
  configFiles?: string[]
}

export type SettingValue<P extends string = string> = unknown


/**
 * Session-scoped settings adapter. `get(path)` resolves the OMP dotted key
 * against the live tool-plus config; unknown keys return the schema default
 * or undefined.
 */
export class Settings {
  #config: RuntimeConfig
  #getDefault: (path: string) => unknown

  constructor(config: RuntimeConfig, getDefault: (path: string) => unknown) {
    this.#config = config
    this.#getDefault = getDefault
  }

  get(path: string): any {
    const field = OMP_KEY_TO_FIELD[path]
    if (field !== undefined) {
      const value = (this.#config as unknown as Record<string, unknown>)[field]
      if (value !== undefined) return value
    }
    return this.#getDefault(path)
  }

  /** OMP edit-variant override hook; DSH resolves the mode from config directly. */
  getEditVariantForModel(_model: string | undefined): 'replace' | 'patch' | 'hashline' | 'apply_patch' | null {
    return null
  }
}

let globalSettings: Settings | null = null

/** Install the resolved tool-plus config into the global settings singleton. */
export function installGlobalSettings(config: RuntimeConfig, getDefault: (path: string) => unknown): void {
  globalSettings = new Settings(config, getDefault)
}

export function isSettingsInitialized(): boolean {
  return globalSettings !== null
}

/** Global settings singleton (read-only facade over the installed config). */
export const settings: Settings = {
  get(path: string): unknown {
    return globalSettings?.get(path)
  },
  getEditVariantForModel(): null {
    return null
  },
} as unknown as Settings
