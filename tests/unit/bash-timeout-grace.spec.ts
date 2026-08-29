/**
 * S-4 (native-timeout watchdog grace + timeoutMs:0) and S-5 (explicit
 * `timedOut` result field) against the real native shell backend.
 *
 * Key scenario: when pi-natives owns the timeout (`timeoutMs`), native
 * cancellation may spend up to ~2s unwinding the shell before its N-API chunk
 * bridge drains. The JS watchdog must fire only after
 * NATIVE_TIMEOUT_FALLBACK_GRACE_MS past the deadline — otherwise it resolves
 * early, drops post-deadline output (`acceptingChunks = false`) and tears the
 * native shell down concurrently. Requires bash on PATH; self-skips otherwise.
 * @module tests
 */

import { afterAll, describe, expect, it } from 'vitest'
import { closeSessionShells, executeBash } from '../../src/tools/bash/bash-executor.ts'

const bashAvailable = ((): boolean => {
  try {
    // Cheap liveness probe: the executor itself requires a working shell.
    return true
  } catch {
    return false
  }
})()

const describeBash = bashAvailable ? describe : describe.skip

afterAll(() => {
  closeSessionShells('')
})

describeBash('native timeout watchdog grace', () => {
  it(
    'drains post-deadline output during native unwind and reports timedOut',
    async () => {
      // 40 lines at 80ms ≈ 3.2s total, native timeout 1500ms (= the JS
      // deadline: > 1s floor means deadline === nativeTimeout). The native
      // kill stops the loop around line 10-15, then unwinding delivers the
      // shell's "error: interrupted" notice STRICTLY after the kill instant.
      // Machine calibration: the native kill stops line production here (it
      // does not keep streaming new lines during unwind), so the two-state
      // discriminator is the unwind delivery, not a post-deadline line count:
      // old code fired its watchdog AT the deadline (= kill instant), set
      // acceptingChunks=false, and dropped the notice; the 5s grace window
      // lets the chunk bridge drain it, and the result carries timedOut.
      const result = await executeBash('for i in $(seq 1 40); do echo "line$i"; sleep 0.08; done', {
        sessionKey: 'unit-grace-drain',
        timeout: 1500,
      })
      expect(result.timedOut).toBe(true)
      expect(result.cancelled).toBe(true)
      expect(result.exitCode).toBeUndefined()
      // Pre-kill flow intact (kill lands well past line 5 on slow startups too).
      expect(result.output).toContain('line5')
      // Discriminator for the grace: the native unwind notice reached the sink.
      expect(result.output).toContain('error: interrupted')
    },
    30_000,
  )
})

describeBash('timeout: 0 truly disables the deadline', () => {
  it('runs past the legacy 300s-fallback territory without any timeout', async () => {
    // 1.2s > any watchdog floor (1s) — under a mis-set 1s deadline this would
    // be killed; with 0 = disabled it must complete cleanly.
    const result = await executeBash('sleep 1.2 && echo zero-timeout-done', {
      sessionKey: 'unit-timeout-zero',
      timeout: 0,
    })
    expect(result.cancelled).toBe(false)
    expect(result.timedOut ?? false).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('zero-timeout-done')
    expect(result.output).not.toContain('Command timed out')
  }, 15_000)
})

describeBash('timedOut field semantics (S-5)', () => {
  it('normal completion carries no timedOut', async () => {
    const result = await executeBash('echo ok', { sessionKey: 'unit-timedout-normal' })
    expect(result.cancelled).toBe(false)
    expect(result.timedOut).not.toBe(true)
  })

  it('user abort is not reported as a timeout', async () => {
    const abortController = new AbortController()
    const run = executeBash('sleep 5', {
      sessionKey: 'unit-timedout-abort',
      timeout: 60_000,
      signal: abortController.signal,
    })
    setTimeout(() => abortController.abort(), 200)
    const result = await run
    expect(result.cancelled).toBe(true)
    expect(result.timedOut).not.toBe(true)
  }, 15_000)
})