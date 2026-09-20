/**
 * A-9: an auto-backgrounded (or explicitly backgrounded) job killed by its own
 * deadline must tell the model it was timed out — OMP parity via the
 * #buildCompletedResult render pass (refs tools/bash.ts:841-858): the delivered
 * text carries the `[Command timed out after N seconds]` annotation and the job
 * is recorded failed, not completed.
 *
 * The executor is NOT mocked here: the point is that a real command gets killed
 * by a real deadline. (The mocked pass-through siblings live in
 * `bash-background.spec.ts`.)
 * @module tests
 */

import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../../src/config/settings.ts'
import { startBashJob } from '../../src/tools/bash/background.ts'

describe('background job killed by its deadline (A-9)', () => {
  it('annotates the delivered text with the timeout and records the job failed', async () => {
    const config = resolveConfig({})
    // 1s deadline instead of 3s: the subject is "a job killed by its own deadline
    // reports it", and 1000ms is the deadline floor the rest of the suite uses —
    // the annotation renders `Math.max(1, round(timeoutMs / 1000))`, so 1s keeps the
    // same code path while cutting ~2s of real wait out of every run.
    const job = startBashJob({
      sessionId: 'spec',
      command: 'sleep 10',
      cwd: process.cwd(),
      timeoutMs: 1000,
      env: undefined,
      config,
    })
    const value = await job.completion
    expect(value.timedOut).toBe(true)
    // `1 second` (not `1 seconds`) so a future pluralization fix does not break this.
    expect(value.output.text).toContain('[Command timed out after 1 second')
    const outcome = await job.hooks.done
    expect(outcome.status).toBe('failed')
  }, 30000)
})
