/**
 * Background-job adaptation for the `ctx.jobs` seam: one managed job runs its
 * command on its OWN `:async:` Shell (never the session's persistent shell),
 * so background work never blocks the foreground session. A job leases one of
 * the session's warm shells when the pool has one, and otherwise cold-creates
 * exactly as before — the pool is an optimization, never a dependency. The registry owns
 * identity, lifecycle state, the output ring, and completion notices
 * (`dsh-tool-jobs` injects them); this module owns the execution resources,
 * streams the run into that ring, and appends the plugin's completion message
 * once the run ends.
 * @module @xiaoso/dsh-tool-plus/background
 */

import { randomBytes } from 'node:crypto'
import type { JobHandle, JobHooks, JobOutcome } from '@deepseek-ai/dsh-jobs'
import { allocateSpillFile, saveOriginalText } from './adapter/spill.ts'
import { createWarmShell, executeBash, type BashExecutorOptions } from './bash-executor.ts'
import { defaultInitScriptPath } from './init-script.ts'
import { TailBuffer } from './streaming-output.ts'
import type { BashForegroundOutput, ResolvedConfig } from './types.ts'
import { WarmShellPool } from './warm-shell.ts'

/**
 * One warm pool per agent session. The pool is created lazily by the session's
 * first bash job and re-created when a shell-affecting setting changes, so an
 * idle shell can never outlive the configuration it was built for.
 */
interface WarmPoolEntry {
  signature: string
  pool: WarmShellPool
}

const warmPools = new Map<string, WarmPoolEntry>()

/** The minimizer settings every job shell uses (shared by cold and warm paths). */
function jobMinimizerSettings(config: ResolvedConfig): NonNullable<BashExecutorOptions['minimizerSettings']> {
  return {
    enabled: config.minimizer.enabled,
    settingsPath: undefined,
    only: config.minimizer.only,
    except: config.minimizer.except,
    maxCaptureBytes: config.minimizer.maxCaptureBytes,
    sourceOutlineLevel: 'default',
    legacyFilters: undefined,
  }
}

/** Shell-affecting options a warm shell must be built with. */
function warmShellOptions(config: ResolvedConfig): BashExecutorOptions {
  return {
    minimizerSettings: jobMinimizerSettings(config),
    minimizerEnabled: config.minimizer.enabled,
    snapshotEnabled: config.snapshotEnabled,
    initScriptEnabled: config.bashInitEnabled,
    initScriptPath: defaultInitScriptPath(),
    rmSafe: config.rmSafe,
    nonInteractiveEnv: config.nonInteractiveEnv,
  }
}

/** Everything that would make an existing warm shell stale. */
function warmPoolSignature(config: ResolvedConfig): string {
  return JSON.stringify({
    enabled: config.warmShellEnabled,
    count: config.warmShellCount,
    ttlMs: config.warmShellTtlMs,
    snapshotEnabled: config.snapshotEnabled,
    initScriptEnabled: config.bashInitEnabled,
    initScriptPath: defaultInitScriptPath(),
    rmSafe: config.rmSafe,
    nonInteractiveEnv: config.nonInteractiveEnv,
    minimizer: config.minimizer,
  })
}

/** Lazily get (or replace) the session's warm pool. */
function getWarmPool(sessionId: string, config: ResolvedConfig): WarmShellPool | undefined {
  const existing = warmPools.get(sessionId)
  if (!config.warmShellEnabled || config.warmShellCount <= 0) {
    if (existing !== undefined) {
      existing.pool.dispose()
      warmPools.delete(sessionId)
    }
    return undefined
  }
  const signature = warmPoolSignature(config)
  if (existing !== undefined && existing.signature === signature) return existing.pool
  existing?.pool.dispose()
  const pool = new WarmShellPool({
    count: config.warmShellCount,
    ttlMs: config.warmShellTtlMs,
    create: () => createWarmShell(warmShellOptions(config)),
  })
  warmPools.set(sessionId, { signature, pool })
  return pool
}

/**
 * Drop one session's warm shells (agent disposal), or every session's (plugin
 * teardown). Idle shells are aborted; shells leased to a running job are
 * unaffected and finish their run.
 */
export function closeSessionWarmShells(sessionId?: string): void {
  if (sessionId === undefined) {
    for (const entry of warmPools.values()) entry.pool.dispose()
    warmPools.clear()
    return
  }
  const entry = warmPools.get(sessionId)
  if (entry === undefined) return
  entry.pool.dispose()
  warmPools.delete(sessionId)
}

export interface ManagedBashJob {
  /** Hooks handed to `ctx.jobs.start`'s `run()`. */
  hooks: JobHooks
  /**
   * The run's completion in tool-result terms. Foreground callers that
   * auto-background and then finish within the wait window resolve this to
   * return a foreground result; the registry's `done` maps it to an outcome.
   */
  completion: Promise<BashForegroundOutput>
}

/** Options for {@link startBashJob}. */
export interface StartBashJobOptions {
  /** Session id prefix for the job's shell key (`<sessionId>:async:<nonce>`). */
  sessionId: string
  command: string
  cwd: string
  /** Effective deadline in ms; `undefined`/0 disables the job deadline. */
  timeoutMs: number | undefined
  /** Command-scoped environment (already merged with dshEnv). */
  env: Record<string, string> | undefined
  config: ResolvedConfig
  /**
   * The registry's producer face, when this run is a registered job: every
   * streamed chunk lands in the job's output ring, and so does the settled
   * completion message. Absent for a run no registry owns (unit callers).
   */
  job?: JobHandle
  /**
   * Builds the settled completion message from the bounded preview and the
   * run's spill file (the plugin's `outputTruncate` policy). Absent keeps the
   * preview verbatim.
   */
  formatCompletion?: (previewText: string, spillPath: string | undefined) => string
}

/**
 * Start one managed background bash job. The producer owns a per-job
 * `AbortController` (cancellation kills only this job's shell) and a bounded
 * preview tail; the registry owns the model's consuming cursor over the ring
 * this job writes to.
 * @param options - job identity and execution parameters.
 * @returns the registry hooks plus the tool-result completion promise.
 */
export function startBashJob(options: StartBashJobOptions): ManagedBashJob {
  const { sessionId, command, cwd, timeoutMs, env, config, job } = options
  const shellKey = `${sessionId}:async:${randomBytes(4).toString('hex')}`
  const abortController = new AbortController()

  // The bounded preview tail: the body of the settled completion message.
  const preview = new TailBuffer(config.outputMaxBytes)

  const completion = (async (): Promise<BashForegroundOutput> => {
    const startedAt = performance.now()
    // Per-job spill mirror (upstream allocates an output artifact per async
    // job): the executor's OutputSink mirrors the full raw stream exactly when
    // the inline windows overflow, so the completion can point the model at
    // the recoverable full output.
    const spillPath = allocateSpillFile()
    // Lease-then-discard: `acquire()` is synchronous, so two parallel jobs can
    // never receive the same warm shell. The refill is single-flight inside the
    // pool and starts as soon as the lease leaves it.
    const warmPool = getWarmPool(sessionId, config)
    const warmShell = warmPool?.acquire()
    // The first job must finish its own snapshot before the pool starts
    // creating shells, otherwise both paths build the same snapshot in
    // parallel. Later jobs can refill immediately: the snapshot is cached.
    if (warmPool?.initialized === true) warmPool.ensureFilled()
    let result: Awaited<ReturnType<typeof executeBash>>
    try {
      result = await executeBash(command, {
        cwd,
        timeout: timeoutMs,
        sessionKey: shellKey,
        env,
        signal: abortController.signal,
        minimizerSettings: jobMinimizerSettings(config),
        minimizerEnabled: config.minimizer.enabled,
        spillThreshold: config.outputSinkTailBytes,
        headBytes: config.outputSinkHeadBytes,
        useShellCommandWrapper: config.useShellCommandWrapper,
        snapshotEnabled: config.snapshotEnabled,
        // The init script must run on every shell creation, including the
        // one-shot job shells the default auto-background path uses; leaving
        // these out made the feature a no-op under the default config
        // (issue #6).
        initScriptEnabled: config.bashInitEnabled,
        initScriptPath: defaultInitScriptPath(),
        rmSafe: config.rmSafe,
        nonInteractiveEnv: config.nonInteractiveEnv,
        artifactPath: spillPath,
        onMinimizedSave: (originalText) => saveOriginalText(originalText),
        ...(warmShell !== undefined ? { warmShell } : {}),
        onChunk: (chunk) => {
          preview.append(chunk)
          // Live ring writes: `job_output` reads the run's output as it arrives,
          // and the registry owns the model's consuming cursor. Each model-facing
          // read is bounded by the job's `outputLimitBytes`.
          job?.append(chunk)
        },
      })
    } catch (error) {
      // The executor never adopted the lease (e.g. setup threw): release its
      // native resources instead of leaving an orphan to GC.
      if (warmShell !== undefined) void warmShell.abort().catch(() => undefined)
      throw error
    } finally {
      // A failed cold create should not leave the session with no warm shells.
      warmPool?.ensureFilled()
    }
    const wallTimeMs = performance.now() - startedAt
    const aborted = result.cancelled && abortController.signal.aborted
    const timedOut = result.timedOut ?? (result.cancelled && !aborted)
    // OMP parity (refs tools/bash.ts:#buildCompletedResult, :841-858): a run
    // killed by its own deadline must SAY so in the delivered text — the
    // sink annotation exists for the foreground path only, so background
    // completions would otherwise go out as raw output with no marker.
    let text = result.output
    if (timedOut) {
      const seconds = Math.max(1, Math.round((timeoutMs ?? 0) / 1000))
      if (!text.includes('[Command timed out after')) {
        text = `[Command timed out after ${seconds} seconds]\n\n${text}`
      }
    }
    // The plugin's completion message joins the ring from inside this producer
    // promise, so it is in place before `done` settles and the registry closes
    // the stream. Below the configured trigger the policy returns the preview
    // unchanged: the streamed chunks already are that text, and a second copy
    // would only duplicate it for the model.
    const previewText = preview.text()
    const message = options.formatCompletion?.(previewText, result.spillPath) ?? previewText
    if (job !== undefined && message !== previewText) job.append(message)
    return {
      kind: 'foreground',
      exitCode: result.exitCode ?? null,
      timedOut,
      aborted,
      timeoutMs: timeoutMs ?? null,
      wallTimeMs,
      ...result.workingDir !== undefined ? { workingDir: result.workingDir } : {},
      ...result.minimized !== undefined ? { minimized: result.minimized } : {},
      output: {
        text,
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
  })()

  const done = completion.then(
    (value): JobOutcome => {
      if (value.aborted) return { status: 'killed', detail: 'cancelled' }
      // OMP parity (refs tools/bash.ts:852-856): a deadline-killed run is
      // isError → the job manager records the job as failed and delivers the
      // rendered error text, not a plain completion.
      if (value.timedOut) {
        const seconds = Math.max(1, Math.round((value.timeoutMs ?? 0) / 1000))
        return { status: 'failed', detail: `Command timed out after ${seconds} seconds` }
      }
      const detail = value.exitCode === null ? undefined : `exit code: ${value.exitCode}`
      return { status: 'completed', detail }
    },
    (error: unknown): JobOutcome => ({
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    }),
  )

  return {
    hooks: {
      cancel: () => {
        if (!abortController.signal.aborted) abortController.abort()
      },
      done,
    },
    completion,
  }
}
