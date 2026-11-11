/**
 * Real-execution coverage for the bash init script (issue #5).
 *
 * The script rides the shell snapshot; these cases prove it is actually
 * sourced before the command: its exports are visible, the Windows PATH
 * prefix puts the real Git dirs first, and a broken script never aborts the
 * command (`|| true` + log).
 * @module tests
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeSessionShells, executeBash, getShellConfig } from '../../src/tools/bash/bash-executor.ts'
import { computePathPrefix, DEFAULT_INIT_SCRIPT } from '../../src/tools/bash/init-script.ts'

const bashAvailable = ((): boolean => {
  try {
    const { shell } = getShellConfig()
    return shell === 'bash' ? existsSync('/bin/bash') || process.platform !== 'win32' : existsSync(shell)
  } catch {
    return false
  }
})()

const describeBash = bashAvailable ? describe : describe.skip

const logFile = path.join(os.tmpdir(), 'dsh-init-exec-log-' + process.pid + '.log')

beforeAll(() => {
  process.env.TOOL_PLUS_INIT_LOG = logFile
})

afterAll(() => {
  closeSessionShells('')
  delete process.env.TOOL_PLUS_INIT_LOG
  fs.rmSync(logFile, { force: true })
})

function writeScript(content: string): string {
  const file = path.join(os.tmpdir(), 'dsh-init-exec-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.sh')
  fs.writeFileSync(file, content, { mode: 0o600 })
  return file
}

describeBash('bash init script', () => {
  it('runs before the command: exports are visible', async () => {
    const script = writeScript('export TOOL_PLUS_PROBE=ok')
    try {
      const result = await executeBash('echo "probe=$TOOL_PLUS_PROBE"', {
        sessionKey: 'init-export',
        timeout: 20_000,
        snapshotEnabled: false,
        initScriptEnabled: true,
        initScriptPath: script,
      })
      expect(result.exitCode).toBe(0)
      expect(result.output).toContain('probe=ok')
    } finally {
      fs.rmSync(script, { force: true })
    }
  }, 30_000)

  it('a broken script never aborts the command', async () => {
    const script = writeScript('this-command-does-not-exist-xyz')
    try {
      const result = await executeBash('echo still-alive', {
        sessionKey: 'init-broken',
        timeout: 20_000,
        snapshotEnabled: false,
        initScriptEnabled: true,
        initScriptPath: script,
      })
      expect(result.exitCode).toBe(0)
      expect(result.output).toContain('still-alive')
    } finally {
      fs.rmSync(script, { force: true })
    }
  }, 30_000)

  it('a missing user copy falls back to the built-in default', async () => {
    const missing = path.join(os.tmpdir(), 'dsh-init-missing-' + Date.now() + '.sh')
    const result = await executeBash('printf "P=%s" "$TOOL_PLUS_PATH_PREFIX"; echo; type -a bash 2>&1 | head -1', {
      sessionKey: 'init-missing',
      timeout: 20_000,
      snapshotEnabled: false,
      initScriptEnabled: true,
      initScriptPath: missing,
    })
    expect(result.exitCode).toBe(0)
    expect(fs.existsSync(missing)).toBe(false)
    expect(fs.existsSync(path.join(os.tmpdir(), 'tool-plus-init-default.sh'))).toBe(true)
  }, 30_000)

it('a disabled init script injects nothing into the session', async () => {
  const result = await executeBash('printf "P=%s;E=%s" "${TOOL_PLUS_PATH_PREFIX:-}" "${TOOL_PLUS_PROBE:-}"', {
    sessionKey: 'init-disabled',
    timeout: 20_000,
    snapshotEnabled: false,
    initScriptEnabled: false,
  })
  expect(result.exitCode).toBe(0)
  // Off means off: no PATH prefix for the default script and no user exports.
  expect(result.output).toContain('P=;E=')
}, 30_000)
it('the default script leaves a successful status when there is no prefix', async () => {
    const script = writeScript(DEFAULT_INIT_SCRIPT)
    try {
      // `source` reports the last command's status: the default must stay 0 when
      // TOOL_PLUS_PATH_PREFIX is empty (POSIX), or 试运行 would show exit 1 for a
      // no-op line.
      const sourcePath = script.replaceAll('\\', '/')
      const result = await executeBash(`source '${sourcePath}' && echo default-ok`, {
        sessionKey: 'init-default-status',
        timeout: 20_000,
        snapshotEnabled: false,
        initScriptEnabled: false,
        env: { TOOL_PLUS_PATH_PREFIX: '' },
      })
      expect(result.exitCode).toBe(0)
      expect(result.output).toContain('default-ok')
    } finally {
      fs.rmSync(script, { force: true })
    }
  }, 30_000)

  it.skipIf(process.platform !== 'win32')('puts the real Git dirs ahead of System32', async () => {
    const prefix = computePathPrefix()
    const script = writeScript(DEFAULT_INIT_SCRIPT)
    try {
      const result = await executeBash('printf "PATH0=%s" "$PATH"', {
        sessionKey: 'init-path',
        timeout: 20_000,
        snapshotEnabled: false,
        initScriptEnabled: true,
        initScriptPath: script,
      })
      expect(result.exitCode).toBe(0)
      if (prefix.length > 0) {
        const first = prefix.split(';')[0]
        expect(result.output).toContain('PATH0=' + first + ';')
      } else {
        expect(result.output).toContain('PATH0=')
      }
    } finally {
      fs.rmSync(script, { force: true })
    }
  }, 30_000)
})
