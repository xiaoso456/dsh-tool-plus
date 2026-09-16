/**
 * Unit spec for the degraded row's openable path.
 *
 * The head states the call verbatim — `:1-2`, `archive.zip:member`,
 * `db.sqlite:table:key` and all — while a link has to name a real file, which
 * is exactly the split the read card already makes (`readCardSummary` keeps the
 * selector; the link gets the projected path). A degraded row now offers the
 * same link: whether the file then previews is the side bar's decision, not
 * this module's.
 *
 * A URL is not a session file, and a tool whose argument is a scope rather than
 * one file (bash, the searches) gets no link at all.
 * @module tests
 */

import { describe, expect, it } from 'vitest'
import { fallbackCardLink } from '../../src/web/client/rows/fallback-card-facts.ts'

describe('fallbackCardLink', () => {
  it('offers the real file behind a selector, because a link must name a file', () => {
    expect(fallbackCardLink('read', { path: 'D:/ws/src/a.ts:1-2' })).toBe('D:/ws/src/a.ts')
    expect(fallbackCardLink('read', { path: 'D:/ws/archive.zip:inner/x.txt' })).toBe('D:/ws/archive.zip')
    expect(fallbackCardLink('read', { path: 'D:/ws/people.sqlite:people:2' })).toBe('D:/ws/people.sqlite')
    // A Windows drive letter is not a selector.
    expect(fallbackCardLink('read', { path: 'D:/ws/plain.ts' })).toBe('D:/ws/plain.ts')
    expect(fallbackCardLink('read', { path: 'C:\\ws\\plain.ts' })).toBe('C:\\ws\\plain.ts')
    // The built-in tool's spelling still names its file.
    expect(fallbackCardLink('read', { file_path: 'D:/ws/src/a.ts:1-2' })).toBe('D:/ws/src/a.ts')
  })

  it('refuses a url: a side bar preview of a page is not a session file', () => {
    expect(fallbackCardLink('read', { url: 'https://example.com/a' })).toBeNull()
    expect(fallbackCardLink('read', { path: 'https://example.com/a' })).toBeNull()
    expect(fallbackCardLink('read', { path: 'skill://catalog/x' })).toBeNull()
  })

  it('offers the path of the file-mutating tools', () => {
    expect(fallbackCardLink('write', { path: 'D:/ws/src/a.ts', content: 'x' })).toBe('D:/ws/src/a.ts')
    expect(fallbackCardLink('edit', { file_path: 'D:/ws/real.ts', path: 'D:/ws/wrong.ts' })).toBe('D:/ws/real.ts')
    expect(fallbackCardLink('ast_edit', { paths: ['D:/ws/src/a.ts'] })).toBe('D:/ws/src/a.ts')
    expect(fallbackCardLink('ast_edit', { paths: 'D:/ws/src/a.ts' })).toBe('D:/ws/src/a.ts')
  })

  it('offers nothing for a tool whose argument is a scope, not a file', () => {
    for (const tool of ['bash', 'grep', 'glob', 'ast_grep', 'todo', '']) {
      expect(fallbackCardLink(tool, { path: 'D:/ws/src', pattern: 'x', command: 'ls' }), tool).toBeNull()
    }
    expect(fallbackCardLink(undefined, { path: 'D:/ws/src' })).toBeNull()
  })

  it('offers nothing when the call names no file at all', () => {
    expect(fallbackCardLink('read', null)).toBeNull()
    expect(fallbackCardLink('read', {})).toBeNull()
    expect(fallbackCardLink('write', { content: 'x' })).toBeNull()
    expect(fallbackCardLink('ast_edit', { paths: [] })).toBeNull()
    expect(fallbackCardLink('read', { path: ':1-2' })).toBeNull()
    expect(fallbackCardLink('read', { path: 42 })).toBeNull()
  })
})
