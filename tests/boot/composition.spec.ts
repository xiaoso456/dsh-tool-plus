/**
 * Keyless composition-boot tests: the plugin mounted with its real service
 * dependencies (tools registry, jobs registry + controller, shell-env),
 * driven through `ctx.tools.execute` exactly like the repo's own tool tests.
 * Requires bash on PATH (Git Bash on Windows); self-skips otherwise.
 * @module tests
 */

import { existsSync } from 'node:fs'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolTasks from '@deepseek-ai/dsh-tool-jobs'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as BashPlus from '../../src/index.ts'
import { getShellConfig } from '../../src/tools/bash/bash-executor.ts'

const bashAvailable = ((): boolean => {
  try {
    const { shell } = getShellConfig()
    return shell === 'bash' ? existsSync('/bin/bash') || process.platform !== 'win32' : existsSync(shell)
  } catch {
    return false
  }
})()

const describeBash = bashAvailable ? describe : describe.skip

const testToolSignal = new AbortController().signal

async function setup(autoBackgroundMs: number, extra: { maxBackgroundJobs?: number } = {}): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(SystemPrompt),
    await ctx.plugin(ToolRuntime),
    await ctx.plugin(AgentRegistry),
    await ctx.plugin(SessionStore),
    await ctx.plugin(LocalJobRegistry),
    await ctx.plugin(ToolTasks),
    await ctx.plugin(BashEnvPlugin),
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() }),
    await ctx.plugin(BashPlus, { autoBackgroundMs, ...extra }),
  ]
  return {
    ctx,
    dispose: async () => {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    },
  }
}

/** Fake Agent with the shared identity and a dedicated lifecycle fiber. */
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
function call(ctx: Context, name: string, args: unknown, agent?: Agent) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`call-${++callCounter}`),
    name,
    arguments: args,
    ...agent !== undefined ? { agent } : {},
  })
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

async function waitForJob(ctx: Context, id: string, agent: Agent, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = ctx.jobs.get(id as JobId, agent)
    if (snapshot.status !== 'running' && snapshot.status !== 'stopping') return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`job ${id} did not settle within ${timeoutMs}ms`)
}

/** Foreground-semantics harness: auto-backgrounding disabled. */
describeBash('bash-plus composition', () => {
  let ctx: Context
  let agent: Agent
  let dispose: () => Promise<void>
  const agentFibers: Fiber[] = []

  beforeEach(async () => {
    const harness = await setup(0)
    ctx = harness.ctx
    dispose = harness.dispose
    agent = registerFakeAgent(ctx, `boot-fg-${callCounter}`, agentFibers)
  })

  afterEach(async () => {
    for (const fiber of agentFibers.reverse()) await fiber.dispose()
    agentFibers.length = 0
    await dispose()
  })

  it('registers the bash tool under the dsh tool registry', () => {
    const tool = ctx.tools.get('bash')
    expect(tool).toBeDefined()
    const properties = (tool?.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(properties).toHaveProperty('command')
    expect(properties).toHaveProperty('run_in_background')
  })

  it('registers the tool:bash system prompt section', () => {
    // A duplicate registration in the same layer throws, which proves the
    // plugin's section is already present.
    expect(() => ctx.systemPrompt.section({ name: 'tool:bash', order: 105, text: 'dup' })).toThrow()
  })

  it('executes a command and returns the exit marker contract', async () => {
    const ok = await call(ctx, 'bash', { command: 'echo hello-boot', description: 'test echo' }, agent)
    expect(ok.isError).toBe(false)
    expect(textOf(ok)).toContain('hello-boot')
    // A zero exit carries no marker; non-zero exits anchor the final line.
    const failed = await call(ctx, 'bash', { command: 'exit 3', description: 'fail' }, agent)
    expect(failed.isError).toBe(false)
    expect(textOf(failed)).toMatch(/\n\[exit code: 3\]$/)
  })

  it('persists cd across calls in one session', async () => {
    const first = await call(ctx, 'bash', { command: 'cd /tmp && pwd', description: 'change dir' }, agent)
    const dir = textOf(first).match(/^(.+)$/m)?.[1]
    expect(dir).toBeTruthy()
    const second = await call(ctx, 'bash', { command: 'pwd', description: 'show cwd' }, agent)
    expect(textOf(second)).toContain(dir!)
  })

  it('passes command-scoped env variables', async () => {
    const result = await call(ctx, 'bash', {
      command: 'echo "$BOOT_TEST_VAR"',
      description: 'echo env',
      env: { BOOT_TEST_VAR: 'boot-scoped' },
    }, agent)
    expect(textOf(result)).toContain('boot-scoped')
  })

  it('intercepts cat by default (interceptorEnabled defaults to true)', async () => {
    // Interception defaults ON (user decision 2026-08-29; upstream default is
    // false): `cat` is blocked with a redirect to the `read` tool whenever the
    // dedicated tool is visible (registered by the plugin itself).
    const result = await call(ctx, 'bash', { command: 'cat package.json', description: 'read file' }, agent)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('Use the `read` tool')
  })

  it('supports run_in_background through ctx.jobs and job reads', async () => {
    const started = await call(ctx, 'bash', {
      command: 'echo job-output-line && sleep 0.2',
      description: 'background echo',
      run_in_background: true,
    }, agent)
    expect(started.isError).toBe(false)
    const id = textOf(started).match(/job (bash-\d+)/)?.[1]
    expect(id).toBeTruthy()
    await waitForJob(ctx, id!, agent)
    const read = ctx.jobs.read(id as JobId, agent)
    expect(read.text).toContain('job-output-line')
  })

  it('points the settled completion read at the spill file for large output', async () => {
    // ~160KB raw: past the sink spill point (~70K) so a spill file exists, and
    // past the 10KB completion-truncation trigger so the notice carries it.
    const started = await call(ctx, 'bash', {
      command: 'seq 1 30000',
      description: 'large background output',
      run_in_background: true,
    }, agent)
    expect(started.isError).toBe(false)
    const id = textOf(started).match(/job (bash-\d+)/)?.[1]
    expect(id).toBeTruthy()
    await waitForJob(ctx, id!, agent)
    const read = ctx.jobs.read(id as JobId, agent)
    // Regression guard: the settled wrapper must apply the configured
    // truncation WITH the spill path — a lost `settled` flag silently degrades
    // every background completion to raw preview tail.
    expect(read.text).toContain('[Output truncated')
    expect(read.text).toMatch(/Full output: .*dsh-bash-spill/)
  })

  it('clamps tiny timeouts up to 1s instead of failing instantly', async () => {
    const result = await call(ctx, 'bash', { command: 'sleep 0.5', description: 'sleep', timeoutMs: 1 }, agent)
    expect(result.isError).toBe(false)
    expect(textOf(result)).not.toContain('[timed out')
  }, 15_000)

  it('reports timeouts with the timed-out marker', async () => {
    const result = await call(ctx, 'bash', { command: 'sleep 5', description: 'sleep long', timeoutMs: 1000 }, agent)
    expect(textOf(result)).toContain('[timed out after 1000ms]')
  })

  it('rejects a second bash tool registration', async () => {
    await expect(ctx.plugin(BashPlus, { autoBackgroundMs: 0 })).rejects.toThrow(/already registered/)
  })
})

/** Concurrency-capped mounting: the second concurrent job is refused at capacity. */
describeBash('bash-plus background capacity', () => {
  let ctx: Context
  let agent: Agent
  let dispose: () => Promise<void>
  const agentFibers: Fiber[] = []

  beforeEach(async () => {
    const harness = await setup(300_000, { maxBackgroundJobs: 1 })
    ctx = harness.ctx
    dispose = harness.dispose
    agent = registerFakeAgent(ctx, `boot-cap-${callCounter}`, agentFibers)
  })

  afterEach(async () => {
    for (const fiber of agentFibers.reverse()) await fiber.dispose()
    agentFibers.length = 0
    await dispose()
  })

  it('refuses a second concurrent background job at the cap', async () => {
    const first = await call(ctx, 'bash', {
      command: 'sleep 0.5',
      description: 'first background job',
      run_in_background: true,
    }, agent)
    expect(first.isError).toBe(false)
    const second = await call(ctx, 'bash', {
      command: 'echo should-not-run',
      description: 'second background job',
      run_in_background: true,
    }, agent)
    expect(second.isError).toBe(true)
    expect(textOf(second)).toContain('at capacity (maxBackgroundJobs: 1)')
    const id = textOf(first).match(/job (bash-\d+)/)?.[1]
    if (id !== undefined) await waitForJob(ctx, id, agent)
  })
})

/** Auto-backgrounding runs with a 1s threshold so tests stay fast. */
describeBash('bash-plus auto-backgrounding', () => {
  let ctx: Context
  let agent: Agent
  let dispose: () => Promise<void>
  const agentFibers: Fiber[] = []

  beforeEach(async () => {
    const harness = await setup(1_000)
    ctx = harness.ctx
    dispose = harness.dispose
    agent = registerFakeAgent(ctx, `boot-ab-${callCounter}`, agentFibers)
  })

  afterEach(async () => {
    for (const fiber of agentFibers.reverse()) await fiber.dispose()
    agentFibers.length = 0
    await dispose()
  })

  it('finishes inside the wait window as a foreground result', async () => {
    const result = await call(ctx, 'bash', { command: 'sleep 0.3 && echo done-inline', description: 'quick' }, agent)
    expect(result.isError).toBe(false)
    expect(textOf(result)).toContain('done-inline')
    expect(textOf(result)).not.toContain('Backgrounded as job')
  })

  it('hands back a job id when the command outlives the window', async () => {
    const result = await call(ctx, 'bash', { command: 'sleep 3', description: 'slow', timeoutMs: 60_000 }, agent)
    expect(result.isError).toBe(false)
    expect(textOf(result)).toContain('Backgrounded as job')
  }, 30_000)

  it('updates the session cwd from a windowed background run', async () => {
    const first = await call(ctx, 'bash', { command: 'cd /tmp && pwd', description: 'change dir' }, agent)
    const dir = textOf(first).match(/^(.+)$/m)?.[1]
    expect(dir).toBeTruthy()
    const second = await call(ctx, 'bash', { command: 'pwd', description: 'show cwd' }, agent)
    expect(textOf(second)).toContain(dir!)
  })
})
