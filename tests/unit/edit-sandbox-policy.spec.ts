/**
 * 方案A 回归（2026-08-27）：edit 适配层写通道策略全覆盖。
 *
 * 缺陷（P1，tool-plus-lab 真机实测发现）：replace 模式经 ctx.fs.writeText 时
 * 缺第 5 参 per-call sandboxPolicy，被宿主部署回退 workspace-write 拒绝
 * （FS_SANDBOX_DENIED）；而 patch/hashline 模式借 OMP file 句柄直写绕过沙箱。
 * 修复：createWritethrough 忽略 file 句柄、全部走 ctx.fs，并按官方 tool-fs
 * 语义解析 per-call policy（sandboxMode 能力事实 + sandboxPolicy.resolve）。
 */
import { describe, expect, it } from 'vitest'
import { createWritethrough } from '../../src/tools/edit/adapter/index.ts'
import { resolveSandboxPolicy } from '../../src/tools/shared/sandbox-policy.ts'

function execFor(cwd: string): any {
  return { agent: { session: { header: { cwd } } }, signal: undefined }
}

function mockCtx(opts: { sandboxMode?: string; policy?: any }) {
  const writeCalls: any[][] = []
  const ctx: any = {
    fs: {
      sandboxMode: opts.sandboxMode,
      resolve: async (p: string) => ({ path: p, displayPath: p }),
      writeText: async (...args: any[]) => {
        writeCalls.push(args)
        return { path: args[0] }
      },
    },
    get(name: string) {
      return name === 'sandboxPolicy' ? opts.policy : undefined
    },
  }
  return { ctx, writeCalls }
}

describe('resolveSandboxPolicy（官方 tool-fs 语义对齐）', () => {
  it('无 confining 后端（sandboxMode undefined）→ undefined', () => {
    const { ctx } = mockCtx({})
    expect(resolveSandboxPolicy(ctx, execFor('D:/w'))).toBeUndefined()
  })

  it('confining 后端 + 服务在场 → resolve({ session }) 结果', () => {
    const resolved = { mode: 'workspace-write', workspaceRoot: 'D:/w' }
    const { ctx } = mockCtx({
      sandboxMode: 'workspace-write',
      policy: { resolve: (req: any) => ({ mode: 'workspace-write', workspaceRoot: req.session.header.cwd }) },
    })
    expect(resolveSandboxPolicy(ctx, execFor('D:/w'))).toEqual(resolved)
  })

  it('confining 后端但服务缺失 → 优雅降级 undefined（不抛）', () => {
    const { ctx } = mockCtx({ sandboxMode: 'workspace-write' })
    expect(resolveSandboxPolicy(ctx, execFor('D:/w'))).toBeUndefined()
  })

  it('exec 无 agent → resolve({}) 空请求', () => {
    const seen: any[] = []
    const { ctx } = mockCtx({
      sandboxMode: 'workspace-write',
      policy: {
        resolve: (req: any) => (seen.push(req), { mode: 'workspace-write', workspaceRoot: 'D:/w' }),
      },
    })
    expect(resolveSandboxPolicy(ctx, { signal: undefined })).toEqual({
      mode: 'workspace-write',
      workspaceRoot: 'D:/w',
    })
    expect(seen[0]).toEqual({})
  })
})

describe('createWritethrough（方案A 收敛）', () => {
  it('忽略 file 句柄，policy 作为 writeText 第 5 参', async () => {
    const { ctx, writeCalls } = mockCtx({
      sandboxMode: 'workspace-write',
      policy: { resolve: (req: any) => ({ mode: 'workspace-write', workspaceRoot: req.session.header.cwd }) },
    })
    const writethrough = createWritethrough(ctx, execFor('D:/w'))
    const bombFile = {
      write: async () => {
        throw new Error('OMP file handle must not be used')
      },
    }
    await writethrough('D:/w/lab/a.txt', 'content', undefined, bombFile)
    expect(writeCalls).toHaveLength(1)
    expect(writeCalls[0][0]).toEqual({ path: 'D:/w/lab/a.txt', displayPath: 'D:/w/lab/a.txt' })
    expect(writeCalls[0][1]).toBe('content')
    expect(writeCalls[0][2]).toBeUndefined()
    expect(writeCalls[0][3]).toBeUndefined()
    expect(writeCalls[0][4]).toEqual({ mode: 'workspace-write', workspaceRoot: 'D:/w' })
  })

  it('无 confining 后端 → policy 参数为 undefined（行为与修复前等价）', async () => {
    const { ctx, writeCalls } = mockCtx({})
    const writethrough = createWritethrough(ctx, execFor('D:/w'))
    await writethrough('D:/w/lab/b.txt', 'x')
    expect(writeCalls[0][4]).toBeUndefined()
  })
})
