/**
 * 实验性功能的性能护栏。
 *
 * 两条结构约束不依赖计时，直接钉住「不做多余的事」：
 *  1. 详细匹配失败提示只在 catch 路径执行：成功编辑的读文件与匹配次数和关闭时完全一致；
 *  2. 多条目预检关闭时零额外开销；开启时恰好只多一次读文件、每条目多一次内存匹配。
 *
 * 两条耗时上限留足余量（约为实测的 20 倍以上），只挡数量级回归，不作微基准。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('../../src/tools/omp/edit/read-file.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tools/omp/edit/read-file.ts')>()
  return { ...actual, readEditFileText: vi.fn(actual.readEditFileText) }
})

vi.mock('../../src/tools/omp/edit/diff.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tools/omp/edit/diff.ts')>()
  return { ...actual, replaceText: vi.fn(actual.replaceText) }
})

import { resolveConfig } from '../../src/config/settings.ts'
import { executeEditTool } from '../../src/tools/edit/adapter/index.ts'
import { describeClosestMatch } from '../../src/tools/edit/adapter/match-error.ts'
import { replaceText } from '../../src/tools/omp/edit/diff.ts'
import { EditMatchError } from '../../src/tools/omp/edit/modes/replace.ts'
import { readEditFileText } from '../../src/tools/omp/edit/read-file.ts'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-perf-guards-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function execFor(cwd: string): any {
  return { agent: { session: { header: { cwd } } }, signal: undefined }
}

function counts(): { reads: number; matches: number } {
  return {
    reads: vi.mocked(readEditFileText).mock.calls.length,
    matches: vi.mocked(replaceText).mock.calls.length,
  }
}

function resetCounts(): void {
  vi.mocked(readEditFileText).mockClear()
  vi.mocked(replaceText).mockClear()
}

describe('结构计数（硬保证）', () => {
  it('成功编辑：详细失败提示开与关的读文件/匹配次数完全一致', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'code.txt')
    const content = Array.from({ length: 200 }, (_, index) => `line ${index} value`).join('\n') + '\n'
    const edits = [
      { oldText: 'line 10 value', newText: 'line 10 VALUE' },
      { oldText: 'line 20 value', newText: 'line 20 VALUE' },
    ]

    const run = async (cfg: unknown) => {
      fs.writeFileSync(file, content)
      resetCounts()
      await executeEditTool(execFor(dir), cfg as never, { file_path: file, edits }, null as never)
      return counts()
    }

    const off = await run({ detailedMatchFailure: false })
    const on = await run(resolveConfig({}))
    expect(off).toEqual({ reads: 2, matches: 2 })
    expect(on).toEqual(off)
  })

  it('失败编辑：附块不额外读文件或匹配（只格式化已算好的 closest）', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'code.txt')
    fs.writeFileSync(file, 'alpha\nbeta\ngamma\n')

    const run = async (cfg: unknown) => {
      resetCounts()
      await executeEditTool(execFor(dir), cfg as never, {
        file_path: file,
        old_string: 'gammaX',
        new_string: 'GAMMA',
      }, null as never).then(() => null, () => null)
      return counts()
    }

    const off = await run({ detailedMatchFailure: false })
    const on = await run(resolveConfig({}))
    expect(off).toEqual({ reads: 1, matches: 1 })
    expect(on).toEqual(off)
  })

  it('多条目预检：关闭零额外开销，开启只多一次读和每条目一次匹配', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'code.txt')
    const content = Array.from({ length: 200 }, (_, index) => `line ${index} value`).join('\n') + '\n'
    const edits = [10, 20, 30, 40].map(index => ({
      oldText: `line ${index} value`,
      newText: `line ${index} VALUE`,
    }))

    const run = async (cfg: unknown) => {
      fs.writeFileSync(file, content)
      resetCounts()
      await executeEditTool(execFor(dir), cfg as never, { file_path: file, edits }, null as never)
      return counts()
    }

    const off = await run({ multiEditPreflight: false, detailedMatchFailure: true })
    const on = await run(resolveConfig({ multiEditPreflight: true }))
    expect(off).toEqual({ reads: 4, matches: 4 })
    expect(on).toEqual({ reads: 5, matches: 8 })
  })

  it('预检失败：只读一次、只匹配到失败条目为止，不写盘', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'code.txt')
    const content = Array.from({ length: 200 }, (_, index) => `line ${index} value`).join('\n') + '\n'
    fs.writeFileSync(file, content)

    resetCounts()
    await executeEditTool(execFor(dir), resolveConfig({ multiEditPreflight: true }), {
      file_path: file,
      edits: [
        { oldText: 'line 10 value', newText: 'line 10 VALUE' },
        { oldText: 'no such line', newText: 'X' },
      ],
    }, null as never).then(() => null, () => null)

    expect(counts()).toEqual({ reads: 1, matches: 2 })
    expect(fs.readFileSync(file, 'utf8')).toBe(content)
  })
})

describe('耗时上限（宽松预算，只挡数量级回归）', () => {
  it('最大块附块：2000 次远低于预算', () => {
    const block = Array.from({ length: 40 }, (_, index) => `const value${index} = ${index} // padding padding padding`).join('\n')
    const error = new EditMatchError(
      'app.ts',
      'const value10 = 10',
      { actualText: block, startIndex: 0, startLine: 1, confidence: 0.9 },
      { allowFuzzy: true, threshold: 0.95 },
    )

    const iterations = 2000
    const started = performance.now()
    for (let index = 0; index < iterations; index++) describeClosestMatch(error)
    const elapsed = performance.now() - started

    // 实测个位数毫秒；300ms 是数量级护栏，不是微基准。
    expect(elapsed).toBeLessThan(300)
  })

  it('预检开启：2000 行文件 4 条目编辑，单次平均耗时远低于预算', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'code.txt')
    const content = Array.from({ length: 2000 }, (_, index) => `line ${index} value`).join('\n') + '\n'
    const edits = [10, 500, 1000, 1500].map(index => ({
      oldText: `line ${index} value`,
      newText: `line ${index} VALUE`,
    }))
    const cfg = resolveConfig({ multiEditPreflight: true })

    const runs = 20
    const started = performance.now()
    for (let index = 0; index < runs; index++) {
      fs.writeFileSync(file, content)
      await executeEditTool(execFor(dir), cfg, { file_path: file, edits }, null as never)
    }
    const average = (performance.now() - started) / runs

    // 实测约 16ms/次（含写盘与引擎自身的 diff）；150ms 只挡数量级回归。
    expect(average).toBeLessThan(150)
  })
})
