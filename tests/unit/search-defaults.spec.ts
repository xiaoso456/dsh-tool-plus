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

/* -------------------------------------------------------------------------- */
/* glob 深度语义：裸 glob 任意深度，带目录前缀的 glob 只匹配直接子项              */
/* -------------------------------------------------------------------------- */

/**
 * 这是 18.12.6 grep.md 明确承诺的一条：
 *   Bare glob `*.ts` matches any depth; `dir/*.ts` only `dir`'s direct children.
 *
 * 移植时实测发现 grep 这条是坏的：它会返回 `dir/sub/c.ts`。根因是 grep 没给
 * native 层传 recursive，而 native 的默认值是 true（把 `*.ts` 扩成任意深度），
 * 于是带目录前缀的 glob 也被递归展开。修法是让 scope 算出 bareGlob 再透传。
 * 下面每一条都在两个工具上各跑一遍，因为 glob 工具本来是对的，坏的只有 grep，
 * 两边都钉住才能防止以后再分叉。
 */
describe('glob 深度语义（裸 glob vs 目录锚定）', () => {
  const tree = () => {
    const dir = tmpDir()
    fs.mkdirSync(path.join(dir, 'dir', 'sub'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'a.ts'), 'needle a\n')
    fs.writeFileSync(path.join(dir, 'dir', 'b.ts'), 'needle b\n')
    fs.writeFileSync(path.join(dir, 'dir', 'sub', 'c.ts'), 'needle c\n')
    return dir
  }

  const globPaths = async (dir: string, p: string): Promise<string[]> => {
    const result = await executeGlobTool(execIn(dir), resolveConfig({}), { path: p }, undefined as never)
    return (result.paths ?? []).slice().sort()
  }

  const grepFiles = async (dir: string, p?: string): Promise<string[]> => {
    const args: Record<string, unknown> = { pattern: 'needle' }
    if (p !== undefined) args.path = p
    const result = await executeGrepTool(execIn(dir), resolveConfig({}), args, undefined as never)
    return (result.files ?? []).slice().sort()
  }

  it('glob：裸 *.ts 匹配任意深度', async () => {
    const dir = tree()
    expect(await globPaths(dir, '*.ts')).toEqual(['a.ts', 'dir/b.ts', 'dir/sub/c.ts'])
  })

  it('glob：dir/*.ts 只匹配直接子项', async () => {
    const dir = tree()
    expect(await globPaths(dir, 'dir/*.ts')).toEqual(['dir/b.ts'])
  })

  it('glob：dir/**/*.ts 递归匹配', async () => {
    const dir = tree()
    expect(await globPaths(dir, 'dir/**/*.ts')).toEqual(['dir/b.ts', 'dir/sub/c.ts'])
  })

  it('grep：裸 *.ts 匹配任意深度', async () => {
    const dir = tree()
    expect(await grepFiles(dir, '*.ts')).toEqual(['a.ts', 'dir/b.ts', 'dir/sub/c.ts'])
  })

  // 这条是本次修复的回归守卫：修之前它返回 ['dir/b.ts', 'dir/sub/c.ts']。
  it('grep：dir/*.ts 只匹配直接子项（不再递归进子目录）', async () => {
    const dir = tree()
    expect(await grepFiles(dir, 'dir/*.ts')).toEqual(['dir/b.ts'])
  })

  it('grep：dir/**/*.ts 递归匹配', async () => {
    const dir = tree()
    expect(await grepFiles(dir, 'dir/**/*.ts')).toEqual(['dir/b.ts', 'dir/sub/c.ts'])
  })

  it('grep：不传 path 时搜整个工作区根', async () => {
    const dir = tree()
    expect(await grepFiles(dir)).toEqual(['a.ts', 'dir/b.ts', 'dir/sub/c.ts'])
  })
})


/* -------------------------------------------------------------------------- */
/* PCRE2 回退：grep.md 承诺 "Rust, then PCRE2"                                  */
/* -------------------------------------------------------------------------- */

/**
 * 上游文案第一句是 `Regex: Rust, then PCRE2`。Rust 的 regex crate 不支持后行断言，
 * 所以「后行断言能命中」本身就是 PCRE2 分支被走到的证据；否定后行断言命中 0 则排除了
 * 「随便什么都返回匹配」的假阳性。这条不是测正则引擎实现，是测我们对文案的承诺。
 */
describe('grep 的 PCRE2 回退', () => {
  const probe = async (pattern: string): Promise<number> => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'x.txt'), 'foobar\nbazqux\n')
    const result = await executeGrepTool(execIn(dir), resolveConfig({}), { pattern }, undefined as never)
    return result.matchCount ?? 0
  }

  it('后行断言命中（Rust regex 做不到，说明落到 PCRE2）', async () => {
    expect(await probe('(?<=foo)bar')).toBe(1)
  })

  it('否定后行断言正确排除', async () => {
    expect(await probe('(?<!foo)bar')).toBe(0)
  })

  it('先行断言命中', async () => {
    expect(await probe('ba(?=z)')).toBe(1)
  })
})
