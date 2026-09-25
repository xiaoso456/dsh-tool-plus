/**
 * Tool-plus settings surfaces, browser half. Registers the plugin's two
 * settings pages and binds the `tool-plus` namespace for reads and writes.
 *
 * dsh 0.1.7 replaced the settings surface contract this file used to speak:
 *
 *  - `ctx.settingsScope.bind(...)` (the removed `SettingsScope` binder) is now
 *    `ctx.configForms.get(ns)` — the settings domain's shared configuration
 *    form for one Host entry, keyed by the settings namespace (the entry's own
 *    id, which this package spells `tool-plus` because a client package must
 *    not depend on the Host package that registers it);
 *  - the keyed `settings.plugin.item` card slot is gone. A plugin's own
 *    configuration page is now a tab in the Plugins section
 *    (`settings.plugins.tab`), exactly as the official companion packages
 *    (`ui-settings-shell` and friends) register theirs;
 *  - both pages register through `configForms.whileServed([ns], ...)`, so a
 *    deployment whose Host does not serve the `tool-plus` namespace shows no
 *    trace of them (the official rule: a page for a namespace nobody serves is
 *    never dispatched).
 *
 * The plugin's own navigation page (`settings.section`, id `tool-plus`) keeps
 * its order right after the Plugins section. Only officially exported APIs are
 * used (the `dsh-client-ui-slots` slot registry, the `dsh-client-locale`
 * dictionary registration, the `dsh-client-ui-settings` configuration forms,
 * and this package's own card and section components).
 *
 * @module @xiaoso/dsh-tool-plus/client
 */

// Type-only: pulls the settings SlotMap declarations (`settings.section`,
// `settings.plugins.tab`) and the `ctx.configForms` Context merge.
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
import { registerToolCards } from '../web/client/registerToolCards.ts'

/**
 * Settings namespace of this plugin, spelled here because a client package
 * must not depend on a Host package — official convention: the browser half
 * spells the same value the Host plugin registers (src/config/settings.ts).
 */
export const BASH_PLUS_CLIENT_NS = 'tool-plus'

/** Locale dictionary namespace of this package's card copy. */
const BASH_PLUS_LOCALE_NS = 'tool-plus' as const

/** Required services (cordis fiber inject): slots + locale + the shared configuration forms. */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Mount the tool-plus settings surfaces.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  // Dictionary registration rides the caller's fiber; the page registrations
  // declare the same locale namespace, so the renderer re-renders them on a
  // locale switch (LocaleFace revision bump).
  ctx.effect(() => ctx.locale.register(BASH_PLUS_LOCALE_NS, { zh, en }), 'tool-plus: card dictionaries')

  // One shared form per namespace: `configForms.get` returns the same instance
  // for the same namespace, so both pages read and write one document.
  const cardForm = ctx.configForms.get<BashPlusSettings>(BASH_PLUS_CLIENT_NS)
  const sectionForm = ctx.configForms.get<ToolSettingsValue>(BASH_PLUS_CLIENT_NS)

  // The plugin's own page in the Plugins section: dsh 0.1.7 turned the keyed
  // card slot into one tab per contributing plugin. Order 20 places it after
  // the shipped inventory tab (order 10).
  ctx.effect(() => ctx.configForms.whileServed([BASH_PLUS_CLIENT_NS], () => ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: BASH_PLUS_CLIENT_NS,
    order: 20,
    label: () => ctx.locale.bind(BASH_PLUS_LOCALE_NS)('title'),
    locale: BASH_PLUS_LOCALE_NS,
    inject: (): BashPlusCardFace => ({ form: cardForm }),
  }, BashPlusCard))), 'tool-plus: plugins page')

  // Tool cards: this plugin draws its own rows for the tools it registers —
  // shadowing the shipped rows where the composition has one, additive for the
  // AST tools — and keeps them in step with the `webCards` switch.
  registerToolCards(ctx)

  // The plugin's own Settings navigation page, placed right after the Plugins
  // section (order 16) so the tool suite reads as one more settings surface.
  // It edits the same namespace through the same shared form.
  ctx.effect(() => ctx.configForms.whileServed([BASH_PLUS_CLIENT_NS], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'tool-plus',
    order: 16,
    label: () => ctx.locale.bind(BASH_PLUS_LOCALE_NS)('nav'),
    locale: BASH_PLUS_LOCALE_NS,
    inject: (): ToolPlusSectionInjected => ({ form: sectionForm }),
  }, ToolPlusSection))), 'tool-plus: settings page')
}
