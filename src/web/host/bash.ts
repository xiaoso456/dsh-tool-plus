/**
 * Host projection for the `bash` terminal card.
 *
 * The call's output value is already the structured shape this card needs, so
 * nothing is read back from the session and nothing is recomputed: the
 * presentation metadata is a lossless narrowing of that value.
 *
 * Two properties matter to the card:
 *  - a `timeoutMs: 0` call (the documented way to disable the deadline) is a
 *    perfectly valid call; the shipped terminal card treats the option as
 *    illegal and drops the whole card, so the run state cannot come from the
 *    arguments;
 *  - a timed-out or aborted run has no exit code of its own, and its result text
 *    (`[timed out after …]`, `[exit code: null]`) is not something the shipped
 *    card parses — the run state has to travel as data.
 *
 * @module @xiaoso/dsh-tool-plus/web/host/bash
 */

import type { TerminalCardMeta } from '../contract.ts'

/** Whether `value` is a plain object (never `null` or an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Project a bash result value into terminal-card metadata.
 *
 * Every emitted field is a plain JSON scalar and no key is ever set to
 * `undefined`: the metadata rides `presentationMeta`, where a non-lossless
 * payload turns a successful call into a failed one. An unrecognized value
 * yields `null`, which simply leaves the row on the generic shell.
 * @param value - the tool's own output value (foreground or background arm).
 * @returns the card metadata, or `null` when the value is not a usable bash result.
 */
export function bashCardMeta(value: unknown): TerminalCardMeta | null {
  if (!isRecord(value)) return null

  if (value.kind === 'background') {
    const jobId = value.jobId
    if (typeof jobId !== 'string' || jobId.trim() === '') return null
    return { kind: 'terminal', mode: 'background', jobId }
  }

  if (value.kind !== 'foreground') return null

  const { exitCode, timedOut, aborted } = value
  if (exitCode !== null && !(typeof exitCode === 'number' && Number.isInteger(exitCode))) return null
  if (typeof timedOut !== 'boolean' || typeof aborted !== 'boolean') return null

  const workingDir = value.workingDir
  return {
    kind: 'terminal',
    mode: 'foreground',
    exitCode,
    timedOut,
    aborted,
    ...typeof workingDir === 'string' && workingDir !== '' ? { workingDir } : {},
  }
}
