/**
 * 多条目编辑预检（实验性 `multiEditPreflight`）回归。
 *
 * 覆盖两层：纯函数按顺序串接与失败归类；adapter 在开关开启时整体拒绝写盘、
 * 关闭时保持上游「逐条应用逐条写盘」的现有行为。
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { formatPreflightError, preflightReplaceEntries } from '../../src/tools/edit/adapter/preflight.ts'
import { executeEditTool } from '../../src/tools/edit/adapter/index.ts'

const DEFAULT_OPTIONS = { allowFuzzy: true, threshold: 0.95 }

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-preflight-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function execFor(cwd: string): any {
  return { agent: { session: { header: { cwd } } }, signal: undefined }
}

describe('preflightReplaceEntries', () => {
  it('全部命中：按顺序串接，后一条可以依赖前一条的新文本', () => {
    const result = preflightReplaceEntries('alpha\nbeta\n', [
      { oldText: 'alpha', newText: 'mid' },
      { oldText: 'mid', newText: 'omega' },
    ], DEFAULT_OPTIONS)

    expect(result.failures).toEqual([])
  })

  it('第 2 条近似但不达阈值：只报第 2 条，并给出 closest 行与阈值原因', () => {
    const result = preflightReplaceEntries('alpha\nbeta\ngamma\n', [
      { oldText: 'alpha', newText: 'ALPHA' },
      { oldText: 'gammaX', newText: 'GAMMA' },
    ], DEFAULT_OPTIONS)

    expect(result.failures).toHaveLength(1)
    const failure = result.failures[0]
    expect(failure.entry).toBe(2)
    expect(failure.detail).toMatch(/closest match is \d+% similar at line 3/)
    expect(failure.detail).toContain('  - gammaX')
    expect(failure.detail).toContain('  + gamma')
    expect(failure.detail).toMatch(/below the 95% similarity threshold/)
  })

  it('相似度很低时仍给出最接近的一行，并说明差距', () => {
    const result = preflightReplaceEntries('alpha\nbeta\n', [
      { oldText: 'zzzzzzzz', newText: 'X' },
    ], DEFAULT_OPTIONS)

    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].detail).toMatch(/closest match is \d+% similar at line 1/)
    expect(result.failures[0].detail).toContain('  - zzzzzzzz')
    expect(result.failures[0].detail).toContain('  + alpha')
  })

  it('同一段文本命中多次：沿用引擎的多命中报错，不写盘', () => {
    const result = preflightReplaceEntries('dup\ndup\n', [
      { oldText: 'dup', newText: 'DUP' },
    ], DEFAULT_OPTIONS)

    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].entry).toBe(1)
    expect(result.failures[0].detail).toContain('Found 2 occurrences')
  })

  it('replace_all 允许重复命中', () => {
    const result = preflightReplaceEntries('dup\ndup\n', [
      { oldText: 'dup', newText: 'DUP' },
    ], { ...DEFAULT_OPTIONS, replaceAll: true })

    expect(result.failures).toEqual([])
  })

  it('条目替换后内容不变：按「没有变化」拒绝', () => {
    const result = preflightReplaceEntries('alpha\n', [
      { oldText: 'alpha', newText: 'alpha' },
    ], DEFAULT_OPTIONS)

    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].detail).toContain('makes no changes')
  })

  it('空 oldText：与引擎同一句提示', () => {
    const result = preflightReplaceEntries('alpha\n', [
      { oldText: '', newText: 'X' },
    ], DEFAULT_OPTIONS)

    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].detail).toBe('old_string must not be empty.')
  })
})

describe('formatPreflightError', () => {
  it('列出全部失败条目并给出恢复指引', () => {
    const message = formatPreflightError('app.ts', 3, [
      { entry: 1, detail: 'closest match is 80% similar at line 2:\n  - a\n  + b' },
      { entry: 3, detail: 'no close enough match in the file.' },
    ])

    expect(message).toContain('Edit preflight failed for app.ts: 2 of 3 entries would not apply. No changes were written.')
    expect(message).toContain('Entry 1 of 3:')
    expect(message).toContain('Entry 3 of 3:')
    expect(message).toContain('Re-read the file and re-issue all 3 entries; none of them were applied.')
  })
})

describe('edit adapter · multiEditPreflight 开关', () => {
  it('默认关闭：保持上游逐条写盘，失败信息含 already applied', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'code.txt')
    fs.writeFileSync(file, 'alpha\nbeta\n')

    const err = await executeEditTool(execFor(dir), {} as never, {
      file_path: file,
      edits: [
        { oldText: 'alpha', newText: 'ALPHA' },
        { oldText: 'this-marker-does-not-exist', newText: 'X' },
      ],
    }, null as never).then(() => null, (e: Error) => e)

    expect(err?.message).toContain('already applied')
    expect(fs.readFileSync(file, 'utf8')).toBe('ALPHA\nbeta\n')
  })

  it('开启后第 2 条失败：一个字节都不写，错误列出失败条目', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'code.txt')
    fs.writeFileSync(file, 'alpha\nbeta\ngamma\n')

    const err = await executeEditTool(execFor(dir), { multiEditPreflight: true } as never, {
      file_path: file,
      edits: [
        { oldText: 'alpha', newText: 'ALPHA' },
        { oldText: 'gammaX', newText: 'GAMMA' },
      ],
    }, null as never).then(() => null, (e: Error) => e)

    expect(err).not.toBeNull()
    expect(err!.message).toContain('Edit preflight failed')
    expect(err!.message).toContain('No changes were written')
    expect(err!.message).toContain('Entry 2 of 2:')
    expect(err!.message).not.toContain('already applied')
    expect(fs.readFileSync(file, 'utf8')).toBe('alpha\nbeta\ngamma\n')
  })

  it('开启后全部命中且后一条依赖前一条：结果与逐条写盘一致', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'code.txt')
    fs.writeFileSync(file, 'alpha\nbeta\n')

    const out = await executeEditTool(execFor(dir), { multiEditPreflight: true } as never, {
      file_path: file,
      edits: [
        { oldText: 'alpha', newText: 'ALPHA' },
        { oldText: 'ALPHA', newText: 'OMEGA' },
      ],
    }, null as never)

    expect(out.text).not.toContain('preflight failed')
    expect(fs.readFileSync(file, 'utf8')).toBe('OMEGA\nbeta\n')
  })

  it('成功路径与关闭开关时结果完全一致', async () => {
    const run = async (enabled: boolean) => {
      const dir = tmpDir()
      const file = path.join(dir, 'code.txt')
      fs.writeFileSync(file, 'alpha\nbeta\n')
      const out = await executeEditTool(execFor(dir), (enabled ? { multiEditPreflight: true } : {}) as never, {
        file_path: file,
        edits: [
          { oldText: 'alpha', newText: 'ALPHA' },
          { oldText: 'beta', newText: 'BETA' },
        ],
      }, null as never)
      // 结果文本里带绝对路径，两次 run 的临时目录不同；归一化后再比较。
      return { text: out.text.split(dir).join('<dir>'), content: fs.readFileSync(file, 'utf8') }
    }

    const off = await run(false)
    const on = await run(true)
    expect(on).toEqual(off)
  })

  it('相对路径按会话 cwd 解析：与引擎读文件同一口径', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'code.txt'), 'alpha\nbeta\n')

    // 进程 cwd 是仓库根，文件在会话 cwd 下。预检若按进程 cwd 读就会读错文件。
    const out = await executeEditTool(execFor(dir), { multiEditPreflight: true } as never, {
      file_path: 'code.txt',
      edits: [
        { oldText: 'alpha', newText: 'ALPHA' },
        { oldText: 'beta', newText: 'BETA' },
      ],
    }, null as never)

    expect(out.text).not.toContain('preflight failed')
    expect(fs.readFileSync(path.join(dir, 'code.txt'), 'utf8')).toBe('ALPHA\nBETA\n')
  })

  it('开关只影响多条目：单条编辑在开启时行为不变', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'code.txt')
    fs.writeFileSync(file, 'alpha\nbeta\n')

    await executeEditTool(execFor(dir), { multiEditPreflight: true } as never, {
      file_path: file,
      old_string: 'beta',
      new_string: 'BETA',
    }, null as never)

    expect(fs.readFileSync(file, 'utf8')).toBe('alpha\nBETA\n')
  })
})
