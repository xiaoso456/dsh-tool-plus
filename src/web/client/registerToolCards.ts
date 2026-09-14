/**
 * Register every tool card this plugin renders through the keyed
 * `tool.call.toolview` slot.
 *
 * Two shapes live here:
 *  - `ast_grep` / `ast_edit` are this plugin's own tool names, so their keys are
 *    unclaimed and registering them is purely additive;
 *  - `bash` / `read` / `write` / `edit` / `grep` / `glob` have a shipped row at
 *    the slot's default priority, which we shadow by registering at
 *    {@link CARD_TAKEOVER_PRIORITY} (the lowest live entry of a cell renders).
 *
 * The shadowing mechanism is a public API but has no published design note, so
 * this module never trusts it blindly: right after registering it reads the
 * cell winners back and, when one of them is not our row, it reports the lost
 * key (`console.error`) and keeps its own entries anyway — a mixed tool view is
 * the deliberate signal that the takeover assumption broke, never a silent
 * fallback to the shipped rows. The `webCards` settings switch (default on)
 * mounts and unmounts the cards on demand.
 *
 * Registration runs inside `ctx.slots.inject`, so it waits for the shipped
 * declaration and is torn down with the plugin fiber. A crash inside a row is
 * contained by that row's own boundary rather than thrown at the slot.
 *
 * @module @xiaoso/dsh-tool-plus/web/client/registerToolCards
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the `tool.call.toolview` SlotMap declaration and the
// `ToolCallViewProps` component contract from the published tool surface.
// Keeping it type-only keeps the runtime bundle free of a package we do not
// ship (ui-tool is not in the client platform baseline).
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
// Type-only: pulls the `ctx.slots` service merge (SlotRegistry).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the `ctx.locale` Context merge (dictionary registration).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the `ctx.settingsScope` Context merge (the scope binder).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { CARD_TAKEOVER_PRIORITY, CARD_TOOL_KEYS } from '../contract.ts'
import { CARD_LOCALE_NS, cardLocales } from './labels.ts'
import AstEditRow from './rows/AstEditRow.tsx'
import FileMutationRow from './rows/FileMutationRow.tsx'
import ReadRow from './rows/ReadRow.tsx'
import SearchRow from './rows/SearchRow.tsx'
import TerminalRow from './rows/TerminalRow.tsx'
import WriteRow from './rows/WriteRow.tsx'

/** The shipped atomic tool-view slot every card registers into. */
const TOOLVIEW_SLOT = 'tool.call.toolview'

/** Settings namespace of this plugin (the browser half spells the Host's). */
const SETTINGS_NS = 'tool-plus'

/** Every row component this module owns, for the winner self-check. */
const OWN_COMPONENTS: ReadonlySet<unknown> = new Set([
  WriteRow, FileMutationRow, AstEditRow, ReadRow, SearchRow, TerminalRow,
])

/** Settings document read back by the switch (one field is consulted). */
interface CardSettings {
  webCards?: boolean
}

/**
 * Mount the tool cards.
 *
 * Registers the card dictionaries and one entry per tool key, then keeps the
 * registration in step with the `webCards` switch. Everything
 * installed here rides the caller's fiber, so plugin unload removes it all.
 * @param ctx - the browser plugin context.
 */
export function registerToolCards(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(CARD_LOCALE_NS, cardLocales), 'tool-plus: card dictionaries')

  let disposeEntries: (() => void) | undefined

  const installEntries = (): (() => void)[] => {
    const disposers = [
      ctx.slots.register({ name: TOOLVIEW_SLOT, key: 'write', priority: CARD_TAKEOVER_PRIORITY, locale: CARD_LOCALE_NS }, WriteRow),
      ctx.slots.register({ name: TOOLVIEW_SLOT, key: 'edit', priority: CARD_TAKEOVER_PRIORITY, locale: CARD_LOCALE_NS }, FileMutationRow),
      ctx.slots.register({ name: TOOLVIEW_SLOT, key: 'ast_edit', priority: CARD_TAKEOVER_PRIORITY, locale: CARD_LOCALE_NS }, AstEditRow),
      ctx.slots.register({ name: TOOLVIEW_SLOT, key: 'read', priority: CARD_TAKEOVER_PRIORITY, locale: CARD_LOCALE_NS }, ReadRow),
      ctx.slots.register({ name: TOOLVIEW_SLOT, key: 'grep', priority: CARD_TAKEOVER_PRIORITY, locale: CARD_LOCALE_NS }, SearchRow),
      ctx.slots.register({ name: TOOLVIEW_SLOT, key: 'glob', priority: CARD_TAKEOVER_PRIORITY, locale: CARD_LOCALE_NS }, SearchRow),
      ctx.slots.register({ name: TOOLVIEW_SLOT, key: 'ast_grep', priority: CARD_TAKEOVER_PRIORITY, locale: CARD_LOCALE_NS }, SearchRow),
      ctx.slots.register({ name: TOOLVIEW_SLOT, key: 'bash', priority: CARD_TAKEOVER_PRIORITY, locale: CARD_LOCALE_NS }, TerminalRow),
    ]
    if (!winnersAreOurs(ctx)) {
      // Some other entry outranks us (or a boundary retired one of our rows).
      // Our entries stay: the host then renders a mixed view, which is exactly
      // the visible signal that the takeover assumption broke. Silently
      // rolling back to the shipped rows would hide a host semantics change.
      console.error(
        `[tool-plus] web tool cards did not win ${TOOLVIEW_SLOT} at priority ${String(CARD_TAKEOVER_PRIORITY)} for:`
          + ` ${lostCardKeys(ctx).join(', ')}. Keeping our entries; another component renders those cells.`,
      )
    }
    return disposers
  }

  const install = (): void => {
    if (disposeEntries !== undefined) return
    // `inject` waits for the shipped declaration (ui-tool owns it) and re-runs
    // if that declaration is ever recreated.
    disposeEntries = ctx.slots.inject(TOOLVIEW_SLOT, () => installEntries())
  }

  const uninstall = (): void => {
    disposeEntries?.()
    disposeEntries = undefined
  }

  const scope = ctx.settingsScope.bind<CardSettings>({ namespace: SETTINGS_NS })
  ctx.effect(() => {
    const sync = (): void => {
      if (cardsEnabled(scope.getSnapshot().value)) install()
      else uninstall()
    }
    const stop = scope.subscribe(sync)
    sync()
    return stop
  }, 'tool-plus: web card switch')
}

/**
 * Whether the cards should be mounted for one settings document.
 *
 * An absent field (first load, namespace not exposed to this client, plugin not
 * yet described) means on: the shipped rows are the fallback, not the target.
 * @param value - the namespace's last accepted section, when there is one.
 * @returns `true` unless the field is explicitly `false`.
 */
function cardsEnabled(value: CardSettings | undefined): boolean {
  return value?.webCards !== false
}

/**
 * Read the current cell winners back and report whether every one of them is a
 * row this module registered.
 *
 * Called immediately after registering, while the ledger is synchronously
 * consistent: a cell whose winner is some other component means our entry did
 * not take the cell — something outranks it, or a boundary retired it.
 * @param ctx - the browser plugin context owning this registration.
 * @returns `true` when every card key resolves to one of this module's rows.
 */
function winnersAreOurs(ctx: ClientContext): boolean {
  return lostCardKeys(ctx).length === 0
}

/**
 * The card keys whose current cell winner is not one of this module's rows.
 *
 * The takeover assumption is unverified host behaviour, so a lost cell is
 * reported by name rather than swallowed.
 * @param ctx - the browser plugin context owning this registration.
 * @returns the lost keys, in contract order (empty when every cell is ours).
 */
function lostCardKeys(ctx: ClientContext): string[] {
  const winners = ctx.slots.entriesOfSlot(TOOLVIEW_SLOT)
  const lost: string[] = []
  for (const key of CARD_TOOL_KEYS) {
    const winner = winners.find(entry => entry.options.key === key)
    if (winner === undefined || !OWN_COMPONENTS.has(winner.component)) lost.push(key)
  }
  return lost
}
