/**
 * T13-9 回归：grep 归档成员行区间选择器（Windows 路径分隔符不一致）。
 *
 * Windows 上 searchPath 经 normalizePathSeparators 变正斜杠 → native grep
 * 返回正斜杠 match.path → rangesByAbsPath 的 key（path.resolve 反斜杠）
 * 查找失败 → 行区间过滤静默失效（返回全部匹配）。本测试验证
 * `zip:member:22-24` 只返回 22-24 行的匹配。
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Settings } from '../../src/tools/grep/adapter/config/settings.ts'
import { getDefault } from '../../src/tools/grep/adapter/config/settings-schema.ts'
import { GrepTool } from '../../src/tools/grep/adapter/omp/grep.ts'
import { zip } from '../../src/tools/grep/adapter/utils/zip.ts'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-plus-grep-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function makeSession(cwd: string) {
  const settings = new Settings({} as never, getDefault)
  return { cwd, settings, enableLsp: false, hasEditTool: true }
}

describe('grep 归档行区间（T13-9）', () => {
  it('`zip:data/numbers.txt:22-24` 只返回 22-24 行匹配', async () => {
    const dir = tmpDir()
    const lines = Array.from({ length: 30 }, (_, i) => `line-${i + 1}`)
    const bytes = zip({ 'data/numbers.txt': new TextEncoder().encode(lines.join('\n')) })
    const zipPath = path.join(dir, 'zip-demo.zip')
    fs.writeFileSync(zipPath, bytes)

    const tool = new GrepTool(makeSession(dir) as never)
    const result = await tool.execute(
      'grep',
      { pattern: 'line-2', path: `${zipPath}:data/numbers.txt:22-24` } as never,
      undefined,
    )
    const text = result.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n')

    // 匹配行以 `*` 标记；区间过滤后应只剩 22/23/24 三行
    const matchedLines = text
      .split('\n')
      .filter(l => l.startsWith('*'))
      .map(l => l.replace(/^\*(\d+)[|:].*$/, '$1'))
    expect(matchedLines).toEqual(['22', '23', '24'])
  })
})
