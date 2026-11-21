/**
 * Generic staged-form model over the plugin's flat settings namespace,
 * shared by the Bash card and the Tool Plus settings section. A form stages
 * what the user types and writes it only on save; field definitions come from
 * the single-source table (`src/config/fields.ts`), so every surface renders
 * the same fields with the same defaults.
 * @module @xiaoso/dsh-tool-plus/client
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
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
  shell: SettingsFormShell
  /** Namespace sync state, so the page can show a skeleton or an explanation. */
  status: ConfigFormSnapshot<ToolSettingsValue>['status']
  /** A stored draft was dropped because the document moved on underneath it. */
  draftDropped: boolean
  /** Controls grouped by `ToolPlusField.group`, in first-appearance order. */
  groups: ToolFormGroup[]
  actions: {
    edit: (field: string, text: string) => void
    resetField: (field: string) => void
    /** @returns true when the Host accepted every submitted field. */
    save: () => Promise<boolean>
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
function revertValue(snap: ConfigFormSnapshot<ToolSettingsValue>, defaults: Record<string, number | boolean | string>, field: string): number | boolean | string | undefined {
  if (hasOwn(snap.base, field)) return (snap.base as Record<string, unknown>)[field] as number | boolean | string
  return defaults[field]
}

/**
 * Text of a staged (or resolved) value for the number controls.
 *
 * A staged value is shown exactly as typed — an emptied box stays empty (the
 * default moves to the placeholder), so the next keystroke appends to nothing
 * instead of to the reverted default. Save already treats blank as "revert".
 */
function numberText(staged: string | undefined, hasStaged: boolean, resolved: number | boolean | string | undefined): string {
  if (hasStaged) return staged ?? ''
  return resolved === undefined || typeof resolved === 'boolean' ? '' : String(resolved)
}

function renderNumber(field: ToolPlusField, numbers: Record<string, string>, value: ToolSettingsValue, snap: ConfigFormSnapshot<ToolSettingsValue>, defaults: Record<string, number | boolean | string>): NumberControl {
  const hasStaged = Object.prototype.hasOwnProperty.call(numbers, field.name)
  const staged = numbers[field.name]
  const resolved = value[field.name]
  const text = numberText(staged, hasStaged, typeof resolved === 'boolean' ? undefined : resolved)
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

  // The reverted value lives in the placeholder: an emptied box shows what it
  // will fall back to without ever pretending it holds that value.
  const placeholder = baseVal === undefined ? '' : String(baseVal)
  return { field: field.name, labelKey: field.labelKey, hintKey: field.hintKey, tipKey: field.tipKey, text, placeholder, overridden, invalid }
}

function renderSelect(field: ToolPlusField, selects: Record<string, string | null>, value: ToolSettingsValue, snap: ConfigFormSnapshot<ToolSettingsValue>, defaults: Record<string, number | boolean | string>): SelectControl {
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
    tipKey: field.tipKey,
    options: field.options ?? [],
    value: v,
    overridden,
  }
}


function renderToggle(field: ToolPlusField, toggles: Record<string, boolean | null>, value: ToolSettingsValue, snap: ConfigFormSnapshot<ToolSettingsValue>, defaults: Record<string, number | boolean | string>): ToggleControl {
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

  return { field: field.name, labelKey: field.labelKey, hintKey: field.hintKey, tipKey: field.tipKey, checked: effectiveVal, overridden }
}

/** Whether any staged edit would change the user document. */
function isDirty(
  snap: ConfigFormSnapshot<ToolSettingsValue>,
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

/** Staged edits, as stored between mounts. */
interface StagedDraft {
  numbers: Record<string, string>
  selects: Record<string, string | null>
  toggles: Record<string, boolean | null>
}

/** One persisted draft: the staged values plus the baseline they were typed against. */
interface StoredDraft extends StagedDraft {
  version: number
  /** Namespace revision at staging time (the document's "version"). */
  revision: number | undefined
  /** Serialized composition layer — the values a cleared field reverts to. */
  base: string
}

/**
 * What reading the parked draft produced.
 * `pending` = the namespace is not readable yet, so there is no baseline to judge it by.
 */
type DraftInspection =
  | { kind: 'none' }
  | { kind: 'pending' }
  | { kind: 'dropped' }
  | ({ kind: 'ready' } & StagedDraft)

/** Draft format version, bumped whenever the stored shape changes. */
const DRAFT_VERSION = 1

function draftStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

function baseStamp(snap: ConfigFormSnapshot<ToolSettingsValue>): string {
  try {
    return JSON.stringify(snap.base ?? null)
  } catch {
    return ''
  }
}

/**
 * Read the parked draft against the current baseline. A draft survives only
 * while both the namespace revision and the composition layer it was typed
 * over are unchanged; anything else means the document moved on and the
 * staged text would write stale values over newer ones.
 */
function inspectDraft(key: string, snap: ConfigFormSnapshot<ToolSettingsValue>): DraftInspection {
  if (snap.status !== 'ready') return { kind: 'pending' }
  const store = draftStorage()
  if (store === null) return { kind: 'none' }
  let raw: string | null
  try {
    raw = store.getItem(key)
  } catch {
    return { kind: 'none' }
  }
  if (raw === null) return { kind: 'none' }
  let parsed: StoredDraft
  try {
    parsed = JSON.parse(raw) as StoredDraft
  } catch {
    return { kind: 'dropped' }
  }
  if (parsed.version !== DRAFT_VERSION || parsed.revision !== snap.revision || parsed.base !== baseStamp(snap)) {
    return { kind: 'dropped' }
  }
  return { kind: 'ready', numbers: parsed.numbers ?? {}, selects: parsed.selects ?? {}, toggles: parsed.toggles ?? {} }
}

function clearDraft(key: string): void {
  const store = draftStorage()
  if (store === null) return
  try {
    store.removeItem(key)
  } catch {
    // Storage disabled or full: nothing to clear.
  }
}

function writeDraft(key: string, draft: StoredDraft): void {
  const store = draftStorage()
  if (store === null) return
  try {
    store.setItem(key, JSON.stringify(draft))
  } catch {
    // Quota exceeded: the in-memory draft still works for this mount.
  }
}

/**
 * Drop the staged entries this save committed, keeping anything the user
 * changed while the write was in flight — same field, different value means it
 * was edited after the snapshot and has not been written yet.
 */
function unstaged<T>(staged: Record<string, T>, submitted: Record<string, T>): Record<string, T> {
  const next: Record<string, T> = {}
  for (const [field, value] of Object.entries(staged)) {
    if (!Object.prototype.hasOwnProperty.call(submitted, field) || submitted[field] !== value) next[field] = value
  }
  return next
}

/**
 * Stage edits over the shared configuration form; only a Save writes the document.
 * @param scope - the `tool-plus` entry's shared configuration form (`ctx.configForms`).
 * @param fields - the fields this surface edits (single-source table slice).
 * @param draftKey - sessionStorage key for the unsaved draft; the section unmounts
 *   when the user leaves the page, so staged edits are parked here and restored
 *   only while the document baseline they were typed against still stands.
 * @returns the form state and its write actions.
 */
export function useToolForm(scope: ConfigForm<ToolSettingsValue>, fields: readonly ToolPlusField[], draftKey: string): ToolForm {
  const defaults = useMemo(() => defaultsOf(fields), [fields])
  const [snap, setSnap] = useState<ConfigFormSnapshot<ToolSettingsValue>>(() => scope.getSnapshot())
  // Read the parked draft once, synchronously, so a restore never flashes the
  // defaults first. A pending read is settled by the effect below.
  const inspected = useRef<DraftInspection | null>(null)
  if (inspected.current === null) inspected.current = inspectDraft(draftKey, scope.getSnapshot())
  const first = inspected.current
  const [numbers, setNumbers] = useState<Record<string, string>>(() => first.kind === 'ready' ? first.numbers : {})
  const [selects, setSelects] = useState<Record<string, string | null>>(() => first.kind === 'ready' ? first.selects : {})
  const [toggles, setToggles] = useState<Record<string, boolean | null>>(() => first.kind === 'ready' ? first.toggles : {})
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [draftDropped, setDraftDropped] = useState(() => first.kind === 'dropped')
  // False while a parked draft is still waiting for the namespace to load: skip
  // persistence until then, so the first commit cannot clear a draft that the
  // restore is about to adopt.
  const [draftSettled, setDraftSettled] = useState(first.kind !== 'pending')

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

  // The namespace can still be loading on the first mount (page reloaded on
  // this section): settle the parked draft as soon as a baseline exists.
  useEffect(() => {
    if (inspected.current === null || inspected.current.kind !== 'pending') return
    const found = inspectDraft(draftKey, snap)
    if (found.kind === 'pending') return
    inspected.current = found
    if (found.kind === 'ready') {
      setNumbers(found.numbers)
      setSelects(found.selects)
      setToggles(found.toggles)
    } else if (found.kind === 'dropped') {
      setDraftDropped(true)
    }
    setDraftSettled(true)
  }, [snap, draftKey])

  // A dropped draft is reported once and removed; never leave it around to be
  // judged again against an even newer baseline.
  useEffect(() => {
    if (!draftDropped) return
    clearDraft(draftKey)
  }, [draftDropped, draftKey])

  // Park the draft on every staged change so leaving the page (the host
  // unmounts this section on a nav switch) cannot silently drop it. Only a
  // dirty form is parked — a clean one clears the slot.
  useEffect(() => {
    if (!draftSettled || snap.status !== 'ready') return
    if (!dirty) {
      clearDraft(draftKey)
      return
    }
    writeDraft(draftKey, {
      version: DRAFT_VERSION,
      revision: snap.revision,
      base: baseStamp(snap),
      numbers,
      selects,
      toggles,
    })
  }, [draftSettled, snap, dirty, numbers, selects, toggles, draftKey])

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

  const save = useCallback(async (): Promise<boolean> => {
    if (!writable || invalid) return false
    // Snapshot what this save submits: anything typed while the writes are in
    // flight must stay staged (and dirty), not be wiped by the cleanup below.
    const submitted: StagedDraft = { numbers, selects, toggles }
    setSaving(true)
    setFailed(false)
    let accepted = true
    try {
      for (const [field, staged] of Object.entries(submitted.numbers)) {
        const baseVal = revertValue(snap, defaults, field)
        const trimmed = staged.trim()
        if (trimmed === '' || Number(trimmed) === baseVal) {
          if (hasOwn(snap.user, field)) accepted = (await scope.unset(field)) && accepted
        } else {
          accepted = (await scope.set(field, Number(trimmed))) && accepted
        }
      }
      for (const [field, staged] of Object.entries(submitted.selects)) {
        const baseVal = String(revertValue(snap, defaults, field) ?? '')
        if (staged === null || staged === baseVal) {
          if (hasOwn(snap.user, field)) accepted = (await scope.unset(field)) && accepted
        } else {
          accepted = (await scope.set(field, staged)) && accepted
        }
      }
      for (const [field, staged] of Object.entries(submitted.toggles)) {
        const baseVal = Boolean(revertValue(snap, defaults, field))
        if (staged === null || staged === baseVal) {
          if (hasOwn(snap.user, field)) accepted = (await scope.unset(field)) && accepted
        } else {
          accepted = (await scope.set(field, staged)) && accepted
        }
      }
    } catch {
      accepted = false
    } finally {
      setSaving(false)
    }
    if (accepted) {
      setNumbers(prev => unstaged(prev, submitted.numbers))
      setSelects(prev => unstaged(prev, submitted.selects))
      setToggles(prev => unstaged(prev, submitted.toggles))
    } else {
      // The document did not take these values: keep every one staged, so the
      // failure message ("kept for you to correct") stays true.
      setFailed(true)
    }
    return accepted
  }, [scope, writable, invalid, numbers, selects, toggles, snap, defaults])

  const discard = useCallback(() => {
    setFailed(false)
    setNumbers({})
    setSelects({})
    setToggles({})
  }, [])

  const shell: SettingsFormShell = { available: snap.status === 'ready', writable, dirty, invalid, saving, failed }
  return { shell, status: snap.status, draftDropped, groups, actions: { edit, resetField, save, discard }, editSelect, onToggle }
}
