/**
 * Warm-shell pool contracts: exclusive leasing, single-flight refills, idle
 * expiry and disposal. The pool only relies on `Shell.abort()`, so the tests
 * use minimal fakes and run in microseconds.
 * @module tests
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Shell } from '@oh-my-pi/pi-natives'
import { WarmShellPool } from '../../src/tools/bash/warm-shell.ts'

interface FakeShell {
  shell: Shell
  abort: ReturnType<typeof vi.fn>
}

function fakeShell(): FakeShell {
  const abort = vi.fn(async () => undefined)
  return { shell: { abort } as unknown as Shell, abort }
}

/** Let the pool's create microtasks settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('WarmShellPool', () => {
  it('fills to the configured count and leases each shell exactly once', async () => {
    const created: FakeShell[] = []
    const pool = new WarmShellPool({
      count: 2,
      ttlMs: 0,
      create: async () => {
        const item = fakeShell()
        created.push(item)
        return item.shell
      },
    })
    pool.ensureFilled()
    await flush()
    expect(pool.stats).toEqual({ idle: 2, creating: 0 })

    const first = pool.acquire()
    const second = pool.acquire()
    // LIFO: the most recently adopted shell is leased first.
    expect(first).toBe(created[1]!.shell)
    expect(second).toBe(created[0]!.shell)
    expect(pool.acquire()).toBeUndefined()
    expect(pool.stats).toEqual({ idle: 0, creating: 0 })

    pool.ensureFilled()
    await flush()
    expect(pool.stats).toEqual({ idle: 2, creating: 0 })
    expect(created).toHaveLength(4)
    pool.dispose()
  })

  it('coalesces concurrent refills into one create per missing shell', async () => {
    let inFlight = 0
    const releases: Array<() => void> = []
    const pool = new WarmShellPool({
      count: 3,
      ttlMs: 0,
      create: () => new Promise<Shell>((resolve) => {
        inFlight++
        releases.push(() => {
          inFlight--
          resolve(fakeShell().shell)
        })
      }),
    })
    pool.ensureFilled()
    pool.ensureFilled()
    pool.ensureFilled()
    expect(pool.stats).toEqual({ idle: 0, creating: 3 })
    await flush()
    expect(inFlight).toBe(3)

    for (const release of releases.splice(0)) release()
    await flush()
    expect(pool.stats).toEqual({ idle: 3, creating: 0 })
    pool.dispose()
  })

  it('expires idle shells after the TTL without recreating them', async () => {
    vi.useFakeTimers()
    const created: FakeShell[] = []
    const pool = new WarmShellPool({
      count: 2,
      ttlMs: 1_000,
      create: async () => {
        const item = fakeShell()
        created.push(item)
        return item.shell
      },
    })
    pool.ensureFilled()
    await flush()
    expect(pool.stats.idle).toBe(2)

    vi.advanceTimersByTime(1_000)
    expect(pool.stats.idle).toBe(0)
    expect(created.every(item => item.abort.mock.calls.length === 1)).toBe(true)
    // Expiry is not a refill trigger; the next bash call creates a new pool entry.
    await flush()
    expect(pool.stats.idle).toBe(0)
    pool.dispose()
  })

  it('does not adopt a create that finishes after dispose', async () => {
    let resolveShell: ((shell: Shell) => void) | undefined
    const late = fakeShell()
    const pool = new WarmShellPool({
      count: 1,
      ttlMs: 0,
      create: () => new Promise<Shell>((resolve) => { resolveShell = resolve }),
    })
    pool.ensureFilled()
    await flush()
    expect(pool.stats).toEqual({ idle: 0, creating: 1 })
    pool.dispose()
    resolveShell!(late.shell)
    await flush()
    expect(pool.stats).toEqual({ idle: 0, creating: 0 })
    expect(late.abort).toHaveBeenCalledTimes(1)
  })

  it('keeps the pool usable when one create fails', async () => {
    let calls = 0
    const errors: unknown[] = []
    const pool = new WarmShellPool({
      count: 2,
      ttlMs: 0,
      create: async () => {
        calls++
        if (calls === 1) throw new Error('boom')
        return fakeShell().shell
      },
      onError: error => errors.push(error),
    })
    pool.ensureFilled()
    await flush()
    expect(errors).toHaveLength(1)
    expect(pool.stats.idle).toBe(1)
    // The completed refill did not re-enter automatically; the next call repairs.
    pool.ensureFilled()
    await flush()
    expect(pool.stats.idle).toBe(2)
    pool.dispose()
  })
})
