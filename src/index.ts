/*
 * Ported from oh-my-pi (https://github.com/can1357/oh-my-pi) — MIT.
 *   Copyright (c) 2025 Mario Zechner
 *   Copyright (c) 2025-2026 Can Bölük
 */
/**
 * The Oh My Pi bash tool for deepseek-harness (port of the pi-gateway
 * bash-runtime extension).
 *
 * Features:
 * - Persistent shell session per Agent with cd/export carry-over
 * - Output minimizer (native intelligent compression for git/npm/cargo/…)
 * - Non-interactive env hardening (PAGER=cat, TERM=dumb, no prompts)
 * - Shell session quarantine after timeout/cancel
 * - Concurrent call isolation (one-shot shells for overlapping calls)
 * - Background execution through the `ctx.jobs` seam (`run_in_background`),
 *   with completion notices injected by `dsh-tool-jobs`
 * - Auto-backgrounding (foreground commands exceeding a threshold)
 * - Command interception (cat/grep/find/sed -i → dedicated dsh tools)
 * - Timeout clamping [1s, maxTimeoutMs]; `timeoutMs: 0` disables the deadline
 * - `cd path && cmd` extraction, `env` and `workdir` parameters
 * - Head+tail output retention with spill-to-file for truncated output
 *
 * The plugin REPLACES `@deepseek-ai/dsh-tool-bash` in a composition: it
 * registers the same `bash` tool name, so mounting both fails loud at load.
 *
 * @module @xiaoso/dsh-bash-plus
 */

import { randomBytes } from 'node:crypto'
import { createWriteStream, type WriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, TerminalCallView, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { DSH_ENV_PREFIX } from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { checkBashInterception, DEFAULT_BASH_INTERCEPTOR_RULES } from './bash-interceptor.ts'
import { closeSessionShells, executeBash } from './bash-executor.ts'
import { startBashJob } from './background.ts'
import { setRuntimeLogger } from './logger.ts'
import { parseExitStatus, renderBashResult } from './render.ts'
import { cleanupSnapshots } from './shell-snapshot.ts'
import type { BashBackgroundOutput, BashForegroundOutput, BashToolArgs, MinimizerConfig, ResolvedConfig } from './types.ts'
import type { JobId } from '@deepseek-ai/dsh-jobs'

export const name = 'tool-bash-plus'
export const inject = ['tools', 'systemPrompt', 'shellEnv']

/** Plugin configuration; every field defaults inside {@link apply}. */
export interface Config {
  enableRunInBackground?: boolean
  autoBackgroundMs?: number
  defaultTimeoutMs?: number
  maxTimeoutMs?: number
  outputMaxBytes?: number
  outputSinkTailBytes?: number
  outputSinkHeadBytes?: number
  minimizer?: MinimizerConfig
  interceptorEnabled?: boolean
  nonInteractiveEnv?: boolean
  snapshotEnabled?: boolean
  useShellCommandWrapper?: boolean
}

/** Runtime configuration schema for the plugin. */
export const Config: z<Config> = z.object({
  enableRunInBackground: z.boolean().default(true),
  autoBackgroundMs: z.number().default(60_000),
  defaultTimeoutMs: z.number().default(300_000),
  maxTimeoutMs: z.number().default(3_600_000),
  outputMaxBytes: z.number().default(51_200),
  outputSinkTailBytes: z.number().default(51_200),
  outputSinkHeadBytes: z.number().default(20_480),
  minimizer: z.object({
    enabled: z.boolean().default(true),
    only: z.array(z.string()).default([]),
    except: z.array(z.string()).default([]),
    maxCaptureBytes: z.number().default(512 * 1024),
  }),
  interceptorEnabled: z.boolean().default(true),
  nonInteractiveEnv: z.boolean().default(true),
  snapshotEnabled: z.boolean().default(true),
  useShellCommandWrapper: z.boolean().default(false),
})

const BASH_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Matches a leading `cd path && cmd`; the captured path must stay free of `$`, backtick, and `(`. */
const CD_PREFIX_PATTERN = /^cd[ \t]+((?:[^&\\\n\r]|\\.)+?)[ \t]*&&[ \t]*/
/** Session id fallback for tool executions without an owning agent (tests, direct calls). */
const ANONYMOUS_SESSION = 'anonymous'

/** The abort error the loop recognizes as a cancelled tool call. */
function abortError(): HarnessError {
  const error = new HarnessError('tool call aborted', TOOL_ABORTED)
  error.name = 'AbortError'
  return error
}

/**
 * Lazily writes full command output to a temp file. Only opens the file once
 * total bytes exceed the threshold, avoiding unnecessary I/O for small
 * outputs.
 */
class FullOutputWriter {
  readonly threshold: number
  private _path: string | undefined
  private stream: WriteStream | undefined
  private readonly pendingChunks: string[] = []
  private pendingBytes = 0
  private closed = false

  constructor(threshold: number) {
    this.threshold = threshold
  }

  append(chunk: string): void {
    if (this.closed) return
    this.pendingBytes += Buffer.byteLength(chunk, 'utf-8')
    if (this._path === undefined && this.pendingBytes > this.threshold) {
      this.ensureFile()
    }
    if (this.stream !== undefined) {
      this.stream.write(chunk)
    } else {
      this.pendingChunks.push(chunk)
    }
  }

  ensureFile(): string {
    if (this._path === undefined) {
      this._path = path.join(tmpdir(), `dsh-bash-${randomBytes(4).toString('hex')}.log`)
      this.stream = createWriteStream(this._path)
      for (const chunk of this.pendingChunks) {
        this.stream.write(chunk)
      }
      this.pendingChunks.length = 0
    }
    return this._path
  }

  get filePath(): string | undefined {
    return this._path
  }

  async close(): Promise<string | undefined> {
    if (this.closed) return this._path
    this.closed = true
    if (this.stream === undefined) return this._path
    await new Promise<void>((resolve, reject) => {
      this.stream!.end(() => {
        resolve()
      })
      this.stream!.on('error', reject)
    })
    return this._path
  }
}

/** Per-session tool state: the working directory the persistent shell carries. */
interface SessionState {
  cwd: string
}

const sessionStates = new Map<string, SessionState>()

function sessionStateFor(sessionId: string, headerCwd: string | undefined): SessionState {
  let state = sessionStates.get(sessionId)
  if (state === undefined) {
    state = { cwd: headerCwd ?? process.cwd() }
    sessionStates.set(sessionId, state)
  }
  return state
}

function validateBashArgs(args: BashToolArgs): void {
  if (args.command.trim().length === 0) {
    throw new Error('invalid command: expected a non-empty string')
  }
  if (args.description.trim().length === 0) {
    throw new Error('invalid description: expected a non-empty string')
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 0)) {
    throw new Error(`invalid timeoutMs: expected a non-negative number, got ${JSON.stringify(args.timeoutMs)}`)
  }
}

/** Validate env key names and drop empty maps. */
function normalizeBashEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (env === undefined || Object.keys(env).length === 0) return undefined
  for (const key of Object.keys(env)) {
    if (!BASH_ENV_NAME_PATTERN.test(key)) {
      throw new Error(`Invalid bash env name: ${key}`)
    }
  }
  return env
}

/** Shape one completed foreground run into the tool's canonical DTO. */
function buildForeground(
  result: Awaited<ReturnType<typeof executeBash>>,
  wallTimeMs: number,
  timeoutMs: number | undefined,
  spillPath: string | undefined,
): BashForegroundOutput {
  return {
    kind: 'foreground',
    exitCode: result.exitCode ?? null,
    timedOut: result.cancelled,
    aborted: false,
    timeoutMs: timeoutMs ?? null,
    wallTimeMs,
    ...result.workingDir !== undefined ? { workingDir: result.workingDir } : {},
    ...result.minimized !== undefined ? { minimized: result.minimized } : {},
    output: {
      text: result.output,
      truncated: result.truncated,
      ...spillPath !== undefined ? { spillPath } : {},
    },
  }
}

/**
 * Present foreground calls as terminals and background starts as generic
 * cards, mirroring `dsh-tool-bash`.
 */
function presentBashCall(args: BashToolArgs): GenericCallView | TerminalCallView {
  if (args.run_in_background === true) {
    return {
      card: 'generic',
      title: args.command,
      kind: 'execute',
      rawInput: args.command,
      content: [{ type: 'text', text: args.description }],
    }
  }
  return {
    card: 'terminal',
    title: args.command,
    description: args.description,
    ...args.workdir !== undefined ? { cwd: args.workdir } : {},
  }
}

/**
 * Present completed foreground output as a terminal; background
 * acknowledgements and execution errors use generic fenced output.
 */
function presentBashResult(args: unknown, result: ToolResult): ToolResultView | undefined {
  const block = result.content.length === 1 ? result.content[0] : undefined
  if (block === undefined || block.type !== 'text') return undefined
  const raw = block.text
  const isBackground = typeof args === 'object' && args !== null && (args as { run_in_background?: unknown }).run_in_background === true
  if (isBackground || result.isError || raw.startsWith('Backgrounded as job')) {
    return { card: 'generic', content: [{ type: 'text', text: `\`\`\`console\n${raw.replace(/\n+$/, '')}\n\`\`\`` }] }
  }
  const { body, ...exit } = parseExitStatus(raw)
  return { card: 'terminal', output: body, ...exit }
}

export function apply(ctx: Context, config: Config = {}): void {
  const cfg: ResolvedConfig = {
    enableRunInBackground: config.enableRunInBackground ?? true,
    autoBackgroundMs: config.autoBackgroundMs ?? 60_000,
    defaultTimeoutMs: config.defaultTimeoutMs ?? 300_000,
    maxTimeoutMs: config.maxTimeoutMs ?? 3_600_000,
    outputMaxBytes: config.outputMaxBytes ?? 51_200,
    outputSinkTailBytes: config.outputSinkTailBytes ?? 51_200,
    outputSinkHeadBytes: config.outputSinkHeadBytes ?? 20_480,
    minimizer: {
      enabled: config.minimizer?.enabled ?? true,
      only: config.minimizer?.only ?? [],
      except: config.minimizer?.except ?? [],
      maxCaptureBytes: config.minimizer?.maxCaptureBytes ?? 512 * 1024,
    },
    interceptorEnabled: config.interceptorEnabled ?? true,
    nonInteractiveEnv: config.nonInteractiveEnv ?? true,
    snapshotEnabled: config.snapshotEnabled ?? true,
    useShellCommandWrapper: config.useShellCommandWrapper ?? false,
  }

  setRuntimeLogger(ctx.logger)

  // Cross-call guidance belongs in the prompt rather than one-call schema prose.
  ctx.systemPrompt.section({
    name: 'tool:bash',
    order: 105,
    text: 'The bash tool runs in a persistent shell session: `cd`, `export`, and other state changes carry over between calls. '
      + 'Long-running commands are moved to the background automatically (the call returns a job id; the result is delivered '
      + 'automatically when it finishes — do not poll for it). '
      + 'Check the [exit code: N] marker on every bash result; investigate failures before moving on.',
  })

  // Shells and snapshot files are process-lifetime resources; release them
  // with the composition and with each disposed agent session.
  ctx.effect(() => () => {
    closeSessionShells('')
    cleanupSnapshots()
    sessionStates.clear()
  }, 'bash-plus teardown')
  ctx.on('agent/disposed', ({ agent }) => {
    closeSessionShells(agent.session.id)
    sessionStates.delete(agent.session.id)
  })

  ctx.tools.register(defineTool({
    name: 'bash',
    description: 'Execute a bash command in a persistent shell session and return its output. '
      + '`cd`, `export`, and other state changes carry over between calls; pass `workdir` to run elsewhere. '
      + 'Non-zero exits are reported as `[exit code: N]`. Long output is minimized and/or truncated to head+tail; '
      + 'the full output is saved to a file whose path is reported when available. '
      + 'Set `run_in_background: true` for long-running commands: the call returns a job id immediately; '
      + 'the result is delivered automatically when it finishes — do not poll for it. '
      + 'Commands exceeding the auto-background threshold are moved to the background automatically. '
      + `Current harness environment facts are exposed through managed \`$${DSH_ENV_PREFIX}*\` variables; inspect them when needed.`,
    parameters: {
      command: { type: 'string', required: true, description: 'The bash command to execute.' },
      description: {
        type: 'string',
        required: true,
        description: 'Clear, concise description of what this command does in active voice, '
          + '5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; '
          + '"git status" → "Show working tree status"; "npm install" → "Install package dependencies".',
      },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds; 0 disables the command deadline; nonzero values are clamped to the configured range.' },
      workdir: { type: 'string', description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against the session cwd.' },
      env: {
        type: 'object',
        additionalProperties: true,
        description: 'Extra environment variables for this command only (not persisted in the session).',
      },
      ...cfg.enableRunInBackground ? {
        run_in_background: { type: 'boolean' as const, description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.' },
      } : {},
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'background' },
              jobId: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'foreground' },
              exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
              timedOut: { type: 'boolean', required: true },
              aborted: { type: 'boolean', required: true },
              timeoutMs: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              wallTimeMs: { type: 'number', required: true },
              workingDir: { type: 'string' },
              minimized: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  filter: { type: 'string', required: true },
                  inputBytes: { type: 'number', required: true },
                  outputBytes: { type: 'number', required: true },
                },
              },
              output: {
                type: 'object',
                additionalProperties: false,
                required: true,
                properties: {
                  text: { type: 'string', required: true },
                  truncated: { type: 'boolean', required: true },
                  spillPath: { type: 'string' },
                },
              },
            },
          },
        ],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'background'
          ? `Backgrounded as job ${value.jobId}; result will be delivered automatically when it finishes. Continue with other work — do not poll for it.`
          : renderBashResult(value),
      }],
    },
    async execute(args: BashToolArgs, exec) {
      validateBashArgs(args)
      const sessionId = exec.agent?.session.id ?? ANONYMOUS_SESSION
      const state = sessionStateFor(sessionId, exec.agent?.session.header.cwd)
      let command = args.command
      const commandEnv = normalizeBashEnv(args.env)

      // cd extraction: `cd src && pwd` becomes workdir="src", command="pwd".
      let workdir = args.workdir
      if (workdir === undefined) {
        const match = CD_PREFIX_PATTERN.exec(command)
        if (match !== null && !/[$`(]/.test(match[1]!)) {
          workdir = match[1]!.trim().replace(/^['"]|['"]$/g, '')
          command = command.slice(match[0].length)
        }
      }
      const commandCwd = workdir === undefined
        ? state.cwd
        : (path.isAbsolute(workdir) ? workdir : path.resolve(state.cwd, workdir))

      // Command interception: block cat/grep/find/sed -i style commands whose
      // dedicated dsh tool is visible, and suggest it instead.
      if (cfg.interceptorEnabled) {
        const availableTools = [...new Set(DEFAULT_BASH_INTERCEPTOR_RULES.map(rule => rule.tool))]
          .filter(tool => ctx.tools.get(tool, exec.agent) !== undefined)
        const interception = checkBashInterception(command, availableTools)
        if (interception.block) {
          throw new Error(interception.message)
        }
      }

      // Timeout clamping: [1s, maxTimeoutMs]; 0 disables the deadline.
      const rawTimeoutMs = args.timeoutMs ?? cfg.defaultTimeoutMs
      const timeoutDisabled = rawTimeoutMs === 0
      const timeoutMs = timeoutDisabled
        ? undefined
        : Math.min(Math.max(1_000, rawTimeoutMs), cfg.maxTimeoutMs)

      // Per-call environment: harness facts + user env (user wins).
      const dshEnv = ctx.shellEnv.collect(exec)
      const env = { ...dshEnv, ...commandEnv }

      const jobs = ctx.get('jobs')
      const backgroundRequested = args.run_in_background === true
      if (backgroundRequested) {
        if (!cfg.enableRunInBackground) {
          throw new Error('run_in_background is disabled for this deployment (enableRunInBackground: false)')
        }
        if (jobs === undefined) {
          throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        }
        if (exec.signal.aborted) throw abortError()
        let managed: ReturnType<typeof startBashJob>
        const id = jobs.start({
          kind: 'bash',
          label: command,
          ...exec.agent !== undefined ? { owner: exec.agent } : {},
          run: () => {
            managed = startBashJob({ sessionId, command, cwd: commandCwd, timeoutMs, env, config: cfg })
            return managed.hooks
          },
        })
        return { kind: 'background', jobId: id } satisfies BashBackgroundOutput
      }

      // Auto-backgrounding: start the job immediately (its own shell), wait up
      // to the threshold; finish inside the window → foreground result with the
      // job marked reported (suppresses the completion notice), else hand back
      // the job id and let the notice arrive later.
      if (cfg.autoBackgroundMs > 0 && jobs !== undefined && !exec.signal.aborted) {
        const autoBgWaitMs = timeoutMs === undefined
          ? cfg.autoBackgroundMs
          : Math.max(0, Math.min(cfg.autoBackgroundMs, timeoutMs - 1_000))
        let managed: ReturnType<typeof startBashJob>
        let id: JobId
        try {
          id = jobs.start({
            kind: 'bash',
            label: command,
            ...exec.agent !== undefined ? { owner: exec.agent } : {},
            run: () => {
              managed = startBashJob({ sessionId, command, cwd: commandCwd, timeoutMs, env, config: cfg })
              return managed.hooks
            },
          })
        } catch {
          // No attached job controller: fall back to a plain foreground run.
          const startedAt = performance.now()
          const result = await executeBash(command, {
            cwd: commandCwd,
            timeout: timeoutMs,
            sessionKey: sessionId,
            env,
            signal: exec.signal,
            minimizerSettings: {
              enabled: cfg.minimizer.enabled,
              settingsPath: undefined,
              only: cfg.minimizer.only,
              except: cfg.minimizer.except,
              maxCaptureBytes: cfg.minimizer.maxCaptureBytes,
              sourceOutlineLevel: 'default',
              legacyFilters: undefined,
            },
            minimizerEnabled: cfg.minimizer.enabled,
            spillThreshold: cfg.outputSinkTailBytes,
            headBytes: cfg.outputSinkHeadBytes,
            useShellCommandWrapper: cfg.useShellCommandWrapper,
            snapshotEnabled: cfg.snapshotEnabled,
            nonInteractiveEnv: cfg.nonInteractiveEnv,
          })
          if (result.cancelled && exec.signal.aborted) throw abortError()
          if (result.workingDir !== undefined) state.cwd = result.workingDir
          return buildForeground(result, performance.now() - startedAt, timeoutMs, undefined)
        }
        const completion = managed!.completion
        const window = await Promise.race([
          completion.then(value => ({ kind: 'completed' as const, value })),
          new Promise<{ kind: 'window' }>(resolve => {
            const timer = setTimeout(() => resolve({ kind: 'window' }), autoBgWaitMs)
            timer.unref?.()
          }),
          new Promise<{ kind: 'aborted' }>((_, reject) => {
            if (exec.signal.aborted) {
              reject(abortError())
              return
            }
            exec.signal.addEventListener('abort', () => reject(abortError()), { once: true })
          }),
        ])
        if (window.kind === 'window') {
          return { kind: 'background', jobId: id } satisfies BashBackgroundOutput
        }
        if (window.kind === 'aborted') {
          jobs.kill(id, exec.agent, 'tool call aborted')
          throw abortError()
        }
        // Completed inside the window: mark reported so the completion notice
        // is suppressed, then return the result as a foreground outcome.
        jobs.read(id, exec.agent)
        if (window.value.workingDir !== undefined) state.cwd = window.value.workingDir
        return window.value
      }

      // Plain foreground run on the persistent session shell.
      const fullWriter = new FullOutputWriter(cfg.outputMaxBytes)
      const startedAt = performance.now()
      const result = await executeBash(command, {
        cwd: commandCwd,
        timeout: timeoutMs,
        sessionKey: sessionId,
        env,
        signal: exec.signal,
        minimizerSettings: {
          enabled: cfg.minimizer.enabled,
          settingsPath: undefined,
          only: cfg.minimizer.only,
          except: cfg.minimizer.except,
          maxCaptureBytes: cfg.minimizer.maxCaptureBytes,
          sourceOutlineLevel: 'default',
          legacyFilters: undefined,
        },
        minimizerEnabled: cfg.minimizer.enabled,
        spillThreshold: cfg.outputSinkTailBytes,
        headBytes: cfg.outputSinkHeadBytes,
        useShellCommandWrapper: cfg.useShellCommandWrapper,
        snapshotEnabled: cfg.snapshotEnabled,
        nonInteractiveEnv: cfg.nonInteractiveEnv,
        onChunk: (chunk) => {
          fullWriter.append(chunk)
        },
      })
      const wallTimeMs = performance.now() - startedAt
      if (result.cancelled && exec.signal.aborted) {
        throw abortError()
      }
      if (result.workingDir !== undefined) state.cwd = result.workingDir
      const spillPath = result.truncated ? await fullWriter.close() : undefined
      return buildForeground(result, wallTimeMs, timeoutMs, spillPath)
    },
    presentCall: presentBashCall,
    presentResult: presentBashResult,
  }))
}
