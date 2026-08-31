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
import { outputMeta } from '../omp/tools/output-meta.ts'
import type { BashForegroundOutput, CollectedOutput } from './types.ts'

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

/**
 * The OMP-form truncation notice: line-range accounting (head+tail ranges for
 * middle elision, shown range for one-sided truncation) plus elided stats,
 * then the spill-file pointer and a read-back hint. Range reconstruction rides
 * the shared OMP algorithm (`outputMeta().truncationFromSummary`), with the
 * upstream `artifact://N` clause replaced by the spill-file path — bash spill
 * files are plain files (deliberately not registered in the read tool's
 * artifact:// space, see adapter/spill.ts) and are recovered with `:N-M`
 * inline selectors instead.
 * @returns the notice lines, or `undefined` when output was not truncated.
 */
export function formatTruncationNotice(value: CollectedOutput): string[] | undefined {
  if (!value.truncated) return undefined
  const totalLines = value.totalLines ?? 0
  const outputLines = value.outputLines ?? 0
  const totalBytes = value.totalBytes ?? 0
  const outputBytes = value.outputBytes ?? 0
  const meta = outputMeta()
    .truncationFromSummary(
      {
        output: '',
        truncated: true,
        totalLines,
        totalBytes,
        outputLines,
        outputBytes,
        elidedLines: value.elidedLines,
        elidedBytes: value.elidedBytes,
      },
      { direction: 'tail' },
    )
    .get()?.truncation
  let body: string
  if (meta !== undefined && meta.direction === 'middle' && meta.headRange !== undefined && meta.tailRange !== undefined) {
    const elidedLines = meta.elidedLines ?? Math.max(0, totalLines - outputLines)
    const elidedBytes = meta.elidedBytes ?? Math.max(0, totalBytes - outputBytes)
    body = `Showing lines ${meta.headRange.start}-${meta.headRange.end} and ${meta.tailRange.start}-${meta.tailRange.end}`
      + ` of ${totalLines}; ${elidedLines.toLocaleString()} middle line${elidedLines === 1 ? '' : 's'} (${formatBytes(elidedBytes)}) elided`
  } else if (meta !== undefined && meta.shownRange !== undefined && meta.shownRange.end >= meta.shownRange.start) {
    body = `Showing lines ${meta.shownRange.start}-${meta.shownRange.end} of ${totalLines}`
  } else {
    body = `Showing ${outputLines} of ${totalLines} lines`
  }
  const lines = [`[output truncated: ${body}. Full output: ${value.spillPath ?? '(unavailable)'}]`]
  if (value.spillPath !== undefined) {
    lines.push(`Re-read elided ranges from the full-output file with the read tool, e.g. "${value.spillPath}:<start>-<end>".`)
  }
  return lines
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
    const originalPart = value.output.originalSpillPath !== undefined ? `; original saved to ${value.output.originalSpillPath}` : ''
    notices.push(
      `[output minimized by ${value.minimized.filter}: ${formatBytes(value.minimized.inputBytes)} → ${formatBytes(value.minimized.outputBytes)}${originalPart}]`,
    )
  }
  const truncation = formatTruncationNotice(value.output)
  if (truncation !== undefined) notices.push(...truncation)
  else if (value.output.spillPath !== undefined) notices.push(`[full raw stream saved: ${value.output.spillPath}]`)
  if (value.rmSafeInjectionFailed === true) {
    notices.push('[rmSafe injection failed: rm deletes permanently — use `command rm` to bypass]')
  }

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
