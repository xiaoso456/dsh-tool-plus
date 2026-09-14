/**
 * Source-level lock on the tool-card registration path.
 *
 * `registerToolCards` is the browser half that takes over the keyed
 * `tool.call.toolview` slot. That behaviour (entry count, keys, priority,
 * locale namespace, the `webCards` switch, and the winner self-check fallback)
 * is normally only observable through a built client bundle in a real browser,
 * so this suite drives the real module through a hand-written `ClientContext`
 * stub instead: no build, no jsdom, no rendered component.
 *
 * The stub models exactly the four services the module touches — `effect`,
 * `locale.register`, `slots.{inject,register,entriesOfSlot}` and
 * `settingsScope.bind` — and keeps a live ledger so a registration can be seen
 * to vanish when its disposer runs.
 * @module tests
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { CARD_TAKEOVER_PRIORITY, CARD_TOOL_KEYS } from '../../src/web/contract.ts'
import { registerToolCards } from '../../src/web/client/registerToolCards.ts'

// The row components pull their chrome from the client primitives package,
// which ships as a browser bundle only (CSS modules, shiki, katex, clsx) and
// therefore cannot be loaded by the Node test runner at all. Nothing renders
// here, so the primitives surface is replaced by inert stand-ins; the module
// under test, the contract, the dictionaries and every row module stay real.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const StandIn = (): null => null
  return {
    CodeBlock: StandIn,
    ReadBlock: StandIn,
    SearchBlock: StandIn,
    TerminalBlock: StandIn,
    DiffBlock: StandIn,
    DisclosureRow: StandIn,
    StateDot: StandIn,
    diffTotals: () => ({ added: 0, removed: 0 }),
  }
})

/** The shipped slot the cards register into. */
const SLOT = 'tool.call.toolview'

/** Locale namespace of the card bundle. */
const LOCALE_NS = 'tool-plus-cards'

/** Settings namespace the switch binds to. */
const SETTINGS_NS = 'tool-plus'

/** One entry as the module hands it to `slots.register`. */
interface SlotEntryOptions {
  name: string
  key: string
  priority: number
  locale?: string
}

/** One registration, in the shape the ledger and the self-check both use. */
interface SlotEntry {
  options: SlotEntryOptions
  component: unknown
}

/** The settings document the switch reads back. */
interface CardSettings {
  webCards?: boolean
}

/** The hand-written `ClientContext` stub plus the knobs a test drives. */
interface CardStub {
  /** The context to pass to `registerToolCards` (deliberately untyped). */
  ctx: never
  /** Slot keys `slots.inject` was called with, in order. */
  injectKeys: string[]
  /** Every `slots.register` call, including ones already disposed. */
  registerCalls: SlotEntry[]
  /** Every `locale.register` call. */
  localeCalls: Array<{ ns: string; dicts: Record<string, unknown> }>
  /** Labels the module passed to `effect`. */
  effectLabels: string[]
  /** Namespaces `settingsScope.bind` was called with. */
  bindNamespaces: string[]
  /** Entries still live (registered and not yet disposed). */
  liveEntries(): SlotEntry[]
  /** Live keys of the current registration. */
  liveKeys(): string[]
  /** Make another component win `key` in `entriesOfSlot` (outranks our rank). */
  hijack(key: string, priority?: number): void
  /** Replace the settings value and fire the subscribers. */
  setSettings(value: CardSettings | undefined): void
  /** Fire the current subscribers without changing the value. */
  pulse(): void
  /** How many subscribers are attached right now. */
  listenerCount(): number
  /** Run every disposer the module returned to `effect`. */
  runEffectDisposers(): void
}

/**
 * Build a fresh stub context for one test.
 * @returns the stub and its inspection knobs.
 */
function createStub(): CardStub {
  const injectKeys: string[] = []
  const registerCalls: SlotEntry[] = []
  const localeCalls: Array<{ ns: string; dicts: Record<string, unknown> }> = []
  const effectLabels: string[] = []
  const effectDisposers: Array<() => void> = []
  const live: SlotEntry[] = []
  const foreign = new Map<string, SlotEntry>()
  const listeners: Array<() => void> = []
  let settingsValue: CardSettings | undefined

  const removeFrom = (list: unknown[], item: unknown): void => {
    const at = list.indexOf(item)
    if (at >= 0) list.splice(at, 1)
  }

  const stub: CardStub = {
    ctx: {
      // The module defers work to the fiber: run it at once and keep the
      // disposer so the test can prove it is wired to something harmless.
      effect: (fn: () => unknown, label?: string) => {
        effectLabels.push(String(label))
        const produced = fn()
        if (typeof produced === 'function') effectDisposers.push(produced as () => void)
        return () => {}
      },
      locale: {
        register: (ns: string, dicts: Record<string, unknown>) => {
          const call = { ns, dicts }
          localeCalls.push(call)
          let disposed = false
          return () => {
            if (disposed) return
            disposed = true
            removeFrom(localeCalls, call)
          }
        },
      },
      slots: {
        // The slot waits for the shipped declaration, so run the callback
        // inline and hand back a remover that unwinds everything it produced.
        inject: (key: string, cb: () => unknown) => {
          injectKeys.push(key)
          const produced = cb()
          const disposers = Array.isArray(produced) ? (produced as Array<() => void>) : []
          let disposed = false
          return () => {
            if (disposed) return
            disposed = true
            for (const dispose of [...disposers].reverse()) dispose()
          }
        },
        register: (options: SlotEntryOptions, component: unknown) => {
          const entry: SlotEntry = { options, component }
          registerCalls.push(entry)
          live.push(entry)
          let disposed = false
          return () => {
            if (disposed) return
            disposed = true
            removeFrom(live, entry)
          }
        },
        // The self-check reads back one winner per cell: lowest rank wins,
        // except where a test forced a foreign component to win.
        entriesOfSlot: (key: string) => {
          const winners = new Map<string, SlotEntry>()
          for (const entry of live) {
            if (entry.options.name !== key) continue
            const seen = winners.get(entry.options.key)
            if (seen === undefined || entry.options.priority < seen.options.priority) {
              winners.set(entry.options.key, entry)
            }
          }
          for (const [cardKey, entry] of foreign) winners.set(cardKey, entry)
          return [...winners.values()]
        },
      },
      settingsScope: {
        bind: (options: { namespace: string }) => {
          stub.bindNamespaces.push(options.namespace)
          return {
            getSnapshot: () => ({ status: 'ready', namespace: options.namespace, value: settingsValue }),
            subscribe: (fn: () => void) => {
              listeners.push(fn)
              let stopped = false
              return () => {
                if (stopped) return
                stopped = true
                removeFrom(listeners, fn)
              }
            },
          }
        },
      },
    } as never,
    injectKeys,
    registerCalls,
    localeCalls,
    effectLabels,
    bindNamespaces: [],
    liveEntries: () => [...live],
    liveKeys: () => live.map(entry => entry.options.key),
    hijack: (key: string, priority = CARD_TAKEOVER_PRIORITY - 1) => {
      foreign.set(key, {
        options: { name: SLOT, key, priority, locale: LOCALE_NS },
        component: () => null,
      })
    },
    setSettings: (value: CardSettings | undefined) => {
      settingsValue = value
      for (const listener of [...listeners]) listener()
    },
    pulse: () => {
      for (const listener of [...listeners]) listener()
    },
    listenerCount: () => listeners.length,
    runEffectDisposers: () => {
      for (const dispose of [...effectDisposers].reverse()) dispose()
    },
  }
  return stub
}

/** Silence `console.warn` and hand back the spy. */
function spyWarn(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, 'warn').mockImplementation(() => {})
}

/** Silence `console.error` and hand back the spy (the lost-cell diagnostic). */
function spyError(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, 'error').mockImplementation(() => {})
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('registerToolCards', () => {
  it('registers one card per contract key into the shipped slot', () => {
    const stub = createStub()
    const warn = spyWarn()

    registerToolCards(stub.ctx)

    expect(stub.injectKeys).toEqual([SLOT])
    expect(stub.registerCalls).toHaveLength(CARD_TOOL_KEYS.length)
    expect(stub.registerCalls).toHaveLength(8)

    const keys = stub.registerCalls.map(call => call.options.key)
    expect(new Set(keys)).toEqual(new Set(CARD_TOOL_KEYS))
    expect(new Set(keys).size).toBe(8)

    for (const call of stub.registerCalls) {
      expect(call.options.name).toBe(SLOT)
      expect(call.options.priority).toBe(CARD_TAKEOVER_PRIORITY)
      expect(call.options.priority).toBe(-1000)
      expect(call.options.locale).toBe(LOCALE_NS)
    }

    expect(stub.liveEntries()).toHaveLength(8)
    expect(warn).not.toHaveBeenCalled()
  })

  it('registers the card dictionaries under the card namespace', () => {
    const stub = createStub()
    spyWarn()

    registerToolCards(stub.ctx)

    expect(stub.localeCalls).toHaveLength(1)
    const [call] = stub.localeCalls
    expect(call.ns).toBe(LOCALE_NS)
    expect(Object.keys(call.dicts).sort()).toEqual(['en', 'zh'])
    expect(Object.keys(call.dicts.zh as Record<string, unknown>).length).toBeGreaterThan(0)
    expect(Object.keys(call.dicts.en as Record<string, unknown>).length).toBeGreaterThan(0)
  })

  it('binds the plugin settings namespace once', () => {
    const stub = createStub()
    spyWarn()

    registerToolCards(stub.ctx)

    expect(stub.bindNamespaces).toEqual([SETTINGS_NS])
  })

  it('unregisters every card when the webCards switch turns off, and re-registers on again', () => {
    const stub = createStub()
    spyWarn()

    registerToolCards(stub.ctx)
    expect(stub.liveEntries()).toHaveLength(8)

    stub.setSettings({ webCards: false })
    expect(stub.liveEntries()).toHaveLength(0)
    expect(stub.liveKeys()).toEqual([])
    // Disposing, not forgetting: the calls happened, the ledger is empty.
    expect(stub.registerCalls).toHaveLength(8)

    stub.setSettings({ webCards: true })
    expect(stub.liveEntries()).toHaveLength(8)
    expect(new Set(stub.liveKeys())).toEqual(new Set(CARD_TOOL_KEYS))
    expect(stub.registerCalls).toHaveLength(16)
  })

  it('keeps the switch on when the namespace has no value yet', () => {
    const stub = createStub()
    spyWarn()

    registerToolCards(stub.ctx)
    stub.setSettings(undefined)

    expect(stub.liveEntries()).toHaveLength(8)
    expect(stub.registerCalls).toHaveLength(8)
  })

  it('keeps every card and reports the lost cell when another component wins a cell', () => {
    const stub = createStub()
    const error = spyError()
    stub.hijack('write')

    expect(() => registerToolCards(stub.ctx)).not.toThrow()

    // 不自动注销：接管假设被打破是宿主语义变化的信号，要报出来，不能悄悄换回官方行。
    expect(stub.registerCalls).toHaveLength(8)
    expect(stub.liveEntries()).toHaveLength(8)
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0]?.[0])).toContain('write')
  })

  it('does not complain when the winners are all its own rows', () => {
    const stub = createStub()
    const error = spyError()
    // A foreign winner on a key we never register must not matter.
    stub.hijack('not_a_card')

    registerToolCards(stub.ctx)

    expect(stub.liveEntries()).toHaveLength(8)
    expect(error).not.toHaveBeenCalled()
  })

  it('stays idempotent when install is triggered repeatedly', () => {
    const stub = createStub()
    spyWarn()

    registerToolCards(stub.ctx)
    expect(stub.registerCalls).toHaveLength(8)

    stub.pulse()
    stub.pulse()
    stub.setSettings({ webCards: true })
    stub.pulse()

    expect(stub.registerCalls).toHaveLength(8)
    expect(stub.liveEntries()).toHaveLength(8)
    expect(new Set(stub.liveKeys())).toEqual(new Set(CARD_TOOL_KEYS))
  })

  it('wires the settings subscription and both effect disposers to harmless ends', () => {
    const stub = createStub()
    spyWarn()

    registerToolCards(stub.ctx)

    // One subscription (the switch), two effects (dictionaries + switch).
    expect(stub.listenerCount()).toBe(1)
    expect(stub.effectLabels).toHaveLength(2)

    expect(() => stub.setSettings({ webCards: false })).not.toThrow()
    expect(() => stub.setSettings({ webCards: true })).not.toThrow()
    expect(() => stub.runEffectDisposers()).not.toThrow()

    // The switch's disposer is the unsubscribe the module returned.
    expect(stub.listenerCount()).toBe(0)
    expect(() => stub.setSettings({ webCards: false })).not.toThrow()
  })

  it('comes back after an off/on cycle and reports a lost cell instead of rolling back', () => {
    const stub = createStub()
    const error = spyError()

    registerToolCards(stub.ctx)
    stub.setSettings({ webCards: false })
    expect(stub.liveEntries()).toHaveLength(0)

    stub.hijack('bash')
    expect(() => stub.setSettings({ webCards: true })).not.toThrow()

    expect(stub.liveEntries()).toHaveLength(8)
    expect(stub.registerCalls).toHaveLength(16)
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0]?.[0])).toContain('bash')
  })
})
