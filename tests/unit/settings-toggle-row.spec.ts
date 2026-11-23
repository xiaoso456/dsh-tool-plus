/**
 * Toggle-row interaction anatomy.
 *
 * The settings page has no DOM test layer (the client specs are pure functions
 * or source-shape guards), so this renders the real row to static markup and
 * pins the one structural fact behind the interaction bug: a `<label for>`
 * wired to the checkbox makes a click on the title flip the switch. Switch rows
 * name the input with `aria-labelledby` instead; only the 40x24 switch area is
 * clickable.
 * @module tests
 */

import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// The rows import browser-only chrome (icons, menu, portal tooltip). Stub those
// modules so the row itself renders in Node.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutlineRegular: () => null,
  Menu: () => null,
}))
vi.mock('../../src/client/tooltip.tsx', () => ({ InfoTip: () => null }))

import { ToggleRow, type ToggleControl } from '../../src/client/rows.tsx'
import type { BashPlusLocaleKey } from '../../src/client/locales.ts'

const t = (key: BashPlusLocaleKey): string => key
const control: ToggleControl = {
  field: 'enableRunInBackground',
  labelKey: 'enableRunInBackground',
  hintKey: 'enableRunInBackgroundHint',
  checked: true,
  overridden: false,
}

describe('toggle row interaction anatomy', () => {
  it('keeps the title inert: no <label> wires it to the checkbox', () => {
    const html = renderToStaticMarkup(createElement(ToggleRow, {
      t,
      control,
      disabled: false,
      onToggle: () => undefined,
      onReset: () => undefined,
    }))
    expect(html).not.toContain('<label')
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*aria-labelledby="[^"]+"/)
    expect(html).toContain('aria-describedby')
  })
})
