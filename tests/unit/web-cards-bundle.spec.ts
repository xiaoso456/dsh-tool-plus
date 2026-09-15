/**
 * The built browser half, loaded for real.
 *
 * `lib/client.js` is the artifact the web module loader actually executes: a
 * `window.__ModuleLoader__.load({ id, factory })` call whose factory the loader
 * keeps lazy and calls with its own `require`. Everything upstream (typecheck,
 * unit tests over `src/**`) can stay green while that artifact is broken — a
 * wrong banner, an external that leaked into the bundle, React values shipped
 * into the Node half. So this spec loads the file into a fresh `node:vm`
 * context with a minimal `window` / `document` / `require` stand-in, invokes the
 * factory, runs `apply(ctx)` against a **real** `SlotCore` with the shipped rows
 * present, and pins the outcome: the eight cards registered at priority -1000
 * with the card locale, every one of them winning its cell.
 *
 * Needs a build output (`pnpm build`); `lib/` is generated, not committed.
 */
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const CLIENT_BUNDLE = `${REPO_ROOT}lib/client.js`
const NODE_BUNDLE = `${REPO_ROOT}lib/index.mjs`

/** Loader id the tsdown banner stamps into the bundle (== package name). */
const PLUGIN_ID = '@xiaoso/dsh-tool-plus'

/** The shipped atomic tool-view slot every card registers into. */
const TOOLVIEW_SLOT = 'tool.call.toolview'

/** Locale namespace of the tool-card dictionaries. */
const CARD_LOCALE_NS = 'tool-plus-cards'

/** Settings namespace the client half registers its own surfaces under. */
const SETTINGS_NS = 'tool-plus'

/** The priority the cards shadow the shipped rows with (lowest wins). */
const TAKEOVER_PRIORITY = -1000

/** Every card key, in registration order. */
const CARD_KEYS = ['write', 'edit', 'ast_edit', 'read', 'grep', 'glob', 'ast_grep', 'bash'] as const

/** The keys the shipped composition already occupies at the default priority. */
const SHIPPED_KEYS = ['bash', 'read', 'write', 'edit', 'grep', 'glob'] as const

/** A row stand-in: identity is all a ledger / winner check needs. */
function inertComponent(name: string): () => null {
  const row = (): null => null
  Object.defineProperty(row, 'name', { value: name })
  return row
}

/** External module ids the bundle may `require`, as minimal stand-ins. */
function externalStubs(): Record<string, unknown> {
  /** One inert primitive stand-in; `apply()` never renders, it only registers. */
  const primitive = (): null => null
  const primitives = new Proxy({}, {
    get: (target: Record<string, unknown>, prop: string | symbol) => {
      if (typeof prop === 'symbol') return undefined
      return target[prop] ?? primitive
    },
  })
  return {
    // `CardBoundary` is declared at factory-evaluation time (`class extends
    // react.Component`), so Component must be constructible; every hook is a
    // stand-in for render paths this spec does not enter.
    'react': {
      Component: class Component {},
      Fragment: Symbol('Fragment'),
      useCallback: (fn: unknown) => fn,
      useEffect: () => {},
      useId: () => 'stub-id',
      useLayoutEffect: () => {},
      useMemo: (fn: () => unknown) => fn(),
      useRef: () => ({ current: undefined }),
      useState: (initial: unknown) => [initial, () => {}],
    },
    'react/jsx-runtime': { Fragment: Symbol('Fragment'), jsx: primitive, jsxs: primitive },
    // The image card portals its lightbox to `document.body`; the spec never
    // opens it, so an inert identity stand-in is all the factory needs.
    'react-dom': { createPortal: (children: unknown) => children },
    '@deepseek-ai/dsh-client-ui-slots': { SlotCore },
    '@deepseek-ai/dsh-client-ui-primitives': primitives,
    // Used for its `RpcId` brand inside a lazily-built RPC channel.
    '@deepseek-ai/dsh-client-connection/client': { RpcId: (value: unknown) => value },
  }
}

/** One `window.__ModuleLoader__.load({ id, factory })` registration. */
interface LoaderEntry {
  readonly id: string
  readonly factory: (require: (id: string) => unknown) => Record<string, unknown>
}

/** A `<style>` tag the bundle appended to `document.head`, if it ever does. */
interface StyleTag {
  readonly dataset: Record<string, string>
  readonly textContent: string
}

interface BootedBundle {
  /** The factory's `module.exports`. */
  readonly exports: Record<string, unknown>
  /** The ids the bundle registered with `__ModuleLoader__.load`. */
  readonly loaderIds: string[]
  /** External ids the factory asked `require` for, in order. */
  readonly requireCalls: string[]
  /** Console warnings raised while running the script and the factory. */
  readonly warnings: string[]
  /** Stylesheets appended to the stubbed `document.head`. */
  readonly styleTags: StyleTag[]
}

/**
 * Run `lib/client.js` in a fresh VM context and call its factory.
 *
 * The factory stays lazy: nothing is required until the loader calls it, which
 * is exactly what this helper does — with a `require` that only answers the ids
 * in {@link externalStubs} and throws on anything else, so a new external in the
 * artifact fails here instead of in the browser.
 * @returns the factory's exports plus what the sandbox observed.
 */
function bootBundle(): BootedBundle {
  const source = readFileSync(CLIENT_BUNDLE, 'utf8')
  const factories = new Map<string, LoaderEntry['factory']>()
  const loaderIds: string[] = []
  const requireCalls: string[] = []
  const warnings: string[] = []
  const styleTags: StyleTag[] = []

  const documentStub = {
    createElement: (): StyleTag => {
      const tag = { dataset: {} as Record<string, string>, textContent: '' }
      styleTags.push(tag)
      return tag
    },
    querySelector: (): null => null,
    head: { appendChild: (): void => {} },
  }
  const windowStub = {
    __ModuleLoader__: {
      load: (entry: LoaderEntry): void => {
        loaderIds.push(entry.id)
        factories.set(entry.id, entry.factory)
      },
    },
    document: documentStub,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
  }
  const consoleStub = {
    debug: (): void => {},
    error: (...args: unknown[]): void => { warnings.push(args.join(' ')) },
    info: (): void => {},
    log: (): void => {},
    warn: (...args: unknown[]): void => { warnings.push(args.join(' ')) },
  }

  vm.runInNewContext(source, {
    window: windowStub,
    document: documentStub,
    console: consoleStub,
    URL,
    setTimeout,
    clearTimeout,
    queueMicrotask,
  }, { filename: 'lib/client.js' })

  const factory = factories.get(PLUGIN_ID)
  if (factory === undefined) {
    throw new Error(`lib/client.js registered no factory for ${PLUGIN_ID}; saw [${loaderIds.join(', ')}]`)
  }
  const stubs = externalStubs()
  const exports = factory((id: string) => {
    requireCalls.push(id)
    const stub = stubs[id]
    if (stub === undefined) {
      throw new Error(`lib/client.js required "${id}", which this spec's stub table does not map`)
    }
    return stub
  })

  return { exports, loaderIds, requireCalls, warnings, styleTags }
}

/** One entry logged through `ctx.slots.register`. */
interface SlotRegistration {
  readonly options: Record<string, unknown>
  readonly component: unknown
}

interface FabricatedCtx {
  readonly core: SlotCore
  readonly ctx: Record<string, unknown>
  /** Registrations into {@link TOOLVIEW_SLOT}, in order. */
  readonly cards: SlotRegistration[]
  /** Every `ctx.locale.register` namespace. */
  readonly locales: string[]
  /** Every `ctx.settingsScope.bind` namespace. */
  readonly scopes: string[]
  /** The row the shipped composition owns for one key, or undefined. */
  readonly shippedRows: ReadonlyMap<string, unknown>
}

/**
 * A browser plugin context shaped like the real composition's: a real
 * `SlotCore` behind `ctx.slots`, the three slots the shipped plugins declare,
 * the six shipped tool rows already registered at the default priority, and
 * inert locale / settings-scope services.
 *
 * `ctx.slots.inject` mirrors the renderer's contract (the callback runs
 * synchronously once the declaration exists, and its disposer is returned);
 * `entriesOfSlot` is delegated to the real core, which is what the plugin's own
 * winner self-check reads back.
 * @returns the context, its core, and what the stubs observed.
 */
function fabricateCtx(): FabricatedCtx {
  const core = new SlotCore()
  core.register({
    name: 'root',
    children: {
      [TOOLVIEW_SLOT]: { kind: 'keyed', scope: 'session' },
      'settings.plugin.item': { kind: 'keyed', scope: 'session' },
      'settings.section': { kind: 'list', scope: 'session' },
    },
  } as never, inertComponent('shipped-composition') as never)

  const shippedRows = new Map<string, unknown>(
    SHIPPED_KEYS.map(key => [key, inertComponent(`shipped-${key}`)]),
  )
  for (const [key, row] of shippedRows) {
    core.register({ name: TOOLVIEW_SLOT, key, priority: 0 } as never, row as never)
  }

  const cards: SlotRegistration[] = []
  const locales: string[] = []
  const scopes: string[] = []
  const listeners = new Set<() => void>()

  /** Normalize a callback's product (one disposer or an iterable) to a disposer. */
  const asDisposer = (created: unknown): (() => void) => {
    if (typeof created === 'function') return created as () => void
    if (Array.isArray(created)) {
      const disposers = [...created].reverse() as (() => void)[]
      return () => { for (const dispose of disposers) dispose() }
    }
    return () => {}
  }

  const scope = {
    getSnapshot: () => ({ value: {} }),
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }

  const slots = {
    register: (options: Record<string, unknown>, component: unknown): (() => void) => {
      if (options.name === TOOLVIEW_SLOT) cards.push({ options, component })
      return core.register(options as never, component as never)
    },
    inject: (key: string, callback: () => unknown): (() => void) => {
      const dispose = asDisposer(callback())
      return () => { dispose() }
    },
    entries: (key: string) => core.entries(key),
    entriesOfSlot: (key: string) => core.entriesOfSlot(key),
  }

  const ctx = {
    effect: (callback: () => unknown): (() => void) => asDisposer(callback()),
    locale: {
      register: (namespace: string): (() => void) => {
        locales.push(namespace)
        return () => {}
      },
      bind: (): ((key: string) => string) => (key: string) => key,
    },
    settingsScope: {
      bind: ({ namespace }: { namespace: string }) => {
        scopes.push(namespace)
        return scope
      },
    },
    slots,
  }

  return { core, ctx, cards, locales, scopes, shippedRows }
}

/** The winning entry of one cell, as the renderer would pick it. */
function winner(core: SlotCore, key: string): { options: Record<string, unknown>; component: unknown } | undefined {
  return core.entriesOfSlot(TOOLVIEW_SLOT).find(entry => entry.options.key === key) as never
}

describe('lib/client.js — the lazy-CJS factory the loader executes', () => {
  it('registers exactly one loader entry, and requires nothing until called', () => {
    const source = readFileSync(CLIENT_BUNDLE, 'utf8')
    const factories = new Map<string, unknown>()
    const documentStub = { createElement: () => ({ dataset: {}, textContent: '' }), querySelector: () => null, head: { appendChild: () => {} } }
    vm.runInNewContext(source, {
      window: { __ModuleLoader__: { load: (entry: LoaderEntry) => { factories.set(entry.id, entry.factory) } }, document: documentStub },
      document: documentStub,
    }, { filename: 'lib/client.js' })

    // The script body only declares the factory; a side effect in it would run
    // in the browser before the loader decides to load the plugin.
    expect([...factories.keys()]).toEqual([PLUGIN_ID])
  })

  it('stays a CJS factory: loader call in the text, no bare import, under 5 MB', () => {
    const source = readFileSync(CLIENT_BUNDLE, 'utf8')

    expect(source).toContain('window.__ModuleLoader__.load(')
    expect(source).not.toMatch(/^\s*import\s/mu)
    expect(statSync(CLIENT_BUNDLE).size).toBeLessThan(5 * 1024 * 1024)
  })

  it('requires only the frozen externals the loader can answer', () => {
    expect(bootBundle().requireCalls).toEqual([
      'react',
      '@deepseek-ai/dsh-client-ui-primitives',
      'react/jsx-runtime',
      '@deepseek-ai/dsh-client-connection/client',
      'react-dom',
    ])
  })
})

describe('lib/client.js — exports and apply()', () => {
  it('exports apply plus the required-service list, and no ESM default', () => {
    const { exports } = bootBundle()

    expect(typeof exports.apply).toBe('function')
    expect(Array.isArray(exports.inject)).toBe(true)
    expect([...(exports.inject as unknown[])]).toEqual(['slots', 'locale', 'settingsScope'])
    expect(exports.default).toBeUndefined()
    expect(exports.BASH_PLUS_CLIENT_NS).toBe(SETTINGS_NS)
  })

  it('apply() registers the eight cards into tool.call.toolview', () => {
    const { exports } = bootBundle()
    const fabricated = fabricateCtx()
    ;(exports.apply as (ctx: unknown) => void)(fabricated.ctx)

    expect(fabricated.cards).toHaveLength(8)
    expect(fabricated.cards.map(card => card.options.key)).toEqual([...CARD_KEYS])
    for (const card of fabricated.cards) {
      expect(card.options.name).toBe(TOOLVIEW_SLOT)
      expect(card.options.priority).toBe(TAKEOVER_PRIORITY)
      expect(card.options.locale).toBe(CARD_LOCALE_NS)
      expect(typeof card.component).toBe('function')
    }
    expect(fabricated.locales).toContain(CARD_LOCALE_NS)
  })

  it('takeover is real: every card wins its cell over the shipped row', () => {
    const { exports } = bootBundle()
    const fabricated = fabricateCtx()
    ;(exports.apply as (ctx: unknown) => void)(fabricated.ctx)

    const registered = new Map(fabricated.cards.map(card => [card.options.key as string, card.component]))
    for (const key of CARD_KEYS) {
      const cell = winner(fabricated.core, key)
      expect(cell, `winner for ${key}`).toBeDefined()
      expect(cell?.component, `winner for ${key}`).toBe(registered.get(key))
      expect(cell?.options.priority, `winner priority for ${key}`).toBe(TAKEOVER_PRIORITY)
    }
    // The shadowed rows stay on the ledger: that is what lets an unload or the
    // settings switch put the shipped row back without re-registering it.
    const ledger = fabricated.core.entries(TOOLVIEW_SLOT).map(entry => entry.component)
    for (const key of SHIPPED_KEYS) expect(ledger).toContain(fabricated.shippedRows.get(key))
  })

  it('apply() also mounts its own settings surfaces, without falling back', () => {
    const { exports, warnings } = bootBundle()
    const fabricated = fabricateCtx()
    ;(exports.apply as (ctx: unknown) => void)(fabricated.ctx)

    // One bound scope per surface: the tool-card switch, the settings card, the
    // settings section — all bound on the plugin's single namespace.
    expect(fabricated.scopes).toHaveLength(3)
    expect(fabricated.scopes.every(namespace => namespace === SETTINGS_NS)).toBe(true)
    expect(fabricated.locales).toContain(SETTINGS_NS)
    expect(fabricated.core.entries('settings.plugin.item').map(entry => entry.options.key)).toEqual([SETTINGS_NS])
    expect(fabricated.core.entriesOfSlot('settings.section').map(entry => entry.options.id)).toEqual([SETTINGS_NS])
    // The winner self-check inside the plugin must not have stepped aside.
    expect(warnings.filter(message => message.includes('could not take over'))).toEqual([])
  })
})

describe('lib/index.mjs — the Node half stays React-free', () => {
  it('never imports or requires react', () => {
    const source = readFileSync(NODE_BUNDLE, 'utf8')

    expect(source.match(/(?:from|require\()\s*["']react(?:\/[^"']*)?["']/gu) ?? []).toEqual([])
  })
})
