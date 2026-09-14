/**
 * `bash` card metadata: the run state that has to travel as data because the
 * shipped terminal card cannot derive it (a `timeoutMs: 0` call is legal, a
 * timed-out run has no exit code, and an auto-backgrounded call is not a
 * finished command).
 */
import { describe, expect, it } from 'vitest'
import { narrowTerminalCardMeta } from '../../src/web/contract.ts'
import { bashCardMeta } from '../../src/web/host/bash.ts'

/** One foreground value with the fields the projection reads. */
function foreground(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'foreground',
    exitCode: 0,
    timedOut: false,
    aborted: false,
    timeoutMs: 3_600_000,
    wallTimeMs: 12,
    output: { text: 'ok\n', truncated: false },
    ...overrides,
  }
}

describe('bash card metadata — foreground', () => {
  it('reports a clean exit', () => {
    expect(bashCardMeta(foreground())).toEqual({
      kind: 'terminal', mode: 'foreground', exitCode: 0, timedOut: false, aborted: false,
    })
  })

  it('reports a non-zero exit', () => {
    expect(bashCardMeta(foreground({ exitCode: 1 }))).toMatchObject({ exitCode: 1 })
    expect(bashCardMeta(foreground({ exitCode: 127 }))).toMatchObject({ exitCode: 127 })
  })

  it('keeps a deadline-disabled call (timeoutMs: 0) a valid card', () => {
    const meta = bashCardMeta(foreground({ timeoutMs: 0 }))
    expect(meta).not.toBeNull()
    expect(narrowTerminalCardMeta(meta)).toEqual(meta)
  })

  it('reports a timed-out run without pretending it exited', () => {
    expect(bashCardMeta(foreground({ exitCode: null, timedOut: true })))
      .toEqual({ kind: 'terminal', mode: 'foreground', exitCode: null, timedOut: true, aborted: false })
  })

  it('distinguishes an aborted run from a timeout', () => {
    expect(bashCardMeta(foreground({ exitCode: null, aborted: true })))
      .toEqual({ kind: 'terminal', mode: 'foreground', exitCode: null, timedOut: false, aborted: true })
  })

  it('carries the working directory only when the run reported one', () => {
    expect(bashCardMeta(foreground({ workingDir: '/work' }))).toMatchObject({ workingDir: '/work' })
    const without = bashCardMeta(foreground()) as Record<string, unknown>
    expect('workingDir' in without).toBe(false)
    expect(bashCardMeta(foreground({ workingDir: '' }))).not.toHaveProperty('workingDir')
  })
})

describe('bash card metadata — background', () => {
  it('reports a managed job hand-off from either source', () => {
    // `run_in_background: true` and the auto-background window return the same arm.
    expect(bashCardMeta({ kind: 'background', jobId: 'bash-7' }))
      .toEqual({ kind: 'terminal', mode: 'background', jobId: 'bash-7' })
  })

  it('rejects a blank or missing job id', () => {
    expect(bashCardMeta({ kind: 'background', jobId: '' })).toBeNull()
    expect(bashCardMeta({ kind: 'background' })).toBeNull()
    expect(bashCardMeta({ kind: 'background', jobId: 7 })).toBeNull()
  })
})

describe('bash card metadata — defensive', () => {
  it('rejects malformed values instead of throwing', () => {
    for (const value of [
      undefined, null, 0, '', 'foreground', [], {}, { kind: 'unknown' },
      { kind: 'foreground', exitCode: 0.5, timedOut: false, aborted: false },
      { kind: 'foreground', exitCode: 0, timedOut: 'no', aborted: false },
      { kind: 'foreground', exitCode: 0, timedOut: false },
      { kind: 'foreground', timedOut: false, aborted: false },
    ]) {
      expect(bashCardMeta(value)).toBeNull()
    }
  })

  it('never emits an undefined-valued key', () => {
    const metas = [
      bashCardMeta(foreground()),
      bashCardMeta(foreground({ workingDir: '/w' })),
      bashCardMeta(foreground({ exitCode: null, timedOut: true })),
      bashCardMeta({ kind: 'background', jobId: 'bash-1' }),
    ]
    for (const meta of metas) {
      expect(meta).not.toBeNull()
      for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
        expect(value, `key ${key} must not be undefined`).not.toBeUndefined()
      }
      // The wire form must survive a JSON round trip unchanged — that is what
      // `presentationMeta` requires of a lossless payload.
      expect(JSON.parse(JSON.stringify(meta))).toEqual(meta)
    }
  })

  it('emits metadata the browser half accepts', () => {
    expect(narrowTerminalCardMeta(bashCardMeta(foreground()))).not.toBeNull()
    expect(narrowTerminalCardMeta(bashCardMeta({ kind: 'background', jobId: 'bash-2' }))).not.toBeNull()
  })
})
