/**
 * Degrade when `ctx.shellEnv` is unavailable (2026-11-20).
 *
 * Production symptom: a bash call fails outright with
 * `cannot get required service "shellEnv" in inactive context` and the command
 * never reaches the shell. The official `dsh-tool-bash` reads the same service
 * the same way, so the failure is a host lifecycle condition rather than a
 * plugin bug; but losing a whole command because five `DSH_*` variables cannot
 * be resolved is the wrong trade. These cases pin the intended behaviour: a
 * missing service costs the `DSH_*` snapshot, never the command.
 * @module tests
 */

import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolExecutorNative from '@deepseek-ai/dsh-tool-executor-native'
import * as ToolTasks from '@deepseek-ai/dsh-tool-jobs'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runtimeLogger, setRuntimeLogger } from '../../src/tools/bash/logger.ts'
import * as BashPlus from '../../src/index.ts'

interface RecordedCall {
  command: string
  env?: Record<string, string>
}

const { recorded } = vi.hoisted(() => ({ recorded: [] as RecordedCall[] }))

vi.mock('../../src/tools/bash/bash-executor.ts', async importOriginal => {
  const actual = await importOriginal()
  return {
    ...actual,
    executeBash: async (command: string, options?: { env?: Record<string, string> }) => {
      recorded.push({ command, ...options?.env !== undefined ? { env: options.env } : {} })
      return {
        output: `mock-output:${command}`,
        exitCode: 0,
        cancelled: false,
        truncated: false,
        totalLines: 1,
        totalBytes: 1,
        outputLines: 1,
        outputBytes: 1,
      }
    },
  }
})

const testToolSignal = new AbortController().signal
let sessionCounter = 0

interface Harness {
  ctx: Context
  agent: Agent
  /** This plugin's own fiber: disposing it is what a host reload does. */
  bashPlusFiber: Fiber
  /** The `shell-env` provider fiber, so a case can take the service away. */
  shellEnvFiber: Fiber
  dispose: () => Promise<void>
}

async function harness(): Promise<Harness> {
  const ctx = new Context()
  const agentFibers: Fiber[] = []
  const fibers: Fiber[] = [
    await ctx.plugin(SystemPrompt),
    await ctx.plugin(ToolRuntime),
    await ctx.plugin(ToolExecutorNative),
    await ctx.plugin(SessionProjection),
    await ctx.plugin(AgentRegistry),
    await ctx.plugin(SessionStore),
    await ctx.plugin(LocalJobRegistry),
    await ctx.plugin(ToolTasks),
  ]
  const shellEnvFiber = await ctx.plugin(BashEnvPlugin)
  fibers.push(shellEnvFiber)
  fibers.push(await ctx.plugin(LocalFileSystem, { cwd: process.cwd() }))
  const bashPlusFiber = await ctx.plugin(BashPlus, { autoBackgroundMs: 0 })
  fibers.push(bashPlusFiber)

  const scopeFiber = ctx.plugin(() => {})
  agentFibers.push(scopeFiber)
  const id = SessionId(`shell-env-degrade-${++sessionCounter}`)
  const agent = {
    id,
    ctx: scopeFiber.ctx,
    inject: () => {},
    session: { id, header: { version: 0, id, createdAt: 0 } },
  } as unknown as Agent
  ctx.agents.register(agent)

  return {
    ctx,
    agent,
    bashPlusFiber,
    shellEnvFiber,
    dispose: async () => {
      for (const fiber of agentFibers.reverse()) await fiber.dispose()
      for (const fiber of fibers.reverse()) await fiber.dispose()
    },
  }
}

let callCounter = 0
async function call(ctx: Context, args: Record<string, unknown>, agent: Agent) {
  const id = ToolCallId(`call-${++callCounter}`)
  const batch = await ctx.tools.execute({
    signal: testToolSignal,
    calls: [{ type: 'tool-call', id, name: 'bash', arguments: JSON.stringify(args) }],
    agent,
  })
  return batch.results[0]!.result
}

describe('bash runs without ctx.shellEnv', () => {
  let h: Harness | undefined
  afterEach(async () => {
    recorded.length = 0
    if (h !== undefined) await h.dispose()
    h = undefined
  })

  it('still injects the DSH_* snapshot while the service is live', async () => {
    h = await harness()
    const result = await call(h.ctx, { command: 'echo hi', description: 'live service' }, h.agent)
    expect(result.isError).toBe(false)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.env?.DSH_SHELL).toBe('1')
  })

  it('runs the command when the tool outlives its plugin fiber', async () => {
    h = await harness()
    // A host reload retires the plugin fiber while the caller still holds the
    // tool it was handed. Reading `ctx.shellEnv` off that retired fiber threw
    // and the command never started.
    const tool = h.ctx.tools.get('bash', h.agent)
    expect(tool).toBeDefined()
    await h.bashPlusFiber.dispose()

    const result = await tool!.execute(
      { command: 'echo hi', description: 'stale fiber' },
      { signal: testToolSignal, agent: h.agent } as never,
    )

    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.env?.DSH_SHELL).toBe('1')
    const foreground = result as { kind: string; exitCode: number; output: { text: string } }
    expect(foreground.kind).toBe('foreground')
    expect(foreground.exitCode).toBe(0)
    expect(foreground.output.text).toContain('mock-output:echo hi')
  })

  it('runs the command when the service itself is gone', async () => {
    h = await harness()
    const tool = h.ctx.tools.get('bash', h.agent)
    expect(tool).toBeDefined()
    // Retire our fiber first: taking the provider away while the plugin is
    // still mounted would unload the plugin through its own `inject`.
    await h.bashPlusFiber.dispose()
    await h.shellEnvFiber.dispose()

    const result = await tool!.execute(
      { command: 'echo hi', description: 'no shell env' },
      { signal: testToolSignal, agent: h.agent } as never,
    )

    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.env?.DSH_SHELL).toBeUndefined()
    const foreground = result as { kind: string; exitCode: number; output: { text: string } }
    expect(foreground.kind).toBe('foreground')
    expect(foreground.exitCode).toBe(0)
    expect(foreground.output.text).toContain('mock-output:echo hi')
  })

  it('warns once when the snapshot is unavailable, so the miss is visible', async () => {
    h = await harness()
    const tool = h.ctx.tools.get('bash', h.agent)
    expect(tool).toBeDefined()
    await h.bashPlusFiber.dispose()
    await h.shellEnvFiber.dispose()

    // The plugin installs the composition logger during apply; replacing it
    // here keeps the assertion on the record instead of the console adapter.
    const previous = runtimeLogger()
    const warn = vi.fn()
    setRuntimeLogger({ info: () => {}, warn, error: () => {}, debug: () => {} })
    try {
      await tool!.execute(
        { command: 'echo hi', description: 'warn on degrade' },
        { signal: testToolSignal, agent: h.agent } as never,
      )
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]![0])).toContain('shellEnv unavailable')
    } finally {
      setRuntimeLogger(previous)
    }
  })
})
