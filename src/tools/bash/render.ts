/**
 * Model-facing result rendering for the bash-plus tool: output body, wall
 * time, minimization/truncation notices, then the exit-status marker the dsh
 * presentation layer parses back into a terminal pill.
 *
 * Marker contract (shared with `dsh-tool-bash`): `[exit code: N]` and
 * `[killed by signal: X]` MUST be the final line of the rendered text —
 * `parseExitStatus` anchors there. Other notices stay in the body.
 * @module @xiaoso/dsh-tool-plus/render
 */

import { parseExitStatus } from '@deepseek-ai/dsh-shell'
import type { BashForegroundOutput } from './types.ts'

/** Format a byte count for human-readable display. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/** The wall-time line appended to every completed foreground result. */
export function formatWallTimeNotice(wallTimeMs: number): string {
  return `Wall time: ${(wallTimeMs / 1000).toFixed(2)} seconds`
}

/** The truncation notice with the full-output spill path. */
function formatTruncationNotice(truncated: boolean, spillPath: string | undefined): string | undefined {
  if (!truncated) return undefined
  return `[output truncated; full output: ${spillPath ?? '(unavailable)'}]`
}

/**
 * Shape one completed run into the text the model sees. Non-zero exits are
 * reported, not errored — the model decides how to react; only infrastructure
 * failures (spawn errors, aborts) surface as isError results.
 * @param value - the completed foreground run.
 * @returns the model-facing text: output body (or `(no output)`), then wall
 *   time, minimization/truncation notices, timeout marker, and finally the
 *   exit-status marker on its own line.
 */
export function renderBashResult(value: BashForegroundOutput): string {
  let body = value.output.text
  if (body.length === 0) body = '(no output)'

  const notices: string[] = []
  const wallTime = formatWallTimeNotice(value.wallTimeMs)
  if (value.minimized !== undefined) {
    notices.push(
      `[output minimized by ${value.minimized.filter}: ${formatBytes(value.minimized.inputBytes)} → ${formatBytes(value.minimized.outputBytes)}]`,
    )
  }
  const truncation = formatTruncationNotice(value.output.truncated, value.output.spillPath)
  if (truncation !== undefined) notices.push(truncation)

  const markers: string[] = []
  if (value.timedOut) {
    markers.push(`[timed out after ${value.timeoutMs ?? '?'}ms]`)
  } else if (value.exitCode !== 0) {
    markers.push(`[exit code: ${value.exitCode}]`)
  }

  const lines = [body, wallTime, ...notices, ...markers].filter(line => line.length > 0)
  return lines.join('\n')
}

/**
 * Shape one background-process read into the delta the model sees: the
 * incremental output since the previous read, with the lossy-read notice when
 * the in-memory tail dropped unread bytes.
 * @param text - the incremental delta from the job producer.
 * @param droppedBytes - bytes elided from the tail window, when any.
 * @returns the delta text with any loss notice appended.
 */
export function renderJobRead(text: string, droppedBytes: number | undefined): string {
  if (droppedBytes !== undefined && droppedBytes > 0) {
    return `${text}\n[job output truncated: ${formatBytes(droppedBytes)} dropped before this read]`
  }
  return text
}

export { parseExitStatus }
