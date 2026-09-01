import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../../src/config/settings.ts'

// Regression: the background path (startBashJob) used to call executeBash
// without `rmSafe`, so every auto-backgrounded / explicitly backgrounded
// command skipped the rm → trash injection (snapshots stayed 60B, rm stayed
// the system command). The foreground path always passed it; the background
// path must mirror it from the resolved config.
const { executeBashMock } = vi.hoisted(() => ({ executeBashMock: vi.fn() }))

vi.mock('../../src/tools/bash/bash-executor.ts', () => ({
  executeBash: (...args: unknown[]) => executeBashMock(...args),
}))

import { startBashJob } from '../../src/tools/bash/background.ts'

describe('background job rmSafe passthrough', () => {
  it('passes rmSafe: true from the resolved config to executeBash', async () => {
    executeBashMock.mockReset()
    executeBashMock.mockResolvedValue({
      output: 'ok',
      exitCode: 0,
      cancelled: false,
      timedOut: false,
      workingDir: undefined,
      spillPath: undefined,
      truncated: false,
    })
    const config = resolveConfig({})
    const job = startBashJob({
      sessionId: 'spec',
      command: 'echo ok',
      cwd: process.cwd(),
      timeoutMs: 5000,
      env: undefined,
      config,
    })
    const value = await job.completion
    expect(value.output.text).toBe('ok')
    expect(executeBashMock).toHaveBeenCalledTimes(1)
    const options = executeBashMock.mock.calls[0][1] as Record<string, unknown>
    expect(options.rmSafe).toBe(true)
  })

  it('passes rmSafe: false when the config disables it', async () => {
    executeBashMock.mockReset()
    executeBashMock.mockResolvedValue({
      output: 'ok',
      exitCode: 0,
      cancelled: false,
      timedOut: false,
      workingDir: undefined,
      spillPath: undefined,
      truncated: false,
    })
    const config = resolveConfig({ rmSafe: false })
    const job = startBashJob({
      sessionId: 'spec',
      command: 'echo ok',
      cwd: process.cwd(),
      timeoutMs: 5000,
      env: undefined,
      config,
    })
    await job.completion
    const options = executeBashMock.mock.calls[0][1] as Record<string, unknown>
    expect(options.rmSafe).toBe(false)
  })
})
