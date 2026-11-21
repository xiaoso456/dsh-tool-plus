/**
 * Retry wrapper for the two file-write backends.
 *
 * Both backends can fail because another process briefly holds the target
 * file, but the errors are different:
 *  - DSH write (ctx.fs.writeText -> dsh-fs-local) throws an FsError whose
 *    message contains 'ReplaceFileW EIO (Win32 1175)' or '... (Win32 32)'.
 *    1175 means "the replaced file could not be removed"; 32 means "sharing
 *    violation". Both leave the original file intact, so retrying is safe.
 *    1176/1177 are failures while moving the replacement into place; retrying
 *    them blindly can lose the file, so they are never retried.
 *  - Native write (OMP writethroughNoop -> node:fs) never calls
 *    ReplaceFileW. The same contention surfaces as EBUSY (Windows
 *    ERROR_SHARING_VIOLATION / ERROR_LOCK_VIOLATION). EPERM/EACCES are
 *    usually real permission problems, so they are not retried either.
 *
 * The matcher runs only in the catch path: a successful write pays nothing.
 * @module @xiaoso/dsh-tool-plus/shared
 */

const REPLACE_FILE_CONTENTION = /ReplaceFileW EIO \(Win32 (?:1175|32)\)/

/** Backoff between retries, in milliseconds; later attempts double and cap at 1s. */
export const DEFAULT_BACKOFF_MS = [50, 150, 400] as const

const MAX_RETRIES = 10

function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message
  if (value !== null && typeof value === 'object') {
    const message = (value as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return ''
}

function codeOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const code = (value as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** Walk error and its cause chain without looping on cycles. */
function* causeChain(error: unknown): Generator<unknown> {
  const seen = new Set<unknown>()
  let current = error
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    yield current
    current = (current as { cause?: unknown }).cause
  }
}

/** True only for the two ReplaceFileW failures that leave both files intact. */
export function isReplaceFileContention(error: unknown): boolean {
  for (const link of causeChain(error)) {
    if (REPLACE_FILE_CONTENTION.test(messageOf(link))) return true
  }
  return false
}

/** True only for EBUSY, the native-write analogue of a sharing violation. */
export function isNativeWriteContention(error: unknown): boolean {
  for (const link of causeChain(error)) {
    if (codeOf(link) === 'EBUSY') return true
  }
  return false
}

/** Clamp a user-supplied retry count into the supported range. */
export function normalizeRetries(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(MAX_RETRIES, Math.trunc(value)))
}

/** Delay before retry number attempt (0-based). */
export function backoffFor(attempt: number, schedule: readonly number[] = DEFAULT_BACKOFF_MS): number {
  if (attempt < schedule.length) return schedule[attempt] ?? 0
  const last = schedule[schedule.length - 1] ?? 0
  return Math.min(last * 2 ** (attempt - schedule.length + 1), 1000)
}

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>

export interface WriteRetryOptions {
  /** Number of retries after the first attempt (0 disables retry). */
  retries: number
  signal?: AbortSignal
  /** Backend-specific predicate; only transient file contention should return true. */
  isRetryable: (error: unknown) => boolean
  /** Test seam; defaults to an abortable timer. */
  sleep?: SleepFn
  /** Test seam; defaults to DEFAULT_BACKOFF_MS. */
  backoffMs?: readonly number[]
}

/**
 * Run write and retry it only when isRetryable accepts the error.
 * The original error is always rethrown after the last attempt or an abort.
 */
export async function writeWithRetry(write: () => Promise<void>, options: WriteRetryOptions): Promise<void> {
  const retries = normalizeRetries(options.retries)
  const schedule = options.backoffMs ?? DEFAULT_BACKOFF_MS
  const sleep = options.sleep ?? abortableSleep
  for (let attempt = 0; ; attempt++) {
    try {
      await write()
      return
    } catch (error) {
      if (attempt >= retries) throw error
      if (options.signal?.aborted) throw error
      if (!options.isRetryable(error)) throw error
      await sleep(backoffFor(attempt, schedule), options.signal)
      if (options.signal?.aborted) throw error
    }
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(finish, ms)
    const onAbort = (): void => finish()
    function finish(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
