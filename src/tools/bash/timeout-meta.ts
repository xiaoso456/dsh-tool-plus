/**
 * Timeout metadata for a settled run, mirroring Oh My Pi's `BashToolDetails`
 * (refs/oh-my-pi, packages/coding-agent/src/tools/bash.ts:#buildCompletedResult):
 * the result states the *effective* deadline in seconds, keeps the caller's
 * requested value only when clamping changed it, and marks a disabled deadline
 * explicitly instead of reporting zero milliseconds.
 * @module
 */

import type { BashForegroundOutput } from './types'

/** The timeout facts a settled result carries (OMP `BashToolDetails` subset). */
export type BashTimeoutDetails = Pick<
  BashForegroundOutput,
  'timeoutSeconds' | 'requestedTimeoutSeconds' | 'timeoutDisabled'
>

/**
 * Describe the deadline a run actually had.
 * @param timeoutMs - effective deadline in ms; `undefined`/0 means disabled.
 * @param requestedTimeoutMs - the deadline before clamping, when the caller asked.
 * @returns the seconds-valued fields for the result object.
 */
export function timeoutDetails(timeoutMs: number | undefined, requestedTimeoutMs?: number): BashTimeoutDetails {
  if (timeoutMs === undefined || timeoutMs === 0) return { timeoutDisabled: true }
  const details: BashTimeoutDetails = { timeoutSeconds: timeoutMs / 1000 }
  if (requestedTimeoutMs !== undefined && requestedTimeoutMs !== timeoutMs) {
    details.requestedTimeoutSeconds = requestedTimeoutMs / 1000
  }
  return details
}

/**
 * Spell a seconds deadline for a notice. OMP interpolates the raw seconds, so a
 * fractional value (a config default below a whole second) stays honest.
 * @param seconds - the deadline in seconds.
 * @returns the number as text, `?` when the value is missing.
 */
export function formatTimeoutSeconds(seconds: number | undefined): string {
  return seconds === undefined ? '?' : String(seconds)
}
