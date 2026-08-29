/**
 * S-13 / S-14c / A-8 后继回归：edit 链三项修复（TDD：本 spec 先于源码改动写就，
 * RED 失败输出已记录在实现报告）。
 *
 * - S-13    adapter 的 fuzzy 阈值三目 `raw > 0 ? raw : 0.95` 把用户显式
 *           editFuzzyThreshold=0/负值静默改成 0.95。上游 settings 面
 *           （refs edit/index.ts:112，PI_EDIT_FUZZY=auto → settings.get 原样
 *           放行 0）；env 串解析层（PI_EDIT_FUZZY*）属 DSH 有意不移植面。
 *           修复：抽出可导出纯函数 resolveFuzzyThreshold，typeof number 原样放行。
 * - S-14c   patch.md verbatim <parameters> 教 JSON `{ path, edits: Entry[] }`
 *           形状，而 DSH schema 只收 `patch: string`（unified-diff/apply_patch
 *           信封字符串）。修复：adapter 拼装描述时重写 <parameters> 块；
 *           create/delete/rename 指向 `input` 的 `*** Begin Patch` 信封语法。
 * - A-8 后继 上游 patch 模式执行前同样走 resolveEditPath（refs
 *           edit/index.ts:556-560 三模式统一语义）；adapter patch 分支直传
 *           原始 path，纠错丢失。修复：执行前 await resolveEditPath。
 *
 * 纠错语义注：findUniqueWorkspaceSuffix 是「工作区尾缀唯一匹配」（verbatim
 * 上游）——发错路径必须恰好是真实文件路径的尾缀才会纠（'doc/x' 不会纠到
 * 'sub/x'，与 replace 模式同款边界），用例按尾缀关系构造。
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { executeEditTool } from '../../src/tools/edit/adapter/index.ts'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-fuzzy-patch-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function execFor(cwd: string): any {
  return { agent: { session: { header: { cwd } } }, signal: undefined }
}

/** S-13/S-14c 的新导出走动态 import：导出缺失时其余用例仍可运行、各自 RED。 */
async function importAdapter(): Promise<Record<string, any>> {
  return (await import('../../src/tools/edit/adapter/index.ts')) as any
}

describe('S-13：editFuzzyThreshold 显式 0/负值不得被 coercion 吞掉', () => {
  it('纯函数：0 原样放行', async () => {
    const mod = await importAdapter()
    expect(mod.resolveFuzzyThreshold, 'adapter 应导出 resolveFuzzyThreshold（S-13 抽取）').toBeTypeOf('function')
    expect(mod.resolveFuzzyThreshold(0)).toBe(0)
  })

  it('纯函数：负值原样放行', async () => {
    const mod = await importAdapter()
    expect(mod.resolveFuzzyThreshold(-0.25)).toBe(-0.25)
  })

  it('纯函数：undefined → 引擎默认 0.95', async () => {
    const mod = await importAdapter()
    expect(mod.resolveFuzzyThreshold(undefined)).toBe(0.95)
  })

  it('端到端：threshold=0 时低置信度 oldText 编辑成功（0.95 下同样输入被拒）', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'code.txt')
    fs.writeFileSync(file, 'alpha\nbeta\ngamma\n')

    const out = await executeEditTool(execFor(dir), { editFuzzyThreshold: 0 } as never, {
      file_path: file,
      old_string: 'alpha\nbeta\nzzz\n',
      new_string: 'alpha\nbeta\nGAMMA\n',
    }, null as never)

    expect(out.text).toContain('Successfully')
    expect(fs.readFileSync(file, 'utf-8')).toBe('alpha\nbeta\nGAMMA\n')
  })

  it('端到端：默认阈值（undefined→0.95）下同输入仍拒绝（默认行为不回归）', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'code.txt')
    fs.writeFileSync(file, 'alpha\nbeta\ngamma\n')

    await expect(executeEditTool(execFor(dir), {} as never, {
      file_path: file,
      old_string: 'alpha\nbeta\nzzz\n',
      new_string: 'alpha\nbeta\nGAMMA\n',
    }, null as never)).rejects.toThrow(/close enough/i)
  })
})

describe('S-14c：patch 模式最终描述与 schema（patch: string）一致', () => {
  it('不含 JSON {path, edits} 教程，也不含 schema 不存在的参数名', async () => {
    const mod = await importAdapter()
    const desc = mod.EDIT_MODE_DESCRIPTIONS?.patch
    expect(desc, 'adapter 应导出 EDIT_MODE_DESCRIPTIONS（sanitize 管线真值）').toBeTypeOf('string')
    // 旧 <parameters>：`// Input is { path: string, edits: Entry[] }. …` + `type Entry = …`
    expect(desc).not.toMatch(/\{\s*path\s*:\s*string/)
    expect(desc).not.toMatch(/type Entry\b/)
    expect(desc).not.toMatch(/Entry\[\]/)
    expect(desc).not.toMatch(/op:\s*"(create|delete|update)"/)
    expect(desc).not.toMatch(/rename:\s*string/)
    // schema 参数名是 file_path，不是裸 `path`
    expect(desc).not.toContain('`path`')
  })

  it('含 unified-diff/apply_patch 信封说明与 @@ hunk 语法', async () => {
    const mod = await importAdapter()
    const desc = mod.EDIT_MODE_DESCRIPTIONS?.patch
    expect(desc, 'adapter 应导出 EDIT_MODE_DESCRIPTIONS（sanitize 管线真值）').toBeTypeOf('string')
    expect(desc).toContain('*** Begin Patch')
    expect(desc).toContain('`patch`')
    expect(desc).toContain('`file_path`')
    expect(desc).toContain('@@')
  })
})

describe('A-8 后继：patch 模式执行前接 resolveEditPath（与 replace 同款）', () => {
  it('错误路径存在唯一尾缀近邻：纠错成功，响应带纠错后路径', async () => {
    const dir = tmpDir()
    fs.mkdirSync(path.join(dir, 'sub'))
    const real = path.join(dir, 'sub', 'quarterly-report-draft.txt')
    fs.writeFileSync(real, 'Q1 revenue: 1000\nQ2 revenue: 2000\n')

    const out = await executeEditTool(execFor(dir), {} as never, {
      file_path: 'quarterly-report-draft.txt',
      patch: '@@\n Q1 revenue: 1000\n-Q2 revenue: 2000\n+Q2 revenue: 2100\n',
    }, null as never)

    expect(out.text.replace(/\\/g, '/')).toContain('sub/quarterly-report-draft.txt')
    expect(fs.readFileSync(real, 'utf-8')).toBe('Q1 revenue: 1000\nQ2 revenue: 2100\n')
    // 纠错 = 改到近邻，而不是在错误路径新建文件
    expect(fs.existsSync(path.join(dir, 'quarterly-report-draft.txt'))).toBe(false)
  })

  it('无近邻：仍报 File not found（纠错不得凭空建文件）', async () => {
    const dir = tmpDir()
    await expect(executeEditTool(execFor(dir), {} as never, {
      file_path: 'missing-file.txt',
      patch: '@@\n-x\n+y\n',
    }, null as never)).rejects.toThrow(/File not found/i)
  })
})