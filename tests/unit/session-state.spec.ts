/**
 * OMP session 级状态跨调用桥接。
 *
 * 上游把 session 级状态挂在 ToolSession 上跨调用共享（refs tools/index.ts:358-362；
 * 18.1.17 的 native `EditStore`：hashline 快照 / CUT-PUT 寄存器 / no-op 守卫），
 * 而 DSH 每次 execute 都新建 ToolSession —— 所以 `shared/session-state.ts` 必须按
 * DSH session 对象（`exec.agent.session`）把状态 persist/attach 回来，否则
 * conflictHistory（T11-2）与 editStore（A-4）都会静默失效。
 *
 * 本文件覆盖两层：
 *  - 状态 API 本身：attach/persist 对 editStore 与 conflictHistory 对称（A-4）；
 *  - 端到端：两次独立工具调用（read 注册 → write 消费 `conflict://1`）共享同一
 *    session 对象时冲突可用、文件真被改写；无 session 上下文时状态不跨调用（T11-2）。
 * @module tests
 */

import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { attachOmpSessionState, persistOmpSessionState } from '../../src/tools/shared/session-state.ts'
import { executeReadTool } from '../../src/tools/read/adapter/index.ts'
import { executeWriteTool } from '../../src/tools/write/adapter/index.ts'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-plus-session-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

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

/** 模拟 DSH exec 上下文：`agent.session` 是同一对象（跨调用稳定）。 */
function execFor(cwd: string, session: object): any {
  return { agent: { session: { header: { cwd }, ...session } }, signal: undefined }
}

describe('OMP session 状态桥接（A-4）', () => {
  it('editStore 经 persist → attach 跨调用 round-trip', () => {
    const sessionKey = {}
    const store = { snapshots: new Map<string, string>() }

    // 第一次调用结束：引擎在 ToolSession 上建好的编辑存储写回共享态
    persistOmpSessionState(sessionKey, {
      conflictHistory: { nextId: 2 } as unknown as object,
      editStore: store,
    } as never)

    // 第二次调用开始：新 ToolSession 应拿到上次的编辑存储（同一实例）
    const nextSession: { conflictHistory?: unknown; editStore?: unknown } = {}
    attachOmpSessionState(nextSession, sessionKey)

    expect(nextSession.conflictHistory).toEqual({ nextId: 2 })
    expect(nextSession.editStore).toBe(store)
  })

  it('无 sessionKey 时跳过（不挂状态），与 conflictHistory 语义一致', () => {
    const session: { conflictHistory?: unknown; editStore?: unknown } = {}
    attachOmpSessionState(session, undefined)
    expect(session.editStore).toBeUndefined()
    expect(session.conflictHistory).toBeUndefined()

    expect(() => persistOmpSessionState(undefined, { editStore: {} } as never)).not.toThrow()
  })
})

describe('冲突注册跨调用（T11-2）', () => {
  it('read 注册 → write conflict://1 解决成功，文件被改写', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'conflicted.py')
    fs.writeFileSync(file, CONFLICTED)
    // 同一 DSH session 对象贯穿两次独立工具调用
    const sessionKey = {}
    const exec = execFor(dir, sessionKey)

    // 第一次调用：read 注册冲突
    const readOut = await executeReadTool(exec, {} as never, { path: file }, null as never)
    expect(readOut.text).toContain('1 unresolved conflict detected')

    // 第二次调用：write 消费冲突 id
    const writeOut = await executeWriteTool(exec, {} as never, {
      path: 'conflict://1',
      content: '@theirs',
    })
    expect(writeOut.text).toContain('Resolved conflict #1')

    // 文件真实改写：标记清除，theirs 侧保留
    const after = fs.readFileSync(file, 'utf-8')
    expect(after).not.toContain('<<<<<<<')
    expect(after).not.toContain('=======')
    expect(after).not.toContain('>>>>>>>')
    expect(after).toContain('print("theirs")')
  })

  it('无 session 上下文：状态不跨调用保持（write 报 Conflict #1 not found）', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'conflicted.py')
    fs.writeFileSync(file, CONFLICTED)
    // 无 agent.session（如无会话上下文）→ attach/persist 跳过
    const exec = { signal: undefined }

    const readOut = await executeReadTool(exec, {} as never, { path: file }, null as never)
    expect(readOut.text).toContain('1 unresolved conflict detected')

    await expect(
      executeWriteTool(exec, {} as never, { path: 'conflict://1', content: '@theirs' }),
    ).rejects.toThrow(/Conflict #1 not found/)
  })
})
