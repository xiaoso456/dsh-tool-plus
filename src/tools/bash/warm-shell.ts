/**
 * Per-session pool of pristine, already-initialized shell sessions.
 *
 * A warm Shell is only ever handed out once: leasing removes it from the pool
 * synchronously, and a shell that has run a command is never returned (its cwd,
 * exports, aliases and job table are dirty). The pool holds only shells that
 * were created and initialized with a no-op command.
 *
 * Refilling is single-flight per pool: concurrent callers see the same
 * `creating` count, so N parallel bash calls cannot spawn N refill waves.
 * A create that finishes after {@link WarmShellPool.dispose} is discarded
 * (aborted) instead of being adopted.
 * @module @xiaoso/dsh-tool-plus/warm-shell
 */

import type { Shell } from '@oh-my-pi/pi-natives'

/** Construction options for {@link WarmShellPool}. */
export interface WarmShellPoolOptions {
  /** Desired number of idle shells (0 = pool disabled). */
  count: number
  /** Idle lifetime in ms; 0 keeps idle shells until leased or disposed. */
  ttlMs: number
  /** Creates and initializes one shell; null/undefined means "not available". */
  create: () => Promise<Shell | null | undefined>
  /** Receives create failures; the pool keeps running with one fewer shell. */
  onError?: (error: unknown) => void
}

interface IdleShell {
  shell: Shell
  createdAt: number
  timer: NodeJS.Timeout | undefined
}

/** Pool counts, for diagnostics and tests. */
export interface WarmShellPoolStats {
  idle: number
  creating: number
}

export class WarmShellPool {
  readonly #count: number
  readonly #ttlMs: number
  readonly #create: () => Promise<Shell | null | undefined>
  readonly #onError: ((error: unknown) => void) | undefined
  #idle: IdleShell[] = []
  #creating = 0
  #disposed = false
  #initialized = false

  constructor(options: WarmShellPoolOptions) {
    this.#count = Math.max(0, Math.trunc(options.count))
    this.#ttlMs = Math.max(0, Math.trunc(options.ttlMs))
    this.#create = options.create
    this.#onError = options.onError
  }

  get stats(): WarmShellPoolStats {
    return { idle: this.#idle.length, creating: this.#creating }
  }

  /**
   * True once the pool has adopted at least one shell. The first job must not
   * race its own snapshot creation with a prefetch, so callers use this to
   * decide whether an early refill is safe.
   */
  get initialized(): boolean {
    return this.#initialized
  }

  /**
   * Lease one idle shell, or undefined when the pool is empty/disposed.
   * Synchronous by design: two callers can never observe the same entry.
   */
  acquire(): Shell | undefined {
    if (this.#disposed) return undefined
    const now = Date.now()
    while (this.#idle.length > 0) {
      const entry = this.#idle.pop()!
      this.#clearTimer(entry)
      if (this.#ttlMs > 0 && now - entry.createdAt >= this.#ttlMs) {
        // The expiry timer may be late (blocked event loop); do not hand out
        // a shell that has outlived its configured idle window.
        void entry.shell.abort().catch(() => undefined)
        continue
      }
      return entry.shell
    }
    return undefined
  }

  /**
   * Start creates until `count` shells are idle or in flight. Safe to call
   * from every execution path; duplicate calls coalesce on `#creating`.
   */
  ensureFilled(): void {
    if (this.#disposed || this.#count === 0) return
    const missing = this.#count - this.#idle.length - this.#creating
    for (let i = 0; i < missing; i++) this.#startCreate()
  }

  /** Drop every idle shell and reject late creates. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const entry of this.#idle) {
      this.#clearTimer(entry)
      void entry.shell.abort().catch(() => undefined)
    }
    this.#idle = []
  }

  #startCreate(): void {
    this.#creating++
    void Promise.resolve()
      .then(() => this.#create())
      .then(
        (shell) => {
          this.#creating--
          this.#adopt(shell)
        },
        (error: unknown) => {
          this.#creating--
          this.#onError?.(error)
        },
      )
  }

  #adopt(shell: Shell | null | undefined): void {
    if (shell === null || shell === undefined) return
    if (this.#disposed || this.#idle.length >= this.#count) {
      // A config change/disable or a racing refill left one shell too many.
      void shell.abort().catch(() => undefined)
      return
    }
    this.#initialized = true
    const entry: IdleShell = { shell, createdAt: Date.now(), timer: undefined }
    if (this.#ttlMs > 0) {
      entry.timer = setTimeout(() => {
        const index = this.#idle.indexOf(entry)
        if (index === -1) return
        this.#idle.splice(index, 1)
        void entry.shell.abort().catch(() => undefined)
      }, this.#ttlMs)
      entry.timer.unref?.()
    }
    this.#idle.push(entry)
  }

  #clearTimer(entry: IdleShell): void {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
  }
}
