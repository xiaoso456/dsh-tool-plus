/**
 * §4.5 grep 结果卡 meta 投影：把 OMP grep 引擎的 `displayContent`
 * （`# dir/` / `## file.ts` 分组头 + `*N│line` 代码帧）解析成官方 search 卡要的
 * `{kind:'search', shape:'matches', files:[{path, matches:[{lineNumber,line}]}], truncated, total}`。
 *
 * 样本全部来自引擎实跑（普通模式与 hashline 模式），不是凭空假设的格式。
 * 覆盖：
 *  - 分组头路径复原（相对 display 路径 → 会话 cwd 下的绝对路径）；
 *  - 单文件作用域（没有分组头，路径由 files[0] 兜底）；
 *  - hashline 模式的 `## file.ts#A526` 头；
 *  - context 行（前缀是空格）与 `…` 省略行都不算 matches；
 *  - 解析不出任何分组 → 不产 meta；
 *  - 超 64 KiB 丢尾部 group、truncated 置 true、total 保持截断前原值；
 *  - 适配层把 display 带进 value，模型可见文本一点没变。
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveConfig } from '../../src/config/settings.ts'
import { SEARCH_META_MAX_BYTES, jsonByteLength, narrowSearchCardMeta } from '../../src/web/contract.ts'
import { searchMatchesCardMeta } from '../../src/web/host/search.ts'
import { executeGrepTool, registerGrep } from '../../src/tools/grep/adapter/index.ts'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-plus-grepcard-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function execIn(dir: string): any {
  return { agent: { session: { header: { cwd: dir } } }, signal: undefined }
}

function captureTool(register: (ctx: any, getConfig: () => any) => unknown): any {
  let captured: any
  const ctx = { tools: { register: (def: any) => { captured = def; return () => {} } } }
  register(ctx, () => resolveConfig({}))
  return captured
}

/** 会话 cwd（刻意用 posix 风格基址，断言两侧都走 path.resolve）。 */
const BASE = path.join(os.tmpdir(), 'tool-plus-grep-base')

/** 引擎实跑样本：目录作用域、普通模式（`# src/` + `## file.ts` 头）。 */
const PLAIN_GROUPED = '# src/\n## a.ts\n 1│const x = 1\n*2│const needle = 2\n 3│const z = 3\n## b.ts\n*1│let needle = 9'

/** 引擎实跑样本：hashline 模式（文件头带 `#<snapshot tag>` 后缀）。 */
const HASHLINE_GROUPED = '# src/\n## a.ts#A526\n 1│const x = 1\n*2│const needle = 2\n 3│const z = 3\n## b.ts#9643\n*1│let needle = 9'

/** 引擎实跑样本：单文件作用域（没有分组头，body 直接开始）。 */
const SINGLE_FILE = ' 1│one\n*2│needle two\n 3│three'

describe('grep card meta — grouped display parsing', () => {
  it('parses the plain grouped code-frame display into per-file matches', () => {
    const meta = searchMatchesCardMeta({
      displayContent: PLAIN_GROUPED,
      cwd: BASE,
      files: ['src/a.ts', 'src/b.ts'],
      matchCount: 2,
      truncated: false,
    })
    expect(meta).toEqual({
      kind: 'search',
      shape: 'matches',
      files: [
        { path: path.resolve(BASE, 'src/a.ts'), matches: [{ lineNumber: 2, line: 'const needle = 2' }] },
        { path: path.resolve(BASE, 'src/b.ts'), matches: [{ lineNumber: 1, line: 'let needle = 9' }] },
      ],
      truncated: false,
      total: 2,
    })
    expect(narrowSearchCardMeta(meta)).not.toBeNull()
  })

  it('parses hashline-tagged headers exactly like plain ones', () => {
    const plain = searchMatchesCardMeta({ displayContent: PLAIN_GROUPED, cwd: BASE, files: ['src/a.ts', 'src/b.ts'], matchCount: 2 })
    const hash = searchMatchesCardMeta({ displayContent: HASHLINE_GROUPED, cwd: BASE, files: ['src/a.ts', 'src/b.ts'], matchCount: 2 })
    expect(hash).toEqual(plain)
  })

  it('never counts context lines or the `…` ellipsis as matches', () => {
    const meta = searchMatchesCardMeta({
      displayContent: '# src/\n## a.ts\n*2│match\n    │…\n 9│context\n*20│later',
      cwd: BASE,
      files: ['src/a.ts'],
      matchCount: 2,
    })
    expect(meta?.files).toEqual([{
      path: path.resolve(BASE, 'src/a.ts'),
      matches: [{ lineNumber: 2, line: 'match' }, { lineNumber: 20, line: 'later' }],
    }])
    expect(meta?.files[0]?.matches.map(match => match.line)).not.toContain('context')
  })

  it('resolves a single-file scope (no group header) from files[0]', () => {
    const meta = searchMatchesCardMeta({
      displayContent: SINGLE_FILE,
      cwd: BASE,
      files: ['a.ts'],
      matchCount: 1,
      truncated: false,
    })
    expect(meta?.files).toEqual([
      { path: path.resolve(BASE, 'a.ts'), matches: [{ lineNumber: 2, line: 'needle two' }] },
    ])
    expect(meta?.total).toBe(1)
  })

  it('falls back to the parsed match count when the engine gives no total', () => {
    const meta = searchMatchesCardMeta({ displayContent: PLAIN_GROUPED, cwd: BASE, files: ['src/a.ts', 'src/b.ts'] })
    expect(meta?.total).toBe(2)
    expect(meta?.truncated).toBe(false)
  })

  it('keeps the engine-reported truncation flag', () => {
    const meta = searchMatchesCardMeta({ displayContent: PLAIN_GROUPED, cwd: BASE, files: ['src/a.ts'], matchCount: 2, truncated: true })
    expect(meta?.truncated).toBe(true)
  })

  it('draws an empty-result card when the engine reports zero matches', () => {
    // 引擎实跑的空结果形状：没有 displayContent，但 matchCount/fileCount 明确是 0。
    const empty = { text: 'No matches found', matchCount: 0, fileCount: 0, files: [], cwd: BASE, scopePath: '.' }
    expect(searchMatchesCardMeta(empty)).toEqual({
      kind: 'search',
      shape: 'matches',
      files: [],
      truncated: false,
      total: 0,
    })
    expect(narrowSearchCardMeta(searchMatchesCardMeta(empty))).not.toBeNull()

    // 引擎没报数（脏输入）时不猜，仍然不产卡。
    expect(searchMatchesCardMeta({ displayContent: 'No matches found', cwd: BASE, files: [] })).toBeNull()
    expect(searchMatchesCardMeta({ displayContent: '', cwd: BASE, files: [] })).toBeNull()
    expect(searchMatchesCardMeta({ cwd: BASE, files: [] })).toBeNull()
    // 有匹配却解析不出分组 → 不产卡，绝不能当成空结果。
    expect(searchMatchesCardMeta({ displayContent: '# skill://demo/SKILL.md\n*3│needle', cwd: BASE, files: [], matchCount: 3 })).toBeNull()
  })
})

describe('grep card meta — 64 KiB cap', () => {
  it('drops trailing groups, flags truncated, and keeps the pre-cap total', () => {
    const cwd = BASE
    const namespace = Array.from({ length: 300 }, (_, index) => `file-${index}-${'x'.repeat(200)}.ts`)
    const display = namespace.map((name, index) => `# ${name}\n*1│match ${index}`).join('\n\n')

    const meta = searchMatchesCardMeta({
      displayContent: display,
      cwd,
      files: namespace,
      matchCount: namespace.length,
      truncated: false,
    })

    expect(meta).not.toBeNull()
    expect(meta!.files.length).toBeGreaterThan(0)
    expect(meta!.files.length).toBeLessThan(namespace.length)
    expect(meta!.truncated).toBe(true)
    expect(meta!.total).toBe(namespace.length)
    expect(jsonByteLength(meta)).toBeLessThanOrEqual(SEARCH_META_MAX_BYTES)
    expect(narrowSearchCardMeta(meta)).not.toBeNull()

    const retained = meta!.files.map(file => path.basename(file.path).slice(0, 10))
    expect(retained[0]).toBe('file-0-xxx')
  })
})

describe('grep card meta — adapter wiring', () => {
  it('runs the real engine and carries the display into the value', async () => {
    const dir = tmpDir()
    fs.mkdirSync(path.join(dir, 'src'))
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'const x = 1\nconst needle = 2\nconst z = 3\n')
    fs.writeFileSync(path.join(dir, 'src', 'b.ts'), 'let needle = 9\n')

    const out = await executeGrepTool(execIn(dir), resolveConfig({}), { pattern: 'needle' }, undefined as never)

    expect(out.text).toContain('const needle = 2')
    expect(out.displayContent).toContain('const needle = 2')
    expect(out.cwd).toBe(dir)
    expect(out.matchCount).toBe(2)
    expect(out.files).toEqual(['src/a.ts', 'src/b.ts'])

    const meta = searchMatchesCardMeta(out)
    expect(meta).toEqual({
      kind: 'search',
      shape: 'matches',
      files: [
        { path: path.resolve(dir, 'src/a.ts'), matches: [{ lineNumber: 2, line: 'const needle = 2' }] },
        { path: path.resolve(dir, 'src/b.ts'), matches: [{ lineNumber: 1, line: 'let needle = 9' }] },
      ],
      truncated: false,
      total: 2,
    })
  })

  it('projects a single-file engine run', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'a.ts'), 'one\nneedle two\nthree\n')

    const out = await executeGrepTool(execIn(dir), resolveConfig({}), { pattern: 'needle', path: 'a.ts' }, undefined as never)
    const meta = searchMatchesCardMeta(out)

    expect(meta?.files).toEqual([
      { path: path.resolve(dir, 'a.ts'), matches: [{ lineNumber: 2, line: 'needle two' }] },
    ])
  })

  it('produces an empty-result card for an empty engine result', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'a.ts'), 'nothing here\n')

    const out = await executeGrepTool(execIn(dir), resolveConfig({}), { pattern: 'needle' }, undefined as never)
    expect(out.text).toContain('No matches found')
    expect(out.matchCount).toBe(0)
    expect(searchMatchesCardMeta(out)).toEqual({
      kind: 'search',
      shape: 'matches',
      files: [],
      truncated: false,
      total: 0,
    })
  })

  it('registers a schema that accepts the display carrier and projects the same meta', () => {
    const def = captureTool(registerGrep)
    expect(def.name).toBe('grep')
    expect(def.output.schema.properties.displayContent.type).toBe('string')
    expect(def.output.schema.properties.cwd.type).toBe('string')

    const value = { text: 'x', displayContent: PLAIN_GROUPED, cwd: BASE, files: ['src/a.ts', 'src/b.ts'], matchCount: 2, truncated: false }
    expect(def.output.presentationMeta({ pattern: 'needle' }, value)).toEqual(
      searchMatchesCardMeta(value),
    )
    // 引擎实跑的空结果形状：matchCount=0 + 没有 displayContent → 出「0 处匹配」空卡。
    expect(def.output.presentationMeta({ pattern: 'needle' }, { text: 'No matches found', matchCount: 0, fileCount: 0, files: [] })).toEqual({
      kind: 'search',
      shape: 'matches',
      files: [],
      truncated: false,
      total: 0,
    })
    // 脏输入（引擎没报数）→ 还是显式 null，不是 undefined。
    expect(def.output.presentationMeta({ pattern: 'needle' }, { text: 'No matches found' })).toBeNull()
    expect(def.output.render({}, value)).toEqual([{ type: 'text', text: 'x' }])
  })
})
