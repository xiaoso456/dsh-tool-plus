/**
 * rmSafe 失败诊断（无额外删除通道）。
 *
 * trash 包的 windows-trash.exe 失败时 stderr 为空、退出码 0x8000FFFF
 * （E_UNEXPECTED），用户只看到 "Command failed: <exe> <args>"。修的是
 * **信息丢失**这一根因：用 rename 探测拿文件系统的真实回答（能否移动），
 * 把 errno 映射成可读原因。不同 errno 必须分开报——权限不足不是“被占用”。
 * 不做“换一条通道再删一次”的绕行：文件被占用是真实运行时条件，任何
 * 通道都删不掉它（实测 exe 与 PowerShell 同时失败），绕行只会掩盖原因。
 *
 * 平台：win32 才做探测（其他平台的 trash 实现本身带 stderr 原因）。
 */
import { describe, expect, it } from 'vitest'
import { describeProbeCode, runTrashCli } from '../../src/tools/bash/trash-cli.ts'
import { makeDeps } from '../helpers/trash-deps.ts'

const IS_WIN32 = process.platform === 'win32'
const lstatOk = async () => ({ isDirectory: false })

describe('describeProbeCode', () => {
  it('maps EBUSY/ENOTEMPTY/PROBE_STUCK to a locked-or-unmovable reason', () => {
    for (const code of ['EBUSY', 'ENOTEMPTY', 'PROBE_STUCK']) {
      expect(describeProbeCode(code)).toContain('locked or cannot be moved')
    }
  })

  it('maps EPERM/EACCES to a permission reason, not a lock reason', () => {
    for (const code of ['EPERM', 'EACCES']) {
      const reason = describeProbeCode(code)
      expect(reason).toContain('permission denied')
      expect(reason).not.toContain('locked')
    }
  })

  it('maps ENOENT/ENOTDIR to a vanished-path reason', () => {
    for (const code of ['ENOENT', 'ENOTDIR']) {
      expect(describeProbeCode(code)).toContain('no longer exists')
    }
  })

  it('returns null for a movable path and for unknown codes', () => {
    expect(describeProbeCode(null)).toBeNull()
    expect(describeProbeCode('UNKNOWN')).toBeNull()
    expect(describeProbeCode('EMFILE')).toBeNull()
  })
})

describe('runTrashCli failure diagnostics (win32 only)', () => {
  it.skipIf(!IS_WIN32)('appends the probed lock reason when trash fails', async () => {
    const h = makeDeps({
      lstat: lstatOk,
      trash: async () => {
        throw new Error('Command failed: windows-trash.exe C:\\x\\a')
      },
      probeRename: async () => 'EBUSY',
    })
    await runTrashCli(['C:\\x\\a'], h.deps)
    expect(h.code()).toBe(1)
    const err = h.err.join('\n')
    expect(err).toContain("cannot remove 'C:\\x\\a'")
    expect(err).toContain('locked or cannot be moved')
    expect(err).not.toContain('Command failed')
  })

  it.skipIf(!IS_WIN32)('reports permission failures as such', async () => {
    const h = makeDeps({
      lstat: lstatOk,
      trash: async () => {
        throw new Error('Command failed: windows-trash.exe C:\\x\\a')
      },
      probeRename: async () => 'EPERM',
    })
    await runTrashCli(['C:\\x\\a'], h.deps)
    expect(h.code()).toBe(1)
    expect(h.err.join('\n')).toContain('permission denied')
  })

  it.skipIf(!IS_WIN32)('stays quiet for entries trash already removed (partial success)', async () => {
    const h = makeDeps({
      lstat: lstatOk,
      trash: async () => {
        throw new Error('Command failed: windows-trash.exe C:\\x\\a C:\\x\\b')
      },
      probeRename: async from => (from.endsWith('a') ? 'ENOENT' : 'EBUSY'),
    })
    await runTrashCli(['C:\\x\\a', 'C:\\x\\b'], h.deps)
    expect(h.code()).toBe(1)
    const err = h.err.join('\n')
    expect(err).not.toContain("cannot remove 'C:\\x\\a'")
    expect(err).toContain("cannot remove 'C:\\x\\b'")
  })

  it.skipIf(!IS_WIN32)('falls back to the trash message when the probe has no verdict', async () => {
    const h = makeDeps({
      lstat: lstatOk,
      trash: async () => {
        throw new Error('Command failed: windows-trash.exe C:\\x\\a')
      },
      probeRename: async () => null,
    })
    await runTrashCli(['C:\\x\\a'], h.deps)
    expect(h.code()).toBe(1)
    expect(h.err.join('\n')).toContain('Command failed')
  })

  it('keeps the original message on non-win32', async () => {
    const h = makeDeps({
      lstat: lstatOk,
      trash: async () => {
        throw new Error('Command failed: windows-trash.exe C:\\x\\a')
      },
    })
    await runTrashCli(['C:\\x\\a'], h.deps)
    if (!IS_WIN32) expect(h.err.join('\n')).toContain('Command failed')
    else expect(h.code()).toBe(1)
  })
})