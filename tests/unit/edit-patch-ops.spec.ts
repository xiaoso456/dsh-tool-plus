/**
 * patch 模式按 OMP 18.12.6 形状对齐后的能力面（2026-11-22 反转 A 方案）。
 *
 * 模型面是 `{ path, edits: [{ op?, rename?, diff? }] }`，`path` 对所有条目生效，
 * 条目按顺序应用。这里补的是原先零覆盖的四件事：create / delete / rename /
 * 多条目聚合，外加一个容易踩的判别：`edits` 这个名字 replace 也在用
 * （`{oldText,newText}`），形状不对必须明确报错而不是硬套。
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveConfig } from '../../src/config/settings.ts'
import { executeEditTool } from '../../src/tools/edit/adapter/index.ts'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-plus-patch-a-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const execFor = (dir: string): any => ({ agent: { session: { header: { cwd: dir } } }, signal: undefined })
const cfg = (): any => resolveConfig({ editMode: 'patch', writeBackend: 'native', writeRetryEnabled: false })

describe('patch 模式：op 能力面', () => {
  it("op:'update' 应用 hunk", async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'a.txt')
    fs.writeFileSync(file, 'one\ntwo\n')
    await executeEditTool(execFor(dir), cfg(), {
      path: 'a.txt',
      edits: [{ op: 'update', diff: '@@\n one\n-two\n+TWO\n' }],
    }, null as never)
    expect(fs.readFileSync(file, 'utf8')).toBe('one\nTWO\n')
  })

  it("op:'create' 建新文件（不存在的 path 不该报 File not found）", async () => {
    const dir = tmpDir()
    await executeEditTool(execFor(dir), cfg(), {
      path: 'new/deep.txt',
      edits: [{ op: 'create', diff: 'hello\nworld\n' }],
    }, null as never)
    expect(fs.readFileSync(path.join(dir, 'new/deep.txt'), 'utf8')).toBe('hello\nworld\n')
  })

  it("op:'delete' 删文件", async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'gone.txt')
    fs.writeFileSync(file, 'bye\n')
    await executeEditTool(execFor(dir), cfg(), {
      path: 'gone.txt',
      edits: [{ op: 'delete' }],
    }, null as never)
    expect(fs.existsSync(file)).toBe(false)
  })

  it("op:'update' + rename 改文件名并保留内容改动", async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'old.txt'), 'alpha\nbeta\n')
    await executeEditTool(execFor(dir), cfg(), {
      path: 'old.txt',
      edits: [{ op: 'update', rename: 'new.txt', diff: '@@\n alpha\n-beta\n+BETA\n' }],
    }, null as never)
    expect(fs.existsSync(path.join(dir, 'old.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8')).toBe('alpha\nBETA\n')
  })

  it('多条目按顺序应用（先改内容，再删）', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'multi.txt')
    fs.writeFileSync(file, 'x\n')
    await executeEditTool(execFor(dir), cfg(), {
      path: 'multi.txt',
      edits: [
        { op: 'update', diff: '@@\n-x\n+y\n' },
        { op: 'delete' },
      ],
    }, null as never)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('缺少 edits 时给出清晰报错（不再接受旧 patch: string）', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
    const err = await executeEditTool(execFor(dir), cfg(), {
      path: 'a.txt',
      patch: '@@\n-a\n+b\n',
    }, null as never).then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/provide old_string\/new_string, patch, or input|edits/)
  })
})

describe('edits 形状判别（replace 与 patch 共用参数名）', () => {
  it('形状带 op/diff 的 edits 走 patch 引擎（与旧 patch: string 同款形状分派）', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
    await executeEditTool(
      execFor(dir),
      resolveConfig({ editMode: 'replace', writeBackend: 'native', writeRetryEnabled: false }),
      { path: 'a.txt', edits: [{ op: 'update', diff: '@@\n-a\n+b\n' }] },
      null as never,
    )
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('b\n')
  })
})
