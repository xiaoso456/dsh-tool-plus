/**
 * Tool-level wiring for the timeout policy (S-4) and cd-workdir extraction
 * (S-16): the plugin mounted on a minimal service stack with `executeBash`
 * replaced by a recording stub, so assertions target exactly what the tool
 * hands to the executor (cwd, timeout) and how the command is rewritten.
 * @module tests
 */

import * as os from 'node:os'
import * as path from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { CallId } from '@deepseek-ai/dsh-llm'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolTasks from '@deepseek-ai/dsh-tool-jobs'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as BashPlus from '../../src/index.ts'

interface RecordedCall {
  command: string
  options?: { cwd?: string; timeout?: number }
}

const { recorded } = vi.hoisted(() => ({
  recorded: [] as Array<{ command: string; options?: { cwd?: string; timeout?: number } }>,
}))

vi.mock('../../src/tools/bash/bash-executor.ts', async importOriginal => {
  const actual = await importOriginal()
  return {
    ...actual,
    executeBash: async (command: string, options?: RecordedCall['options']) => {
      recorded.push({ command, options })
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

async function setup(config: Record<string, unknown> = {}): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  const fibers: Fiber[] = [
    await ctx.plugin(SystemPrompt),
    await ctx.plugin(ToolRuntime),
    await ctx.plugin(AgentRegistry),
    await ctx.plugin(SessionStore),
    await ctx.plugin(LocalJobRegistry),
    await ctx.plugin(ToolTasks),
    await ctx.plugin(BashEnvPlugin),
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() }),
    await ctx.plugin(BashPlus, config),
  ]
  return {
    ctx,
    dispose: async () => {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    },
  }
}

function registerFakeAgent(ctx: Context, sessionId: string, fibers: Fiber[]): Agent {
  const scopeFiber = ctx.plugin(() => {})
  fibers.push(scopeFiber)
  const id = SessionId(sessionId)
  const agent = {
    id,
    ctx: scopeFiber.ctx,
    inject: () => {},
    session: { id, header: { version: 0, id, createdAt: 0 } },
  } as unknown as Agent
  ctx.agents.register(agent)
  return agent
}

let callCounter = 0
function call(ctx: Context, args: Record<string, unknown>, agent?: Agent) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++callCounter}`),
    name: 'bash',
    arguments: args,
    ...agent !== undefined ? { agent } : {},
  })
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

interface Harness {
  ctx: Context
  agent: Agent
  dispose: () => Promise<void>
  agentFibers: Fiber[]
}

async function harness(config: Record<string, unknown>): Promise<Harness> {
  const agentFibers: Fiber[] = []
  const { ctx, dispose } = await setup(config)
  const agent = registerFakeAgent(ctx, `timeout-wiring-${++sessionCounter}`, agentFibers)
  return {
    ctx,
    agent,
    agentFibers,
    dispose: async () => {
      for (const fiber of agentFibers.reverse()) await fiber.dispose()
      agentFibers.length = 0
      await dispose()
    },
  }
}

describe('timeout policy wiring (S-4)', () => {
  let h: Harness
  beforeEach(async () => {
    recorded.length = 0
  })
  afterEach(async () => {
    if (h) await h.dispose()
  })

  it('passes timeoutMs: 0 through to the executor (true disable, not undefined)', async () => {
    h = await harness({ autoBackgroundMs: 0 })
    const result = await call(h.ctx, { command: 'echo hi', description: 'no deadline', timeoutMs: 0 }, h.agent)
    expect(result.isError).toBe(false)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.options?.timeout).toBe(0)
  })

  it('keeps the default deadline when timeoutMs is omitted', async () => {
    h = await harness({ autoBackgroundMs: 0, defaultTimeoutMs: 2_000 })
    recorded.length = 0
    await call(h.ctx, { command: 'echo hi', description: 'default deadline' }, h.agent)
    expect(recorded[0]!.options?.timeout).toBe(2_000)
  })

  it('background jobs without timeoutMs run without a deadline (timeoutMs: 0, not the foreground default)', async () => {
    h = await harness({ autoBackgroundMs: 0, defaultTimeoutMs: 2_000 })
    const result = await call(
      h.ctx,
      { command: 'echo bg', description: 'bg no deadline', run_in_background: true },
      h.agent,
    )
    expect(result.isError).toBe(false)
    expect(recorded[0]!.options?.timeout).toBe(0)
  })

  it('background jobs with an explicit timeoutMs keep it', async () => {
    h = await harness({ autoBackgroundMs: 0 })
    recorded.length = 0
    await call(
      h.ctx,
      { command: 'echo bg', description: 'bg explicit', run_in_background: true, timeoutMs: 5_000 },
      h.agent,
    )
    expect(recorded[0]!.options?.timeout).toBe(5_000)
  })

  it('floors after capping: maxTimeoutMs below 1s still yields at least the 1s floor', async () => {
    h = await harness({ autoBackgroundMs: 0, maxTimeoutMs: 500 })
    recorded.length = 0
    await call(h.ctx, { command: 'echo hi', description: 'capped', timeoutMs: 60_000 }, h.agent)
    expect(recorded[0]!.options?.timeout).toBe(1_000)
  })

  it('auto-background wait with timeoutMs: 0 uses the full autoBackgroundMs window (no instant backgrounding)', async () => {
    h = await harness({ autoBackgroundMs: 1_000 })
    recorded.length = 0
    const result = await call(h.ctx, { command: 'echo fast', description: 'quick', timeoutMs: 0 }, h.agent)
    expect(result.isError).toBe(false)
    expect(textOf(result)).not.toContain('Backgrounded as job')
    expect(textOf(result)).toContain('mock-output:echo fast')
  })
})

describe('cd workdir wiring (S-16)', () => {
  let h: Harness
  beforeEach(async () => {
    recorded.length = 0
  })
  afterEach(async () => {
    if (h) await h.dispose()
  })

  it('routes a leading bare `cd <path> &&` through workdir and strips it from the command', async () => {
    h = await harness({ autoBackgroundMs: 0 })
    await call(h.ctx, { command: 'cd x && ls', description: 'cd prefix' }, h.agent)
    expect(recorded[0]!.command).toBe('ls')
    expect(recorded[0]!.options?.cwd).toBe(path.resolve(process.cwd(), 'x'))
  })

  it('expands ~ in a leading cd target', async () => {
    h = await harness({ autoBackgroundMs: 0 })
    recorded.length = 0
    await call(h.ctx, { command: 'cd ~ && ls', description: 'cd home' }, h.agent)
    expect(recorded[0]!.command).toBe('ls')
    expect(recorded[0]!.options?.cwd).toBe(os.homedir())
  })

  it('expands ~/… in a leading cd target', async () => {
    h = await harness({ autoBackgroundMs: 0 })
    recorded.length = 0
    await call(h.ctx, { command: 'cd ~/proj && make', description: 'cd home sub' }, h.agent)
    expect(recorded[0]!.command).toBe('make')
    // expandTilde yields home + '/proj' (upstream concat semantics); the tool
    // resolves it against the session cwd, normalizing separators.
    expect(recorded[0]!.options?.cwd).toBe(path.resolve(os.homedir() + '/proj'))
  })

  it('expands ~ in an explicit workdir argument', async () => {
    h = await harness({ autoBackgroundMs: 0 })
    recorded.length = 0
    await call(h.ctx, { command: 'pwd', description: 'explicit home', workdir: '~' }, h.agent)
    expect(recorded[0]!.command).toBe('pwd')
    expect(recorded[0]!.options?.cwd).toBe(os.homedir())
  })

  it('bails to the shell on extra cd arguments instead of absorbing them into workdir', async () => {
    h = await harness({ autoBackgroundMs: 0 })
    recorded.length = 0
    await call(h.ctx, { command: 'cd a b && ls', description: 'extra arg' }, h.agent)
    expect(recorded[0]!.command).toBe('cd a b && ls')
    expect(recorded[0]!.options?.cwd).toBe(process.cwd())
  })

  it('bails to the shell on redirects in the cd prefix', async () => {
    h = await harness({ autoBackgroundMs: 0 })
    recorded.length = 0
    await call(h.ctx, { command: 'cd /tmp 2>/dev/null && echo ok', description: 'redirect' }, h.agent)
    expect(recorded[0]!.command).toBe('cd /tmp 2>/dev/null && echo ok')
    expect(recorded[0]!.options?.cwd).toBe(process.cwd())
  })

  it('bails to the shell on command substitution in the cd target', async () => {
    h = await harness({ autoBackgroundMs: 0 })
    recorded.length = 0
    await call(h.ctx, { command: 'cd $(pwd) && ls', description: 'subshell' }, h.agent)
    expect(recorded[0]!.command).toBe('cd $(pwd) && ls')
    expect(recorded[0]!.options?.cwd).toBe(process.cwd())
  })
})