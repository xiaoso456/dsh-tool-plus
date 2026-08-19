/**
 * Unit tests for the config-driven completion truncation ported from the OMP
 * bash-runtime `applyConfiguredTruncation`.
 * @module tests
 */

import { describe, expect, it } from 'vitest'
import { applyConfiguredTruncation, countTextLines } from '../../src/config/truncate.ts'
import type { OutputTruncateConfig } from '../../src/config/settings.ts'

/** 26 rows of `row-N-xxxxxxxx` — just over the byte and line triggers below. */
function fixtureText(): string {
  return Array.from({ length: 26 }, (_, i) => `row-${i}-${'x'.repeat(8)}`).join('\n')
}

function policy(overrides: Partial<OutputTruncateConfig> = {}, strategy: 'bytes' | 'lines' = 'bytes'): OutputTruncateConfig {
  return {
    strategy,
    triggerBytes: 400,
    triggerLines: 10,
    bytes: { mode: 'middle', headBytes: 48, tailBytes: 48 },
    lines: { mode: 'middle', headLines: 2, tailLines: 2 },
    ...overrides,
  }
}

describe('applyConfiguredTruncation', () => {
  it('passes the text through under the trigger threshold', () => {
    const small = 'hi'
    expect(applyConfiguredTruncation(small, undefined, policy())).toBe(small)
  })

  it('truncates bytes in middle mode and points the notice at the full output', () => {
    const text = fixtureText()
    const out = applyConfiguredTruncation(text, '/tmp/full.log', policy())
    expect(out.startsWith('row-0-')).toBe(true)
    expect(out).toContain('row-25-')
    expect(out).toMatch(/\[Output truncated \(middle\): kept \d+\/405 bytes\. Full output: \/tmp\/full\.log\]$/)
    expect(Buffer.byteLength(out, 'utf-8')).toBeLessThan(Buffer.byteLength(text, 'utf-8'))
  })

  it('truncates bytes in tail mode and marks the elided earlier output', () => {
    const out = applyConfiguredTruncation(fixtureText(), undefined, policy({ bytes: { mode: 'tail', headBytes: 48, tailBytes: 48 } }))
    expect(out.startsWith('... [earlier output omitted]')).toBe(true)
    expect(out).toContain('row-25-')
    expect(out).toMatch(/\[Output truncated \(tail\): kept \d+\/405 bytes.\]$/)
  })

  it('truncates bytes in head mode and marks the elided later output', () => {
    const out = applyConfiguredTruncation(fixtureText(), undefined, policy({ bytes: { mode: 'head', headBytes: 48, tailBytes: 48 } }))
    expect(out.startsWith('row-0-')).toBe(true)
    expect(out).toMatch(/... \[later output omitted\]\n\n\[Output truncated \(head\): kept \d+\/405 bytes.\]$/)
  })

  it('truncates by line count in middle mode', () => {
    const out = applyConfiguredTruncation(fixtureText(), undefined, policy({}, 'lines'))
    expect(out.startsWith('row-0-')).toBe(true)
    expect(out).toMatch(/\[Output truncated \(middle\): kept \d+\/26 lines.\]$/)
  })

  it('keeps an empty text untouched', () => {
    expect(applyConfiguredTruncation('', undefined, policy())).toBe('')
  })
})

describe('countTextLines', () => {
  it('counts newlines plus one', () => {
    expect(countTextLines('a')).toBe(1)
    expect(countTextLines('a\nb')).toBe(2)
    expect(countTextLines('a\nb\n')).toBe(3)
  })
})
