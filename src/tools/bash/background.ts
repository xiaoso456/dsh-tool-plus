/**
 * Background-job adaptation for the `ctx.jobs` seam: one managed job runs its
 * command on its OWN `:async:` Shell (never the session's persistent shell),
 * so background work never blocks the foreground session. The registry owns
 * identity, lifecycle state, and completion notices (`dsh-tool-jobs` injects
 * them); this module owns the execution resources and their hooks.
 * @module @xiaoso/dsh-tool-plus/background
 */

import { randomBytes } from 'node:crypto'
import type { JobHooks, JobOutcome } from '@deepseek-ai/dsh-jobs'
import { allocateSpillFile, saveOriginalText } from './adapter/spill.ts'
import { executeBash } from './bash-executor.ts'
import { TailBuffer } from './streaming-output.ts'
import type { BashForegroundOutput, ResolvedConfig } from './types.ts'

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
  /** Effective deadline in ms; `undefined` disables the job deadline. */
  timeoutMs: number | undefined
  /** Command-scoped environment (already merged with dshEnv). */
  env: Record<string, string> | undefined
  config: ResolvedConfig
}

/**
 * Start one managed background bash job. The producer owns a per-job
 * `AbortController` (cancellation kills only this job's shell), a bounded
 * preview tail, and a consuming delta cursor for `readOutput`.
 * @param options - job identity and execution parameters.
 * @returns the registry hooks plus the tool-result completion promise.
 */
export function startBashJob(options: StartBashJobOptions): ManagedBashJob {
  const { sessionId, command, cwd, timeoutMs, env, config } = options
  const shellKey = `${sessionId}:async:${randomBytes(4).toString('hex')}`
  const abortController = new AbortController()

  // preview: the bounded final output; delta: the consuming read cursor.
  const preview = new TailBuffer(config.outputMaxBytes)
  const delta = new TailBuffer(config.outputMaxBytes)
  let settled = false
  let settledText = ''

  const completion = (async (): Promise<BashForegroundOutput> => {
    const startedAt = performance.now()
    // Per-job spill mirror (upstream allocates an output artifact per async
    // job): the executor's OutputSink mirrors the full raw stream exactly when
    // the inline windows overflow, so the completion can point the model at
    // the recoverable full output.
    const spillPath = allocateSpillFile()
    const result = await executeBash(command, {
      cwd,
      timeout: timeoutMs,
      sessionKey: shellKey,
      env,
      signal: abortController.signal,
      minimizerSettings: {
        enabled: config.minimizer.enabled,
        settingsPath: undefined,
        only: config.minimizer.only,
        except: config.minimizer.except,
        maxCaptureBytes: config.minimizer.maxCaptureBytes,
        sourceOutlineLevel: 'default',
        legacyFilters: undefined,
      },
      minimizerEnabled: config.minimizer.enabled,
      spillThreshold: config.outputSinkTailBytes,
      headBytes: config.outputSinkHeadBytes,
      useShellCommandWrapper: config.useShellCommandWrapper,
      snapshotEnabled: config.snapshotEnabled,
      nonInteractiveEnv: config.nonInteractiveEnv,
      artifactPath: spillPath,
      onMinimizedSave: (originalText) => saveOriginalText(originalText),
      onChunk: (chunk) => {
        preview.append(chunk)
        delta.append(chunk)
      },
    })
    settled = true
    settledText = preview.text()
    const wallTimeMs = performance.now() - startedAt
    const aborted = result.cancelled && abortController.signal.aborted
    return {
      kind: 'foreground',
      exitCode: result.exitCode ?? null,
      timedOut: result.cancelled && !aborted,
      aborted,
      timeoutMs: timeoutMs ?? null,
      wallTimeMs,
      ...result.workingDir !== undefined ? { workingDir: result.workingDir } : {},
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
  })()

  const done = completion.then(
    (value): JobOutcome => {
      if (value.aborted) return { status: 'killed', detail: 'cancelled' }
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
      readOutput: () => {
        if (settled) return settledText
        const text = delta.text()
        delta.reset()
        return text
      },
    },
    completion,
  }
}
