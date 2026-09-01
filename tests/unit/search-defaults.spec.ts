/**
 * 搜索工具默认值配置：grep 的 case/gitignore、glob 的 hidden/gitignore 未显式
 * 传参时使用配置默认值（grepCaseDefault / grepGitignoreDefault /
 * globHiddenDefault / globGitignoreDefault），显式传参优先。
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveConfig } from '../../src/config/settings.ts'
import { executeGlobTool } from '../../src/tools/glob/adapter/index.ts'
import { executeGrepTool } from '../../src/tools/grep/adapter/index.ts'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-plus-search-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** 标记 git 仓库（native walker 的 .gitignore 只在仓库内生效）。 */
function gitRepo(dir: string): void {
  fs.mkdirSync(path.join(dir, '.git'))
}

/** 适配层可识别的 exec 上下文（cwd 指向临时目录）。 */
function execIn(dir: string): any {
  return { agent: { session: { header: { cwd: dir } } }, signal: undefined }
}

describe('grep 默认值配置', () => {
  it('未传 case 时使用 grepCaseDefault（false = 忽略大小写）', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'foo.txt'), 'Foo bar\n')
    const cfg = resolveConfig({ grepCaseDefault: false })
    const result = await executeGrepTool(execIn(dir), cfg, { pattern: 'foo' }, undefined as never)
    expect(result.matchCount).toBeGreaterThan(0)
    expect(result.files).toEqual(['foo.txt'])
  })

  it('显式传 case 覆盖配置默认', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'foo.txt'), 'Foo bar\n')
    const cfg = resolveConfig({ grepCaseDefault: false })
    const result = await executeGrepTool(execIn(dir), cfg, { pattern: 'foo', case: true }, undefined as never)
    expect(result.matchCount ?? 0).toBe(0)
  })

  it('未传 case 时默认大小写敏感（默认 true，行为不变）', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'foo.txt'), 'Foo bar\n')
    const result = await executeGrepTool(execIn(dir), resolveConfig({}), { pattern: 'foo' }, undefined as never)
    expect(result.matchCount ?? 0).toBe(0)
  })

  it('未传 gitignore 时使用 grepGitignoreDefault（false = 不尊重 .gitignore）', async () => {
    const dir = tmpDir()
    gitRepo(dir)
    fs.writeFileSync(path.join(dir, '.gitignore'), 'secret.txt\n')
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'needle\n')
    fs.writeFileSync(path.join(dir, 'visible.txt'), 'needle\n')
    const cfg = resolveConfig({ grepGitignoreDefault: false })
    const result = await executeGrepTool(execIn(dir), cfg, { pattern: 'needle' }, undefined as never)
    expect(result.fileCount).toBe(2)
    expect(result.files).toEqual(expect.arrayContaining(['secret.txt', 'visible.txt']))
  })

  it('显式传 gitignore 覆盖配置默认', async () => {
    const dir = tmpDir()
    gitRepo(dir)
    fs.writeFileSync(path.join(dir, '.gitignore'), 'secret.txt\n')
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'needle\n')
    fs.writeFileSync(path.join(dir, 'visible.txt'), 'needle\n')
    const cfg = resolveConfig({ grepGitignoreDefault: false })
    const result = await executeGrepTool(execIn(dir), cfg, { pattern: 'needle', gitignore: true }, undefined as never)
    expect(result.fileCount).toBe(1)
    expect(result.files).toEqual(['visible.txt'])
  })
})

describe('glob 默认值配置', () => {
  it('未传 hidden 时使用 globHiddenDefault（false = 不含隐藏文件）', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, '.dot.txt'), 'x\n')
    fs.writeFileSync(path.join(dir, 'plain.txt'), 'x\n')
    const cfg = resolveConfig({ globHiddenDefault: false })
    const result = await executeGlobTool(execIn(dir), cfg, { path: '*' }, undefined as never)
    expect(result.text).not.toContain('.dot.txt')
    expect(result.text).toContain('plain.txt')
  })

  it('显式传 hidden 覆盖配置默认', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, '.dot.txt'), 'x\n')
    fs.writeFileSync(path.join(dir, 'plain.txt'), 'x\n')
    const cfg = resolveConfig({ globHiddenDefault: false })
    const result = await executeGlobTool(execIn(dir), cfg, { path: '*', hidden: true }, undefined as never)
    expect(result.text).toContain('.dot.txt')
  })

  it('未传 gitignore 时使用 globGitignoreDefault（false = 不尊重 .gitignore）', async () => {
    const dir = tmpDir()
    gitRepo(dir)
    fs.writeFileSync(path.join(dir, '.gitignore'), 'secret.txt\n')
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'x\n')
    fs.writeFileSync(path.join(dir, 'visible.txt'), 'x\n')
    const cfg = resolveConfig({ globGitignoreDefault: false })
    const result = await executeGlobTool(execIn(dir), cfg, { path: '*' }, undefined as never)
    expect(result.text).toContain('secret.txt')
    expect(result.text).toContain('visible.txt')
  })

  it('显式传 gitignore 覆盖配置默认', async () => {
    const dir = tmpDir()
    gitRepo(dir)
    fs.writeFileSync(path.join(dir, '.gitignore'), 'secret.txt\n')
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'x\n')
    fs.writeFileSync(path.join(dir, 'visible.txt'), 'x\n')
    const cfg = resolveConfig({ globGitignoreDefault: false })
    const result = await executeGlobTool(execIn(dir), cfg, { path: '*', gitignore: true }, undefined as never)
    expect(result.text).not.toContain('secret.txt')
    expect(result.text).toContain('visible.txt')
  })
})
