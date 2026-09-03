/**
 * Generic staged-form model over the plugin's flat settings namespace,
 * shared by the Bash card and the Tool Plus settings section. A form stages
 * what the user types and writes it only on save; field definitions come from
 * the single-source table (`src/config/fields.ts`), so every surface renders
 * the same fields with the same defaults.
 * @module @xiaoso/dsh-tool-plus/client
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { CardShell } from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { ToolPlusField } from '../config/fields.ts'
import { hasOwn, type NumberControl, type SelectControl, type ToggleControl } from './rows.tsx'

/** The flat settings document shape this form edits. */
export type ToolSettingsValue = Record<string, number | boolean | string | undefined>

/** One group of controls (a Bash subgroup or a whole tool's section). */
export interface ToolFormGroup {
  group: string
  numbers: NumberControl[]
  selects: SelectControl[]
  toggles: ToggleControl[]
}

/** The form state a settings surface renders. */
export interface ToolForm {
  shell: CardShell
  /** Controls grouped by `ToolPlusField.group`, in first-appearance order. */
  groups: ToolFormGroup[]
  actions: {
    edit: (field: string, text: string) => void
    resetField: (field: string) => void
    save: () => Promise<void>
    discard: () => void
  }
  editSelect: (field: string, value: string) => void
  onToggle: (field: string, checked: boolean) => void
}

/** Schema defaults from the field table: what a cleared field reverts to. */
function defaultsOf(fields: readonly ToolPlusField[]): Record<string, number | boolean | string> {
  const out: Record<string, number | boolean | string> = {}
  for (const field of fields) out[field.name] = field.default
  return out
}

/** Value a cleared field will revert to: the composition base when present, else the schema default. */
function revertValue(snap: SettingsScopeSnapshot<ToolSettingsValue>, defaults: Record<string, number | boolean | string>, field: string): number | boolean | string | undefined {
  if (hasOwn(snap.base, field)) return (snap.base as Record<string, unknown>)[field] as number | boolean | string
  return defaults[field]
}

/** Text of a staged (or resolved) value for the number controls. */
function numberText(staged: string | undefined, hasStaged: boolean, resolved: number | boolean | string | undefined, snap: SettingsScopeSnapshot<ToolSettingsValue>, defaults: Record<string, number | boolean | string>, field: string): string {
  if (hasStaged) return (staged ?? '').trim() === '' ? String(revertValue(snap, defaults, field) ?? '') : (staged ?? '')
  return resolved === undefined || typeof resolved === 'boolean' ? '' : String(resolved)
}

function renderNumber(field: ToolPlusField, numbers: Record<string, string>, value: ToolSettingsValue, snap: SettingsScopeSnapshot<ToolSettingsValue>, defaults: Record<string, number | boolean | string>): NumberControl {
  const hasStaged = Object.prototype.hasOwnProperty.call(numbers, field.name)
  const staged = numbers[field.name]
  const resolved = value[field.name]
  const text = numberText(staged, hasStaged, typeof resolved === 'boolean' ? undefined : resolved, snap, defaults, field.name)
  const baseVal = revertValue(snap, defaults, field.name)
  const userStored = hasOwn(snap.user, field.name)

  let overridden = false
  let invalid = false
  if (hasStaged) {
    const trimmed = (staged ?? '').trim()
    if (trimmed === '') {
      overridden = false
    } else {
      const num = Number(trimmed)
      if (Number.isFinite(num)) {
        overridden = num !== baseVal
      } else {
        invalid = true
      }
    }
  } else {
    overridden = userStored
  }

  return { field: field.name, labelKey: field.labelKey, hintKey: field.hintKey, text, overridden, invalid }
}

function renderSelect(field: ToolPlusField, selects: Record<string, string | null>, value: ToolSettingsValue, snap: SettingsScopeSnapshot<ToolSettingsValue>, defaults: Record<string, number | boolean | string>): SelectControl {
  const hasStaged = Object.prototype.hasOwnProperty.call(selects, field.name)
  const staged = selects[field.name]
  const resolved = value[field.name]
  const baseVal = String(revertValue(snap, defaults, field.name) ?? '')
  const v = hasStaged ? (staged ?? baseVal) : (typeof resolved === 'string' ? resolved : baseVal)
  const userStored = hasOwn(snap.user, field.name)

  let overridden = false
  if (hasStaged) {
    if (staged === null || staged === baseVal) overridden = false
    else overridden = true
  } else {
    overridden = userStored
  }

  return {
    field: field.name,
    labelKey: field.labelKey,
    hintKey: field.hintKey,
    options: field.options ?? [],
    value: v,
    overridden,
  }
}

function renderToggle(field: ToolPlusField, toggles: Record<string, boolean | null>, value: ToolSettingsValue, snap: SettingsScopeSnapshot<ToolSettingsValue>, defaults: Record<string, number | boolean | string>): ToggleControl {
  const hasStaged = Object.prototype.hasOwnProperty.call(toggles, field.name)
  const staged = toggles[field.name]
  const baseVal = Boolean(revertValue(snap, defaults, field.name))
  const userStored = hasOwn(snap.user, field.name)
  const userVal = (snap.user as Record<string, unknown> | undefined)?.[field.name]
  const effectiveVal = hasStaged ? (staged ?? baseVal) : Boolean(value[field.name])

  let overridden = false
  if (hasStaged) {
    if (staged === null || staged === baseVal) overridden = false
    else overridden = true
  } else {
    overridden = userStored
  }

  return { field: field.name, labelKey: field.labelKey, hintKey: field.hintKey, checked: effectiveVal, overridden }
}

/** Whether any staged edit would change the user document. */
function isDirty(
  snap: SettingsScopeSnapshot<ToolSettingsValue>,
  defaults: Record<string, number | boolean | string>,
  selects: Record<string, string | null>,
  numbers: Record<string, string>,
  toggles: Record<string, boolean | null>,
): boolean {
  for (const [field, staged] of Object.entries(selects)) {
    const baseVal = String(revertValue(snap, defaults, field) ?? '')
    const userStored = hasOwn(snap.user, field)
    const userVal = (snap.user as Record<string, unknown> | undefined)?.[field]
    if (staged === null) {
      if (userStored) return true
    } else if (staged === baseVal) {
      if (userStored) return true
    } else {
      if (!userStored || userVal !== staged) return true
    }
  }
  for (const [field, staged] of Object.entries(numbers)) {
    const baseVal = revertValue(snap, defaults, field)
    const userStored = hasOwn(snap.user, field)
    const userVal = (snap.user as Record<string, unknown> | undefined)?.[field]
    const trimmed = staged.trim()
    if (trimmed === '') {
      if (userStored) return true
    } else {
      const num = Number(trimmed)
      if (Number.isFinite(num)) {
        if (num === baseVal) {
          if (userStored) return true
        } else {
          if (!userStored || userVal !== num) return true
        }
      } else {
        return true // invalid draft keeps dirty
      }
    }
  }
  for (const [field, staged] of Object.entries(toggles)) {
    const baseVal = Boolean(revertValue(snap, defaults, field))
    const userStored = hasOwn(snap.user, field)
    const userVal = (snap.user as Record<string, unknown> | undefined)?.[field]
    if (staged === null) {
      if (userStored) return true
    } else if (staged === baseVal) {
      if (userStored) return true
    } else {
      if (!userStored || userVal !== staged) return true
    }
  }
  return false
}

/**
 * Stage edits over the bound scope; only a Save writes the document.
 * @param scope - bound settings scope for the `tool-plus` namespace.
 * @param fields - the fields this surface edits (single-source table slice).
 * @returns the form state and its write actions.
 */
export function useToolForm(scope: SettingsScope<ToolSettingsValue>, fields: readonly ToolPlusField[]): ToolForm {
  const defaults = useMemo(() => defaultsOf(fields), [fields])
  const [snap, setSnap] = useState<SettingsScopeSnapshot<ToolSettingsValue>>(() => scope.getSnapshot())
  const [numbers, setNumbers] = useState<Record<string, string>>({})
  const [selects, setSelects] = useState<Record<string, string | null>>({})
  const [toggles, setToggles] = useState<Record<string, boolean | null>>({})
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => scope.subscribe(() => {
    setSnap(scope.getSnapshot())
    setFailed(false)
  }), [scope])

  const value = snap.value ?? {}
  const writable = snap.writable

  const groups = useMemo<ToolFormGroup[]>(() => {
    const order: string[] = []
    const map = new Map<string, ToolFormGroup>()
    for (const field of fields) {
      let group = map.get(field.group)
      if (group === undefined) {
        order.push(field.group)
        group = { group: field.group, numbers: [], selects: [], toggles: [] }
        map.set(field.group, group)
      }
      if (field.kind === 'number') group.numbers.push(renderNumber(field, numbers, value, snap, defaults))
      else if (field.kind === 'select') group.selects.push(renderSelect(field, selects, value, snap, defaults))
      else if (field.kind === 'boolean') group.toggles.push(renderToggle(field, toggles, value, snap, defaults))
      // kind === 'action': not part of the staged form — the section renders
      // its own button row and never contributes to dirty/validation.
    }
    return order.map(key => map.get(key)!)
  }, [fields, numbers, selects, toggles, value, snap, defaults])

  const invalid = groups.some(group => group.numbers.some(c => c.invalid))
  const dirty = useMemo(() => isDirty(snap, defaults, selects, numbers, toggles), [snap, defaults, selects, numbers, toggles])

  const edit = useCallback((field: string, text: string) => {
    setFailed(false)
    setNumbers(prev => ({ ...prev, [field]: text }))
  }, [])

  const editSelect = useCallback((field: string, value: string) => {
    setFailed(false)
    setSelects(prev => ({ ...prev, [field]: value }))
  }, [])

  const onToggle = useCallback((field: string, checked: boolean) => {
    setFailed(false)
    setToggles(prev => ({ ...prev, [field]: checked }))
  }, [])

  const resetField = useCallback((field: string) => {
    setFailed(false)
    setNumbers(prev => ({ ...prev, [field]: '' }))
    setSelects(prev => ({ ...prev, [field]: null }))
    setToggles(prev => ({ ...prev, [field]: null }))
  }, [])

  const save = useCallback(async () => {
    if (!writable || invalid) return
    setSaving(true)
    setFailed(false)
    try {
      for (const [field, staged] of Object.entries(numbers)) {
        const baseVal = revertValue(snap, defaults, field)
        const trimmed = staged.trim()
        if (trimmed === '' || Number(trimmed) === baseVal) {
          if (hasOwn(snap.user, field)) await scope.unset(field)
        } else {
          await scope.set(field, Number(trimmed))
        }
      }
      for (const [field, staged] of Object.entries(selects)) {
        const baseVal = String(revertValue(snap, defaults, field) ?? '')
        if (staged === null || staged === baseVal) {
          if (hasOwn(snap.user, field)) await scope.unset(field)
        } else {
          await scope.set(field, staged)
        }
      }
      for (const [field, staged] of Object.entries(toggles)) {
        const baseVal = Boolean(revertValue(snap, defaults, field))
        if (staged === null || staged === baseVal) {
          if (hasOwn(snap.user, field)) await scope.unset(field)
        } else {
          await scope.set(field, staged)
        }
      }
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
      setNumbers({})
      setSelects({})
      setToggles({})
    }
  }, [scope, writable, invalid, numbers, selects, toggles, snap, defaults])

  const discard = useCallback(() => {
    setFailed(false)
    setNumbers({})
    setSelects({})
    setToggles({})
  }, [])

  const shell: CardShell = { available: snap.status === 'ready', writable, dirty, invalid, saving, failed }
  return { shell, groups, actions: { edit, resetField, save, discard }, editSelect, onToggle }
}
