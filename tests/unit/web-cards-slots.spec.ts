/**
 * The slot semantics the tool cards depend on, pinned as a contract test.
 *
 * Cards take over the shipped `tool.call.toolview` cells by registering at a
 * lower priority. That mechanism is a public API with no design note behind it,
 * so this spec locks the four properties the takeover relies on — coexistence at
 * a different priority, lowest-priority-wins, the shadowed entry surviving on
 * the ledger, and an abdicating crash falling back to it — plus the declaration
 * precondition that forces registration through `ctx.slots.inject`. A dsh
 * upgrade that changes any of them fails here first, before it fails in the UI.
 */
import { describe, expect, it } from 'vitest'
import { SlotCore, type StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { CARD_TAKEOVER_PRIORITY, CARD_TOOL_KEYS } from '../../src/web/contract.ts'

/** The shipped tool-view slot's key. */
const SLOT = 'tool.call.toolview'

/** The six keys a shipped row already occupies at the default priority. */
const SHIPPED_KEYS = ['bash', 'read', 'write', 'edit', 'grep', 'glob'] as const

/** A component stand-in: identity is all the ledger check needs. */
function component(name: string): () => null {
  const fn = (): null => null
  Object.defineProperty(fn, 'name', { value: name })
  return fn
}

/**
 * A core with the tool-view slot declared the way the shipped composition
 * declares it (a keyed child of another entry).
 * @returns the core plus the disposer of the declaring entry.
 */
function declaredCore(): { core: SlotCore; dispose: () => void } {
  const core = new SlotCore()
  const dispose = core.register({
    name: 'root',
    children: { [SLOT]: { kind: 'keyed', scope: 'session' } },
  } as never, component('parent') as never)
  return { core, dispose }
}

/** Register one entry into the declared slot. */
function register(
  core: SlotCore,
  key: string,
  priority: number,
  row: () => null,
): () => void {
  return core.register({ name: SLOT, key, priority } as never, row as never)
}

/** The winning component of one key's cell, or undefined when the cell is empty. */
function winner(core: SlotCore, key: string): unknown {
  return core.entriesOfSlot(SLOT).find(entry => entry.options.key === key)?.component
}

describe('tool card takeover — declaration precondition', () => {
  it('refuses to register into a slot no parent entry declared', () => {
    const bare = new SlotCore()
    expect(() => register(bare, 'read', 0, component('shipped')))
      .toThrow(/not declared/u)
  })

  it('accepts registrations once a parent declares the slot', () => {
    const { core, dispose } = declaredCore()
    expect(() => register(core, 'read', 0, component('shipped'))).not.toThrow()
    dispose()
  })
})

describe('tool card takeover — shadowing', () => {
  it('rejects a second registration at the same priority', () => {
    const { core, dispose } = declaredCore()
    register(core, 'read', 0, component('shipped'))
    expect(() => register(core, 'read', 0, component('other')))
      .toThrow(/already has an entry/u)
    dispose()
  })

  it('lets a lower priority coexist and renders it', () => {
    const { core, dispose } = declaredCore()
    const shipped = component('shipped')
    const ours = component('ours')
    register(core, 'read', 0, shipped)
    register(core, 'read', CARD_TAKEOVER_PRIORITY, ours)

    expect(winner(core, 'read')).toBe(ours)
    // The shadowed entry stays on the ledger: that is what lets an unload (or a
    // settings switch) put the shipped row back without re-registering it.
    const ledger = core.entries(SLOT).map(entry => entry.component)
    expect(ledger).toContain(shipped)
    expect(ledger).toContain(ours)
    dispose()
  })

  it('restores the shipped row when the takeover is disposed', () => {
    const { core, dispose } = declaredCore()
    const shipped = component('shipped')
    register(core, 'read', 0, shipped)
    const takeover = register(core, 'read', CARD_TAKEOVER_PRIORITY, component('ours'))

    takeover()
    expect(winner(core, 'read')).toBe(shipped)
    dispose()
  })

  it('falls back to the shipped row when the takeover abdicates', () => {
    const { core, dispose } = declaredCore()
    const shipped = component('shipped')
    const ours = component('ours')
    register(core, 'read', 0, shipped)
    register(core, 'read', CARD_TAKEOVER_PRIORITY, ours)

    const entry = core.entries(SLOT).find(candidate => candidate.component === ours) as StoredEntry
    core.reportEntryError(SLOT, entry, new Error('row crashed'), { abdicate: true })

    // A row that throws must not take the cell down with it.
    expect(winner(core, 'read')).toBe(shipped)
    dispose()
  })
})

describe('tool card takeover — the full card roster', () => {
  it('wins every card key, including the two the composition never declares', () => {
    const { core, dispose } = declaredCore()
    const shipppedRows = new Map(SHIPPED_KEYS.map(key => [key, component(`shipped-${key}`)]))
    for (const [key, row] of shipppedRows) register(core, key, 0, row)

    const ourRows = new Map(CARD_TOOL_KEYS.map(key => [key, component(`card-${key}`)]))
    const takeovers = [...ourRows].map(([key, row]) => register(core, key, CARD_TAKEOVER_PRIORITY, row))

    for (const key of CARD_TOOL_KEYS) {
      expect(winner(core, key), `winner for ${key}`).toBe(ourRows.get(key))
    }
    // Only the shipped six had a predecessor; the AST keys are additive.
    expect(core.entries(SLOT).length).toBe(SHIPPED_KEYS.length + CARD_TOOL_KEYS.length)

    for (const disposeOne of takeovers) disposeOne()
    for (const [key, row] of shipppedRows) {
      expect(winner(core, key), `restored winner for ${key}`).toBe(row)
    }
    for (const key of CARD_TOOL_KEYS.filter(candidate => !shipppedRows.has(candidate))) {
      expect(winner(core, key), `emptied cell for ${key}`).toBeUndefined()
    }
    dispose()
  })
})
