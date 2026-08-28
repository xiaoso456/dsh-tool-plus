/**
 * T11-2 回归：冲突注册跨工具调用保持（OMP ConflictHistory 挂 session）。
 *
 * OMP 的 ConflictHistory 挂在 ToolSession 上，read 注册、write 消费。
 * DSH 适配层每次 execute 都新建 ToolSession，必须通过
 * shared/session-state.ts 按 DSH session 对象（exec.agent.session）持久化。
 * 本测试模拟两次独立工具调用（各自 executeReadTool/executeWriteTool），
 * 共享同一个 exec.agent.session 对象，验证：
 *  - read 注册的冲突 id 在 write 时可用（conflict://1 解决成功）
 *  - 文件内容真实被改写（theirs 侧保留，标记清除）
 *  - 无 session 上下文时状态不跨调用保持（退化为每次新建）
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { executeReadTool } from '../../src/tools/read/adapter/index.ts'
import { executeWriteTool } from '../../src/tools/write/adapter/index.ts'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-plus-conflict-'))
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

/** 模拟 DSH exec 上下文：agent.session 是同一对象（跨调用稳定）。 */
function execFor(cwd: string, session: object): any {
  return { agent: { session: { header: { cwd }, ...session } }, signal: undefined }
}

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
