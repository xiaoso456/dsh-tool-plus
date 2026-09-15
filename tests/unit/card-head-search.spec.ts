/**
 * Unit tests for the search cards' collapsed trailing fragment: the scope a
 * grep / ast_grep call actually searched, and the result count (or "no
 * results") every search shape needs before it is expanded.
 *
 * A search's subject on the row is its *pattern*, so the scope had no place to
 * be seen at all — worst when the search found nothing, where a bare
 * `Grep · zzz` reads as if the pattern were wrong rather than as if the tool
 * looked in the wrong tree. A glob is the exception: its own argument is the
 * path pattern, so it needs the count, not a scope.
 * @module tests
 */

import { describe, expect, it } from 'vitest'
import type { SearchCardMeta } from '../../src/web/contract.ts'
import { en, zh } from '../../src/web/client/labels.ts'
import type { CardTranslate } from '../../src/web/client/row-utils.ts'
import { searchCardSuffix } from '../../src/web/client/rows/search-card-facts.ts'

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

/** Grouped matches for `foo`: 2 in a.ts + 1 in b.ts. */
const matches: SearchCardMeta = {
  kind: 'search',
  shape: 'matches',
  files: [
    { path: 'src/a.ts', matches: [{ lineNumber: 1, line: 'foo' }, { lineNumber: 9, line: 'foo' }] },
    { path: 'src/b.ts', matches: [{ lineNumber: 4, line: 'foo' }] },
  ],
  truncated: false,
  total: 3,
}

describe('search card suffix', () => {
  it('names the scope the search actually ran in, then the counts', () => {
    expect(searchCardSuffix({ pattern: 'foo', path: 'src/tools' }, matches, '/w/app', t.zh))
      .toBe('· 范围 src/tools · 3 处匹配 · 2 个文件')
  })

  it('shortens a workspace-absolute scope', () => {
    expect(searchCardSuffix({ pattern: 'foo', path: '/w/app/src/tools' }, matches, '/w/app', t.zh))
      .toBe('· 范围 src/tools · 3 处匹配 · 2 个文件')
  })

  it('shortens every path of a semicolon-delimited scope', () => {
    // The target grammar accepts a `;`-delimited list. One prefix cut would
    // shorten the first entry and leave the rest absolute, so the same scope
    // would read as two unrelated things.
    expect(searchCardSuffix({ pattern: 'foo', path: '/w/app/a.ts; /w/app/src' }, matches, '/w/app', t.zh))
      .toBe('· 范围 a.ts; src · 3 处匹配 · 2 个文件')
    expect(searchCardSuffix({ pattern: 'foo', path: 'src/a.ts; src/b.ts' }, matches, '/w/app', t.zh))
      .toBe('· 范围 src/a.ts; src/b.ts · 3 处匹配 · 2 个文件')
  })

  it('says the search was empty instead of showing zero counts', () => {
    const empty: SearchCardMeta = { kind: 'search', shape: 'matches', files: [], truncated: false, total: 0 }
    expect(searchCardSuffix({ pattern: 'zzz', path: 'src/tools' }, empty, '/w/app', t.zh))
      .toBe('· 范围 src/tools · 无结果')
  })

  it('drops the scope fragment when the call searched the workspace root', () => {
    // No `path` argument means the workspace root; naming a scope the model
    // never typed would claim a tree the call did not ask for.
    expect(searchCardSuffix({ pattern: 'foo' }, matches, '/w/app', t.zh)).toBe('· 3 处匹配 · 2 个文件')
    expect(searchCardSuffix(null, matches, '/w/app', t.zh)).toBe('· 3 处匹配 · 2 个文件')
  })

  it('reports what was kept of a capped match payload', () => {
    const capped: SearchCardMeta = {
      kind: 'search',
      shape: 'matches',
      files: [{ path: 'src/a.ts', matches: [{ lineNumber: 1, line: 'foo' }] }],
      truncated: true,
      total: 40,
    }
    expect(searchCardSuffix({ pattern: 'foo', path: 'src/tools' }, capped, '/w/app', t.zh))
      .toBe('· 范围 src/tools · 显示 1 / 共 40 处匹配 · 1 个文件')
  })

  it('shows a glob\'s count without a scope: its argument is its scope', () => {
    const paths: SearchCardMeta = {
      kind: 'search',
      shape: 'paths',
      paths: ['src/a.ts', 'src/b.ts'],
      truncated: false,
      total: 2,
    }
    expect(searchCardSuffix({ path: 'src/**/*.ts' }, paths, '/w/app', t.zh)).toBe('· 2 个路径')
  })

  it('reports a capped and an empty path list', () => {
    const capped: SearchCardMeta = {
      kind: 'search',
      shape: 'paths',
      paths: ['src/a.ts'],
      truncated: true,
      total: 50,
    }
    const empty: SearchCardMeta = { kind: 'search', shape: 'paths', paths: [], truncated: false, total: 0 }
    expect(searchCardSuffix({ path: 'src/**/*.ts' }, capped, '/w/app', t.zh)).toBe('· 显示 1 / 共 50 个路径')
    expect(searchCardSuffix({ path: 'src/**/*.ts' }, empty, '/w/app', t.zh)).toBe('· 无结果')
  })

  it('speaks English in the English dictionary', () => {
    expect(searchCardSuffix({ pattern: 'foo', path: 'src/tools' }, matches, '/w/app', t.en))
      .toBe('· in src/tools · 3 matches · 2 files')
  })
})
