/**
 * A-6 回归：glob/grep adapter 补齐上游 meta-notice 追加。
 *
 * 背景（second-impl-audit.md A-6）：上游对所有工具统一
 * wrapToolWithMetaNotice（refs tools/index.ts:677），把 formatOutputNotice(meta)
 * 的限量/截断提示拼进模型可见文本。插件适配层只给 read 实现了
 * （read/adapter/index.ts:104），glob/grep 引擎仍在设置 truncation/limits meta
 * 但 adapter 不消费——结果被静默截断，模型不知道。
 *
 * 契约：glob/grep 的 execute 链（executeGlobTool / executeGrepTool，镜像 read
 * 的 executeReadTool 模式导出）必须在结果里带上 notice，render 输出拼接后
 * 模型可见。
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { executeGlobTool } from '../../src/tools/glob/adapter/index.ts'
import { executeGrepTool } from '../../src/tools/grep/adapter/index.ts'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-notice-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** 模拟 DSH exec 上下文（同 read-notice.spec 的模式）。 */
function execFor(cwd: string): any {
  return { agent: { session: { header: { cwd } } }, signal: undefined }
}

describe('glob 结果 notice（A-6）', () => {
  it('超过 limit：模型可见文本含 "results limit reached" 提示', async () => {
    const dir = tmpDir()
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) {
      fs.writeFileSync(path.join(dir, name), 'x\n')
    }

    const out = await executeGlobTool(execFor(dir), {} as never, { path: dir, limit: 3 }, null as never)

    // 静默截断 → 修复后必须有上游同款提示（formatOutputNotice 语义）
    expect(out.text).toMatch(/\d+ results? limit reached/)
    expect(out.text).toContain('limit=')
  })
})

describe('grep 结果 notice（A-6）', () => {
  it('超长行命中列宽截断：模型可见文本含 "Some lines truncated to N chars"', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'long.txt')
    fs.writeFileSync(file, `${'needle'} ${'A'.repeat(2000)}\nplain line\n`)

    const out = await executeGrepTool(execFor(dir), {} as never, { pattern: 'needle', path: file }, null as never)

    expect(out.text).toMatch(/Some lines truncated to \d+ chars/)
  })
})