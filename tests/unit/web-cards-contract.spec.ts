/**
 * Web tool-card contract: the shared shapes, byte caps and defensive narrowing
 * every card path relies on. A card must never throw — malformed, oversized or
 * foreign metadata has to narrow to `null` so the row falls back to the generic
 * shell instead of taking the slot entry down with it.
 */
import { describe, expect, it } from 'vitest'
import {
  AST_EDIT_META_MAX_BYTES,
  CARD_TAKEOVER_PRIORITY,
  CARD_TOOL_KEYS,
  EDIT_META_MAX_BYTES,
  READ_META_MAX_BYTES,
  SEARCH_META_MAX_BYTES,
  capTail,
  capText,
  jsonByteLength,
  narrowAstEditCardMeta,
  narrowEditCardMeta,
  narrowReadCardMeta,
  narrowSearchCardMeta,
  narrowTerminalCardMeta,
  narrowWriteCardMeta,
  utf8ByteLength,
} from '../../src/web/contract.ts'

/** Every narrowing function, so the "never throws" matrix stays exhaustive. */
const NARROWERS = [
  narrowWriteCardMeta,
  narrowEditCardMeta,
  narrowAstEditCardMeta,
  narrowReadCardMeta,
  narrowSearchCardMeta,
  narrowTerminalCardMeta,
] as const

describe('web card contract — constants', () => {
  it('claims a shadowing rank below the shipped rows and below zero', () => {
    expect(CARD_TAKEOVER_PRIORITY).toBeLessThan(0)
    // A large gap: a future release may rank its own rows below zero.
    expect(CARD_TAKEOVER_PRIORITY).toBeLessThanOrEqual(-100)
  })

  it('names every tool whose card this plugin renders itself', () => {
    expect([...CARD_TOOL_KEYS].sort()).toEqual(
      ['ast_edit', 'ast_grep', 'bash', 'edit', 'glob', 'grep', 'read', 'write'],
    )
  })

  it('keeps the search cap at the shipped search card budget', () => {
    expect(SEARCH_META_MAX_BYTES).toBe(64 * 1024)
  })
})

describe('web card contract — byte budget helpers', () => {
  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    expect(utf8ByteLength('')).toBe(0)
    expect(utf8ByteLength('abc')).toBe(3)
    expect(utf8ByteLength('中文')).toBe(6)
    expect(utf8ByteLength('😀')).toBe(4)
  })

  it('measures a payload by its serialized form', () => {
    expect(jsonByteLength({ a: 1 })).toBe(utf8ByteLength('{"a":1}'))
    expect(jsonByteLength(undefined)).toBe(0)
  })

  it('returns text unchanged when it fits the budget', () => {
    expect(capText('hello', 5)).toBe('hello')
    expect(capText('hello', 99)).toBe('hello')
  })

  it('truncates to the longest fitting prefix', () => {
    const text = 'a'.repeat(100)
    expect(capText(text, 10)).toBe('a'.repeat(10))
    expect(utf8ByteLength(capText(text, 10))).toBeLessThanOrEqual(10)
  })

  it('never splits a surrogate pair', () => {
    const text = '😀😀😀'
    for (const cap of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const capped = capText(text, cap)
      expect(utf8ByteLength(capped)).toBeLessThanOrEqual(cap)
      expect([...capped].every(character => character === '😀')).toBe(true)
    }
  })

  it('drops entries from the tail until the wrapped payload fits', () => {
    const items = Array.from({ length: 20 }, (_, index) => ({ text: 'x'.repeat(10), index }))
    const retained = capTail(items, 80, kept => ({ kind: 'edit', diffs: kept }))
    expect(retained.length).toBeLessThan(items.length)
    expect(retained.length).toBeGreaterThan(0)
    // The retained head keeps input order and identity.
    expect(retained).toEqual(items.slice(0, retained.length))
    expect(jsonByteLength({ kind: 'edit', diffs: retained })).toBeLessThanOrEqual(80)
  })

  it('empties the list when even one entry overflows the budget', () => {
    expect(capTail([{ text: 'x'.repeat(500) }], 16, kept => ({ diffs: kept }))).toEqual([])
    expect(capTail([], 16, kept => ({ diffs: kept }))).toEqual([])
  })
})

describe('web card contract — write metadata', () => {
  it('accepts a path with and without a language hint', () => {
    expect(narrowWriteCardMeta({ kind: 'write', path: 'src/a.ts', lang: 'typescript' }))
      .toEqual({ kind: 'write', path: 'src/a.ts', lang: 'typescript' })
    expect(narrowWriteCardMeta({ kind: 'write', path: 'src/a.ts' }))
      .toEqual({ kind: 'write', path: 'src/a.ts' })
  })

  it('drops a blank or non-string language hint instead of failing the card', () => {
    expect(narrowWriteCardMeta({ kind: 'write', path: 'a', lang: '' })).toEqual({ kind: 'write', path: 'a' })
    expect(narrowWriteCardMeta({ kind: 'write', path: 'a', lang: 7 })).toEqual({ kind: 'write', path: 'a' })
  })

  it('rejects a missing, blank or foreign path', () => {
    expect(narrowWriteCardMeta({ kind: 'write' })).toBeNull()
    expect(narrowWriteCardMeta({ kind: 'write', path: '   ' })).toBeNull()
    expect(narrowWriteCardMeta({ kind: 'edit', path: 'a' })).toBeNull()
  })
})

describe('web card contract — edit metadata', () => {
  const hunks = [
    { path: 'src/a.ts', oldText: 'old\n', newText: 'new\n' },
    { path: 'src/b.ts', oldText: null, newText: 'created\n' },
  ]

  it('accepts the shipped diff-card hunk shape', () => {
    expect(narrowEditCardMeta({ kind: 'edit', diffs: hunks }))
      .toEqual({ kind: 'edit', diffs: hunks })
  })

  it('rejects an absent, empty or non-array diff list', () => {
    expect(narrowEditCardMeta({ kind: 'edit' })).toBeNull()
    expect(narrowEditCardMeta({ kind: 'edit', diffs: [] })).toBeNull()
    expect(narrowEditCardMeta({ kind: 'edit', diffs: 'x' })).toBeNull()
  })

  it('requires an explicit null on the removed side (undefined is malformed)', () => {
    expect(narrowEditCardMeta({ kind: 'edit', diffs: [{ path: 'a', newText: 'x' }] })).toBeNull()
    expect(narrowEditCardMeta({ kind: 'edit', diffs: [{ path: 'a', oldText: 5, newText: 'x' }] })).toBeNull()
    expect(narrowEditCardMeta({ kind: 'edit', diffs: [{ path: 'a', oldText: null }] })).toBeNull()
    expect(narrowEditCardMeta({ kind: 'edit', diffs: [{ oldText: null, newText: 'x' }] })).toBeNull()
  })

  it('rejects a payload past the diff budget', () => {
    const huge = [{ path: 'a', oldText: null, newText: 'x'.repeat(EDIT_META_MAX_BYTES + 1024) }]
    expect(narrowEditCardMeta({ kind: 'edit', diffs: huge })).toBeNull()
  })
})

describe('web card contract — ast_edit metadata', () => {
  const meta = {
    kind: 'ast_edit',
    preview: 'src/a.ts\n│ 12 │ foo()',
    files: [{ path: 'src/a.ts', count: 2 }],
    replacements: 2,
    applied: true,
  }

  it('accepts the engine preview with its counters', () => {
    expect(narrowAstEditCardMeta(meta)).toEqual(meta)
  })

  it('rejects a malformed file entry or counter', () => {
    expect(narrowAstEditCardMeta({ ...meta, files: [{ path: '', count: 1 }] })).toBeNull()
    expect(narrowAstEditCardMeta({ ...meta, files: [{ path: 'a', count: -1 }] })).toBeNull()
    expect(narrowAstEditCardMeta({ ...meta, replacements: 1.5 })).toBeNull()
    expect(narrowAstEditCardMeta({ ...meta, applied: 'yes' })).toBeNull()
    expect(narrowAstEditCardMeta({ ...meta, preview: undefined })).toBeNull()
  })

  it('rejects a payload past the preview budget', () => {
    expect(narrowAstEditCardMeta({ ...meta, preview: 'x'.repeat(AST_EDIT_META_MAX_BYTES + 1024) })).toBeNull()
  })
})

describe('web card contract — read metadata', () => {
  const meta = {
    kind: 'read',
    path: 'src/a.ts',
    offset: 5,
    lines: [{ number: 5, text: 'a' }, { number: 6, text: 'b' }],
    totalLines: 10,
    lang: 'typescript',
  }

  it('accepts the shipped read-card window shape', () => {
    expect(narrowReadCardMeta(meta)).toEqual(meta)
  })

  it('accepts an empty window (every line elided) but rejects bad numbering', () => {
    expect(narrowReadCardMeta({ ...meta, lines: [] })).toEqual({ ...meta, lines: [] })
    expect(narrowReadCardMeta({
      ...meta,
      lines: [{ number: 6, text: 'a' }, { number: 5, text: 'b' }],
    })).toBeNull()
    expect(narrowReadCardMeta({ ...meta, lines: [{ number: 5, text: 'a' }, { number: 5, text: 'b' }] }))
      .toBeNull()
  })

  it('rejects a line past totalLines, a zero offset and a missing total', () => {
    expect(narrowReadCardMeta({ ...meta, lines: [{ number: 11, text: 'a' }] })).toBeNull()
    expect(narrowReadCardMeta({ ...meta, offset: 0 })).toBeNull()
    expect(narrowReadCardMeta({ ...meta, totalLines: undefined })).toBeNull()
  })

  it('rejects a payload past the read budget', () => {
    const lines = [{ number: 1, text: 'x'.repeat(READ_META_MAX_BYTES + 1024) }]
    expect(narrowReadCardMeta({ ...meta, offset: 1, lines, totalLines: 1 })).toBeNull()
  })
})

describe('web card contract — search metadata', () => {
  it('accepts a grouped-matches payload', () => {
    const meta = {
      kind: 'search',
      shape: 'matches',
      files: [{ path: 'src/a.ts', matches: [{ lineNumber: 3, line: 'foo' }] }],
      truncated: false,
      total: 1,
    }
    expect(narrowSearchCardMeta(meta)).toEqual(meta)
  })

  it('accepts a flat-path payload', () => {
    const meta = {
      kind: 'search', shape: 'paths', paths: ['a.ts', 'b.ts'], truncated: true, total: 40,
    }
    expect(narrowSearchCardMeta(meta)).toEqual(meta)
  })

  it('rejects a malformed file, match or counter', () => {
    const base = {
      kind: 'search', shape: 'matches', files: [], truncated: false, total: 0,
    }
    expect(narrowSearchCardMeta(base)).toEqual(base)
    expect(narrowSearchCardMeta({
      ...base, files: [{ path: 'a', matches: [{ lineNumber: 0, line: 'x' }] }],
    })).toBeNull()
    expect(narrowSearchCardMeta({
      ...base, files: [{ path: 'a', matches: [{ lineNumber: 1, line: 2 }] }],
    })).toBeNull()
    expect(narrowSearchCardMeta({ ...base, truncated: 'no' })).toBeNull()
    expect(narrowSearchCardMeta({ ...base, total: -1 })).toBeNull()
    expect(narrowSearchCardMeta({ ...base, shape: 'paths' })).toBeNull()
    expect(narrowSearchCardMeta({
      kind: 'search', shape: 'paths', paths: ['a', 7], truncated: false, total: 2,
    })).toBeNull()
  })

  it('rejects a payload past the search budget', () => {
    const meta = {
      kind: 'search',
      shape: 'paths',
      paths: ['x'.repeat(SEARCH_META_MAX_BYTES + 1024)],
      truncated: true,
      total: 1,
    }
    expect(narrowSearchCardMeta(meta)).toBeNull()
  })
})

describe('web card contract — terminal metadata', () => {
  it('accepts both settle shapes, including a null exit code', () => {
    expect(narrowTerminalCardMeta({
      kind: 'terminal', mode: 'foreground', exitCode: 0, timedOut: false, aborted: false,
    })).toEqual({
      kind: 'terminal', mode: 'foreground', exitCode: 0, timedOut: false, aborted: false,
    })
    expect(narrowTerminalCardMeta({
      kind: 'terminal', mode: 'foreground', exitCode: null, timedOut: true, aborted: false, workingDir: '/w',
    })).toEqual({
      kind: 'terminal', mode: 'foreground', exitCode: null, timedOut: true, aborted: false, workingDir: '/w',
    })
    expect(narrowTerminalCardMeta({ kind: 'terminal', mode: 'background', jobId: 'bash-1' }))
      .toEqual({ kind: 'terminal', mode: 'background', jobId: 'bash-1' })
  })

  it('rejects a missing mode, a non-integer exit code and a blank job id', () => {
    expect(narrowTerminalCardMeta({ kind: 'terminal', exitCode: 0 })).toBeNull()
    expect(narrowTerminalCardMeta({
      kind: 'terminal', mode: 'foreground', exitCode: 0.5, timedOut: false, aborted: false,
    })).toBeNull()
    expect(narrowTerminalCardMeta({
      kind: 'terminal', mode: 'foreground', exitCode: 0, timedOut: 'no', aborted: false,
    })).toBeNull()
    expect(narrowTerminalCardMeta({ kind: 'terminal', mode: 'background', jobId: '' })).toBeNull()
  })
})

describe('web card contract — nothing throws', () => {
  const garbage: unknown[] = [
    undefined, null, 0, 1, -1, 1.5, '', 'write', true, false, [], [
      { kind: 'write' },
    ], {}, { kind: 'unknown' }, new Map(), Symbol('x'),
  ]

  it('narrows garbage to null for every card kind', () => {
    for (const narrow of NARROWERS) {
      for (const value of garbage) {
        expect(narrow(value)).toBeNull()
      }
    }
  })

  it('survives a meta carrying hostile getters', () => {
    const hostile = {
      kind: 'write',
      get path(): string {
        return 'a'
      },
    }
    // Contract functions read plain fields only; the defensive call must not throw.
    expect(() => narrowWriteCardMeta(hostile)).not.toThrow()
    expect(() => jsonByteLength(hostile)).not.toThrow()
  })
})
