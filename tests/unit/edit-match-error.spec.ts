/**
 * 详细匹配失败提示（实验性 `detailedMatchFailure`，默认开启）回归。
 *
 * 纯函数层钉住附块条件（相似度、行数/字节上限、缩进原样）；adapter 层钉住
 * 单条与多条编辑的报错里都能看到块，以及开关关闭时保持引擎原文。
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { EditMatchError } from '../../src/tools/omp/edit/modes/replace.ts'
import { describeClosestMatch, withClosestMatch } from '../../src/tools/edit/adapter/match-error.ts'
import { executeEditTool } from '../../src/tools/edit/adapter/index.ts'
import { resolveConfig } from '../../src/config/settings.ts'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-match-error-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function execFor(cwd: string): any {
  return { agent: { session: { header: { cwd } } }, signal: undefined }
}

function matchError(closest?: { actualText: string; startLine?: number; confidence: number }): EditMatchError {
  return new EditMatchError(
    'app.ts',
    'const a = 1',
    closest === undefined
      ? undefined
      : { actualText: closest.actualText, startIndex: 0, startLine: closest.startLine ?? 1, confidence: closest.confidence },
    { allowFuzzy: true, threshold: 0.95 },
  )
}

describe('describeClosestMatch', () => {
  it('附上整块与起始行，并说明可以直接当 old_string', () => {
    const block = describeClosestMatch(matchError({ actualText: 'const a = 2\nconst b = 3', startLine: 41, confidence: 0.87 }))
    expect(block).toContain('87% similar, starting at line 41')
    expect(block).toContain('<closest_match>\nconst a = 2\nconst b = 3\n</closest_match>')
    expect(block).toContain('use it as old_string')
  })

  it('原样保留缩进与空行（否则拿回去也匹配不上）', () => {
    const text = '  if (ready) {\n\n    run()\n  }'
    const block = describeClosestMatch(matchError({ actualText: text, confidence: 0.9 }))
    expect(block).toContain(text)
  })

  it('相似度低于 80% 不附块', () => {
    const error = matchError({ actualText: 'zzz', confidence: 0.79 })
    expect(describeClosestMatch(error)).toBeNull()
    expect(withClosestMatch(error)).toBe(error)
  })

  it('多个高置信候选时不附单块（避免暗示错的那个）', () => {
    const error = new EditMatchError(
      'app.ts',
      'x',
      { actualText: 'x', startIndex: 0, startLine: 1, confidence: 0.9 },
      { allowFuzzy: true, threshold: 0.95, fuzzyMatches: 2 },
    )
    expect(describeClosestMatch(error)).toBeNull()
  })

  it('没有 closest 时不附块', () => {
    const error = matchError()
    expect(describeClosestMatch(error)).toBeNull()
    expect(withClosestMatch(error)).toBe(error)
  })

  it('超过 40 行不附块，只给起始行与行数', () => {
    const text = Array.from({ length: 41 }, (_, index) => `line ${index + 1}`).join('\n')
    const block = describeClosestMatch(matchError({ actualText: text, startLine: 10, confidence: 0.9 }))
    expect(block).toContain('too large to include (41 lines)')
    expect(block).toContain('line 10')
    expect(block).not.toContain('<closest_match>')
  })

  it('超过 4KB 不附块', () => {
    const text = 'a'.repeat(3000) + '\n' + 'b'.repeat(3000)
    const block = describeClosestMatch(matchError({ actualText: text, startLine: 5, confidence: 0.9 }))
    expect(block).toContain('too large to include (2 lines)')
    expect(block).not.toContain('<closest_match>')
  })

  it('只处理 EditMatchError，其它错误原样放过', () => {
    const plain = new Error('boom')
    expect(withClosestMatch(plain)).toBe(plain)
  })

  it('保留引擎原消息作为前缀', () => {
    const error = matchError({ actualText: 'gamma', confidence: 0.9 })
    const enriched = withClosestMatch(error) as Error
    expect(enriched.message.startsWith(error.message)).toBe(true)
    expect(enriched.name).toBe(error.name)
  })
})

describe('edit adapter · detailedMatchFailure 开关', () => {
  it('默认开启：单条匹配失败的报错里带 closest 块', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'code.txt')
    fs.writeFileSync(file, 'alpha\nbeta\ngamma\n')

    const err = await executeEditTool(execFor(dir), resolveConfig({}), {
      file_path: file,
      old_string: 'gammaX',
      new_string: 'GAMMA',
    }, null as never).then(() => null, (e: Error) => e)

    expect(err?.message).toContain('<closest_match>')
    expect(err?.message).toContain('\ngamma\n')
    expect(err?.message).toContain('below the 95% similarity threshold')
  })

  it('默认开启：多条编辑第 2 条失败时，聚合报错里也带块', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'code.txt')
    fs.writeFileSync(file, 'alpha\nbeta\ngamma\n')

    const err = await executeEditTool(execFor(dir), resolveConfig({}), {
      file_path: file,
      edits: [
        { oldText: 'alpha', newText: 'ALPHA' },
        { oldText: 'gammaX', newText: 'GAMMA' },
      ],
    }, null as never).then(() => null, (e: Error) => e)

    expect(err?.message).toContain('entry 2 of 2')
    expect(err?.message).toContain('<closest_match>')
    expect(err?.message).toContain('already applied')
  })

  it('开关关闭：报错保持引擎原文，没有块', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'code.txt')
    fs.writeFileSync(file, 'alpha\nbeta\ngamma\n')

    const err = await executeEditTool(execFor(dir), { detailedMatchFailure: false } as never, {
      file_path: file,
      old_string: 'gammaX',
      new_string: 'GAMMA',
    }, null as never).then(() => null, (e: Error) => e)

    expect(err?.message).not.toContain('<closest_match>')
    expect(err?.message).toContain('below the 95% similarity threshold')
  })

  it('相似度太低时即使开着也不附块', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'code.txt')
    fs.writeFileSync(file, 'alpha\n')

    const err = await executeEditTool(execFor(dir), resolveConfig({}), {
      file_path: file,
      old_string: 'zzzzzzzz',
      new_string: 'X',
    }, null as never).then(() => null, (e: Error) => e)

    expect(err?.message).not.toContain('<closest_match>')
  })
})
