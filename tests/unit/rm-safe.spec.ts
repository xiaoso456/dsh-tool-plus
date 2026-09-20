/**
 * rmSafe: rm 重定义脚本生成、快照注入、注入状态查询、状态文案与后台透传。
 *
 * 本文件是 rmSafe 的规范单元测试，合并自四个文件：
 * - rm-safe.spec.ts（原内容：rmSafeScript / injectRmSafe / win32 快照注入点）
 * - rm-safe-status.spec.ts（注入状态查询）
 * - rm-safe-status-text.spec.ts（状态文案）
 * - background-rm-safe.spec.ts（后台任务 rmSafe 透传）
 *
 * 关注点：
 * - rmSafeScript：生成 bash 函数定义（rm → node trash-cli）；
 * - injectRmSafe：向快照文件内联追加函数定义，幂等（不重复追加）；
 * - win32 快照：getOrCreateSnapshot 在 Windows 上不再返回 null，而是生成
 *   "仅注入"快照文件，让 rmSafe 在 Windows Git bash 也生效；
 * - 注入状态查询：探测输出解析、Windows 路径转换、运行时探测与状态机；
 * - 状态文案：rmSafe/status 结果 → 本地化文案的纯映射；
 * - 后台透传：startBashJob 必须把 config 的 rmSafe 透传给 executeBash。
 */
import { describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { injectRmSafe, rmSafeScript } from '../../src/tools/bash/rm-safe.ts'
import { getOrCreateSnapshot } from '../../src/tools/bash/shell-snapshot.ts'
import {
  parseProbeOutput,
  probeRmSafeRuntime,
  queryRmSafeStatus,
  toGitBashPath,
  type RmSafeStatusDeps,
} from '../../src/tools/bash/rm-safe-status.ts'
import { rmSafeStatusText } from '../../src/client/rm-safe-status-text.ts'
import { zh } from '../../src/client/locales.ts'
import { resolveConfig } from '../../src/config/settings.ts'

// Regression: the background path (startBashJob) used to call executeBash
// without `rmSafe`, so every auto-backgrounded / explicitly backgrounded
// command skipped the rm → trash injection (snapshots stayed 60B, rm stayed
// the system command). The foreground path always passed it; the background
// path must mirror it from the resolved config.
const { executeBashMock } = vi.hoisted(() => ({ executeBashMock: vi.fn() }))

vi.mock('../../src/tools/bash/bash-executor.ts', () => ({
  executeBash: (...args: unknown[]) => executeBashMock(...args),
}))

import { startBashJob } from '../../src/tools/bash/background.ts'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rm-safe-test-'))
}

// 状态文案测试用的翻译函数：只取 zh 里对应 key 的字面量。
const t = (key: Parameters<typeof rmSafeStatusText>[0] extends (k: infer K) => string ? K : never): string => zh[key]

describe('rmSafeScript', () => {
  it('生成 bash 函数定义，内嵌 node 与 cli 绝对路径', () => {
    const script = rmSafeScript('C:/node.exe', 'C:/plugin/lib/trash-cli.mjs')
    expect(script).toContain('rm()')
    expect(script).toContain("'C:/node.exe'")
    expect(script).toContain("'C:/plugin/lib/trash-cli.mjs'")
    expect(script).toContain('"$@"')
  })

  it('路径含单引号时正确转义', () => {
    const script = rmSafeScript('/opt/node', "/opt/it's/lib/trash-cli.mjs")
    expect(script).toContain("'/opt/it'\\''s/lib/trash-cli.mjs'")
  })
})

describe('injectRmSafe', () => {
  it('向快照文件内联追加 rm 函数定义', () => {
    const dir = tmpDir()
    const snapshot = path.join(dir, 'snapshot.sh')
    fs.writeFileSync(snapshot, '# header\n')
    injectRmSafe(snapshot, 'C:/node.exe', 'C:/plugin/lib/trash-cli.mjs')
    const content = fs.readFileSync(snapshot, 'utf8')
    expect(content).toContain('# dsh-tool-plus rmSafe')
    expect(content).toContain('rm()')
    expect(content).toContain("'C:/node.exe' 'C:/plugin/lib/trash-cli.mjs' \"$@\"")
    expect(content.startsWith('# header\n')).toBe(true)
  })

  it('幂等：重复注入不追加第二遍', () => {
    const dir = tmpDir()
    const snapshot = path.join(dir, 'snapshot.sh')
    fs.writeFileSync(snapshot, '# header\n')
    injectRmSafe(snapshot, 'C:/node.exe', 'C:/plugin/lib/trash-cli.mjs')
    injectRmSafe(snapshot, 'C:/node.exe', 'C:/plugin/lib/trash-cli.mjs')
    const content = fs.readFileSync(snapshot, 'utf8')
    expect(content.match(/rm\(\)/g)).toHaveLength(1)
  })

  it('快照文件不可读时返回 false（不抛异常）', () => {
    const dir = tmpDir()
    const missing = path.join(dir, 'no-such-snapshot.sh')
    expect(injectRmSafe(missing, 'C:/node.exe', 'C:/plugin/lib/trash-cli.mjs')).toBe(false)
  })
})

describe('win32 快照注入点', () => {
  it('Windows 上 getOrCreateSnapshot 返回非 null 的注入文件', async () => {
    if (process.platform !== 'win32') return
    const snapshotPath = await getOrCreateSnapshot('bash', {})
    expect(snapshotPath).not.toBeNull()
    expect(fs.existsSync(snapshotPath!)).toBe(true)
  })
})

describe('注入状态查询（原 rm-safe-status.spec.ts）', () => {
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
        nodePath: vi.fn(() => '/usr/bin/node'),
        cliPath: vi.fn(() => '/tmp/trash-cli.mjs'),
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
      expect(d.inject).not.toHaveBeenCalled()
    })

    it('injects with the resolved node and cli paths', async () => {
      const d = deps()
      await queryRmSafeStatus(d)
      expect(d.inject).toHaveBeenCalledWith('/tmp/snapshot.sh', '/usr/bin/node', '/tmp/trash-cli.mjs')
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

})

describe('状态文案（原 rm-safe-status-text.spec.ts）', () => {
  describe('rmSafeStatusText', () => {
    it('announces a verified injection', () => {
      expect(rmSafeStatusText(t, { status: 'injected', runtime: 'function' }))
        .toBe('安全 rm 已注入并验证：rm 进入回收站')
    })

    it('announces an unverified injection', () => {
      expect(rmSafeStatusText(t, { status: 'injected', runtime: 'unknown' }))
        .toBe('安全 rm 已注入（运行时验证不可用）')
    })

    it('maps every failure reason into the failed message', () => {
      const reasons = [
        'snapshot-unavailable',
        'cli-missing',
        'script-write-failed',
        'snapshot-write-failed',
        'runtime-not-effective',
      ] as const
      for (const reason of reasons) {
        const text = rmSafeStatusText(t, { status: 'failed', reason })
        expect(text).toContain('安全 rm 注入失败')
        expect(text).not.toContain('{reason}')
      }
    })

    it('maps disabled to the empty string', () => {
      expect(rmSafeStatusText(t, { status: 'disabled' })).toBe('')
    })
  })

})

describe('后台任务 rmSafe 透传（原 background-rm-safe.spec.ts）', () => {
  describe('background job rmSafe passthrough', () => {
    it('passes rmSafe: true from the resolved config to executeBash', async () => {
      executeBashMock.mockReset()
      executeBashMock.mockResolvedValue({
        output: 'ok',
        exitCode: 0,
        cancelled: false,
        timedOut: false,
        workingDir: undefined,
        spillPath: undefined,
        truncated: false,
      })
      const config = resolveConfig({})
      const job = startBashJob({
        sessionId: 'spec',
        command: 'echo ok',
        cwd: process.cwd(),
        timeoutMs: 5000,
        env: undefined,
        config,
      })
      const value = await job.completion
      expect(value.output.text).toBe('ok')
      expect(executeBashMock).toHaveBeenCalledTimes(1)
      const options = executeBashMock.mock.calls[0][1] as Record<string, unknown>
      expect(options.rmSafe).toBe(true)
    })

    it('passes rmSafe: false when the config disables it', async () => {
      executeBashMock.mockReset()
      executeBashMock.mockResolvedValue({
        output: 'ok',
        exitCode: 0,
        cancelled: false,
        timedOut: false,
        workingDir: undefined,
        spillPath: undefined,
        truncated: false,
      })
      const config = resolveConfig({ rmSafe: false })
      const job = startBashJob({
        sessionId: 'spec',
        command: 'echo ok',
        cwd: process.cwd(),
        timeoutMs: 5000,
        env: undefined,
        config,
      })
      await job.completion
      const options = executeBashMock.mock.calls[0][1] as Record<string, unknown>
      expect(options.rmSafe).toBe(false)
    })
  })

})
