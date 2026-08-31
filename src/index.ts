/*
 * Ported from oh-my-pi (https://github.com/can1357/oh-my-pi) — MIT.
 *   Copyright (c) 2025 Mario Zechner
 *   Copyright (c) 2025-2026 Can Bölük
 */
/**
 * The Oh My Pi tool suite for deepseek-harness: bash + read + write + edit + grep + glob.
 */
import * as path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, TerminalCallView, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { DSH_ENV_PREFIX } from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { checkBashInterception, DEFAULT_BASH_INTERCEPTOR_RULES } from './tools/bash/bash-interceptor.ts'
import { closeSessionShells, executeBash } from './tools/bash/bash-executor.ts'
import { allocateSpillFile, sweepStaleSpillFiles } from './tools/bash/adapter/spill.ts'
import { startBashJob, type ManagedBashJob } from './tools/bash/background.ts'
import { expandTilde, extractCdWorkdir } from './tools/bash/cd-workdir.ts'
import { setRuntimeLogger } from './tools/bash/logger.ts'
import { parseExitStatus, renderBashResult } from './tools/bash/render.ts'
import { installBashPlusSettings, resolveConfig, type Config, type RuntimeConfig } from './config/settings.ts'
import { installBrowserProbeRpc } from './host/browser-probe-rpc.ts'
import { installBunShim } from './tools/shared/bun-shim.ts'
import { applyConfiguredTruncation } from './config/truncate.ts'
import { cleanupSnapshots } from './tools/bash/shell-snapshot.ts'
import type { BashBackgroundOutput, BashForegroundOutput, BashToolArgs } from './tools/bash/types.ts'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import { registerRead } from './tools/read/adapter/index.ts'
import { registerWrite } from './tools/write/adapter/index.ts'
import { registerEdit } from './tools/edit/adapter/index.ts'
import { registerGrep } from './tools/grep/adapter/index.ts'
import { registerGlob } from './tools/glob/adapter/index.ts'
import { registerAstEdit } from './tools/ast-edit/adapter/index.ts'
import { registerAstGrep } from './tools/ast-grep/adapter/index.ts'

export const name = 'tool-plus'
export const inject = ['tools', 'systemPrompt', 'shellEnv', 'fs']

export { Config } from './config/settings.ts'

const BASH_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const ANONYMOUS_SESSION = 'anonymous'

function abortError(): HarnessError {
  const error = new HarnessError('tool call aborted', TOOL_ABORTED)
  error.name = 'AbortError'
  return error
}

interface SessionState { cwd: string }
const sessionStates = new Map<string, SessionState>()
function sessionStateFor(sessionId: string, headerCwd: string | undefined): SessionState {
  let state = sessionStates.get(sessionId)
  if (state === undefined) { state = { cwd: headerCwd ?? process.cwd() }; sessionStates.set(sessionId, state) }
  return state
}
function validateBashArgs(args: BashToolArgs): void {
  if (args.command.trim().length === 0) throw new Error('invalid command: expected a non-empty string')
  if (args.description.trim().length === 0) throw new Error('invalid description: expected a non-empty string')
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 0)) throw new Error(`invalid timeoutMs: expected a non-negative number, got ${JSON.stringify(args.timeoutMs)}`)
}
function normalizeBashEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (env === undefined || Object.keys(env).length === 0) return undefined
  for (const key of Object.keys(env)) if (!BASH_ENV_NAME_PATTERN.test(key)) throw new Error(`Invalid bash env name: ${key}`)
  return env
}
function buildForeground(result: Awaited<ReturnType<typeof executeBash>>, wallTimeMs: number, timeoutMs: number | undefined): BashForegroundOutput {
  return {
    kind: 'foreground', exitCode: result.exitCode ?? null, timedOut: result.timedOut ?? false, aborted: false, timeoutMs: timeoutMs ?? null, wallTimeMs,
    ...result.workingDir !== undefined ? { workingDir: result.workingDir } : {},
    ...result.minimized !== undefined ? { minimized: result.minimized } : {},
    ...result.rmSafeInjectionFailed === true ? { rmSafeInjectionFailed: true } : {},
    output: {
      text: result.output,
      truncated: result.truncated,
      ...result.spillPath !== undefined ? { spillPath: result.spillPath } : {},
      ...result.originalOutputPath !== undefined ? { originalSpillPath: result.originalOutputPath } : {},
      totalLines: result.totalLines,
      totalBytes: result.totalBytes,
      outputLines: result.outputLines,
      outputBytes: result.outputBytes,
      ...result.elidedLines !== undefined ? { elidedLines: result.elidedLines } : {},
      ...result.elidedBytes !== undefined ? { elidedBytes: result.elidedBytes } : {},
    },
  }
}
function presentBashCall(args: BashToolArgs): GenericCallView | TerminalCallView {
  if (args.run_in_background === true) return { card: 'generic', title: args.command, kind: 'execute', rawInput: args.command, content: [{ type: 'text', text: args.description }] }
  return { card: 'terminal', title: args.command, description: args.description, ...args.workdir !== undefined ? { cwd: args.workdir } : {} }
}
function presentBashResult(args: unknown, result: ToolResult): ToolResultView | undefined {
  const block = result.content.length === 1 ? result.content[0] : undefined
  if (block === undefined || block.type !== 'text') return undefined
  const raw = block.text
  const isBackground = typeof args === 'object' && args !== null && (args as { run_in_background?: unknown }).run_in_background === true
  if (isBackground || result.isError || raw.startsWith('Backgrounded as job')) return { card: 'generic', content: [{ type: 'text', text: `\`\`\`console\n${raw.replace(/\n+$/, '')}\n\`\`\`` }] }
  const { body, ...exit } = parseExitStatus(raw)
  return { card: 'terminal', output: body, ...exit }
}

export function apply(ctx: Context, config: Config = {}): void {
  // OMP tool code (adapter/omp) is Bun-origin; provide the Bun global on Node
  // before any tool executes (step.md "Bun 兼容").
  installBunShim()
  let cfg: RuntimeConfig = resolveConfig(config)
  setRuntimeLogger(ctx.logger)
  // Best-effort sweep of orphaned spill files (>24h old) left by earlier runs,
  // including the legacy flat tmpdir naming.
  sweepStaleSpillFiles()
  // A-3：auto-generated guard 走 settings-pull（edit.blockAutoGenerated，经
  // omp-settings 映射到本配置，调用方逐次传 session.settings），无需推送开关。

  // editMode 敏感工具（read 的 IS_HL_MODE 描述、edit 按模式选描述）+ AST 工具
  // 启用开关（astGrepEnabled/astEditEnabled）：DSH 注册表同名重复注册会抛错
  // （NamedEntries），故先 dispose 旧注册再重注册（配置热更新，开关变化即时生效）。
  let disposeModeSensitive: Array<() => void> = []
  const registerModeSensitive = (): void => {
    for (const dispose of disposeModeSensitive) dispose()
    const registrations: Array<() => void> = [registerRead(ctx, () => cfg), registerEdit(ctx, () => cfg)]
    // OMP isToolActive 语义：ast_grep 默认禁用（astGrep.enabled=false），
    // ast_edit 默认启用（astEdit.enabled=true）；glob/grep 无条件注册。
    if (cfg.astGrepEnabled) registrations.push(registerAstGrep(ctx, () => cfg))
    if (cfg.astEditEnabled) registrations.push(registerAstEdit(ctx, () => cfg))
    disposeModeSensitive = registrations
  }
  registerModeSensitive()
  installBashPlusSettings(ctx, config, (current) => {
    cfg = current()
    registerModeSensitive()
  })

  // Tool-plus RPC (`/tool-plus` channel: `browser/detect` + `rmSafe/status`)
  // served to the settings panel; teardown on plugin dispose. Best-effort:
  // without a Connection service (CLI-only deployments) this is a no-op.
  const disposeBrowserProbe = installBrowserProbeRpc(ctx, { getRmSafe: () => cfg.rmSafe })

  ctx.systemPrompt.section({
    name: 'tool:bash',
    order: 105,
    text: 'The bash tool runs in a persistent shell session: `cd`, `export`, and other state changes carry over between calls. '
      + 'Long-running commands are moved to the background automatically (the call returns a job id; the result is delivered '
      + 'automatically when it finishes — do not poll for it). '
      + 'Check the [exit code: N] marker on every bash result; investigate failures before moving on.',
  })

  ctx.effect(() => () => { closeSessionShells(''); cleanupSnapshots(); sessionStates.clear(); disposeBrowserProbe() }, 'bash-plus teardown')
  ctx.on('agent/disposed', ({ agent }) => { closeSessionShells(agent.session.id); sessionStates.delete(agent.session.id) })

  ctx.tools.register(defineTool({
    name: 'bash',
    description: 'Execute a bash command in a persistent shell session and return its output. '
      + '`cd`, `export`, and other state changes carry over between calls; pass `workdir` to run elsewhere. '
      + 'Non-zero exits are reported as `[exit code: N]`. Long output is minimized and/or truncated to head+tail; '
      + 'whenever anything is dropped, the full raw stream is saved to a log file whose path is printed with the result — '
      + 're-read elided ranges with the read tool using :N-M selectors on that path. '
      + 'Set `run_in_background: true` for long-running commands: the call returns a job id immediately; '
      + 'the result is delivered automatically when it finishes — do not poll for it. '
      + 'Commands exceeding the auto-background threshold are moved to the background automatically. '
      + `Current harness environment facts are exposed through managed \`$${DSH_ENV_PREFIX}*\` variables; inspect them when needed.`,
    parameters: {
      command: { type: 'string', required: true, description: 'The bash command to execute.' },
      description: { type: 'string', required: true, description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; "git status" → "Show working tree status"; "npm install" → "Install package dependencies".' },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds; 0 disables the command deadline; nonzero values are clamped to the configured range.' },
      workdir: { type: 'string', description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against the session cwd.' },
      env: { type: 'object', additionalProperties: true, description: 'Extra environment variables for this command only (not persisted in the session).' },
      ...cfg.enableRunInBackground ? { run_in_background: { type: 'boolean' as const, description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.' } } : {},
    },
    output: {
      schema: {
        oneOf: [
          { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'background' }, jobId: { type: 'string', required: true } } },
          { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'foreground' }, exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] }, timedOut: { type: 'boolean', required: true }, aborted: { type: 'boolean', required: true }, timeoutMs: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] }, wallTimeMs: { type: 'number', required: true }, workingDir: { type: 'string' }, minimized: { type: 'object', additionalProperties: false, properties: { filter: { type: 'string', required: true }, inputBytes: { type: 'number', required: true }, outputBytes: { type: 'number', required: true } } }, output: { type: 'object', additionalProperties: false, required: true, properties: { text: { type: 'string', required: true }, truncated: { type: 'boolean', required: true }, spillPath: { type: 'string' }, originalSpillPath: { type: 'string' }, totalLines: { type: 'number' }, totalBytes: { type: 'number' }, outputLines: { type: 'number' }, outputBytes: { type: 'number' }, elidedLines: { type: 'number' }, elidedBytes: { type: 'number' } } } } },
        ],
      },
      render: (_args, value) => [{ type: 'text', text: value.kind === 'background' ? `Backgrounded as job ${value.jobId}; result will be delivered automatically when it finishes. Continue with other work — do not poll for it.` : renderBashResult(value) }],
    },
    async execute(args: BashToolArgs, exec) {
      validateBashArgs(args)
      const sessionId = exec.agent?.session.id ?? ANONYMOUS_SESSION
      const state = sessionStateFor(sessionId, exec.agent?.session.header.cwd)
      let command = args.command
      const commandEnv = normalizeBashEnv(args.env)
      let workdir = args.workdir
      if (workdir === undefined) {
        const cd = extractCdWorkdir(command)
        if (cd !== null) { workdir = cd.workdir; command = cd.command }
      }
      const commandCwd = workdir === undefined ? state.cwd : path.resolve(state.cwd, expandTilde(workdir))
      if (cfg.interceptorEnabled) {
        const availableTools = [...new Set(DEFAULT_BASH_INTERCEPTOR_RULES.map(rule => rule.tool))].filter(tool => ctx.tools.get(tool, exec.agent) !== undefined)
        const interception = checkBashInterception(command, availableTools)
        if (interception.block) throw new Error(interception.message)
      }
      const rawTimeoutMs = args.timeoutMs ?? cfg.defaultTimeoutMs
      const timeoutDisabled = rawTimeoutMs === 0
      // `timeoutMs: 0` passes through as a real disable (the executor skips
      // both its watchdog and the native timeoutMs); explicit values are
      // capped before the 1s floor so a maxTimeoutMs below 1s cannot produce
      // a sub-floor deadline.
      const timeoutMs = timeoutDisabled ? 0 : Math.max(1_000, Math.min(rawTimeoutMs, cfg.maxTimeoutMs))
      const dshEnv = ctx.shellEnv.collect(exec)
      const env = { ...dshEnv, ...commandEnv }
      const jobs = ctx.get('jobs')
      const backgroundSlotsAvailable = (): boolean => {
        if (jobs === undefined || cfg.maxBackgroundJobs <= 0) return true
        const live = jobs.list(exec.agent).filter(j => j.status === 'running' || j.status === 'stopping').length
        return live < cfg.maxBackgroundJobs
      }
      const startManagedJob = (): ManagedBashJob => {
        // Background jobs: unset timeout = no deadline (upstream bash.ts
        // `timeout: options.timeoutMs ?? 0`), not the foreground default.
        const managed = startBashJob({ sessionId, command, cwd: commandCwd, timeoutMs: args.timeoutMs ?? 0, env, config: cfg })
        let settled = false
        let settledSpillPath: string | undefined
        void managed.completion.then(
          (value) => { settled = true; settledSpillPath = value.output.spillPath },
          () => { settled = true; settledSpillPath = undefined },
        )
        return {
          hooks: {
            ...managed.hooks,
            readOutput: () => {
              const text = managed.hooks.readOutput?.() ?? ''
              // The settled completion text is the bounded preview tail; point
              // its truncation notice at the job's spill file so the elided
              // middle stays recoverable.
              return settled ? applyConfiguredTruncation(text, settledSpillPath, cfg.outputTruncate) : text
            },
          },
          completion: managed.completion,
        }
      }
      const backgroundRequested = args.run_in_background === true
      if (backgroundRequested) {
        if (!cfg.enableRunInBackground) throw new Error('run_in_background is disabled for this deployment (enableRunInBackground: false)')
        if (jobs === undefined) throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        if (!backgroundSlotsAvailable()) throw new Error(`background jobs at capacity (maxBackgroundJobs: ${cfg.maxBackgroundJobs})`)
        if (exec.signal.aborted) throw abortError()
        let managed: ManagedBashJob
        const id = jobs.start({ kind: 'bash', label: command, ...exec.agent !== undefined ? { owner: exec.agent } : {}, run: () => { managed = startManagedJob(); return managed.hooks } })
        return { kind: 'background', jobId: id } satisfies BashBackgroundOutput
      }
      if (cfg.autoBackgroundMs > 0 && jobs !== undefined && backgroundSlotsAvailable() && !exec.signal.aborted) {
        // timeoutMs 0 (deadline disabled) waits like the no-deadline case:
        // the full autoBackgroundMs window, not an instant hand-off.
        const autoBgWaitMs = timeoutMs === 0 ? cfg.autoBackgroundMs : Math.max(0, Math.min(cfg.autoBackgroundMs, timeoutMs - 1_000))
        let managed: ManagedBashJob
        let id: JobId
        try {
          id = jobs.start({ kind: 'bash', label: command, ...exec.agent !== undefined ? { owner: exec.agent } : {}, run: () => { managed = startManagedJob(); return managed.hooks } })
        } catch {
          const startedAt = performance.now()
          const result = await executeBash(command, { cwd: commandCwd, timeout: timeoutMs, sessionKey: sessionId, env, signal: exec.signal, minimizerSettings: { enabled: cfg.minimizer.enabled, settingsPath: undefined, only: cfg.minimizer.only, except: cfg.minimizer.except, maxCaptureBytes: cfg.minimizer.maxCaptureBytes, sourceOutlineLevel: 'default', legacyFilters: undefined }, minimizerEnabled: cfg.minimizer.enabled, spillThreshold: cfg.outputSinkTailBytes, headBytes: cfg.outputSinkHeadBytes, useShellCommandWrapper: cfg.useShellCommandWrapper, snapshotEnabled: cfg.snapshotEnabled, rmSafe: cfg.rmSafe, nonInteractiveEnv: cfg.nonInteractiveEnv, artifactPath: allocateSpillFile() })
          if (result.cancelled && exec.signal.aborted) throw abortError()
          if (result.workingDir !== undefined) state.cwd = result.workingDir
          return buildForeground(result, performance.now() - startedAt, timeoutMs)
        }
        const completion = managed!.completion
        const window = await Promise.race([
          completion.then(value => ({ kind: 'completed' as const, value })),
          new Promise<{ kind: 'window' }>(resolve => { const timer = setTimeout(() => resolve({ kind: 'window' }), autoBgWaitMs); timer.unref?.() }),
          new Promise<{ kind: 'aborted' }>((_, reject) => { if (exec.signal.aborted) { reject(abortError()); return } exec.signal.addEventListener('abort', () => reject(abortError()), { once: true }) }),
        ])
        if (window.kind === 'window') return { kind: 'background', jobId: id } satisfies BashBackgroundOutput
        if (window.kind === 'aborted') { jobs.kill(id, exec.agent, 'tool call aborted'); throw abortError() }
        jobs.read(id, exec.agent)
        if (window.value.workingDir !== undefined) state.cwd = window.value.workingDir
        return window.value
      }
      const startedAt = performance.now()
      const result = await executeBash(command, { cwd: commandCwd, timeout: timeoutMs, sessionKey: sessionId, env, signal: exec.signal, minimizerSettings: { enabled: cfg.minimizer.enabled, settingsPath: undefined, only: cfg.minimizer.only, except: cfg.minimizer.except, maxCaptureBytes: cfg.minimizer.maxCaptureBytes, sourceOutlineLevel: 'default', legacyFilters: undefined }, minimizerEnabled: cfg.minimizer.enabled, spillThreshold: cfg.outputSinkTailBytes, headBytes: cfg.outputSinkHeadBytes, useShellCommandWrapper: cfg.useShellCommandWrapper, snapshotEnabled: cfg.snapshotEnabled, rmSafe: cfg.rmSafe, nonInteractiveEnv: cfg.nonInteractiveEnv, artifactPath: allocateSpillFile() })
      const wallTimeMs = performance.now() - startedAt
      if (result.cancelled && exec.signal.aborted) throw abortError()
      if (result.workingDir !== undefined) state.cwd = result.workingDir
      return buildForeground(result, wallTimeMs, timeoutMs)
    },
    presentCall: presentBashCall,
    presentResult: presentBashResult,
  }))

  // file tools — now that fs is a hard inject, these always have ctx.fs
  // （read/edit/ast_grep/ast_edit 已由 registerModeSensitive 注册，支持 editMode
  // 与 AST 启用开关热更新重注册；ast_grep/ast_edit 按开关条件注册）
  registerWrite(ctx, () => cfg)
  registerGrep(ctx, () => cfg)
  registerGlob(ctx, () => cfg)

  ctx.systemPrompt.section({
    name: 'tool:read',
    order: 100,
    text: 'Use the read tool — not shell cat/head/tail — to inspect files. `path` accepts an inline selector: :N (single line), :N-M (range), :N+K (K lines from N), :N- (to EOF), comma multi-range, :raw (verbatim). Archive members use "archive.zip:inner/path".',
  })
  ctx.systemPrompt.section({
    name: 'tool:write',
    order: 101,
    text: 'Use the write tool to create or overwrite files. Parent directories are created. Shebang files auto chmod +x. Hashline patches ([PATH#HASH] headers) and conflict:// URIs are handled.',
  })
  ctx.systemPrompt.section({
    name: 'tool:edit',
    order: 102,
    text: 'Use the edit tool — not shell sed — for literal replacements. `old_string` must appear exactly once by default; use `replace_all:true` for multiple occurrences. Multi-segment `edits[]` and unified `patch` are supported. Fuzzy matching helps with whitespace differences.',
  })
  ctx.systemPrompt.section({
    name: 'tool:grep',
    order: 104,
    text: 'Use the grep tool — not shell grep/rg — to search file contents. Returns path\\nLine N: text grouped output. Use `glob` for file discovery.',
  })
  ctx.systemPrompt.section({
    name: 'tool:glob',
    order: 103,
    text: 'Use the glob tool — not shell find/fd — to find files by pattern. Pattern with no "/" matches basenames at any depth. Results are files only, mtime-sorted.',
  })
}
