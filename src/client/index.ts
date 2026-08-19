/**
 * Bash-plus settings card, browser half. Registers the plugin's card into the
 * Plugins settings surface's `settings.plugin.item` slot — keyed by the
 * `bash-plus` namespace, so the configurable tab pairs it with the Host-side
 * namespace of the same name — binds that namespace's settings scope for
 * reads and writes, and registers the card's locale dictionaries.
 *
 * Only officially exported APIs are used (`dsh-client-ui-slots` slot
 * registry, `dsh-client-locale` dictionary registration, `dsh-client-runtime`
 * scope contract, `dsh-client-ui-settings` scope binder, and the published
 * `dsh-client-ui-settings-plugins` slot-type declaration); the card itself is
 * this package's own, not a copy of any non-exported card internals.
 *
 * @module @xiaoso/dsh-bash-plus/client
 */

// Type-only: pulls the `settings.plugin.item` SlotMap declaration and
// `SettingsPluginItemOwnerProps` from the published settings surface.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// Type-only: pulls the `ctx.settingsScope` Context merge (the scope binder).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the `ctx.locale` Context merge (dictionary registration).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { BashPlusCard, type BashPlusCardFace, type BashPlusSettings } from './BashPlusCard.tsx'
import { en, zh } from './locales.ts'

/**
 * Settings namespace of this plugin, spelled here because a client package
 * must not depend on a Host package — official convention: the browser half
 * spells the same value the Host plugin registers (src/config/settings.ts).
 */
export const BASH_PLUS_CLIENT_NS = 'bash-plus'

/** Locale dictionary namespace of this package's card copy. */
const BASH_PLUS_LOCALE_NS = 'bash-plus' as const

/** Required services (cordis fiber inject): slots + locale + the settings scope binder. */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * Mount the bash-plus settings card.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  // Dictionary registration rides the caller's fiber; the card's slot entry
  // declares the same locale namespace, so the renderer re-renders it on a
  // locale switch (LocaleFace revision bump).
  ctx.effect(() => ctx.locale.register(BASH_PLUS_LOCALE_NS, { zh, en }), 'bash-plus: card dictionaries')

  const scope = ctx.settingsScope.bind<BashPlusSettings>({ namespace: BASH_PLUS_CLIENT_NS })
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: BASH_PLUS_CLIENT_NS,
    locale: BASH_PLUS_LOCALE_NS,
    inject: (): BashPlusCardFace => ({ scope }),
  }, BashPlusCard))
}
