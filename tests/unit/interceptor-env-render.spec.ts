/**
 * Unit tests for the interception rules, non-interactive env hardening, and
 * result rendering.
 * @module tests
 */

import * as fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkBashInterception, DEFAULT_BASH_INTERCEPTOR_RULES } from '../../src/tools/bash/bash-interceptor.ts'
import { buildNonInteractiveEnv, NON_INTERACTIVE_ENV } from '../../src/tools/bash/non-interactive-env.ts'
import { parseExitStatus, renderBashResult } from '../../src/tools/bash/render.ts'
import { sanitizeSnapshotForBrush } from '../../src/tools/bash/shell-snapshot.ts'
import { clampTimeout } from '../../src/tools/omp/tools/tool-timeouts.ts'
import type { BashForegroundOutput } from '../../src/tools/bash/types.ts'
import { findOnPath } from '../../src/tools/bash/which.ts'

describe('checkBashInterception', () => {
  it('blocks cat/head/tail and suggests the read tool when available', () => {
    const result = checkBashInterception('cat package.json', ['read', 'edit'])
    expect(result.block).toBe(true)
    expect(result.suggestedTool).toBe('read')
    expect(result.message).toContain('Original command')
  })

  it('skips rules whose suggested tool is not available', () => {
    const result = checkBashInterception('cat package.json', ['edit'])
    expect(result.block).toBe(false)
  })

  it('blocks sed -i and suggests edit', () => {
    const result = checkBashInterception('sed -i s/a/b/ file.txt', ['edit'])
    expect(result.block).toBe(true)
    expect(result.suggestedTool).toBe('edit')
  })

  it('does not block mid-command matches', () => {
    const result = checkBashInterception('echo x | grep y', ['grep'])
    expect(result.block).toBe(false)
  })

  it('default rules target dsh tool names', () => {
    const tools = [...new Set(DEFAULT_BASH_INTERCEPTOR_RULES.map(rule => rule.tool))]
    // A-2：规则表对齐上游 10 条（含 echo/printf 重定向 → write），hub 3 条映射为
    // tool:"bash" 的 run_in_background 引导（second-impl-audit.md A-2 终局）。
    expect(tools.sort()).toEqual(['bash', 'edit', 'glob', 'grep', 'read', 'write'])
  })
})

describe('buildNonInteractiveEnv', () => {
  it('hardens pagers, prompts, and color output', () => {
    const env = buildNonInteractiveEnv(undefined, { PATH: '/bin' }, 'linux')
    expect(env.PAGER).toBe('cat')
    expect(env.TERM).toBe('dumb')
    expect(env.NO_COLOR).toBe('1')
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.EDITOR).toBe('true')
  })

  it('lets overrides win', () => {
    const env = buildNonInteractiveEnv({ PAGER: 'less' }, {}, 'linux')
    expect(env.PAGER).toBe('less')
    expect(env.TERM).toBe(NON_INTERACTIVE_ENV.TERM)
  })

  it('adds UTF-8 defaults on Windows only when unset', () => {
    const env = buildNonInteractiveEnv(undefined, {}, 'win32')
    expect(env.PYTHONUTF8).toBe('1')
    // A base env that already carries the group value suppresses the defaults.
    const withExisting = buildNonInteractiveEnv(undefined, { PYTHONUTF8: '0' }, 'win32')
    expect(withExisting.PYTHONUTF8).toBeUndefined()
  })

  it('reports CI=true for clap-style strict bool parsers', () => {
    const env = buildNonInteractiveEnv(undefined, { PATH: '/bin' }, 'linux')
    expect(env.CI).toBe('true')
  })

  it('marks the child as an agent via AGENT=1', () => {
    const env = buildNonInteractiveEnv(undefined, { PATH: '/bin' }, 'linux')
    expect(env.AGENT).toBe('1')
  })

  it('drops CI when PI_BASH_NO_CI or its legacy alias opts out', () => {
    const gated = buildNonInteractiveEnv(undefined, { PI_BASH_NO_CI: '1' }, 'linux')
    expect(gated.CI).toBeUndefined()
    const legacy = buildNonInteractiveEnv(undefined, { CLAUDE_BASH_NO_CI: '1' }, 'linux')
    expect(legacy.CI).toBeUndefined()
  })

  it('applies the no-CI gate on the win32 branch, keeping UTF-8 defaults', () => {
    const gated = buildNonInteractiveEnv(undefined, { PI_BASH_NO_CI: '1' }, 'win32')
    expect(gated.CI).toBeUndefined()
    expect(gated.PYTHONUTF8).toBe('1')
  })

  it('resolves SSH_ASKPASS to a real reject-prompt command', () => {
    const env = buildNonInteractiveEnv(undefined, { PATH: '/bin' }, 'linux')
    // REJECT_PROMPT_COMMAND semantics: PATH-resolved `false`, else literal "false".
    const expected = findOnPath('false') ?? 'false'
    expect(env.SSH_ASKPASS).toBe(expected)
    expect(fs.existsSync(env.SSH_ASKPASS) || env.SSH_ASKPASS === 'false').toBe(true)
  })
})

describe('sanitizeSnapshotForBrush', () => {
  it('drops aliases brush cannot expand', () => {
    const content = [
      "alias -- ls='ls --color=auto'",
      "alias -- which='(which)'",
      'export PATH=/usr/bin',
    ].join('\n')
    const { content: out, dropped } = sanitizeSnapshotForBrush(content)
    expect(dropped).toEqual(['which'])
    expect(out).toContain("alias -- ls='ls --color=auto'")
    expect(out).toContain('export PATH=/usr/bin')
  })
})

describe('clampTimeout', () => {
  it('clamps into the configured bash range', () => {
    expect(clampTimeout('bash', 0.5)).toBe(1)
    expect(clampTimeout('bash', 9999)).toBe(3600)
    expect(clampTimeout('bash', 120)).toBe(120)
  })
})

describe('renderBashResult', () => {
  it('places the exit marker last so parseExitStatus recovers it', () => {
    const value: BashForegroundOutput = {
      kind: 'foreground',
      exitCode: 3,
      timedOut: false,
      aborted: false,
      timeoutMs: 5000,
      wallTimeMs: 1234,
      output: { text: 'boom\n', truncated: false },
    }
    const text = renderBashResult(value)
    expect(text).toContain('Wall time: 1.23 seconds')
    expect(text).toMatch(/\n\[exit code: 3\]$/)
    const parsed = parseExitStatus(text)
    expect(parsed.exitCode).toBe(3)
    expect(parsed.body).not.toContain('[exit code: 3]')
  })

  it('renders empty output as (no output)', () => {
    const value: BashForegroundOutput = {
      kind: 'foreground',
      exitCode: 0,
      timedOut: false,
      aborted: false,
      timeoutMs: null,
      wallTimeMs: 10,
      output: { text: '', truncated: false },
    }
    expect(renderBashResult(value)).toContain('(no output)')
  })

  it('warns visibly when the rmSafe injection failed', () => {
    const value: BashForegroundOutput = {
      kind: 'foreground',
      exitCode: 0,
      timedOut: false,
      aborted: false,
      timeoutMs: null,
      wallTimeMs: 10,
      rmSafeInjectionFailed: true,
      output: { text: 'ok\n', truncated: false },
    }
    const text = renderBashResult(value)
    expect(text).toContain('[rmSafe injection failed: rm deletes permanently')
  })

  it('reports truncation with OMP-form line accounting, the spill path, and a read-back hint', () => {
    const value: BashForegroundOutput = {
      kind: 'foreground',
      exitCode: null,
      timedOut: true,
      aborted: false,
      timeoutMs: 1000,
      wallTimeMs: 1005,
      output: {
        text: 'partial',
        truncated: true,
        spillPath: 'tmp/full.log',
        totalLines: 214,
        totalBytes: 90_000,
        outputLines: 81,
        outputBytes: 41_000,
        elidedLines: 133,
        elidedBytes: 49_000,
      },
    }
    const text = renderBashResult(value)
    expect(text).toContain('[timed out after 1000ms]')
    // Middle-elision ranges reconstructed by the shared OMP algorithm:
    // keptLines = outputLines - 1 = 80 → head 1-40, tail 175-214.
    expect(text).toContain('Showing lines 1-40 and 175-214 of 214')
    expect(text).toContain('Full output: tmp/full.log]')
    expect(text).toContain('Re-read elided ranges from the full-output file with the read tool')
  })

  it('reports an unavailable spill path when truncation produced no file', () => {
    const value: BashForegroundOutput = {
      kind: 'foreground',
      exitCode: 0,
      timedOut: false,
      aborted: false,
      timeoutMs: null,
      wallTimeMs: 5,
      output: { text: 'partial', truncated: true },
    }
    const text = renderBashResult(value)
    expect(text).toContain('[output truncated:')
    expect(text).toContain('Full output: (unavailable)]')
    expect(text).not.toContain('Re-read elided ranges')
  })

  it('points at a complete mirror even when only the column cap triggered spilling', () => {
    const value: BashForegroundOutput = {
      kind: 'foreground',
      exitCode: 0,
      timedOut: false,
      aborted: false,
      timeoutMs: null,
      wallTimeMs: 5,
      output: { text: 'ok', truncated: false, spillPath: 'tmp/mirror.log' },
    }
    const text = renderBashResult(value)
    expect(text).toContain('[full raw stream saved: tmp/mirror.log]')
  })

  it('notes minimization facts plus the original capture path', () => {
    const value: BashForegroundOutput = {
      kind: 'foreground',
      exitCode: 0,
      timedOut: false,
      aborted: false,
      timeoutMs: null,
      wallTimeMs: 5,
      minimized: { filter: 'git', inputBytes: 12_345, outputBytes: 42 },
      output: { text: 'minimized', truncated: false, originalSpillPath: 'tmp/original.log' },
    }
    const text = renderBashResult(value)
    expect(text).toContain('[output minimized by git: 12.1KB → 42B; original saved to tmp/original.log]')
  })
})
