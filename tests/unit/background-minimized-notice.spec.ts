import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../../src/config/settings.ts'

// Regression: the background path (startBashJob) built the completion result
// without the `minimized` field, so auto-backgrounded runs (the default path
// for commands finishing inside the autoBackgroundMs window) silently lost
// the `[output minimized by …; original saved to …]` notice — the model never
// learned the pre-minimization text was recoverable. The foreground path
// (buildForeground) always carried it; the background path must mirror it.
const { executeBashMock } = vi.hoisted(() => ({ executeBashMock: vi.fn() }))

vi.mock('../../src/tools/bash/bash-executor.ts', () => ({
  executeBash: (...args: unknown[]) => executeBashMock(...args),
}))

import { startBashJob } from '../../src/tools/bash/background.ts'

describe('background job minimized passthrough', () => {
  it('carries minimized + originalSpillPath into the completion result', async () => {
    executeBashMock.mockReset()
    executeBashMock.mockResolvedValue({
      output: 'minimized text',
      exitCode: 0,
      cancelled: false,
      timedOut: false,
      workingDir: undefined,
      spillPath: undefined,
      truncated: false,
      minimized: { filter: 'git', inputBytes: 5124, outputBytes: 1190 },
      originalOutputPath: 'tmp/dsh-bash-original-abc.log',
    })
    const config = resolveConfig({})
    const job = startBashJob({
      sessionId: 'spec',
      command: 'git show HEAD -- file.txt',
      cwd: process.cwd(),
      timeoutMs: 5000,
      env: undefined,
      config,
    })
    const value = await job.completion
    expect(value.minimized).toEqual({ filter: 'git', inputBytes: 5124, outputBytes: 1190 })
    expect(value.output.originalSpillPath).toBe('tmp/dsh-bash-original-abc.log')
    expect(value.kind).toBe('foreground')
  })
})
