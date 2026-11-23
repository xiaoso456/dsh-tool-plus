/*
 * Ported from oh-my-pi (https://github.com/can1357/oh-my-pi) — MIT.
 *   Copyright (c) 2025 Mario Zechner
 *   Copyright (c) 2025-2026 Can Bölük
 */
/**
 * The Oh My Pi tool suite for deepseek-harness: bash + read + write + edit + grep + glob.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, TerminalCallView, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { checkBashInterception, DEFAULT_BASH_INTERCEPTOR_RULES } from './tools/bash/bash-interceptor.ts'
import { closeSessionShells, executeBash } from './tools/bash/bash-executor.ts'
import { allocateSpillFile, saveOriginalText, sweepStaleSpillFiles } from './tools/bash/adapter/spill.ts'
import { sweepStaleArtifacts } from './tools/shared/artifacts.ts'
import { closeSessionWarmShells, startBashJob, type ManagedBashJob } from './tools/bash/background.ts'
import { extractCdWorkdir } from './tools/bash/cd-workdir.ts'
import { runtimeLogger, setRuntimeLogger } from './tools/bash/logger.ts'
import { resolveToCwd } from './tools/omp/tools/path-utils.ts'
import { parseExitStatus, renderBashResult } from './tools/bash/render.ts'
import { timeoutDetails } from './tools/bash/timeout-meta.ts'
import { installBashPlusSettings, resolveConfig, type Config, type RuntimeConfig } from './config/settings.ts'
import { defaultInitScriptPath } from './tools/bash/init-script.ts'
import { bashSystemPromptText, bashToolDescription } from './tools/bash/description.ts'
import { TOOL_SECTION_ORDERS } from './tool-section-orders.ts'
import { installBrowserProbeRpc } from './host/browser-probe-rpc.ts'
import { readNativeStatus } from './tools/shared/native-status.ts'
import { normalizeWindowsUnixTmpPath } from './tools/shared/windows-tmp-path.ts'
import { ensureInheritableHiddenConsole } from './host/win32-console.ts'
import { applyPresetAction, comparePresetAgainstTemplate, listPresetStatuses } from './host/preset-host.ts'
import { bashCardMeta } from './web/host/bash.ts'
import { installBunShim } from './tools/shared/bun-shim.ts'
import { applyConfiguredTruncation } from './config/truncate.ts'
import { cleanupSnapshots } from './tools/bash/shell-snapshot.ts'
import type { BashBackgroundOutput, BashForegroundOutput, BashToolArgs } from './tools/bash/types.ts'
import type { JobHandle, JobHooks, JobId, JobSpec } from '@deepseek-ai/dsh-jobs'
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
  if (args.description !== undefined && typeof args.description !== 'string') throw new Error('invalid description: expected a string when provided')
  if (args.timeout !== undefined && (!Number.isFinite(args.timeout) || args.timeout < 0)) throw new Error(`invalid timeout: expected a non-negative number of seconds, got ${JSON.stringify(args.timeout)}`)
}

/** Trim a provided description; absent or blank both mean “no description”. */
function optionalDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}
function normalizeBashEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (env === undefined || Object.keys(env).length === 0) return undefined
  for (const key of Object.keys(env)) if (!BASH_ENV_NAME_PATTERN.test(key)) throw new Error(`Invalid bash env name: ${key}`)
  return env
}
function buildForeground(result: Awaited<ReturnType<typeof executeBash>>, wallTimeMs: number, timeoutMs: number | undefined, requestedTimeoutMs?: number): BashForegroundOutput {
  return {
    kind: 'foreground', exitCode: result.exitCode ?? null, timedOut: result.timedOut ?? false, aborted: false, ...timeoutDetails(timeoutMs, requestedTimeoutMs), wallTimeMs,
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
  const description = optionalDescription(args.description)
  if (args.async === true) return { card: 'generic', title: args.command, kind: 'execute', rawInput: args.command, content: [{ type: 'text', text: description ?? '' }] }
  return { card: 'terminal', title: args.command, ...description !== undefined ? { description } : {}, ...args.workdir !== undefined ? { cwd: args.workdir } : {} }
}
function presentBashResult(args: unknown, result: ToolResult): ToolResultView | undefined {
  const block = result.content.length === 1 ? result.content[0] : undefined
  if (block === undefined || block.type !== 'text') return undefined
  const raw = block.text
  const isBackground = typeof args === 'object' && args !== null && (args as { async?: unknown }).async === true
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
  // Windows：宿主是没有控制台的 GUI 镜像，它的每个 console 子进程（上游 pi-shell
  // 的 `where git` 探测、快照 bash、任何插件 spawn 的 CLI）都要新建一个控制台窗口
  // → 每条命令闪一次。先给宿主自己拿一个不可见控制台，子进程就只是继承它。
  // Win32 那半在 addon 里（`hideHostConsole`，见 src/host/win32-console.ts）；
  // 没装我们的平台包或调用失败都只降级，不影响插件——但降级意味着每条命令又
  // 会闪一次窗口，所以降级走 warn：`hideHostConsole` 曾经因为加载到旧 addon
  // 而整体失效，只记 debug 的话症状（闪窗）和原因（少了导出）在日志里对不上。
  const hostConsole = ensureInheritableHiddenConsole()
  if (hostConsole === 'native-unavailable' || hostConsole === 'alloc-failed') {
    runtimeLogger().warn('host console', { outcome: hostConsole })
  } else {
    runtimeLogger().debug('host console', { outcome: hostConsole })
  }
  // Best-effort sweep of orphaned spill files (>24h old) left by earlier runs,
  // including the legacy flat tmpdir naming.
  sweepStaleSpillFiles()
  // Same sweep for the artifacts dir (grep over URL materializes fetched pages there).
  sweepStaleArtifacts()
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
  /** bash 那一组注册在下面才建立；设置回调会同步跑一次，先置 false 避开 TDZ。 */
  let bashSurfaceReady = false
  installBashPlusSettings(ctx, config, (current) => {
    cfg = current()
    registerModeSensitive()
    // bash 那一组在下面才定义；installBashPlusSettings 会同步回调一次，故用标志避开 TDZ。
    if (bashSurfaceReady) registerBashSurface()
  })

  // Tool-plus RPC (`/tool-plus` route: `browser/detect`, `rmSafe/status`,
  // `presets/status`, `presets/apply`, `presets/compare`) served to the settings
  // panel; teardown on plugin dispose. Best-effort: without a web server
  // (CLI-only deployments) this is a no-op. One route takes one handler, so
  // every endpoint family rides this single registration.
  //
  // The preset endpoints never touch the filesystem themselves: the write path
  // is the harness's own `ctx.configEditor`, which owns the profile lock, the
  // atomic write, the rollback and the precedence check.
  // One line per start: which native addon this install runs. Silence here is
  // what made "zip: command not found" look like a bug in the tool rather than
  // a missing platform package; the settings panel shows the same state.
  {
    const nativeStatus = readNativeStatus()
    if (nativeStatus.status === 'active') {
      runtimeLogger().info(`native addon: ${nativeStatus.packageName}@${nativeStatus.version} (${nativeStatus.loadedPath})`)
    } else {
      // `loadedPath` is the only evidence for `foreign-addon`: the package side
      // looks healthy there, so name the file that actually ran.
      const loaded = nativeStatus.loadedPath === undefined ? '' : `, loaded ${nativeStatus.loadedPath}`
      runtimeLogger().warn(
        `native addon: not our build (${nativeStatus.reason}${loaded}); zip/tree/uuidgen/strings/hexdump/rev/free/bc are unavailable`,
      )
    }
  }

  const disposeBrowserProbe = installBrowserProbeRpc(ctx, {
    getRmSafe: () => cfg.rmSafe,
    bashInit: {
      getEnabled: () => cfg.bashInitEnabled,
    },
    presets: {
      listPresets: (presetCtx) => listPresetStatuses(presetCtx),
      applyAction: (presetCtx, id, action, templateId) => applyPresetAction(presetCtx, id, action, templateId),
      comparePreset: (presetCtx, presetId, templateId) => comparePresetAgainstTemplate(presetCtx, presetId, templateId),
    },
  })

  /**
   * bash 的提示词段落与工具描述随配置分支（见 tools/bash/description.ts）：自动后台开着时
   * 每条命令都是新 Shell，只能承诺工作目录跟随 `cd`；关掉后才是真持久。配置热更新要换文案，
   * 但 DSH 注册表对同名条目会抛错，所以每次先撤旧注册再注册。
   */
  let disposeBashSurface: Array<() => void> = []
  const registerBashSurface = (): void => {
    for (const dispose of disposeBashSurface) dispose()
    disposeBashSurface = [
      ctx.systemPrompt.section({
        name: 'tool:bash',
        order: TOOL_SECTION_ORDERS.bash,
        text: bashSystemPromptText(cfg),
      }),
    ]
    disposeBashSurface.push(ctx.tools.register(defineTool({
    name: 'bash',
    description: bashToolDescription(cfg),
    parameters: {
      command: { type: 'string', required: true, description: 'The bash command to execute.' },
      description: { type: 'string', description: 'Optional one-line description of what this command does in active voice, 5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; "git status" → "Show working tree status"; "npm install" → "Install package dependencies".' },
      timeout: { type: 'number', description: 'Timeout in seconds; 0 disables the command deadline; nonzero values are clamped to the configured range.' },
      workdir: { type: 'string', description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against the session cwd.' },
      env: { type: 'object', additionalProperties: true, description: 'Extra environment variables for this command only (not persisted in the session).' },
      ...cfg.enableRunInBackground ? { async: { type: 'boolean' as const, description: 'Run the command as a background job and return its job id immediately (collect with job_output, stop with job_kill). The timeout still applies; pass timeout: 0 for watchers and long-running jobs.' } } : {},
    },
    output: {
      schema: {
        oneOf: [
          { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'background' }, jobId: { type: 'string', required: true } } },
          { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'foreground' }, exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] }, timedOut: { type: 'boolean', required: true }, aborted: { type: 'boolean', required: true }, timeoutSeconds: { type: 'number' }, requestedTimeoutSeconds: { type: 'number' }, timeoutDisabled: { type: 'boolean' }, wallTimeMs: { type: 'number', required: true }, workingDir: { type: 'string' }, minimized: { type: 'object', additionalProperties: false, properties: { filter: { type: 'string', required: true }, inputBytes: { type: 'number', required: true }, outputBytes: { type: 'number', required: true } } }, output: { type: 'object', additionalProperties: false, required: true, properties: { text: { type: 'string', required: true }, truncated: { type: 'boolean', required: true }, spillPath: { type: 'string' }, originalSpillPath: { type: 'string' }, totalLines: { type: 'number' }, totalBytes: { type: 'number' }, outputLines: { type: 'number' }, outputBytes: { type: 'number' }, elidedLines: { type: 'number' }, elidedBytes: { type: 'number' } } } } },
        ],
      },
      render: (_args, value) => [{ type: 'text', text: value.kind === 'background' ? `Backgrounded as job ${value.jobId}; result will be delivered automatically when it finishes. Continue with other work — do not poll for it.` : renderBashResult(value) }],
      // Card metadata for the plugin's own terminal row: the value already
      // carries the run state, so nothing is read back or recomputed.
      presentationMeta: (_args: unknown, value: unknown) => bashCardMeta(value),
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
      // Upstream bash.ts resolves an explicit cwd through `resolveToCwd`
      // (path-utils): MSYS drive aliases (`/d/…`), stray `:` prefixes, and `~`
      // all normalize before `path.resolve`. Both branches feed the same native
      // `set cwd` at run start, so both are checked here: a stale `state.cwd`
      // (the last successful cd target, deleted or renamed) would otherwise
      // surface as the shell's cryptic "Failed to set cwd". The check also runs
      // before jobs.start, so a dead cwd never registers a doomed background
      // job. The explicit-workdir messages stay unchanged for compatibility.
      // The base cwd is normalized too: a legacy session may still carry a
      // logical `/tmp/...` from an older shell snapshot. Native paths are
      // unaffected, so this is a no-op for every normal session.
      const baseCwd = normalizeWindowsUnixTmpPath(state.cwd)
      const commandCwd = workdir === undefined ? baseCwd : resolveToCwd(workdir, baseCwd)
      const cwdLabel = workdir === undefined ? 'Session working directory' : 'Working directory'
      let cwdStat: fs.Stats
      try {
        cwdStat = await fs.promises.stat(commandCwd)
      } catch {
        if (workdir === undefined) {
          throw new Error(
            `Session working directory does not exist: ${commandCwd}. `
            + 'It may have been deleted or renamed. Pass an absolute workdir, '
            + 'or start the command with `cd "<absolute path>" && ...`.',
          )
        }
        throw new Error(`Working directory does not exist: ${commandCwd}`)
      }
      if (!cwdStat.isDirectory()) throw new Error(`${cwdLabel} is not a directory: ${commandCwd}`)
      if (cfg.interceptorEnabled) {
        const availableTools = [...new Set(DEFAULT_BASH_INTERCEPTOR_RULES.map(rule => rule.tool))].filter(tool => ctx.tools.get(tool, exec.agent) !== undefined)
        const interception = checkBashInterception(command, availableTools)
        if (interception.block) throw new Error(interception.message)
      }
      // `timeout` is seconds (OMP parity): omitted uses the configured
      // default, 0 is a real disable (the executor skips both its watchdog and
      // the native timeoutMs), and explicit values are capped before the 1s
      // floor so a maxTimeoutMs below 1s cannot produce a sub-floor deadline.
      const requestedTimeoutMs = args.timeout === undefined ? cfg.defaultTimeoutMs : Math.round(args.timeout * 1_000)
      // Only an explicit `0` (or a zero default) disables the deadline; a tiny
      // positive `timeout` floors to 1s instead of silently becoming 0.
      const timeoutDisabled = requestedTimeoutMs === 0 && (args.timeout === undefined || args.timeout === 0)
      const timeoutMs = timeoutDisabled ? 0 : Math.max(1_000, Math.min(requestedTimeoutMs, cfg.maxTimeoutMs))
      // Read the service through `ctx.get` rather than `ctx.shellEnv`: a host
      // reload retires this plugin's fiber while callers may still hold the
      // tools it registered, and property access on a retired fiber throws
      // `cannot get required service "shellEnv" in inactive context`. `get`
      // yields undefined instead, so a missing service costs the DSH_* snapshot
      // but never the command itself.
      const shellEnv = ctx.get('shellEnv')
      if (shellEnv === undefined) {
        // Losing the snapshot is not worth losing the command, but it is worth
        // a warning: the description promises managed DSH_* variables, and a
        // silent miss would look like the shell simply has empty ones.
        runtimeLogger().warn('bash: shellEnv unavailable, running without the managed DSH_* variables', { sessionId })
      }
      const dshEnv = shellEnv === undefined ? {} : shellEnv.collect(exec)
      const env = { ...dshEnv, ...commandEnv }
      const jobs = ctx.get('jobs')
      // Owned-job access is fenced by the owner's SESSION id (0.1.7): the job's
      // owner is `exec.agent.id`, and every registry read/kill/wait/list is
      // checked against that same id.
      const owner = exec.agent?.id
      const backgroundSlotsAvailable = (): boolean => {
        if (jobs === undefined || cfg.maxBackgroundJobs <= 0) return true
        const live = jobs.list(owner).filter(j => j.status === 'running' || j.status === 'stopping').length
        return live < cfg.maxBackgroundJobs
      }
      const startManagedJob = (job?: JobHandle): ManagedBashJob =>
        // Background jobs keep the same deadline as the foreground path (OMP
        // `async` semantics): omitted `timeout` means the configured default,
        // and `timeout: 0` is the only way to run without a deadline.
        startBashJob({
          sessionId,
          command,
          cwd: commandCwd,
          timeoutMs,
          requestedTimeoutMs,
          env,
          config: cfg,
          ...job !== undefined ? { job } : {},
          // The settled completion message follows the plugin's truncation
          // policy and names the job's spill file, so the elided middle stays
          // recoverable.
          formatCompletion: (text, spillPath) => applyConfiguredTruncation(text, spillPath, cfg.outputTruncate),
        })
      // One registry job spec: identity, owner, per-read bound, and the
      // producer starter. `outputLimitBytes` is the host's cap for each
      // model-facing read, so the plugin's `outputMaxBytes` tail budget bounds
      // `job_output` exactly like the foreground preview.
      const jobSpec = (run: (job: JobHandle) => JobHooks): JobSpec => ({
        kind: 'bash' as const,
        label: command,
        ...owner !== undefined ? { owner } : {},
        ...Number.isSafeInteger(cfg.outputMaxBytes) && cfg.outputMaxBytes > 0 ? { outputLimitBytes: cfg.outputMaxBytes } : {},
        run,
      })
      const backgroundRequested = args.async === true
      if (backgroundRequested) {
        if (!cfg.enableRunInBackground) throw new Error('async is disabled for this deployment (enableRunInBackground: false)')
        if (jobs === undefined) throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        if (!backgroundSlotsAvailable()) throw new Error(`background jobs at capacity (maxBackgroundJobs: ${cfg.maxBackgroundJobs})`)
        if (exec.signal.aborted) throw abortError()
        const id = jobs.start(jobSpec((job) => startManagedJob(job).hooks))
        return { kind: 'background', jobId: id } satisfies BashBackgroundOutput
      }
      if (cfg.autoBackgroundMs > 0 && jobs !== undefined && backgroundSlotsAvailable() && !exec.signal.aborted) {
        // timeoutMs 0 (deadline disabled) waits like the no-deadline case:
        // the full autoBackgroundMs window, not an instant hand-off.
        const autoBgWaitMs = Math.max(1, timeoutMs === 0 ? cfg.autoBackgroundMs : Math.min(cfg.autoBackgroundMs, timeoutMs - 1_000))
        let managed: ManagedBashJob
        let id: JobId
        try {
          id = jobs.start(jobSpec((job) => { managed = startManagedJob(job); return managed.hooks }))
        } catch {
          const startedAt = performance.now()
          const result = await executeBash(command, { cwd: commandCwd, timeout: timeoutMs, sessionKey: sessionId, env, signal: exec.signal, minimizerSettings: { enabled: cfg.minimizer.enabled, settingsPath: undefined, only: cfg.minimizer.only, except: cfg.minimizer.except, maxCaptureBytes: cfg.minimizer.maxCaptureBytes, sourceOutlineLevel: 'default', legacyFilters: undefined }, minimizerEnabled: cfg.minimizer.enabled, spillThreshold: cfg.outputSinkTailBytes, headBytes: cfg.outputSinkHeadBytes, useShellCommandWrapper: cfg.useShellCommandWrapper, snapshotEnabled: cfg.snapshotEnabled, initScriptEnabled: cfg.bashInitEnabled, initScriptPath: defaultInitScriptPath(), rmSafe: cfg.rmSafe, nonInteractiveEnv: cfg.nonInteractiveEnv, artifactPath: allocateSpillFile(), onMinimizedSave: (text) => saveOriginalText(text) })
          if (result.cancelled && exec.signal.aborted) throw abortError()
          if (result.workingDir !== undefined) state.cwd = result.workingDir
          return buildForeground(result, performance.now() - startedAt, timeoutMs, requestedTimeoutMs)
        }
        // The registry wait IS the window (0.1.7): a live wait released by the
        // settlement marks it `awaited`, so a run that finishes inside the
        // window — whose id the model never saw — produces no completion
        // notice; a timed-out wait leaves the job running and hands the id over
        // to `job_output`/`job_kill` instead.
        let settled = false
        try {
          const view = await jobs.wait(id, autoBgWaitMs, owner, exec.signal)
          settled = view.status !== 'running' && view.status !== 'stopping'
        } catch {
          // A wait on this call's own live job rejects only for the call's
          // abort: the model's call is over, so the command goes with it. The
          // second, live wait keeps the kill's settlement from notifying a
          // model that never saw the id.
          jobs.kill(id, owner, 'tool call aborted')
          await jobs.wait(id, Math.max(1_000, timeoutMs), owner)
          throw abortError()
        }
        if (!settled) return { kind: 'background', jobId: id } satisfies BashBackgroundOutput
        // Settled while this call waited: the model never saw the id, so the
        // record leaves the registry with this result and no notice follows it.
        const value = await managed!.completion
        jobs.remove(id, owner)
        if (value.workingDir !== undefined) state.cwd = value.workingDir
        return value
      }
      const startedAt = performance.now()
      const result = await executeBash(command, { cwd: commandCwd, timeout: timeoutMs, sessionKey: sessionId, env, signal: exec.signal, minimizerSettings: { enabled: cfg.minimizer.enabled, settingsPath: undefined, only: cfg.minimizer.only, except: cfg.minimizer.except, maxCaptureBytes: cfg.minimizer.maxCaptureBytes, sourceOutlineLevel: 'default', legacyFilters: undefined }, minimizerEnabled: cfg.minimizer.enabled, spillThreshold: cfg.outputSinkTailBytes, headBytes: cfg.outputSinkHeadBytes, useShellCommandWrapper: cfg.useShellCommandWrapper, snapshotEnabled: cfg.snapshotEnabled, initScriptEnabled: cfg.bashInitEnabled, initScriptPath: defaultInitScriptPath(), rmSafe: cfg.rmSafe, nonInteractiveEnv: cfg.nonInteractiveEnv, artifactPath: allocateSpillFile(), onMinimizedSave: (text) => saveOriginalText(text) })
      const wallTimeMs = performance.now() - startedAt
      if (result.cancelled && exec.signal.aborted) throw abortError()
      if (result.workingDir !== undefined) state.cwd = result.workingDir
      return buildForeground(result, wallTimeMs, timeoutMs, requestedTimeoutMs)
    },
    presentCall: presentBashCall,
    presentResult: presentBashResult,
  })))
  }
  bashSurfaceReady = true
  registerBashSurface()

  ctx.effect(() => () => { closeSessionShells(''); closeSessionWarmShells(); cleanupSnapshots(); sessionStates.clear(); disposeBrowserProbe() }, 'bash-plus teardown')
  ctx.on('agent/disposed', ({ agent }) => { closeSessionShells(agent.session.id); closeSessionWarmShells(agent.session.id); sessionStates.delete(agent.session.id) })

  // file tools — now that fs is a hard inject, these always have ctx.fs
  // （read/edit/ast_grep/ast_edit 已由 registerModeSensitive 注册，支持 editMode
  // 与 AST 启用开关热更新重注册；ast_grep/ast_edit 按开关条件注册）
  registerWrite(ctx, () => cfg)
  registerGrep(ctx, () => cfg)
  registerGlob(ctx, () => cfg)

  ctx.systemPrompt.section({
    name: 'tool:read',
    order: TOOL_SECTION_ORDERS.read,
    text: 'Use the read tool — not shell cat/head/tail — to inspect files. `path` accepts an inline selector: :N (single line), :N-M (range), :N+K (K lines from N), :N- (to EOF), comma multi-range, :raw (verbatim). Archive members use "archive.zip:inner/path".',
  })
  ctx.systemPrompt.section({
    name: 'tool:write',
    order: TOOL_SECTION_ORDERS.write,
    text: 'Use the write tool to create or overwrite files. Parent directories are created. Shebang files auto chmod +x. Hashline patches ([PATH#HASH] headers) and conflict:// URIs are handled.',
  })
  ctx.systemPrompt.section({
    name: 'tool:edit',
    order: TOOL_SECTION_ORDERS.edit,
    text: 'Use the edit tool — not shell sed — for literal replacements. `old_string` must appear exactly once by default; use `replace_all:true` for multiple occurrences. Unified `patch` is supported. Fuzzy matching helps with whitespace differences.',
  })
  ctx.systemPrompt.section({
    name: 'tool:grep',
    order: TOOL_SECTION_ORDERS.grep,
    text: 'Use the grep tool — not shell grep/rg — to search file contents. Returns path\\nLine N: text grouped output. Use `glob` for file discovery.',
  })
  ctx.systemPrompt.section({
    name: 'tool:glob',
    order: TOOL_SECTION_ORDERS.glob,
    text: 'Use the glob tool — not shell find/fd — to find files by pattern. Pattern with no "/" matches basenames at any depth. Results are files only, mtime-sorted.',
  })
}
