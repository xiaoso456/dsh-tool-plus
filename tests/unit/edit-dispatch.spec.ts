/**
 * A-7/A-8 回归：edit adapter 补齐上游 dispatch 层（聚合 + 路径纠错）。
 *
 * 背景（second-impl-audit.md A-7/A-8）：上游 replace/patch/apply_patch 在
 * dispatch 层做两件 adapter 层缺失的事：
 *  1. executeSinglePathEntries / executeApplyPatchPerFile 聚合：保留引擎
 *     per-entry 文本、失败时输出 "Entries 1-N were already applied / NOT
 *     applied…re-issue only the failed and unapplied entries" 恢复指引
 *     （refs edit/index.ts:243-356）；
 *  2. resolveEditPath：mustExist + findUniqueWorkspaceSuffix 路径后缀纠错
 *     （refs edit/index.ts:92-107）。
 * 插件 adapter 自造了 "Edited X: N replacement(s)" 格式并用正则从人类文本
 * 回解计数；路径直传引擎，纠错能力丢失（verbatim findUniqueWorkspaceSuffix
 * 在库但 edit 链无人调用）。
 *
 * 修复方向：从 refs verbatim 移植 dispatch 聚合函数到 omp/edit/，adapter 导出
 * executeEditTool（镜像 read 的 executeReadTool 模式）并委托之。
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { executeEditTool } from '../../src/tools/edit/adapter/index.ts'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-dispatch-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function execFor(cwd: string): any {
  return { agent: { session: { header: { cwd } } }, signal: undefined }
}

describe('edit dispatch 聚合（A-7）', () => {
  it('多段编辑中途失败：错误信息含上游恢复指引（已应用/未应用条目）', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'code.txt')
    fs.writeFileSync(file, 'alpha\nbeta\ngamma\n')

    const err = await executeEditTool(execFor(dir), {} as never, {
      file_path: file,
      edits: [
        { oldText: 'alpha', newText: 'ALPHA' },
        { oldText: 'this-marker-does-not-exist', newText: 'X' },
      ],
    }, null as never).then(
      () => null,
      (e: Error) => e,
    )

    expect(err).not.toBeNull()
    // 上游 dispatch 的失败恢复指引（refs edit/index.ts:243-356 语义）
    expect(err!.message).toContain('already applied')
    expect(err!.message).toMatch(/NOT applied/i)
    expect(err!.message).toMatch(/re-issue only/i)
  })

  it('全成功多段编辑：结果保留引擎 per-entry 摘要（非自造单行格式）', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'code.txt')
    fs.writeFileSync(file, 'alpha\nbeta\n')

    const out = await executeEditTool(execFor(dir), {} as never, {
      file_path: file,
      edits: [
        { oldText: 'alpha', newText: 'ALPHA' },
        { oldText: 'beta', newText: 'BETA' },
      ],
    }, null as never)

    // 引擎逐条 resultText 保留（含 "Successfully replaced" 语义），不再是
    // adapter 自造的 `Edited <path>: N replacement(s)` 单行
    expect(out.text).not.toMatch(/^Edited .+: \d+ replacement/)
  })
})

describe('edit 路径纠错（A-8）', () => {
  it('路径缺前缀但工作区内唯一后缀匹配：findUniqueWorkspaceSuffix 恢复', async () => {
    const dir = tmpDir()
    fs.mkdirSync(path.join(dir, 'sub'))
    const file = path.join(dir, 'sub', 'hello.txt')
    fs.writeFileSync(file, 'hello\n')

    // 上游 resolveEditPath：mustExist 失败后 findUniqueWorkspaceSuffix 恢复
    const out = await executeEditTool(execFor(dir), {} as never, {
      file_path: 'hello.txt',
      old_string: 'hello',
      new_string: 'HELLO',
    }, null as never)

    expect(out.text).toContain('Successfully')
    expect(fs.readFileSync(file, 'utf-8')).toBe('HELLO\n')
  })
})