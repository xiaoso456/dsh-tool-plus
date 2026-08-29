import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../../src/config/settings.ts'
import { startBashJob } from '../../src/tools/bash/background.ts'

// A-9: an auto-backgrounded (or explicitly backgrounded) job killed by its own
// deadline must tell the model it was timed out — OMP parity via the
// #buildCompletedResult render pass (refs tools/bash.ts:841-858): the delivered
// text carries the `[Command timed out after N seconds]` annotation and the job
// is recorded failed, not completed.
describe('background job killed by its deadline (A-9)', () => {
  it('annotates the delivered text with the timeout and records the job failed', async () => {
    const config = resolveConfig({})
    const job = startBashJob({
      sessionId: 'spec',
      command: 'sleep 10',
      cwd: process.cwd(),
      timeoutMs: 3000,
      env: undefined,
      config,
    })
    const value = await job.completion
    expect(value.timedOut).toBe(true)
    expect(value.output.text).toContain('[Command timed out after 3 seconds]')
    const outcome = await job.hooks.done
    expect(outcome.status).toBe('failed')
  }, 30000)
})