/**
 * rmSafe 注入状态查询：探测输出解析、Windows 路径转换、运行时探测与
 * 状态机（文件层 + 运行时层）的单元测试。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  parseProbeOutput,
  probeRmSafeRuntime,
  queryRmSafeStatus,
  toGitBashPath,
  type RmSafeStatusDeps,
} from '../../src/tools/bash/rm-safe-status.ts'

describe('parseProbeOutput', () => {
  it('recognizes a redefined rm function', () => {
    expect(parseProbeOutput('rm is a function\n')).toBe('function')
  })

  it('recognizes the system command', () => {
    expect(parseProbeOutput('rm is /usr/bin/rm\n')).toBe('system')
    expect(parseProbeOutput('rm is hashed (/usr/bin/rm)\n')).toBe('system')
  })

  it('treats empty output as the system command', () => {
    expect(parseProbeOutput('')).toBe('system')
  })

  it('matches the function marker anywhere in combined type/declare output', () => {
    const combined = 'rm is a function\nrm () \n{\n    /path/node /path/trash-cli.mjs "$@"\n}\n'
    expect(parseProbeOutput(combined)).toBe('function')
  })
})

describe('toGitBashPath', () => {
  it('converts a drive path to git-bash form', () => {
    expect(toGitBashPath('C:\\Users\\x\\snapshot.sh')).toBe('/c/Users/x/snapshot.sh')
    expect(toGitBashPath('D:/tmp/rm-safe.sh')).toBe('/d/tmp/rm-safe.sh')
  })

  it('normalizes backslashes for non-drive paths', () => {
    expect(toGitBashPath('foo\\bar\\baz')).toBe('foo/bar/baz')
  })
})

describe('probeRmSafeRuntime', () => {
  const spawnShell = vi.fn()

  it('reports function when the snapshot redefines rm', async () => {
    spawnShell.mockResolvedValue({ stdout: 'rm is a function\n', timedOut: false })
    const result = await probeRmSafeRuntime('/bin/bash', '/tmp/snapshot.sh', { spawnShell })
    expect(result).toBe('function')
    expect(spawnShell).toHaveBeenCalledWith('/bin/bash', ['-c', expect.stringContaining('source')], 5_000)
  })

  it('reports system when rm is not redefined', async () => {
    spawnShell.mockResolvedValue({ stdout: 'rm is /usr/bin/rm\n', timedOut: false })
    await expect(probeRmSafeRuntime('/bin/bash', '/tmp/snapshot.sh', { spawnShell })).resolves.toBe('system')
  })

  it('reports unknown on timeout', async () => {
    spawnShell.mockResolvedValue({ stdout: '', timedOut: true })
    await expect(probeRmSafeRuntime('/bin/bash', '/tmp/snapshot.sh', { spawnShell })).resolves.toBe('unknown')
  })

  it('reports unknown when the shell cannot spawn', async () => {
    spawnShell.mockRejectedValue(new Error('spawn ENOENT'))
    await expect(probeRmSafeRuntime('/bin/bash', '/tmp/snapshot.sh', { spawnShell })).resolves.toBe('unknown')
  })
})

describe('queryRmSafeStatus', () => {
  function deps(overrides: Partial<RmSafeStatusDeps> = {}): RmSafeStatusDeps {
    return {
      getOrCreateSnapshot: vi.fn(async () => '/tmp/snapshot.sh'),
      cliExists: vi.fn(() => true),
      ensureScript: vi.fn(() => '/tmp/dsh-bash-plus/rm-safe.sh'),
      inject: vi.fn(() => true),
      probe: vi.fn(async () => 'function' as const),
      ...overrides,
    }
  }

  it('reports snapshot-unavailable when the snapshot cannot be created', async () => {
    const d = deps({ getOrCreateSnapshot: vi.fn(async () => null) })
    await expect(queryRmSafeStatus(d)).resolves.toEqual({ status: 'failed', reason: 'snapshot-unavailable' })
    expect(d.cliExists).not.toHaveBeenCalled()
  })

  it('reports cli-missing when the trash-cli artifact is absent', async () => {
    const d = deps({ cliExists: vi.fn(() => false) })
    await expect(queryRmSafeStatus(d)).resolves.toEqual({ status: 'failed', reason: 'cli-missing' })
    expect(d.ensureScript).not.toHaveBeenCalled()
  })

  it('reports script-write-failed when the script cannot be ensured', async () => {
    const d = deps({ ensureScript: vi.fn(() => null) })
    await expect(queryRmSafeStatus(d)).resolves.toEqual({ status: 'failed', reason: 'script-write-failed' })
    expect(d.inject).not.toHaveBeenCalled()
  })

  it('reports snapshot-write-failed when the injection cannot be appended', async () => {
    const d = deps({ inject: vi.fn(() => false) })
    await expect(queryRmSafeStatus(d)).resolves.toEqual({ status: 'failed', reason: 'snapshot-write-failed' })
    expect(d.probe).not.toHaveBeenCalled()
  })

  it('reports injected with runtime function when the probe confirms it', async () => {
    const d = deps()
    await expect(queryRmSafeStatus(d)).resolves.toEqual({ status: 'injected', runtime: 'function' })
  })

  it('reports runtime-not-effective when a fresh session still has the system rm', async () => {
    const d = deps({ probe: vi.fn(async () => 'system' as const) })
    await expect(queryRmSafeStatus(d)).resolves.toEqual({ status: 'failed', reason: 'runtime-not-effective' })
  })

  it('reports injected with runtime unknown when the probe is unavailable', async () => {
    const d = deps({ probe: vi.fn(async () => 'unknown' as const) })
    await expect(queryRmSafeStatus(d)).resolves.toEqual({ status: 'injected', runtime: 'unknown' })
  })
})
