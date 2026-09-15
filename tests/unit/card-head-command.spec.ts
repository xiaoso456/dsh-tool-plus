/**
 * Unit tests for the two command-shaped cards' collapsed facts: the command a
 * bash description hides, and the rewrite rule an ast_edit preview only shows
 * once expanded.
 *
 * Both cards used to make the reader expand (or guess) to learn what actually
 * ran or what rule was applied: `Bash · 列出所有测试文件` names the intent,
 * never the command, and an `ast_edit` row's body previews the *result* while
 * the rule that produced it lived only in the call's arguments.
 * @module tests
 */

import { describe, expect, it } from 'vitest'
import { en, zh } from '../../src/web/client/labels.ts'
import type { CardTranslate } from '../../src/web/client/row-utils.ts'
import { astEditRuleLine, bashCardSummary } from '../../src/web/client/rows/command-card-facts.ts'

/** A recording translate seat over one dictionary. */
function translator(dict: Record<string, string>): CardTranslate {
  return ((key: string, params?: Record<string, unknown>) => {
    const template = dict[key]
    if (template === undefined) throw new Error(`missing dictionary key: ${key}`)
    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
  }) as unknown as CardTranslate
}

/** The card dictionary in each language. */
const t = { zh: translator(zh), en: translator(en) }

describe('bash card summary', () => {
  it('adds the command the description hides', () => {
    expect(bashCardSummary('列出所有测试文件', 'pnpm test --run', null))
      .toBe('列出所有测试文件 · pnpm test --run')
  })

  it('is the command alone when the model wrote no description', () => {
    expect(bashCardSummary(null, 'pnpm build', null)).toBe('pnpm build')
    expect(bashCardSummary('', 'pnpm build', null)).toBe('pnpm build')
  })

  it('shows only the command\'s first line', () => {
    expect(bashCardSummary('两件事', 'pnpm test --run\nrm -rf dist', null))
      .toBe('两件事 · pnpm test --run')
  })

  it('reports the outcome instead when the run was interrupted', () => {
    // A timed-out or cancelled run has no result to describe; the outcome is
    // the whole fact and the command must not push it out of the row.
    expect(bashCardSummary('列出所有测试文件', 'pnpm test --run', '已超时')).toBe('已超时')
    expect(bashCardSummary(null, 'pnpm build', '已取消')).toBe('已取消')
  })
})

describe('ast_edit rule line', () => {
  it('states the rewrite the call asked for', () => {
    expect(astEditRuleLine({ ops: [{ pat: 'console.log($A)', out: 'log($A)' }], paths: ['src/a.ts'] }, t.zh))
      .toBe('规则: console.log($A) → log($A)')
  })

  it('counts every op the line does not state', () => {
    // House style marks an elided tail with a leading ellipsis (the same
    // `… 其余 N 行` a collapsed window uses). The count is every *other* entry
    // the call carried, usable or not: otherwise a two-entry call whose first
    // entry cannot be drawn would claim to have had exactly one rule.
    expect(astEditRuleLine({ ops: [{ pat: 'a', out: 'b' }, { pat: 'c', out: 'd' }] }, t.zh))
      .toBe('规则: a → b · … 其余 1 条')
  })

  it('skips entries that are not a usable rule, still counting them', () => {
    expect(astEditRuleLine({ ops: [{ pat: 'orphan' }, { pat: 'x', out: 'y' }] }, t.zh))
      .toBe('规则: x → y · … 其余 1 条')
    expect(astEditRuleLine({ ops: [{ pat: '', out: 'y' }, { pat: 'x', out: 42 }] }, t.zh)).toBeNull()
    expect(astEditRuleLine({ ops: [{ pat: 'orphan' }, { pat: 'x', out: 'y' }, { pat: 'z', out: 'w' }] }, t.zh))
      .toBe('规则: x → y · … 其余 2 条')
  })

  it('states an empty replacement instead of hiding the op', () => {
    // An empty `out` is the engine's own "replace with nothing": it is a real
    // rule, so the line states it (the arrow ends the line) rather than
    // skipping the entry and reporting a shorter call than was made.
    expect(astEditRuleLine({ ops: [{ pat: 'a', out: '' }, { pat: 'b', out: 'c' }] }, t.zh))
      .toBe('规则: a → · … 其余 1 条')
  })

  it('has no rule to state when the call head is gone or the ops are unusable', () => {
    expect(astEditRuleLine(null, t.zh)).toBeNull()
    expect(astEditRuleLine({ paths: ['src/a.ts'] }, t.zh)).toBeNull()
    expect(astEditRuleLine({ ops: [] }, t.zh)).toBeNull()
    expect(astEditRuleLine({ ops: 'run' }, t.zh)).toBeNull()
  })

  it('speaks English in the English dictionary', () => {
    expect(astEditRuleLine({ ops: [{ pat: 'a', out: 'b' }, { pat: 'c', out: 'd' }] }, t.en))
      .toBe('Rules: a → b · … 1 more')
  })
})
