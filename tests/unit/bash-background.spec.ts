/**
 * Background job (startBashJob) pass-through coverage.
 *
 * The background path is the default for commands that outlive the
 * `autoBackgroundMs` window, and it has to mirror the foreground path wherever
 * the two were built separately. This file covers the `minimized` +
 * `originalSpillPath` pass-through: without it the model never learns the
 * pre-minimization text is recoverable.
 *
 * Verified against a mocked executor, so it runs in milliseconds. The other two
 * background contracts live with their own subjects:
 * - `rmSafe` pass-through → `rm-safe.spec.ts`（rm-safe 契约面）
 * - deadline kill → `background-timeout-notice.spec.ts`（真跑 native 进程）
 * @module tests
 */

import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../../src/config/settings.ts'

const { executeBashMock } = vi.hoisted(() => ({ executeBashMock: vi.fn() }))

vi.mock('../../src/tools/bash/bash-executor.ts', () => ({
  executeBash: (...args: unknown[]) => executeBashMock(...args),
}))

import { startBashJob } from '../../src/tools/bash/background.ts'

/** A minimal successful executor result; override the fields under test. */
function executorResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    output: 'ok',
    exitCode: 0,
    cancelled: false,
    timedOut: false,
    workingDir: undefined,
    spillPath: undefined,
    truncated: false,
    ...overrides,
  }
}

/** Start a job against the mocked executor and await its completion result. */
async function startJob(config: ReturnType<typeof resolveConfig>, command = 'echo ok') {
  const job = startBashJob({
    sessionId: 'spec',
    command,
    cwd: process.cwd(),
    timeoutMs: 5000,
    env: undefined,
    config,
  })
  return job.completion
}

describe('background job minimized passthrough', () => {
  it('carries minimized + originalSpillPath into the completion result', async () => {
    executeBashMock.mockReset()
    executeBashMock.mockResolvedValue(executorResult({
      output: 'minimized text',
      minimized: { filter: 'git', inputBytes: 5124, outputBytes: 1190 },
      originalOutputPath: 'tmp/dsh-bash-original-abc.log',
    }))
    const value = await startJob(resolveConfig({}), 'git show HEAD -- file.txt')
    expect(value.minimized).toEqual({ filter: 'git', inputBytes: 5124, outputBytes: 1190 })
    expect(value.output.originalSpillPath).toBe('tmp/dsh-bash-original-abc.log')
    expect(value.kind).toBe('foreground')
  })
})

// 后台 rmSafe 透传的两条用例归 `rm-safe.spec.ts`（同属 rm-safe 契约面）；
// 这里只留 minimized 透传，避免同一断言在两个文件里各跑一遍。

