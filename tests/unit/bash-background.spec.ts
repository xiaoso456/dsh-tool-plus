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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../../src/config/settings.ts'

const { executeBashMock, createWarmShellMock } = vi.hoisted(() => ({
  executeBashMock: vi.fn(),
  createWarmShellMock: vi.fn(async () => null),
}))

vi.mock('../../src/tools/bash/bash-executor.ts', () => ({
  executeBash: (...args: unknown[]) => executeBashMock(...args),
  createWarmShell: () => createWarmShellMock(),
}))

import { closeSessionWarmShells, startBashJob } from '../../src/tools/bash/background.ts'

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
async function startJob(config: ReturnType<typeof resolveConfig>, command = 'echo ok', sessionId = 'spec') {
  const job = startBashJob({
    sessionId,
    command,
    cwd: process.cwd(),
    timeoutMs: 5000,
    env: undefined,
    config,
  })
  return job.completion
}

afterEach(() => {
  closeSessionWarmShells()
})

describe('background job warm shells', () => {
  it('leases a refilled shell for the next job and never for the first', async () => {
    executeBashMock.mockReset()
    createWarmShellMock.mockReset()
    const created: Array<{ abort: ReturnType<typeof vi.fn> }> = []
    createWarmShellMock.mockImplementation(async () => {
      const shell = { abort: vi.fn(async () => undefined) }
      created.push(shell)
      return shell
    })
    executeBashMock.mockResolvedValue(executorResult())
    const config = resolveConfig({ warmShellEnabled: true, warmShellCount: 1, warmShellTtlMs: 0 })
    await startJob(config, 'first', 'warm-session')
    const firstOptions = executeBashMock.mock.calls[0]?.[1] as Record<string, unknown>
    expect(firstOptions.warmShell).toBeUndefined()
    // The refill runs in the background after the first job; wait for adoption.
    // Adoption trails the create promise by a microtask, so cross a macrotask
    // boundary before the shell can actually be leased.
    await vi.waitFor(() => expect(created).toHaveLength(1))
    await new Promise(resolve => setTimeout(resolve, 0))

    await startJob(config, 'second', 'warm-session')
    const secondOptions = executeBashMock.mock.calls[1]?.[1] as Record<string, unknown>
    expect(secondOptions.warmShell).toBe(created[0])
  })

  it('never creates a warm shell when the pool is disabled', async () => {
    executeBashMock.mockReset()
    createWarmShellMock.mockReset()
    executeBashMock.mockResolvedValue(executorResult())
    await startJob(resolveConfig({ warmShellEnabled: false }), 'disabled', 'warm-disabled')
    expect(createWarmShellMock).not.toHaveBeenCalled()
  })
})

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

describe('background job init-script passthrough', () => {
  it('forwards the init-script config so job shells source it too (issue #6)', async () => {
    executeBashMock.mockReset()
    executeBashMock.mockResolvedValue(executorResult())
    await startJob(resolveConfig({ bashInitEnabled: true }))
    const passed = executeBashMock.mock.calls[0]?.[1] as Record<string, unknown>
    expect(passed.initScriptEnabled).toBe(true)
    expect(String(passed.initScriptPath)).toMatch(/bash-init\.sh$/)
  })

  it('stays off when the feature is disabled', async () => {
    executeBashMock.mockReset()
    executeBashMock.mockResolvedValue(executorResult())
    await startJob(resolveConfig({ bashInitEnabled: false }))
    const passed = executeBashMock.mock.calls[0]?.[1] as Record<string, unknown>
    expect(passed.initScriptEnabled).toBe(false)
  })
})

// 后台 rmSafe 透传的两条用例归 `rm-safe.spec.ts`（同属 rm-safe 契约面）；
// 这里只留 minimized 透传，避免同一断言在两个文件里各跑一遍。

