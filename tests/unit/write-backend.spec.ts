/**
 * 写入通道实验项（writeBackend / writeRetry）回归：
 * - 两种后端的错误识别与重试边界；
 * - 共享通道按配置选 DSH ctx.fs 或 OMP 直写；
 * - edit 与 write 都吃到同一份配置。
 * @module tests
 */

import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveConfig } from '../../src/config/settings.ts'
import { executeEditTool } from '../../src/tools/edit/adapter/index.ts'
import { executeReadTool } from '../../src/tools/read/adapter/index.ts'
import { writeWithRetry } from '../../src/tools/shared/atomic-write-retry.ts'
import {
  backoffFor,
  isNativeWriteContention,
  isReplaceFileContention,
  normalizeRetries,
} from '../../src/tools/shared/atomic-write-retry.ts'
import { createWriteChannel } from '../../src/tools/shared/write-channel.ts'
import { executeWriteTool } from '../../src/tools/write/adapter/index.ts'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-write-backend-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function execFor(cwd: string): any {
  return { agent: { session: { header: { cwd } } }, signal: undefined }
}

function errno(code: string, message = 'busy'): Error {
  return Object.assign(new Error(message), { code })
}

const CONFLICTED = [
  'def choose():',
  '<<<<<<< HEAD',
  '    print("ours")',
  '=======',
  '    print("theirs")',
  '>>>>>>> feature',
  '    return None',
  '',
].join('\n')

function dshCtx(writeText: (target: any, content: string) => Promise<unknown>, policy?: any): any {
  return {
    fs: {
      sandboxMode: policy === undefined ? undefined : 'workspace-write',
      resolve: async (p: string) => ({ path: p, displayPath: p }),
      writeText,
    },
    get: (name: string) => (name === 'sandboxPolicy' ? { resolve: () => policy } : undefined),
  }
}

describe('写入错误的识别边界', () => {
  it('DSH 只认 1175 / 32，1176 / 1177 不重试', () => {
    for (const code of [1175, 32]) {
      expect(isReplaceFileContention(new Error('ReplaceFileW EIO (Win32 ' + code + '): x'))).toBe(true)
    }
    for (const code of [1176, 1177, 5, 2]) {
      expect(isReplaceFileContention(new Error('ReplaceFileW EIO (Win32 ' + code + '): x'))).toBe(false)
    }
    expect(isReplaceFileContention(new Error('EACCES: permission denied'))).toBe(false)
  })

  it('DSH 识别 cause 链里的 1175', () => {
    const outer = Object.assign(new Error('cannot write "x"'), { cause: new Error('ReplaceFileW EIO (Win32 1175): x') })
    expect(isReplaceFileContention(outer)).toBe(true)
  })

  it('原生只认 EBUSY，EPERM / EACCES 不重试', () => {
    expect(isNativeWriteContention(errno('EBUSY'))).toBe(true)
    expect(isNativeWriteContention(errno('EPERM'))).toBe(false)
    expect(isNativeWriteContention(errno('EACCES'))).toBe(false)
    expect(isNativeWriteContention(errno('ENOENT'))).toBe(false)
  })

  it('原生识别 cause 链里的 EBUSY', () => {
    const outer = Object.assign(new Error('write failed'), { cause: errno('EBUSY') })
    expect(isNativeWriteContention(outer)).toBe(true)
  })

  it('非 Error / 循环 cause 不抛也不误判', () => {
    for (const value of [null, undefined, 'ReplaceFileW EIO (Win32 1175)', {}, { code: 1175 }]) {
      expect(isReplaceFileContention(value)).toBe(false)
      expect(isNativeWriteContention(value)).toBe(false)
    }
    const loop: any = new Error('no code')
    loop.cause = loop
    expect(isReplaceFileContention(loop)).toBe(false)
    expect(isNativeWriteContention(loop)).toBe(false)
  })

  it('大小写和错误码前缀差异不误判', () => {
    expect(isReplaceFileContention(new Error('replacefilew eio (win32 1175): x'))).toBe(false)
    expect(isReplaceFileContention(new Error('ReplaceFileW EIO (Win32 11750): x'))).toBe(false)
    expect(isNativeWriteContention(errno('ebusy'))).toBe(false)
  })

  it('FsError 包装不影响识别', () => {
    const wrapped = Object.assign(new Error('cannot write "x": ReplaceFileW EIO (Win32 32): x'), { code: 'FS_IO_ERROR' })
    expect(isReplaceFileContention(wrapped)).toBe(true)
  })
})

describe('writeWithRetry', () => {
  it('次数 clamp 到 0 到 10', () => {
    expect(normalizeRetries(-3)).toBe(0)
    expect(normalizeRetries(0)).toBe(0)
    expect(normalizeRetries(3.9)).toBe(3)
    expect(normalizeRetries(99)).toBe(10)
  })

  it('失败两次后成功，按 50 / 150 退避', async () => {
    let calls = 0
    const sleeps: number[] = []
    await writeWithRetry(
      async () => {
        calls++
        if (calls <= 2) throw new Error('ReplaceFileW EIO (Win32 1175): x')
      },
      { retries: 2, isRetryable: isReplaceFileContention, sleep: async (ms) => { sleeps.push(ms) } },
    )
    expect(calls).toBe(3)
    expect(sleeps).toEqual([50, 150])
  })

  it('次数用尽后抛原始错误', async () => {
    let calls = 0
    const failure = new Error('ReplaceFileW EIO (Win32 1175): x')
    await expect(
      writeWithRetry(
        async () => {
          calls++
          throw failure
        },
        { retries: 2, isRetryable: isReplaceFileContention, sleep: async () => {} },
      ),
    ).rejects.toBe(failure)
    expect(calls).toBe(3)
  })

  it('不可重试的错误只写一次', async () => {
    let calls = 0
    await expect(
      writeWithRetry(
        async () => {
          calls++
          throw errno('EACCES')
        },
        { retries: 3, isRetryable: isNativeWriteContention, sleep: async () => {} },
      ),
    ).rejects.toBeInstanceOf(Error)
    expect(calls).toBe(1)
  })

  it('abort 后不再重试', async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    await expect(
      writeWithRetry(
        async () => {
          calls++
          throw errno('EBUSY')
        },
        { retries: 2, signal: controller.signal, isRetryable: isNativeWriteContention, sleep: async () => {} },
      ),
    ).rejects.toBeInstanceOf(Error)
    expect(calls).toBe(1)
  })

  it('退避期间 abort 也停止', async () => {
    const controller = new AbortController()
    let calls = 0
    await expect(
      writeWithRetry(
        async () => {
          calls++
          throw errno('EBUSY')
        },
        {
          retries: 2,
          signal: controller.signal,
          isRetryable: isNativeWriteContention,
          sleep: async () => { controller.abort() },
        },
      ),
    ).rejects.toBeInstanceOf(Error)
    // 退避期间 abort：醒来先判 signal，不再发起第二次写。
    expect(calls).toBe(1)
  })

  it('成功路径不调用匹配器、不等待', async () => {
    let matcher = 0
    let sleeps = 0
    await writeWithRetry(async () => {}, {
      retries: 3,
      isRetryable: () => {
        matcher++
        return true
      },
      sleep: async () => {
        sleeps++
      },
    })
    expect(matcher).toBe(0)
    expect(sleeps).toBe(0)
  })

  it('次数为 0 时不重试也不等待', async () => {
    let calls = 0
    await expect(
      writeWithRetry(
        async () => {
          calls++
          throw errno('EBUSY')
        },
        {
          retries: 0,
          isRetryable: isNativeWriteContention,
          sleep: async () => {
            throw new Error('must not sleep')
          },
        },
      ),
    ).rejects.toBeInstanceOf(Error)
    expect(calls).toBe(1)
  })

  it('次数上限 10：最多写 11 次', async () => {
    let calls = 0
    await expect(
      writeWithRetry(
        async () => {
          calls++
          throw errno('EBUSY')
        },
        { retries: 99, isRetryable: isNativeWriteContention, sleep: async () => {} },
      ),
    ).rejects.toBeInstanceOf(Error)
    expect(calls).toBe(11)
  })

  it('退避表 50 / 150 / 400 后翻倍并封顶 1 秒', () => {
    expect([0, 1, 2, 3, 4, 5].map(n => backoffFor(n))).toEqual([50, 150, 400, 800, 1000, 1000])
  })

  it('退避把 signal 原样传给 sleep', async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    await expect(
      writeWithRetry(
        async () => {
          throw errno('EBUSY')
        },
        {
          retries: 1,
          signal: controller.signal,
          isRetryable: isNativeWriteContention,
          sleep: async (_ms, signal) => {
            seen = signal
          },
        },
      ),
    ).rejects.toBeInstanceOf(Error)
    expect(seen).toBe(controller.signal)
  })
})

describe('createWriteChannel', () => {
  it('DSH 通道走 ctx.fs，policy 作为第 5 参，忽略 file 句柄', async () => {
    const calls: any[] = []
    const policy = { mode: 'workspace-write', workspaceRoot: 'D:/w' }
    const ctx = dshCtx(async (...args: any[]) => { calls.push(args) }, policy)
    const channel = createWriteChannel(ctx, execFor('D:/w'), resolveConfig({ writeBackend: 'dsh', writeRetryEnabled: false }))
    await channel('D:/w/a.txt', 'x', undefined, {
      write: async () => { throw new Error('file handle must not be used') },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toBe('x')
    expect(calls[0][4]).toEqual(policy)
  })

  it('DSH 通道遇到 1175 会重试', async () => {
    let attempts = 0
    const ctx = dshCtx(async () => {
      attempts++
      if (attempts === 1) throw new Error('ReplaceFileW EIO (Win32 1175): x')
    })
    const channel = createWriteChannel(ctx, execFor('D:/w'), resolveConfig({ writeBackend: 'dsh', writeRetryEnabled: true, writeRetryCount: 1 }))
    await channel('D:/w/a.txt', 'x')
    expect(attempts).toBe(2)
  })

  it('原生通道不碰 ctx.fs，写盘成功', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'native.txt')
    const ctx = dshCtx(async () => { throw new Error('ctx.fs must not be used') })
    const channel = createWriteChannel(ctx, execFor(dir), resolveConfig({ writeBackend: 'native', writeRetryEnabled: false }))
    await channel(file, 'native')
    expect(fs.readFileSync(file, 'utf-8')).toBe('native')
  })

  it('原生通道遇到 EBUSY 会重试', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'native-retry.txt')
    let calls = 0
    const fileHandle = {
      write: async (content: string) => {
        calls++
        if (calls === 1) throw errno('EBUSY')
        fs.writeFileSync(file, content)
      },
    }
    const channel = createWriteChannel(undefined, execFor(dir), resolveConfig({ writeBackend: 'native', writeRetryEnabled: true, writeRetryCount: 1 }))
    await channel(file, 'retried', undefined, fileHandle)
    expect(calls).toBe(2)
    expect(fs.readFileSync(file, 'utf-8')).toBe('retried')
  })

  it('DSH 无 confining 后端时 policy 为 undefined', async () => {
    const calls: any[] = []
    const ctx = dshCtx(async (...args: any[]) => { calls.push(args) })
    const channel = createWriteChannel(ctx, execFor('D:/w'), resolveConfig({ writeBackend: 'dsh', writeRetryEnabled: false }))
    await channel('D:/w/a.txt', 'x')
    expect(calls[0][4]).toBeUndefined()
  })

  it('DSH 关闭重试后 1175 直接抛', async () => {
    let attempts = 0
    const ctx = dshCtx(async () => {
      attempts++
      throw new Error('ReplaceFileW EIO (Win32 1175): x')
    })
    const channel = createWriteChannel(ctx, execFor('D:/w'), resolveConfig({ writeBackend: 'dsh', writeRetryEnabled: false }))
    await expect(channel('D:/w/a.txt', 'x')).rejects.toThrow(/1175/)
    expect(attempts).toBe(1)
  })

  it('DSH 遇 1176 不重试', async () => {
    let attempts = 0
    const ctx = dshCtx(async () => {
      attempts++
      throw new Error('ReplaceFileW EIO (Win32 1176): x')
    })
    const channel = createWriteChannel(ctx, execFor('D:/w'), resolveConfig({ writeBackend: 'dsh', writeRetryEnabled: true, writeRetryCount: 3 }))
    await expect(channel('D:/w/a.txt', 'x')).rejects.toThrow(/1176/)
    expect(attempts).toBe(1)
  })

  it('DSH 遇 32 也会重试', async () => {
    let attempts = 0
    const ctx = dshCtx(async () => {
      attempts++
      if (attempts === 1) throw new Error('ReplaceFileW EIO (Win32 32): x')
    })
    const channel = createWriteChannel(ctx, execFor('D:/w'), resolveConfig({ writeBackend: 'dsh', writeRetryEnabled: true, writeRetryCount: 1 }))
    await channel('D:/w/a.txt', 'x')
    expect(attempts).toBe(2)
  })

  it('resolve 失败不重试', async () => {
    let writes = 0
    const ctx: any = {
      fs: {
        sandboxMode: undefined,
        resolve: async () => {
          throw errno('ENOENT')
        },
        writeText: async () => {
          writes++
        },
      },
      get: () => undefined,
    }
    const channel = createWriteChannel(ctx, execFor('D:/w'), resolveConfig({ writeBackend: 'dsh', writeRetryEnabled: true, writeRetryCount: 3 }))
    await expect(channel('D:/w/a.txt', 'x')).rejects.toBeInstanceOf(Error)
    expect(writes).toBe(0)
  })

  it('原生关闭重试后 EBUSY 直接抛', async () => {
    const dir = tmpDir()
    let calls = 0
    const fileHandle = {
      write: async () => {
        calls++
        throw errno('EBUSY')
      },
    }
    const channel = createWriteChannel(undefined, execFor(dir), resolveConfig({ writeBackend: 'native', writeRetryEnabled: false }))
    await expect(channel(path.join(dir, 'x.txt'), 'x', undefined, fileHandle)).rejects.toBeInstanceOf(Error)
    expect(calls).toBe(1)
  })

  it('原生遇 EPERM 不重试', async () => {
    const dir = tmpDir()
    let calls = 0
    const fileHandle = {
      write: async () => {
        calls++
        throw errno('EPERM')
      },
    }
    const channel = createWriteChannel(undefined, execFor(dir), resolveConfig({ writeBackend: 'native', writeRetryEnabled: true, writeRetryCount: 3 }))
    await expect(channel(path.join(dir, 'x.txt'), 'x', undefined, fileHandle)).rejects.toBeInstanceOf(Error)
    expect(calls).toBe(1)
  })

  it('无 ctx 时即使配置 dsh 也回退原生', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'fallback.txt')
    const channel = createWriteChannel(undefined, execFor(dir), resolveConfig({ writeBackend: 'dsh', writeRetryEnabled: false }))
    await channel(file, 'fallback')
    expect(fs.readFileSync(file, 'utf-8')).toBe('fallback')
  })

  it('未知 backend 值回退 DSH', async () => {
    const calls: any[] = []
    const ctx = dshCtx(async (...args: any[]) => { calls.push(args) })
    const cfg = { ...resolveConfig({}), writeBackend: 'bogus' as any }
    const channel = createWriteChannel(ctx, execFor('D:/w'), cfg)
    await channel('D:/w/a.txt', 'x')
    expect(calls).toHaveLength(1)
  })
})

describe('edit / write 都吃 writeBackend', () => {
  it('write 选 DSH 时走 ctx.fs.writeText', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'write-dsh.txt')
    const seen: string[] = []
    const ctx = dshCtx(async (target: any, content: string) => {
      seen.push(content)
      fs.writeFileSync(target.path, content)
    })
    await executeWriteTool(execFor(dir), resolveConfig({ writeBackend: 'dsh', writeRetryEnabled: false }), { path: file, content: 'dsh' }, ctx)
    expect(seen).toEqual(['dsh'])
    expect(fs.readFileSync(file, 'utf-8')).toBe('dsh')
  })

  it('write 选原生时绕过 ctx.fs', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'write-native.txt')
    const ctx = dshCtx(async () => { throw new Error('ctx.fs must not be used') })
    await executeWriteTool(execFor(dir), resolveConfig({ writeBackend: 'native', writeRetryEnabled: false }), { path: file, content: 'native' }, ctx)
    expect(fs.readFileSync(file, 'utf-8')).toBe('native')
  })

  it('edit 选 DSH 时走 ctx.fs.writeText', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'edit-dsh.txt')
    fs.writeFileSync(file, 'old\n')
    const seen: string[] = []
    const ctx = dshCtx(async (target: any, content: string) => {
      seen.push(content)
      fs.writeFileSync(target.path, content)
    })
    await executeEditTool(execFor(dir), resolveConfig({ writeBackend: 'dsh', writeRetryEnabled: false }), {
      file_path: file,
      old_string: 'old',
      new_string: 'new',
    }, ctx)
    expect(seen).toEqual(['new\n'])
    expect(fs.readFileSync(file, 'utf-8')).toBe('new\n')
  })

  it('edit 选原生时绕过 ctx.fs', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'edit-native.txt')
    fs.writeFileSync(file, 'old\n')
    const ctx = dshCtx(async () => { throw new Error('ctx.fs must not be used') })
    await executeEditTool(execFor(dir), resolveConfig({ writeBackend: 'native', writeRetryEnabled: false }), {
      file_path: file,
      old_string: 'old',
      new_string: 'new',
    }, ctx)
    expect(fs.readFileSync(file, 'utf-8')).toBe('new\n')
  })

  it('write DSH 遇 1175 重试后成功', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'write-retry.txt')
    let writes = 0
    const ctx = dshCtx(async (target: any, content: string) => {
      writes++
      if (writes === 1) throw new Error('ReplaceFileW EIO (Win32 1175): x')
      fs.writeFileSync(target.path, content)
    })
    await executeWriteTool(
      execFor(dir),
      resolveConfig({ writeBackend: 'dsh', writeRetryEnabled: true, writeRetryCount: 1 }),
      { path: file, content: 'retried' },
      ctx,
    )
    expect(writes).toBe(2)
    expect(fs.readFileSync(file, 'utf-8')).toBe('retried')
  })

  it('write DSH 遇 1176 不重试', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'write-1176.txt')
    let writes = 0
    const ctx = dshCtx(async () => {
      writes++
      throw new Error('ReplaceFileW EIO (Win32 1176): x')
    })
    await expect(
      executeWriteTool(
        execFor(dir),
        resolveConfig({ writeBackend: 'dsh', writeRetryEnabled: true, writeRetryCount: 3 }),
        { path: file, content: 'x' },
        ctx,
      ),
    ).rejects.toThrow(/1176/)
    expect(writes).toBe(1)
  })

  it('write DSH 把 policy 传到第 5 参', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'write-policy.txt')
    const policy = { mode: 'workspace-write', workspaceRoot: dir }
    const calls: any[] = []
    const ctx = dshCtx(async (...args: any[]) => {
      calls.push(args)
      fs.writeFileSync(args[0].path, args[1])
    }, policy)
    await executeWriteTool(execFor(dir), resolveConfig({ writeBackend: 'dsh', writeRetryEnabled: false }), { path: file, content: 'p' }, ctx)
    expect(calls[0][4]).toEqual(policy)
  })

  it('edit DSH 遇 1175 重试后成功', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'edit-retry.txt')
    fs.writeFileSync(file, 'old\n')
    let writes = 0
    const ctx = dshCtx(async (target: any, content: string) => {
      writes++
      if (writes === 1) throw new Error('ReplaceFileW EIO (Win32 1175): x')
      fs.writeFileSync(target.path, content)
    })
    await executeEditTool(
      execFor(dir),
      resolveConfig({ writeBackend: 'dsh', writeRetryEnabled: true, writeRetryCount: 1 }),
      { file_path: file, old_string: 'old', new_string: 'new' },
      ctx,
    )
    expect(writes).toBe(2)
    expect(fs.readFileSync(file, 'utf-8')).toBe('new\n')
  })

  it('write conflict:// 也走注入的 DSH 通道', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'conflicted.py')
    fs.writeFileSync(file, CONFLICTED)
    const session = { header: { cwd: dir } }
    const exec = { agent: { session }, signal: undefined }
    await executeReadTool(exec, {} as never, { path: file }, null as never)
    const calls: string[] = []
    const ctx = dshCtx(async (target: any, content: string) => {
      calls.push(content)
      fs.writeFileSync(target.path, content)
    })
    const out = await executeWriteTool(
      exec,
      resolveConfig({ writeBackend: 'dsh', writeRetryEnabled: false }),
      { path: 'conflict://1', content: '@theirs' },
      ctx,
    )
    expect(calls).toHaveLength(1)
    expect(out.text).toContain('Resolved conflict #1')
    const after = fs.readFileSync(file, 'utf-8')
    expect(after).not.toContain('<<<<<<<')
    expect(after).toContain('    print("theirs")')
  })
})
