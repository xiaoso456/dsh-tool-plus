/**
 * Leading-treatment unit spec: which glyph a row leads with, and what replaces
 * it when the call did not settle cleanly.
 *
 * The treatment is the shipped `ToolRow`'s own (`leadingFor`): a settled or
 * running call leads with the row's glyph, and only a failure or an interrupt
 * swaps that glyph for a state dot. The glyph per tool mirrors the shipped
 * variant table (`VARIANT_ICONS` in the generic tool card), so a row here leads
 * with the same shape the shipped row would have drawn.
 *
 * This file pins the decisions, not the pixels: `card-leading.ts` is pure on
 * purpose so the mapping is testable without a browser (the client half is a
 * browser bundle and cannot render under the Node runner).
 * @module tests
 */

import { describe, expect, it } from 'vitest'
import { CARD_TOOL_KEYS } from '../../src/web/contract.ts'
import { leadingGlyph, leadingKind } from '../../src/web/client/rows/card-leading.ts'
import type { CardState } from '../../src/web/client/row-utils.ts'

describe('leadingGlyph', () => {
  it.each([
    ['bash', 'bash'],
    ['read', 'read'],
    ['write', 'edit'],
    ['edit', 'edit'],
    ['grep', 'search'],
    ['glob', 'search'],
    // This plugin's own two tools are not in the shipped name table; they take
    // the family whose shipped glyph describes the act — a search reads, an
    // atomic edit writes.
    ['ast_grep', 'search'],
    ['ast_edit', 'edit'],
  ])('leads %s with the %s glyph', (toolName, glyph) => {
    expect(leadingGlyph(toolName)).toBe(glyph)
  })

  it('decides a glyph for every card key the plugin registers', () => {
    // A new card key that silently fell through to the generic sparkle would
    // ship an anonymous leading mark; this forces the decision into the diff.
    for (const key of CARD_TOOL_KEYS) {
      expect(leadingGlyph(key), key).not.toBe('others')
    }
  })

  it.each([['', '<empty>'], ['unknown_tool', 'unknown_tool']])(
    'falls back to the generic glyph for %s',
    (toolName) => {
      expect(leadingGlyph(toolName)).toBe('others')
    },
  )

  it('falls back to the generic glyph when the call carries no name at all', () => {
    expect(leadingGlyph(undefined)).toBe('others')
    expect(leadingGlyph(null)).toBe('others')
  })
})

describe('leadingKind', () => {
  it.each([
    ['ok', 'glyph'],
    ['running', 'glyph'],
    ['error', 'error'],
    ['warning', 'warning'],
  ] as ReadonlyArray<[CardState, string]>)('maps %s onto %s', (state, kind) => {
    expect(leadingKind(state)).toBe(kind)
  })
})
