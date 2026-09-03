/**
 * Tool-plus settings card, browser half. Registers the plugin's card into the
 * Plugins settings surface's `settings.plugin.item` slot — keyed by the
 * `tool-plus` namespace, so the configurable tab pairs it with the Host-side
 * namespace of the same name — binds that namespace's settings scope for
 * reads and writes, and registers the card's locale dictionaries.
 *
 * Only officially exported APIs are used (`dsh-client-ui-slots` slot
 * registry, `dsh-client-locale` dictionary registration, `dsh-client-ui-settings`
 * scope contract and binder, and the published
 * `dsh-client-ui-settings-plugins` slot-type declaration); the card itself is
 * this package's own, not a copy of any non-exported card internals.
 *
 * @module @xiaoso/dsh-tool-plus/client
 */

// Type-only: pulls the `settings.plugin.item` SlotMap declaration and
// `SettingsPluginItemOwnerProps` from the published settings surface.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// Type-only: pulls the `ctx.settingsScope` Context merge (the scope binder).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the `ctx.locale` Context merge (dictionary registration).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { BashPlusCard, type BashPlusCardFace, type BashPlusSettings } from './BashPlusCard.tsx'
import { ToolPlusSection, type ToolPlusSectionInjected } from './ToolPlusSection.tsx'
import type { ToolSettingsValue } from './forms.ts'
import { en, zh } from './locales.ts'

/**
 * Settings namespace of this plugin, spelled here because a client package
 * must not depend on a Host package — official convention: the browser half
 * spells the same value the Host plugin registers (src/config/settings.ts).
 */
export const BASH_PLUS_CLIENT_NS = 'tool-plus'

/** Locale dictionary namespace of this package's card copy. */
const BASH_PLUS_LOCALE_NS = 'tool-plus' as const

/** Required services (cordis fiber inject): slots + locale + the settings scope binder. */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * Mount the tool-plus settings card.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  // Dictionary registration rides the caller's fiber; the card's slot entry
  // declares the same locale namespace, so the renderer re-renders it on a
  // locale switch (LocaleFace revision bump).
  ctx.effect(() => ctx.locale.register(BASH_PLUS_LOCALE_NS, { zh, en }), 'tool-plus: card dictionaries')

  const scope = ctx.settingsScope.bind<BashPlusSettings>({ namespace: BASH_PLUS_CLIENT_NS })
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: BASH_PLUS_CLIENT_NS,
    locale: BASH_PLUS_LOCALE_NS,
    inject: (): BashPlusCardFace => ({ scope }),
  }, BashPlusCard))

  // The plugin's own Settings page, placed right after the Plugins section
  // (order 15) so the tool suite reads as one more settings surface. The
  // section edits the same namespace through the same bound scope.
  const sectionScope = ctx.settingsScope.bind<ToolSettingsValue>({ namespace: BASH_PLUS_CLIENT_NS })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'tool-plus',
    order: 16,
    label: () => ctx.locale.bind(BASH_PLUS_LOCALE_NS)('nav'),
    locale: BASH_PLUS_LOCALE_NS,
    inject: (): ToolPlusSectionInjected => ({ scope: sectionScope }),
  }, ToolPlusSection))
}
