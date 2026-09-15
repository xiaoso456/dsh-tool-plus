/**
 * Unit tests for the browser card layer's pure halves: the card dictionary
 * (key-set and placeholder parity between zh and en) and the defensive readers
 * every row builds on.
 *
 * The row components themselves are React and are not exercised here — the
 * contract these tests pin is the one that decides whether a card is drawn at
 * all, and every input below is either a real shape from the tool-call ledger
 * or a malformed one the readers must survive without throwing.
 * @module tests
 */

import { describe, expect, it } from 'vitest'
import { CARD_LOCALE_NS, cardLocales, en, zh } from '../../src/web/client/labels.ts'
import {
  argText, argsSummary, cardMeta, cardState, cardTitle, diffBlockLabels, displayPath, dotState,
  firstLine, isSubCall, lineCount, parseCardArgs, parseShellStatus, readBlockLabels, resultText,
  searchBlockLabels, terminalBlockLabels,
  type CardBlockView, type CardTranslate,
} from '../../src/web/client/row-utils.ts'

/** `{name}` placeholders of one template, in a stable order. */
function placeholders(template: string): string[] {
  return [...template.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map(match => match[1] ?? '').sort()
}

/** A recording translate seat over one dictionary. */
function translator(
  dict: Record<string, string>,
  calls: { key: string; params?: Record<string, unknown> }[] = [],
): CardTranslate {
  return ((key: string, params?: Record<string, unknown>) => {
    calls.push(params === undefined ? { key } : { key, params })
    const template = dict[key]
    if (template === undefined) throw new Error(`missing dictionary key: ${key}`)
    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
  }) as unknown as CardTranslate
}

/** A running call whose arguments are `args`. */
function running(args: unknown, extra: Partial<CardBlockView> = {}): CardBlockView {
  return { name: 'read', argsRaw: JSON.stringify(args), subCalls: [], ...extra }
}

/** A settled result paired with a call head whose arguments are `args`. */
function settled(args: unknown, result: Record<string, unknown> = {}): CardBlockView {
  return {
    kind: 'tool-result',
    callId: 'call-1',
    call: typeof args === 'string' ? null : { name: 'read', argsRaw: JSON.stringify(args) },
    content: [{ type: 'text', text: 'hello' }],
    isError: false,
    ...result,
  }
}

describe('card dictionary', () => {
  it('is registered under this plugin\'s own namespace', () => {
    expect(CARD_LOCALE_NS).toBe('tool-plus-cards')
    expect(cardLocales.zh).toBe(zh)
    expect(cardLocales.en).toBe(en)
  })

  it('has the same key set in both languages', () => {
    const zhKeys = Object.keys(zh).sort()
    const enKeys = Object.keys(en).sort()
    expect(enKeys).toEqual(zhKeys)
    expect(zhKeys.length).toBeGreaterThan(30)
  })

  it('has a non-empty string for every key in both languages', () => {
    for (const [key, value] of Object.entries(zh)) {
      expect(value.trim(), `zh.${key}`).not.toBe('')
      expect(en[key as keyof typeof en]?.trim(), `en.${key}`).not.toBe('')
    }
  })

  it('uses the same template placeholders in both languages', () => {
    for (const [key, value] of Object.entries(zh)) {
      expect(placeholders(en[key as keyof typeof en] ?? ''), `en.${key}`).toEqual(placeholders(value))
    }
  })

  it('covers every title and every tool-specific fragment the rows draw', () => {
    for (const key of [
      'title.bash', 'title.read', 'title.write', 'title.edit',
      'title.grep', 'title.glob', 'title.astGrep', 'title.astEdit',
      'copy', 'copied', 'collapse', 'expand', 'collapseAria', 'expandAria', 'expandRest',
      'files.one', 'files.other', 'running', 'done', 'failed', 'cancelled', 'timedOut', 'noOutput',
      'write.lines', 'write.madeExecutable',
      'astEdit.replacements', 'astEdit.files', 'astEdit.parseErrors',
      'astEdit.rules', 'astEdit.rulesRest',
      'read.window', 'read.collapseAria', 'read.expandAria', 'read.expandRest',
      'search.paths', 'search.paths.truncated', 'search.matches', 'search.matches.truncated',
      'search.noResults', 'search.scope', 'search.collapseAria', 'search.expandAria', 'search.expandRest',
      'terminal.signal', 'terminal.exitCode', 'terminal.running', 'terminal.failed',
      'terminal.done', 'terminal.noOutput',
      'bash.background', 'generic.params', 'generic.noDetail', 'inspect',
    ]) {
      expect(zh[key as keyof typeof zh], `zh.${key}`).toBeDefined()
    }
  })
})

describe('primitive label adapters', () => {
  it('binds the diff chrome to this plugin\'s dictionary', () => {
    const calls: { key: string; params?: Record<string, unknown> }[] = []
    const labels = diffBlockLabels(translator(zh, calls))
    expect(labels.copy).toBe(zh.copy)
    expect(labels.collapse).toBe(zh.collapse)
    expect(labels.collapseAria).toBe(zh.collapseAria)
    expect(labels.expandAria(3)).toBe('展开其余 3 行')
    expect(labels.expand(4)).toBe('… 其余 4 行')
    expect(labels.files(1)).toBe('1 个文件')
    expect(labels.files(2)).toBe('2 个文件')
    expect(calls.some(call => call.key === 'files.one')).toBe(true)
    expect(calls.some(call => call.key === 'files.other')).toBe(true)
  })

  it('binds the read chrome including the window note', () => {
    const labels = readBlockLabels(translator(zh))
    expect(labels.window(2, 10)).toBe('显示 2 / 10 行')
    expect(labels.collapseAria).toBe(zh['read.collapseAria'])
    expect(labels.expandAria(5)).toBe('展开其余 5 行')
    expect(labels.expand(5)).toBe('… 其余 5 行')
  })

  it('binds the search chrome for both shapes and the truncation variant', () => {
    const calls: { key: string; params?: Record<string, unknown> }[] = []
    const labels = searchBlockLabels(translator(zh, calls))
    expect(labels.pathsSummary(1, 2, false)).toBe('1 个路径')
    expect(labels.pathsSummary(1, 2, true)).toBe('显示 1 / 共 2 个路径')
    expect(labels.matchesSummary(1, 2, 3, false)).toBe('1 处匹配 · 3 个文件')
    expect(labels.matchesSummary(1, 2, 3, true)).toBe('显示 1 / 共 2 处匹配 · 3 个文件')
    expect(labels.noResults).toBe(zh['search.noResults'])
    expect(calls.map(call => call.key)).toContain('search.paths.truncated')
  })

  it('binds the terminal chrome, including the exit-code and signal pills', () => {
    const labels = terminalBlockLabels(translator(en))
    expect(labels.signal('SIGTERM')).toBe('signal SIGTERM')
    expect(labels.exitCode(2)).toBe('exit code 2')
    expect(labels.running).toBe(en['terminal.running'])
    expect(labels.failed).toBe(en['terminal.failed'])
    expect(labels.done).toBe(en['terminal.done'])
    expect(labels.noOutput).toBe(en['terminal.noOutput'])
    expect(labels.expandAria(7)).toBe('Expand 7 more lines')
  })
})

describe('parseCardArgs', () => {
  it('parses a running call\'s argument object', () => {
    expect(parseCardArgs(running({ path: 'a.ts', content: 'x' }))).toEqual({ path: 'a.ts', content: 'x' })
  })

  it('parses a settled call\'s backfilled head', () => {
    expect(parseCardArgs(settled({ path: 'a.ts' }))).toEqual({ path: 'a.ts' })
  })

  it('caches per node, so one parse serves every render', () => {
    const block = running({ path: 'a.ts' })
    expect(parseCardArgs(block)).toBe(parseCardArgs(block))
  })

  it('returns null for every malformed argument payload', () => {
    expect(parseCardArgs(running('not json at all'))).toBeNull()
    expect(parseCardArgs(running('[1,2,3]'))).toBeNull()
    expect(parseCardArgs(running('42'))).toBeNull()
    expect(parseCardArgs(running('null'))).toBeNull()
    expect(parseCardArgs({ name: 'read' })).toBeNull()
    expect(parseCardArgs({ name: 'read', argsRaw: 42 })).toBeNull()
    expect(parseCardArgs(settled({ path: 'a.ts' }, { call: null }))).toBeNull()
    expect(parseCardArgs({} as CardBlockView)).toBeNull()
  })
})

describe('cardState and dotState', () => {
  it('reports a running call until it settles', () => {
    expect(cardState(running({}))).toBe('running')
    expect(dotState('running')).toBe('ongoing')
  })

  it('reports a settled success as ok', () => {
    expect(cardState(settled({}))).toBe('ok')
    expect(dotState('ok')).toBe('done')
  })

  it('reports a failed call as an error', () => {
    expect(cardState(settled({}, { isError: true }))).toBe('error')
    expect(dotState('error')).toBe('error')
  })

  it('reports a timed-out or cancelled foreground command as a warning', () => {
    const timedOut = settled({}, { meta: { kind: 'terminal', mode: 'foreground', exitCode: null, timedOut: true, aborted: false } })
    const aborted = settled({}, { meta: { kind: 'terminal', mode: 'foreground', exitCode: null, timedOut: false, aborted: true } })
    expect(cardState(timedOut)).toBe('warning')
    expect(cardState(aborted)).toBe('warning')
    expect(dotState('warning')).toBe('warning')
  })

  it('keeps a non-zero exit ok, because bash reports it as result data', () => {
    const failed = settled({}, { meta: { kind: 'terminal', mode: 'foreground', exitCode: 2, timedOut: false, aborted: false } })
    expect(cardState(failed)).toBe('ok')
  })

  it('ignores malformed metadata instead of throwing', () => {
    expect(cardState(settled({}, { meta: { kind: 'terminal', mode: 'foreground' } }))).toBe('ok')
    expect(cardState(settled({}, { meta: 'nonsense' }))).toBe('ok')
  })
})

describe('cardMeta', () => {
  it('exposes metadata only once the call settled', () => {
    expect(cardMeta(running({}))).toBeUndefined()
    expect(cardMeta(settled({}, { meta: { kind: 'read' } }))).toEqual({ kind: 'read' })
  })
})

describe('isSubCall', () => {
  it('is true only for a call dispatched by another tool', () => {
    expect(isSubCall(running({}))).toBe(false)
    expect(isSubCall(settled({}, { parentCallId: undefined }))).toBe(false)
    expect(isSubCall(settled({}, { parentCallId: 'call-0' }))).toBe(true)
    expect(isSubCall({ parentCallId: 7 } as CardBlockView)).toBe(false)
  })
})

describe('resultText', () => {
  it('joins every text block of a settled result', () => {
    expect(resultText(settled({}, { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })))
      .toBe('a\nb')
  })

  it('ignores non-text blocks and returns empty for a running call', () => {
    expect(resultText(settled({}, { content: [{ type: 'image', text: 'nope' }] }))).toBe('')
    expect(resultText(settled({}, { content: [{ type: 'text' }] }))).toBe('')
    expect(resultText(running({}))).toBe('')
  })

  it('survives a malformed content list', () => {
    expect(resultText(settled({}, { content: 'nope' }))).toBe('')
    expect(resultText(settled({}, { content: [null, 7, 'x'] }))).toBe('')
  })
})

describe('firstLine', () => {
  it('returns the first non-empty line, trimmed', () => {
    expect(firstLine('a\nb')).toBe('a')
    expect(firstLine('\n\n  x  \n')).toBe('x')
    expect(firstLine('')).toBe('')
    expect(firstLine('   ')).toBe('')
  })

  it('clips a long line to a row-sized summary', () => {
    const clipped = firstLine('x'.repeat(500))
    expect(clipped.length).toBe(200)
    expect(clipped.endsWith('…')).toBe(true)
  })
})

describe('lineCount', () => {
  it('counts content lines without the terminating newline', () => {
    expect(lineCount('')).toBe(0)
    expect(lineCount('a')).toBe(1)
    expect(lineCount('a\n')).toBe(1)
    expect(lineCount('a\nb')).toBe(2)
    expect(lineCount('\n')).toBe(1)
  })
})

describe('parseShellStatus', () => {
  it('strips an exit-code marker and reports the code', () => {
    expect(parseShellStatus('out\n[exit code: 2]'))
      .toEqual({ output: 'out', exitCode: 2, signal: undefined, timedOut: false })
  })

  it('reports an unknown exit status as null and still strips the marker', () => {
    expect(parseShellStatus('out\n[exit code: null]'))
      .toEqual({ output: 'out', exitCode: null, signal: undefined, timedOut: false })
  })

  it('recovers a signal name the projection does not carry', () => {
    expect(parseShellStatus('out\n[killed by signal: SIGTERM]'))
      .toEqual({ output: 'out', exitCode: undefined, signal: 'SIGTERM', timedOut: false })
  })

  it('strips a timeout marker that precedes the signal marker', () => {
    const status = parseShellStatus('out\n[timed out after 30000ms]\n[killed by signal: SIGKILL]')
    expect(status.output).toBe('out')
    expect(status.timedOut).toBe(true)
    expect(status.signal).toBe('SIGKILL')
  })

  it('leaves output without markers untouched', () => {
    expect(parseShellStatus('out\nmore'))
      .toEqual({ output: 'out\nmore', exitCode: undefined, signal: undefined, timedOut: false })
  })

  it('handles a marker-only result and an empty one', () => {
    expect(parseShellStatus('[exit code: 0]'))
      .toEqual({ output: '', exitCode: 0, signal: undefined, timedOut: false })
    expect(parseShellStatus(''))
      .toEqual({ output: '', exitCode: undefined, signal: undefined, timedOut: false })
  })
})

describe('argument and path helpers', () => {
  it('reads a non-empty string argument', () => {
    expect(argText({ path: 'a.ts' }, 'path')).toBe('a.ts')
    expect(argText({ path: '' }, 'path')).toBeNull()
    expect(argText({ path: 7 }, 'path')).toBeNull()
    expect(argText(null, 'path')).toBeNull()
  })

  it('shortens a path under the session workspace', () => {
    expect(displayPath('/w/app/src/a.ts', '/w/app')).toBe('src/a.ts')
    expect(displayPath('/w/app/src/a.ts', '/w/app/')).toBe('src/a.ts')
    expect(displayPath('/other/a.ts', '/w/app')).toBe('/other/a.ts')
    expect(displayPath('/w/app/src/a.ts', undefined)).toBe('/w/app/src/a.ts')
  })

  it('summarizes a call by its argument count', () => {
    const t = translator(zh)
    expect(argsSummary({ a: 1, b: 2 }, t)).toBe('2 个参数')
    expect(argsSummary({}, t)).toBe(zh['generic.noDetail'])
    expect(argsSummary(null, t)).toBe(zh['generic.noDetail'])
  })

  it('maps a wire tool name onto its title, with a fallback for a truncated call', () => {
    const t = translator(zh)
    expect(cardTitle('ast_grep', t, 'title.grep')).toBe(zh['title.astGrep'])
    expect(cardTitle('bash', t, 'title.bash')).toBe(zh['title.bash'])
    expect(cardTitle('', t, 'title.write')).toBe(zh['title.write'])
    expect(cardTitle('mystery', t, 'title.read')).toBe(zh['title.read'])
  })
})
