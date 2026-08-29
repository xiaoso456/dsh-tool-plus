/**
 * S-16: leading `cd <path> && …` workdir extraction + `~` expansion.
 *
 * The bash tool routes a bare leading `cd <path> && …` through its structured
 * workdir seam. Extraction must match upstream `extractLeadingCdTarget`
 * semantics verbatim (redirects, extra args, command substitution,
 * unterminated quotes, non-`&&` operators → bail; the whole command then stays
 * with the shell), and both the extracted target and an explicit `workdir`
 * argument expand a leading `~`/`~/…` against os.homedir() (upstream
 * expandTilde semantics, refs packages/coding-agent/src/tools/path-utils.ts).
 * @module tests
 */

import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractCdWorkdir, expandTilde } from '../../src/tools/bash/cd-workdir.ts'

describe('expandTilde', () => {
  it('expands bare ~ and ~/… prefixes against the injected home', () => {
    expect(expandTilde('~', '/home/u')).toBe('/home/u')
    expect(expandTilde('~/proj', '/home/u')).toBe('/home/u/proj')
    expect(expandTilde('~\\proj', '/home/u')).toBe('/home/u\\proj')
  })

  it('defaults to os.homedir()', () => {
    expect(expandTilde('~')).toBe(os.homedir())
    expect(expandTilde('~/x')).toBe(os.homedir() + '/x')
  })

  it('joins a bare ~name like upstream (user-home approximation)', () => {
    expect(expandTilde('~other', '/home/u')).toBe(path.join('/home/u', 'other'))
  })

  it('leaves non-~ paths untouched', () => {
    expect(expandTilde('/abs/path', '/home/u')).toBe('/abs/path')
    expect(expandTilde('rel/path', '/home/u')).toBe('rel/path')
    expect(expandTilde('', '/home/u')).toBe('')
  })
})

describe('extractCdWorkdir', () => {
  // tool-plus-lab/audit-probes/S16/probe-s16.ts corpus (22 rows) + ~ supplements.
  // `home` is injected so expectations are deterministic on every platform.
  interface Row {
    command: string
    expected: { workdir: string; command: string } | null
  }

  const rows: Row[] = [
    { command: 'cd x && ls', expected: { workdir: 'x', command: 'ls' } },
    { command: 'cd x&&ls', expected: { workdir: 'x', command: 'ls' } },
    { command: 'cd', expected: null },
    { command: 'cd .. && ls', expected: { workdir: '..', command: 'ls' } },
    { command: 'cd "a b" && ls', expected: { workdir: 'a b', command: 'ls' } },
    { command: "cd 'a b' && ls", expected: { workdir: 'a b', command: 'ls' } },
    // extra argument: not a bare `cd <path>` — bail
    { command: 'cd a b && ls', expected: null },
    { command: 'VAR=1 cd x && ls', expected: null },
    { command: 'cd $(x) && ls', expected: null },
    { command: 'cd `x` && ls', expected: null },
    { command: 'cd ~ && ls', expected: { workdir: '/home/u', command: 'ls' } },
    { command: 'cd /abs && ls', expected: { workdir: '/abs', command: 'ls' } },
    { command: 'cd x; ls', expected: null },
    { command: 'pushd x && ls', expected: null },
    { command: 'cd x && cd y && ls', expected: { workdir: 'x', command: 'cd y && ls' } },
    { command: 'cd - && ls', expected: { workdir: '-', command: 'ls' } },
    // upstream regression cases (refs test/tools/shell-tokenize.test.ts)
    { command: 'cd /tmp 2>/dev/null && echo ok', expected: null },
    { command: 'cd /tmp >/dev/null 2>&1 && echo ok', expected: null },
    { command: 'cd a\\ b && ls', expected: { workdir: 'a b', command: 'ls' } },
    { command: 'cd "a&&b" && ls', expected: { workdir: 'a&&b', command: 'ls' } },
    { command: 'cd /tmp &&echo', expected: { workdir: '/tmp', command: 'echo' } },
    { command: 'cd /tmp extra && echo ok', expected: null },
    // ~ supplements
    { command: 'cd ~/proj && make', expected: { workdir: '/home/u/proj', command: 'make' } },
  ]

  it.each(rows.map(row => [row.command, row.expected] as const))(
    '%s',
    (command, expected) => {
      expect(extractCdWorkdir(command, '/home/u')).toEqual(expected)
    },
  )

  it('expands ~ against os.homedir() when no home is injected', () => {
    expect(extractCdWorkdir('cd ~ && ls')).toEqual({ workdir: os.homedir(), command: 'ls' })
    expect(extractCdWorkdir('cd ~/proj && make')).toEqual({
      workdir: os.homedir() + '/proj',
      command: 'make',
    })
  })

  it('bails on command substitution in the cd target, leaving the command for the shell', () => {
    // Locks the old `!/[$`(]/` guard semantics via the corpus rows above; this
    // assertion makes the "bail back to shell" contract explicit.
    expect(extractCdWorkdir('cd $(pwd) && ls', '/home/u')).toBeNull()
    expect(extractCdWorkdir('cd `pwd` && ls', '/home/u')).toBeNull()
  })
})