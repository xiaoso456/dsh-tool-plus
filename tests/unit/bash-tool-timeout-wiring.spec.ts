/**
 * Tool-level wiring for the timeout policy (S-4) and cd-workdir extraction
 * (S-16): the plugin mounted on a minimal service stack with `executeBash`
 * replaced by a recording stub, so assertions target exactly what the tool
 * hands to the executor (cwd, timeout) and how the command is rewritten.
 * @module tests
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as BashPlus from '../../src/index.ts'
import { resolveWindowsTempDir } from '../../src/tools/shared/windows-tmp-path.ts'

interface RecordedCall {
  command: string
  options?: { cwd?: string; timeout?: number }
}

const { recorded, nextWorkingDirs } = vi.hoisted(() => ({
  recorded: [] as Array<{ command: string; options?: { cwd?: string; timeout?: number } }>,
  /** Each successful call consumes one entry and reports it as its final cwd. */
  nextWorkingDirs: [] as string[],
}))

vi.mock('../../src/tools/bash/bash-executor.ts', async importOriginal => {
  const actual = await importOriginal()
  return {
    ...actual,
    executeBash: async (command: string, options?: RecordedCall['options']) => {
      recorded.push({ command, options })
      const workingDir = nextWorkingDirs.shift()
      return {
        output: `mock-output:${command}`,
        exitCode: 0,
        cancelled: false,
        truncated: false,
        totalLines: 1,
        totalBytes: 1,
        outputLines: 1,
        outputBytes: 1,
        ...(workingDir !== undefined ? { workingDir } : {}),
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
    await ctx.plugin(ToolExecutorNative),
    await ctx.plugin(SessionProjection),
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

function registerFakeAgent(ctx: Context, sessionId: string, fibers: Fiber[], headerCwd?: string): Agent {
  const scopeFiber = ctx.plugin(() => {})
  fibers.push(scopeFiber)
  const id = SessionId(sessionId)
  const agent = {
    id,
    ctx: scopeFiber.ctx,
    inject: () => {},
    session: {
      id,
      header: { version: 0, id, createdAt: 0, ...(headerCwd !== undefined ? { cwd: headerCwd } : {}) },
    },
  } as unknown as Agent
  ctx.agents.register(agent)
  return agent
}

let callCounter = 0
/** One `bash` call through the real executor; see composition.spec.ts for the 0.2.2 batch shape. */
async function call(ctx: Context, args: Record<string, unknown>, agent?: Agent) {
  const id = ToolCallId(`call-${++callCounter}`)
  const batch = await ctx.tools.execute({
    signal: testToolSignal,
    calls: [{ type: 'tool-call', id, name: 'bash', arguments: JSON.stringify(args) }],
    ...agent !== undefined ? { agent } : {},
  })
  return batch.results[0]!.result
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

async function harness(config: Record<string, unknown>, headerCwd?: string): Promise<Harness> {
  const agentFibers: Fiber[] = []
  const { ctx, dispose } = await setup(config)
  const agent = registerFakeAgent(ctx, `timeout-wiring-${++sessionCounter}`, agentFibers, headerCwd)
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cd-wiring-')).replace(/\\/g, '/')
    await call(h.ctx, { command: `cd '${dir}' && ls`, description: 'cd prefix' }, h.agent)
    expect(recorded[0]!.command).toBe('ls')
    // The authored forward-slash tempdir form is returned as-is by `resolveToCwd`.
    expect(recorded[0]!.options?.cwd).toBe(dir)
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
    // `~/..` keeps the `~/…` prefix shape while targeting a directory that
    // exists on every platform (the stat check would fail on a fabricated one).
    // expandTilde's upstream concat yields home + '/..'; `resolveToCwd` returns
    // the absolute input as authored (no `..` folding).
    await call(h.ctx, { command: 'cd ~/.. && make', description: 'cd home sub' }, h.agent)
    expect(recorded[0]!.command).toBe('make')
    expect(recorded[0]!.options?.cwd).toBe(os.homedir() + '/..')
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

describe('cd workdir MSYS path forms (S-16b)', () => {
  let h: Harness
  beforeEach(async () => {
    recorded.length = 0
  })
  afterEach(async () => {
    if (h) await h.dispose()
  })

  it('converts an MSYS /d/… leading cd target to the native drive path', async () => {
    h = await harness({ autoBackgroundMs: 0 })
    await call(h.ctx, { command: 'cd /d/code && pwd', description: 'msys cd' }, h.agent)
    expect(recorded[0]!.command).toBe('pwd')
    expect(recorded[0]!.options?.cwd).toBe(process.platform === 'win32' ? 'D:\\code' : '/d/code')
  })

  it('converts an MSYS path in an explicit workdir argument', async () => {
    h = await harness({ autoBackgroundMs: 0 })
    await call(h.ctx, { command: 'pwd', description: 'msys workdir', workdir: '/d/code' }, h.agent)
    expect(recorded[0]!.options?.cwd).toBe(process.platform === 'win32' ? 'D:\\code' : '/d/code')
  })

  it('keeps the drive-letter + forward-slash form working through the same resolver', async () => {
    h = await harness({ autoBackgroundMs: 0 })
    // `resolveToCwd` returns absolute inputs in their authored form (only MSYS
    // aliases get converted); Node's fs accepts the forward-slash drive form.
    await call(h.ctx, { command: 'cd D:/code && pwd', description: 'drive slash' }, h.agent)
    expect(recorded[0]!.options?.cwd).toBe('D:/code')
  })

  it('peels a stray leading colon from the cd target (upstream expandPath semantics)', async () => {
    h = await harness({ autoBackgroundMs: 0 })
    await call(h.ctx, { command: 'cd :D:/code && pwd', description: 'colon prefix' }, h.agent)
    expect(recorded[0]!.options?.cwd).toBe('D:/code')
  })

  it('treats a bare / as the workspace-root alias (session cwd)', async () => {
    h = await harness({ autoBackgroundMs: 0 })
    await call(h.ctx, { command: 'cd / && pwd', description: 'root alias' }, h.agent)
    expect(recorded[0]!.options?.cwd).toBe(process.cwd())
  })

  it('fails loud on a nonexistent workdir instead of a shell-side cryptic cwd error', async () => {
    h = await harness({ autoBackgroundMs: 0 })
    const result = await call(
      h.ctx,
      { command: 'cd /d/code/no-such-dir-xyz && pwd', description: 'missing dir' },
      h.agent,
    )
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('Working directory does not exist')
  })

  it('fails loud when the workdir target is a file, not a directory', async () => {
    h = await harness({ autoBackgroundMs: 0 })
    const result = await call(
      h.ctx,
      { command: 'pwd', description: 'file workdir', workdir: 'package.json' },
      h.agent,
    )
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('Working directory is not a directory')
  })
})

describe('session cwd validation (S-16c)', () => {
  let h: Harness
  const tmpDirs: string[] = []
  const tmpDir = (prefix: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    tmpDirs.push(dir)
    return dir
  }
  const tmpDirInWindowsTemp = (prefix: string): string => {
    const dir = fs.mkdtempSync(path.join(resolveWindowsTempDir(), prefix))
    tmpDirs.push(dir)
    return dir
  }

  beforeEach(() => {
    recorded.length = 0
    nextWorkingDirs.length = 0
  })
  afterEach(async () => {
    if (h) await h.dispose()
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reports a clear error when the last cd target was deleted', async () => {
    const workspace = tmpDir('dsh-cwd-ws-')
    const target = tmpDir('dsh-cwd-target-')
    h = await harness({ autoBackgroundMs: 0 }, workspace)
    nextWorkingDirs.push(target)
    const first = await call(h.ctx, { command: 'enter-target', description: 'move cwd' }, h.agent)
    expect(first.isError).toBe(false)
    expect(recorded[0]!.options?.cwd).toBe(workspace)
    fs.rmSync(target, { recursive: true, force: true })
    recorded.length = 0

    const result = await call(h.ctx, { command: 'pwd', description: 'stale cwd' }, h.agent)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain(`Session working directory does not exist: ${target}`)
    expect(recorded).toHaveLength(0)
  })

  it('reports the same clear error when the session cwd is missing at start', async () => {
    const dead = tmpDir('dsh-cwd-dead-')
    fs.rmSync(dead, { recursive: true, force: true })
    h = await harness({ autoBackgroundMs: 0 }, dead)

    const result = await call(h.ctx, { command: 'pwd', description: 'dead workspace' }, h.agent)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain(`Session working directory does not exist: ${dead}`)
    expect(recorded).toHaveLength(0)
  })

  it('reports a clear error when the session cwd points at a file', async () => {
    const dir = tmpDir('dsh-cwd-file-')
    const file = path.join(dir, 'plain.txt')
    fs.writeFileSync(file, 'x')
    h = await harness({ autoBackgroundMs: 0 }, file)

    const result = await call(h.ctx, { command: 'pwd', description: 'file cwd' }, h.agent)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain(`Session working directory is not a directory: ${file}`)
    expect(recorded).toHaveLength(0)
  })

  it('recovers through an absolute workdir and follows it on the next call', async () => {
    const dead = tmpDir('dsh-cwd-dead-')
    fs.rmSync(dead, { recursive: true, force: true })
    const live = tmpDir('dsh-cwd-live-')
    h = await harness({ autoBackgroundMs: 0 }, dead)
    nextWorkingDirs.push(live)

    const first = await call(h.ctx, { command: 'pwd', description: 'recover', workdir: live }, h.agent)
    expect(first.isError).toBe(false)
    expect(recorded[0]!.options?.cwd).toBe(live)

    recorded.length = 0
    const second = await call(h.ctx, { command: 'pwd', description: 'after recovery' }, h.agent)
    expect(second.isError).toBe(false)
    expect(recorded[0]!.options?.cwd).toBe(live)
  })

  it.skipIf(process.platform !== 'win32')('resolves an explicit /tmp workdir to the host temp directory', async () => {
    const workspace = tmpDir('dsh-cwd-ws-')
    const target = tmpDirInWindowsTemp('dsh-cwd-tmp-')
    h = await harness({ autoBackgroundMs: 0 }, workspace)

    const result = await call(
      h.ctx,
      { command: 'pwd', description: 'tmp workdir', workdir: '/tmp/' + path.basename(target) },
      h.agent,
    )
    expect(result.isError).toBe(false)
    expect(recorded[0]!.options?.cwd).toBe(target)
  })

  it.skipIf(process.platform !== 'win32')('resolves a leading cd /tmp to the host temp directory', async () => {
    const workspace = tmpDir('dsh-cwd-ws-')
    const target = tmpDirInWindowsTemp('dsh-cwd-tmp-')
    h = await harness({ autoBackgroundMs: 0 }, workspace)

    const result = await call(
      h.ctx,
      { command: 'cd "/tmp/' + path.basename(target) + '" && pwd', description: 'tmp cd' },
      h.agent,
    )
    expect(result.isError).toBe(false)
    expect(recorded[0]!.command).toBe('pwd')
    expect(recorded[0]!.options?.cwd).toBe(target)
  })

  it.skipIf(process.platform !== 'win32')('normalizes a legacy logical /tmp session cwd', async () => {
    const workspace = tmpDir('dsh-cwd-ws-')
    const target = tmpDirInWindowsTemp('dsh-cwd-tmp-')
    const logical = '/tmp/' + path.basename(target)
    h = await harness({ autoBackgroundMs: 0 }, workspace)
    nextWorkingDirs.push(logical)

    const first = await call(h.ctx, { command: 'enter-target', description: 'move to logical /tmp' }, h.agent)
    expect(first.isError).toBe(false)
    recorded.length = 0

    const second = await call(h.ctx, { command: 'pwd', description: 'after logical /tmp' }, h.agent)
    expect(second.isError).toBe(false)
    expect(recorded[0]!.options?.cwd).toBe(target)
  })

  it('recovers through an absolute leading cd while the session cwd is dead', async () => {
    const dead = tmpDir('dsh-cwd-dead-')
    fs.rmSync(dead, { recursive: true, force: true })
    const live = tmpDir('dsh-cwd-live-')
    h = await harness({ autoBackgroundMs: 0 }, dead)
    nextWorkingDirs.push(live)

    const result = await call(
      h.ctx,
      { command: `cd "${live}" && pwd`, description: 'recover via cd' },
      h.agent,
    )
    expect(result.isError).toBe(false)
    expect(recorded[0]!.command).toBe('pwd')
    expect(recorded[0]!.options?.cwd).toBe(live)
  })
})