/**
 * T02 回归：read 截断提示（OMP session 层 formatOutputNotice 语义）。
 *
 * OMP 的截断/限量提示不在工具文本里，由 session 层追加；DSH 适配层在
 * render 前补上（toReadToolResult 的 notice 字段 + renderReadOutput 拼接）。
 * 本测试用临时目录夹具，验证：
 *  - 长行文件 → "Some lines truncated to N chars" 提示
 *  - 大文件（超 summarize 上限）→ "Showing lines X-Y of Z" 提示
 *  - 普通小文件 → 无提示，render 输出 = 文本
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { executeReadTool, renderReadOutput } from '../../src/tools/read/adapter/index.ts'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-plus-read-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** 模拟 DSH exec 上下文：agent.session 是同一对象（跨调用稳定）。 */
function execFor(cwd: string): any {
  return { agent: { session: { header: { cwd } } }, signal: undefined }
}

describe('read 截断提示（T02）', () => {
  it('长行文件：输出含 "Some lines truncated to N chars" 提示', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'longline.txt')
    fs.writeFileSync(file, 'A'.repeat(2000))

    const out = await executeReadTool(execFor(dir), {} as never, { path: file })

    // 截断本身发生（尾部省略号）
    expect(out.text).toContain('…')
    // 提示在 notice 字段，render 拼接后模型可见
    expect(out.notice).toMatch(/Some lines truncated to \d+ chars/)
    expect(renderReadOutput(out)).toContain('Some lines truncated to')
  })

  it('大文件（超 summarize 上限）：输出含 "Showing lines X-Y of Z" 提示', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'huge.log')
    // 20001 行 > MAX_SUMMARY_LINES(20000)，且 > read.defaultLimit(300) → 走普通截断路径
    fs.writeFileSync(file, Array.from({ length: 20_001 }, (_, i) => `line-${i}`).join('\n'))

    const out = await executeReadTool(execFor(dir), {} as never, { path: file })

    expect(out.notice).toMatch(/Showing lines \d+-\d+ of 20001/)
    expect(renderReadOutput(out)).toContain('Showing lines')
  })

  it('普通小文件：无提示，render 输出 = 文本', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'small.txt')
    fs.writeFileSync(file, 'hello\nworld\n')

    const out = await executeReadTool(execFor(dir), {} as never, { path: file })

    expect(out.notice).toBeUndefined()
    expect(renderReadOutput(out)).toBe(out.text)
  })
})
