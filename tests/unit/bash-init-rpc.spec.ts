/**
 * bash/init* endpoint contract: payload validation, status fallback, write and
 * reset against a temp path.
 * @module tests
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  handleBashInitEndpoint,
  parseBashInitSavePayload,
  parseBashInitTestPayload,
} from '../../src/host/bash-init-rpc.ts'
import { BASH_INIT_RESET_ENDPOINT, BASH_INIT_SAVE_ENDPOINT, BASH_INIT_STATUS_ENDPOINT, BASH_INIT_TEST_ENDPOINT } from '../../src/tools/shared/browser-rpc-channel.ts'
import { getShellConfig } from '../../src/tools/bash/bash-executor.ts'
import { DEFAULT_INIT_SCRIPT } from '../../src/tools/bash/init-script.ts'

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-init-rpc-'))
}

describe('parseBashInitSavePayload', () => {
  it('accepts a string body and rejects everything else', () => {
    expect(parseBashInitSavePayload({ content: 'export A=1' })).toEqual({ content: 'export A=1' })
    expect(parseBashInitSavePayload({ content: 1 })).toBeUndefined()
    expect(parseBashInitSavePayload({})).toBeUndefined()
    expect(parseBashInitSavePayload(null)).toBeUndefined()
    expect(parseBashInitSavePayload({ content: 'x'.repeat(256 * 1024 + 1) })).toBeUndefined()
  })
})

describe('parseBashInitTestPayload', () => {
  it('allows an absent content and validates the given one', () => {
    expect(parseBashInitTestPayload({})).toEqual({})
    expect(parseBashInitTestPayload(undefined)).toEqual({})
    expect(parseBashInitTestPayload({ content: 'echo hi' })).toEqual({ content: 'echo hi' })
    expect(parseBashInitTestPayload({ content: 7 })).toBeUndefined()
  })
})

describe('handleBashInitEndpoint', () => {
  const deps = (enabled = true) => ({ getEnabled: () => enabled })

  /** Run `body` with $DSH_HOME pointed at `dir`, restoring the real value after. */
  async function withHome<T>(dir: string, body: () => Promise<T>): Promise<T> {
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = dir
    try {
      return await body()
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  }

  it('status reports the built-in default when no user copy exists', async () => {
    const dir = tempDir()
    try {
      const result = await withHome(dir, () => handleBashInitEndpoint(deps(), BASH_INIT_STATUS_ENDPOINT, {}))
      expect(result?.ok).toBe(true)
      const value = (result as { value: { source: string; exists: boolean; content: string } }).value
      expect(value.source).toBe('default')
      expect(value.exists).toBe(false)
      expect(value.content).toBe(DEFAULT_INIT_SCRIPT)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('save writes the user copy, status reads it back, reset removes it', async () => {
    const dir = tempDir()
    try {
      const script = path.join(dir, 'tool-plus', 'bash-init.sh')
      const saved = await withHome(dir, () => handleBashInitEndpoint(deps(), BASH_INIT_SAVE_ENDPOINT, { content: 'export A=1' }))
      expect(saved?.ok).toBe(true)
      expect(fs.readFileSync(script, 'utf8')).toBe('export A=1')
      // save answers with the state after the write (one round trip for the dialog)
      expect((saved as { value: { source: string; exists: boolean; content: string } }).value).toMatchObject({
        source: 'user',
        exists: true,
        content: 'export A=1',
      })

      const status = await withHome(dir, () => handleBashInitEndpoint(deps(), BASH_INIT_STATUS_ENDPOINT, {}))
      const value = (status as { value: { source: string; exists: boolean; content: string } }).value
      expect(value).toMatchObject({ source: 'user', exists: true, content: 'export A=1' })

      const reset = await withHome(dir, () => handleBashInitEndpoint(deps(), BASH_INIT_RESET_ENDPOINT, {}))
      expect(reset?.ok).toBe(true)
      expect((reset as { value: { source: string; exists: boolean } }).value).toMatchObject({
        source: 'default',
        exists: false,
      })
      expect(fs.existsSync(script)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns undefined for endpoints that are not ours', async () => {
    expect(await handleBashInitEndpoint(deps(), 'browser/detect', {})).toBeUndefined()
  })
})

describe('bash/initTest runs the script itself', () => {
  const deps = { getEnabled: () => true }
  const bashReady = ((): boolean => {
    try {
      const { shell } = getShellConfig()
      return shell === 'bash' ? fs.existsSync('/bin/bash') || process.platform !== 'win32' : fs.existsSync(shell)
    } catch {
      return false
    }
  })()

  it.skipIf(!bashReady)('returns what the script printed, nothing else', async () => {
    const result = await handleBashInitEndpoint(deps, BASH_INIT_TEST_ENDPOINT, { content: 'echo hello-from-script' })
    expect(result?.ok).toBe(true)
    const value = (result as { value: { output: string; exitCode?: number } }).value
    expect(value.exitCode).toBe(0)
    expect(value.output).toContain('hello-from-script')
    expect(value.output).not.toContain('__TP_')
  }, 30_000)
})

