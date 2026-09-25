/**
 * Tool-plus settings surface, browser half: the plugin's own Settings
 * navigation page and the binding of the `tool-plus` namespace it reads and
 * writes.
 *
 * dsh 0.1.7 replaced the settings surface contract this file used to speak:
 *
 *  - `ctx.settingsScope.bind(...)` (the removed `SettingsScope` binder) is now
 *    `ctx.configForms.get(ns)` — the settings domain's shared configuration
 *    form for one Host entry, keyed by the settings namespace (the entry's own
 *    id, which this package spells `tool-plus` because a client package must
 *    not depend on the Host package that registers it);
 *  - the keyed `settings.plugin.item` card slot is gone. Its 0.1.7
 *    replacement — a tab inside the official Plugins section
 *    (`settings.plugins.tab`) — is deliberately NOT used: this plugin already
 *    ships a full Settings page of its own (`settings.section`, id
 *    `tool-plus`) that carries every tool's configuration, so a second entry
 *    point inside the Plugins page would only duplicate it and split the one
 *    form across two surfaces;
 *  - the page registers through `configForms.whileServed([ns], ...)`, so a
 *    deployment whose Host does not serve the `tool-plus` namespace shows no
 *    trace of it (the official rule: a page for a namespace nobody serves is
 *    never dispatched).
 *
 * The navigation page (`settings.section`, id `tool-plus`) keeps its order
 * right after the Plugins section. Only officially exported APIs are used (the
 * `dsh-client-ui-slots` slot registry, the `dsh-client-locale` dictionary
 * registration, the `dsh-client-ui-settings` configuration forms, and this
 * package's own section component).
 *
 * @module @xiaoso/dsh-tool-plus/client
 */

// Type-only: pulls the settings SlotMap declarations (`settings.section`) and
// the `ctx.configForms` Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the `ctx.locale` Context merge (dictionary registration).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
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

/** Locale dictionary namespace of this package's page copy. */
const BASH_PLUS_LOCALE_NS = 'tool-plus' as const

/** Required services (cordis fiber inject): slots + locale + the shared configuration forms. */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Mount the tool-plus settings page.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  // Dictionary registration rides the caller's fiber; the page registration
  // declares the same locale namespace, so the renderer re-renders it on a
  // locale switch (LocaleFace revision bump).
  ctx.effect(() => ctx.locale.register(BASH_PLUS_LOCALE_NS, { zh, en }), 'tool-plus: page dictionaries')

  // The page's own view over the plugin's namespace: `configForms.get` returns
  // one shared form instance per namespace, so the page and the tool cards read
  // one document.
  const form = ctx.configForms.get<ToolSettingsValue>(BASH_PLUS_CLIENT_NS)

  // Tool cards: this plugin draws its own rows for the tools it registers —
  // shadowing the shipped rows where the composition has one, additive for the
  // AST tools — and keeps them in step with the `webCards` switch.
  registerToolCards(ctx)

  // The plugin's Settings navigation page, placed right after the official
  // Plugins section (order 16).
  ctx.effect(() => ctx.configForms.whileServed([BASH_PLUS_CLIENT_NS], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'tool-plus',
    order: 16,
    label: () => ctx.locale.bind(BASH_PLUS_LOCALE_NS)('nav'),
    locale: BASH_PLUS_LOCALE_NS,
    inject: (): ToolPlusSectionInjected => ({ form }),
  }, ToolPlusSection))), 'tool-plus: settings page')
}
