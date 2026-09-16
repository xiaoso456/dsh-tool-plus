/**
 * Unit spec for the generic card's collapsed summary.
 *
 * Every row falls back to the generic shell when its own card cannot be built —
 * a running call, a session-window-truncated one, a Code Dispatch child, a
 * result with no text, a directory/archive/sqlite read, a Host-projected
 * interruption. The shipped generic row still says what the call ASKED FOR (its
 * variant's own summary keys), and this plugin's fallback must do the same: the
 * argument count it used to print hid the only fact the reader needs — `read` on
 * a directory, a `:raw` window and a child call all collapsed to "1 个参数".
 *
 * The summary is a pure function of the call's arguments, so it is testable
 * under the Node runner (the card components themselves are a browser bundle).
 * @module tests
 */

import { describe, expect, it } from 'vitest'
import { CARD_TOOL_KEYS } from '../../src/web/contract.ts'
import { argsSummary, type CardTranslate } from '../../src/web/client/row-utils.ts'
import { fallbackCardSummary } from '../../src/web/client/rows/fallback-card-facts.ts'

/** A translate seat over the real zh dictionary (missing keys throw). */
function translator(dict: Record<string, string>): CardTranslate {
  return ((key: string, params?: Record<string, unknown>) => {
    const template = dict[key]
    if (template === undefined) throw new Error(`missing dictionary key: ${key}`)
    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
  }) as unknown as CardTranslate
}

const t = translator({
  'generic.noDetail': '无参数',
  'generic.params': '{count} 个参数',
})

describe('fallbackCardSummary', () => {
  it('states the path the read asked for, selector and all', () => {
    expect(fallbackCardSummary('read', { path: 'D:/ws/src/a.ts:1-2' }, 'D:/ws', t)).toBe('src/a.ts:1-2')
    expect(fallbackCardSummary('read', { path: 'D:/ws/archive.zip:inner/x.ts' }, 'D:/ws', t))
      .toBe('archive.zip:inner/x.ts')
    // A directory read is the case that stays degraded for good: it has no
    // window, so the generic shell is its only home and the path is the one
    // fact the head must carry.
    expect(fallbackCardSummary('read', { path: 'D:/ws/src' }, 'D:/ws', t)).toBe('src')
  })

  it('states the url when the read asked for one', () => {
    expect(fallbackCardSummary('read', { url: 'https://example.com/a' }, 'D:/ws', t))
      .toBe('https://example.com/a')
  })

  it('states the command and the intent for bash', () => {
    expect(fallbackCardSummary('bash', { command: 'ls', description: '列举目录' }, 'D:/ws', t))
      .toBe('列举目录 · ls')
    expect(fallbackCardSummary('bash', { command: 'ls' }, 'D:/ws', t)).toBe('ls')
  })

  it('states the path for the file-mutating tools', () => {
    expect(fallbackCardSummary('write', { path: 'D:/ws/src/a.ts', content: 'x' }, 'D:/ws', t)).toBe('src/a.ts')
    expect(fallbackCardSummary('edit', { file_path: 'D:/ws/src/a.ts' }, 'D:/ws', t)).toBe('src/a.ts')
    expect(fallbackCardSummary('edit', { path: 'D:/ws/src/a.ts' }, 'D:/ws', t)).toBe('src/a.ts')
    expect(fallbackCardSummary('ast_edit', { paths: ['D:/ws/src/a.ts'] }, 'D:/ws', t)).toBe('src/a.ts')
  })

  it('states the subject of a search', () => {
    expect(fallbackCardSummary('grep', { pattern: 'export function', path: 'D:/ws/src' }, 'D:/ws', t))
      .toBe('export function')
    expect(fallbackCardSummary('glob', { path: 'D:/ws/src/**/*.ts' }, 'D:/ws', t)).toBe('src/**/*.ts')
    expect(fallbackCardSummary('ast_grep', { pat: 'console.log($$$ARGS)' }, 'D:/ws', t))
      .toBe('console.log($$$ARGS)')
  })

  it('falls back to the argument count only when the call states nothing', () => {
    for (const tool of ['read', 'write', 'edit', 'ast_edit', 'grep', 'glob', 'ast_grep', 'bash']) {
      expect(fallbackCardSummary(tool, null, 'D:/ws', t), tool).toBe(t('generic.noDetail'))
      expect(fallbackCardSummary(tool, {}, 'D:/ws', t), tool).toBe(t('generic.noDetail'))
    }
    // An unknown tool keeps the count: this module knows only these eight keys.
    expect(fallbackCardSummary('todo', { todos: [] }, 'D:/ws', t)).toBe(t('generic.params', { count: 1 }))
    expect(fallbackCardSummary('', { a: 1 }, 'D:/ws', t)).toBe(t('generic.params', { count: 1 }))
    expect(fallbackCardSummary(undefined, { a: 1, b: 2 }, 'D:/ws', t)).toBe(t('generic.params', { count: 2 }))
  })

  it('reads the built-in tools\' own spelling too, so an old transcript still states its path', () => {
    // Before this plugin took the keys over, the shipped tools recorded
    // `file_path`; such a call has no `path` at all.
    expect(fallbackCardSummary('read', { file_path: 'D:/ws/src/a.ts:1-2' }, 'D:/ws', t)).toBe('src/a.ts:1-2')
    expect(fallbackCardSummary('write', { file_path: 'D:/ws/src/a.ts', content: 'x' }, 'D:/ws', t)).toBe('src/a.ts')
    // A search call's `queries` is the shipped row's one special case.
    expect(fallbackCardSummary('grep', { queries: ['export function', 'leadingGlyph'] }, 'D:/ws', t))
      .toBe('export function, leadingGlyph')
    // The table's own choice, not "the first string in the object": `path` comes
    // first here, so only a `query` key can produce `export`.
    expect(fallbackCardSummary('grep', { path: 'D:/ws/src', query: 'export' }, 'D:/ws', t)).toBe('export')
  })

  it('prefers the argument each tool\'s own engine reads when two are present', () => {
    // Our edit engine is `args.file_path ?? args.path`; the shipped table puts
    // `path` first only because the built-in edit has no `path` parameter.
    // Getting this backwards would name a file the call never touched.
    expect(fallbackCardSummary('edit', { file_path: 'D:/ws/real.ts', path: 'D:/ws/wrong.ts' }, 'D:/ws', t))
      .toBe('real.ts')
    expect(fallbackCardSummary('write', { path: 'D:/ws/real.ts', file_path: 'D:/ws/wrong.ts' }, 'D:/ws', t))
      .toBe('real.ts')
  })

  it('states any string the payload carries before it states a count', () => {
    // The shipped row's key-free try: the call said *something*, even under a
    // name this module does not know. First line only, as the shipped row does:
    // a streaming write can briefly carry a whole `content` and no `path` yet.
    expect(fallbackCardSummary('read', { something: 'D:/ws/src/a.ts' }, 'D:/ws', t)).toBe('D:/ws/src/a.ts')
    expect(fallbackCardSummary('write', { content: 'line one\nline two' }, 'D:/ws', t)).toBe('line one')
    // …and the same through the key table: a pattern may legitimately be
    // multi-line, and a head is one line.
    expect(fallbackCardSummary('grep', { pattern: 'alpha\nbeta' }, 'D:/ws', t)).toBe('alpha')
    // A payload whose values are all non-strings has no fact to state, so the
    // raw text (which exists even when the parse does not) is the last try.
    // Without the raw text this is the floor: the count.
    const flags = { caseSensitive: true }
    expect(fallbackCardSummary('glob', flags, 'D:/ws', t)).toBe(t('generic.params', { count: 1 }))
    expect(fallbackCardSummary('glob', flags, 'D:/ws', t, '{"caseSensitive":true}\n{}'))
      .toBe('{"caseSensitive":true}')
    // A call still streaming its arguments does not parse at all; its raw text
    // is the only evidence of what it was about to ask for.
    expect(fallbackCardSummary('bash', null, 'D:/ws', t, '{"command":"node -e \\"setTimeout')).toBe('{"command":"node -e \\"setTimeout')
  })

  it('never shows a count for a key whose arguments state a fact', () => {
    // The regression this whole module exists for: one of the eight keys
    // silently collapsing to "1 个参数" again.
    const sample: Record<string, Record<string, unknown>> = {
      bash: { command: 'ls', description: '列举目录' },
      read: { path: 'D:/ws/src/a.ts' },
      write: { path: 'D:/ws/src/a.ts', content: 'x' },
      edit: { file_path: 'D:/ws/src/a.ts' },
      grep: { pattern: 'foo' },
      glob: { path: 'D:/ws/src/**/*.ts' },
      ast_grep: { pat: 'console.log($$$ARGS)' },
      ast_edit: { paths: ['D:/ws/src/a.ts'] },
    }
    for (const key of CARD_TOOL_KEYS) {
      const args = sample[key]
      expect(args, `${key} needs a sample call`).toBeDefined()
      expect(fallbackCardSummary(key, args, 'D:/ws', t), key).not.toBe(argsSummary(args, t))
    }
  })

  it('survives a malformed argument payload', () => {
    // A call whose only argument is unusable keeps the count: with no fact to
    // state, the count is the honest last resort.
    expect(fallbackCardSummary('read', { path: 42 }, 'D:/ws', t)).toBe(t('generic.params', { count: 1 }))
    expect(fallbackCardSummary('ast_edit', { paths: 'D:/ws/a.ts' }, 'D:/ws', t)).toBe('a.ts')
    expect(fallbackCardSummary('bash', { command: '' }, undefined, t)).toBe(t('generic.params', { count: 1 }))
  })
})
