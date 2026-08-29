/**
 * Config-driven output truncation for background→foreground completion text.
 * Provenance (second-impl-audit.md S-1, 2026-08-29): the truncation
 * primitives (truncateHead/Middle/Tail, TruncationResult) are OMP 17.3.5
 * verbatim, imported directly from `../omp/session/streaming-output.ts`;
 * the composition layer below (trigger threshold + retention mode + notice
 * format) is a plugin-specific design shipped with the bash-plus settings
 * card (763023e, 2026-08-19) — `applyConfiguredTruncation` has no
 * counterpart in refs/oh-my-pi 17.3.5, so the old "ported verbatim from the
 * OMP bash-runtime" claim was unverifiable and has been dropped.
 * @module @xiaoso/dsh-tool-plus/truncate
 */

import { truncateHead, truncateMiddle, truncateTail, type TruncationResult } from '../tools/omp/session/streaming-output.ts'
import type { OutputTruncateConfig } from './settings.ts'

/** Upper bound standing in for "no limit", matching the OMP helper. */
const TRUNC_NO_LIMIT = 1_000_000_000

/** Line count of `text` (newline count + 1), matching the OMP helper. */
export function countTextLines(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') n++
  }
  return n + 1
}

/**
 * Truncate a background job's completion text per the configured strategy
 * (bytes/lines), trigger threshold, and retention mode (head/tail/middle) —
 * ported from the OMP bash-runtime `applyConfiguredTruncation`. Returns the
 * text unchanged when it does not exceed the trigger threshold; otherwise
 * appends a notice describing the truncation.
 * @param text - the completion text to truncate.
 * @param fullOutputPath - optional path to the full output, appended to the notice.
 * @param truncate - the resolved truncation policy.
 * @returns the (possibly truncated) completion text.
 */
export function applyConfiguredTruncation(text: string, fullOutputPath: string | undefined, truncate: OutputTruncateConfig): string {
  if (text.length === 0) return text

  const isBytes = truncate.strategy === 'bytes'
  const size = isBytes ? Buffer.byteLength(text, 'utf-8') : countTextLines(text)
  const trigger = isBytes ? truncate.triggerBytes : truncate.triggerLines
  if (size <= trigger) return text

  const mode = isBytes ? truncate.bytes.mode : truncate.lines.mode
  let result: TruncationResult
  if (isBytes) {
    if (mode === 'head') {
      result = truncateHead(text, { maxBytes: truncate.bytes.headBytes, maxLines: TRUNC_NO_LIMIT })
    } else if (mode === 'middle') {
      result = truncateMiddle(text, {
        maxBytes: truncate.bytes.headBytes + truncate.bytes.tailBytes,
        maxHeadBytes: truncate.bytes.headBytes,
        maxLines: TRUNC_NO_LIMIT,
        maxHeadLines: Math.floor(TRUNC_NO_LIMIT / 2),
      })
    } else {
      result = truncateTail(text, { maxBytes: truncate.bytes.tailBytes, maxLines: TRUNC_NO_LIMIT })
    }
  } else if (mode === 'head') {
    result = truncateHead(text, { maxLines: truncate.lines.headLines, maxBytes: TRUNC_NO_LIMIT })
  } else if (mode === 'middle') {
    result = truncateMiddle(text, {
      maxLines: truncate.lines.headLines + truncate.lines.tailLines,
      maxHeadLines: truncate.lines.headLines,
      maxBytes: TRUNC_NO_LIMIT,
      maxHeadBytes: Math.floor(TRUNC_NO_LIMIT / 2),
    })
  } else {
    result = truncateTail(text, { maxLines: truncate.lines.tailLines, maxBytes: TRUNC_NO_LIMIT })
  }

  if (!result.truncated) return text

  const pathPart = fullOutputPath ? ` Full output: ${fullOutputPath}` : ''
  const kept = isBytes
    ? `${result.outputBytes ?? 0}/${result.totalBytes} bytes`
    : `${result.outputLines ?? 0}/${result.totalLines} lines`
  const notice = `[Output truncated (${mode}): kept ${kept}.${pathPart}]`

  let body = result.content
  if (mode === 'tail') body = `... [earlier output omitted]\n${body}`
  else if (mode === 'head') body = `${body}\n... [later output omitted]`
  return `${body}\n\n${notice}`
}
