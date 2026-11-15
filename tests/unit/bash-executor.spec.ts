/**
 * Real-execution tests for the native shell backend. Require bash on PATH
 * (Git Bash on Windows); the suite self-skips when no bash is available.
 * @module tests
 */

import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { buildMinimizerOptions, closeSessionShells, createWarmShell, executeBash, getShellConfig } from '../../src/tools/bash/bash-executor.ts'

const bashAvailable = ((): boolean => {
  try {
    const { shell } = getShellConfig()
    return shell === 'bash' ? existsSync('/bin/bash') || process.platform !== 'win32' : existsSync(shell)
  } catch {
    return false
  }
})()

const describeBash = bashAvailable ? describe : describe.skip

afterAll(() => {
  closeSessionShells('')
})

describeBash('executeBash', () => {
  it('runs a command and reports the exit code', async () => {
    const result = await executeBash('echo hello && exit 0', { sessionKey: 'unit-basic' })
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('hello')
    expect(result.cancelled).toBe(false)
  })

  it('reports non-zero exits as completed runs', async () => {
    const result = await executeBash('exit 3', { sessionKey: 'unit-exit' })
    expect(result.exitCode).toBe(3)
    expect(result.cancelled).toBe(false)
  })

  it('persists cwd across calls on the same session key', async () => {
    const sessionKey = `unit-cd-${randomBytes(4).toString('hex')}`
    const first = await executeBash('cd /tmp && pwd', { sessionKey })
    expect(first.workingDir).toBeDefined()
    const second = await executeBash('pwd', { sessionKey })
    expect(second.output.trim()).toBe(first.output.trim())
  })

  it('passes command-scoped environment variables', async () => {
    const result = await executeBash('echo "$BASH_PLUS_TEST_VAR"', {
      sessionKey: 'unit-env',
      env: { BASH_PLUS_TEST_VAR: 'scoped-value' },
    })
    expect(result.output).toContain('scoped-value')
  })

  it('times out and reports cancellation', async () => {
    const result = await executeBash('sleep 5', {
      sessionKey: 'unit-timeout',
      timeout: 1_000,
    })
    expect(result.cancelled).toBe(true)
    expect(result.exitCode).toBeUndefined()
  })

  it('runs on a pristine warm shell without installing it as the persistent session', async () => {
    const warm = await createWarmShell({ snapshotEnabled: false, initScriptEnabled: false, rmSafe: false })
    expect(warm).not.toBeNull()
    const sessionKey = `unit-warm-${randomBytes(4).toString('hex')}:async:1`
    const result = await executeBash('echo warm-lease && pwd', { sessionKey, warmShell: warm! })
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('warm-lease')
    // The lease is one-shot: a second call on the same key cold-creates its own
    // shell instead of finding the (never stored) warm shell in the map.
    const second = await executeBash('echo second', { sessionKey })
    expect(second.output).toContain('second')
    await warm!.abort()
  })

  it('truncates oversized output but keeps the head window', async () => {
    const result = await executeBash('seq 1 200000', {
      sessionKey: 'unit-truncate',
      spillThreshold: 51_200,
      headBytes: 20_480,
    })
    expect(result.truncated).toBe(true)
    expect(result.totalBytes).toBeGreaterThan(200_000)
    expect(result.output).toContain('1')
  }, 30_000)
})

describe('buildMinimizerOptions', () => {
  it('returns undefined when disabled', () => {
    const options = buildMinimizerOptions({
      enabled: false,
      settingsPath: undefined,
      only: [],
      except: [],
      maxCaptureBytes: 1024,
      sourceOutlineLevel: 'default',
      legacyFilters: undefined,
    })
    expect(options).toBeUndefined()
  })

  it('maps settings onto native options', () => {
    const options = buildMinimizerOptions({
      enabled: true,
      settingsPath: undefined,
      only: ['git'],
      except: ['npm'],
      maxCaptureBytes: 4096,
      sourceOutlineLevel: 'default',
      legacyFilters: undefined,
    })
    expect(options).toEqual({
      enabled: true,
      settingsPath: undefined,
      only: ['git'],
      except: ['npm'],
      maxCaptureBytes: 4096,
      sourceOutlineLevel: undefined,
      legacyFilters: undefined,
    })
  })
})
