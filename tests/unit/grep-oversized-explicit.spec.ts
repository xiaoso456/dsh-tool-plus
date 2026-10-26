/**
 * 回归：显式指定 >4 MiB 文件时不应再提示「只搜了前 4MB」。
 *
 * pi-natives 18.12.6 对显式文件做完整扫描（18.1.17 才在 4 MiB 处截断），
 * 工具层旧的 stat>4MiB 提示会误报 partial coverage。匹配点放在 4 MiB 之后，
 * 既验证确实扫到文件末尾，也验证不再追加那行提示。
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Settings } from '../../src/tools/omp/config/settings.ts'
import { getDefault } from '../../src/tools/omp/config/settings-schema.ts'
import { GrepTool } from '../../src/tools/omp/tools/grep.ts'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-plus-grep-large-'))
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

describe('grep 显式大文件（>4 MiB）', () => {
  it('能匹配 4 MiB 之后的内容，且不提示 partial coverage', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'big.txt')
    const filler = 'x'.repeat(100)
    fs.writeFileSync(file, `${filler}\n`.repeat(47_000) + 'NEEDLE_BEYOND_4MB\n')
    expect(fs.statSync(file).size).toBeGreaterThan(4 * 1024 * 1024)

    const tool = new GrepTool(makeSession(dir) as never)
    const result = await tool.execute(
      'grep',
      { pattern: 'NEEDLE_BEYOND_4MB', path: file } as never,
      undefined,
    )
    const text = result.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n')

    expect(text).toContain('NEEDLE_BEYOND_4MB')
    expect(text).not.toContain('Searched only the first')
  })
})
