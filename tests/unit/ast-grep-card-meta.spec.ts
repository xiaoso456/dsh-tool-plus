/**
 * §4.6 ast_grep 结果卡 meta 投影：与 grep 共用同一份解析器
 * （`src/web/host/search.ts`），只是适配层此前只回 `{text}`，现在把
 * `displayContent` / `files` / `matchCount` / `limitReached` 放进 value。
 *
 * 样本来自引擎实跑：`# a.ts` 分组头 + `*2│line` 代码帧 + `  meta: A=2` 元变量行。
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveConfig } from '../../src/config/settings.ts'
import { narrowSearchCardMeta } from '../../src/web/contract.ts'
import { searchMatchesCardMeta } from '../../src/web/host/search.ts'
import { registerAstGrep, toAstGrepToolResult } from '../../src/tools/ast-grep/adapter/index.ts'
import { AstGrepTool } from '../../src/tools/omp/tools/ast-grep.ts'
import { Settings } from '../../src/tools/omp/config/settings.ts'
import { getDefault } from '../../src/tools/omp/config/settings-schema.ts'

function captureTool(register: (ctx: any, getConfig: () => any) => unknown): any {
  let captured: any
  const ctx = { tools: { register: (def: any) => { captured = def; return () => {} } } }
  register(ctx, () => resolveConfig({}))
  return captured
}

const BASE = path.join(os.tmpdir(), 'tool-plus-astgrep-base')

/** 引擎实跑样本：`# a.ts` 头 + 匹配行 + 元变量行。 */
const AST_DISPLAY = '# a.ts\n*2│const needle = 2\n  meta: A=2'

describe('ast_grep card meta — display parsing', () => {
  it('parses the grouped code-frame display and ignores meta-variable lines', () => {
    const meta = searchMatchesCardMeta({
      displayContent: AST_DISPLAY,
      cwd: BASE,
      files: ['a.ts'],
      matchCount: 1,
      truncated: false,
    })
    expect(meta).toEqual({
      kind: 'search',
      shape: 'matches',
      files: [{ path: path.resolve(BASE, 'a.ts'), matches: [{ lineNumber: 2, line: 'const needle = 2' }] }],
      truncated: false,
      total: 1,
    })
    expect(narrowSearchCardMeta(meta)).not.toBeNull()
  })

  it('keeps only the first line of a multi-line match (marker `*` lines)', () => {
    const meta = searchMatchesCardMeta({
      displayContent: '# a.ts\n*2│const x = {\n 3│  a: 1\n 4│};',
      cwd: BASE,
      files: ['a.ts'],
      matchCount: 1,
    })
    expect(meta?.files[0]?.matches).toEqual([{ lineNumber: 2, line: 'const x = {' }])
  })

  it('flags truncation when the engine hit its match limit', () => {
    const meta = searchMatchesCardMeta({
      displayContent: AST_DISPLAY,
      cwd: BASE,
      files: ['a.ts'],
      matchCount: 1,
      truncated: true,
    })
    expect(meta?.truncated).toBe(true)
  })

  it('draws an empty-result card when the run found nothing', () => {
    expect(searchMatchesCardMeta({ text: 'No matches found', matchCount: 0, fileCount: 0, files: [], cwd: BASE })).toEqual({
      kind: 'search',
      shape: 'matches',
      files: [],
      truncated: false,
      total: 0,
    })
    // 没有计数可依（脏输入）→ 不产卡，也不许把有匹配的失败解析当空结果。
    expect(searchMatchesCardMeta({ displayContent: 'No matches found', cwd: BASE, files: [] })).toBeNull()
    expect(searchMatchesCardMeta({ cwd: BASE, files: [] })).toBeNull()
  })
})

describe('ast_grep card meta — adapter wiring', () => {
  it('puts the display, files, total and limit flag into the output value', () => {
    const result: any = {
      content: [{ type: 'text', text: 'AST body' }],
      details: {
        matchCount: 1,
        fileCount: 1,
        filesSearched: 1,
        limitReached: false,
        cwd: BASE,
        files: ['a.ts'],
        displayContent: AST_DISPLAY,
      },
    }
    const value = toAstGrepToolResult(result)

    expect(value.text).toBe('AST body')
    expect(value.displayContent).toBe(AST_DISPLAY)
    expect(value.cwd).toBe(BASE)
    expect(value.files).toEqual(['a.ts'])
    expect(value.matchCount).toBe(1)
    // 与 grep 同款：引擎没截断时不带这个键（投影按 `=== true` 判）。
    expect(value.truncated).toBeUndefined()
    expect(searchMatchesCardMeta(value)?.files[0]?.path).toBe(path.resolve(BASE, 'a.ts'))

    const limited = toAstGrepToolResult({ ...result, details: { ...result.details, limitReached: true } })
    expect(limited.truncated).toBe(true)
  })

  it('keeps error results throwing (adapter contract unchanged)', () => {
    const result: any = { isError: true, content: [{ type: 'text', text: 'pat is invalid' }], details: {} }
    expect(() => toAstGrepToolResult(result)).toThrow('pat is invalid')
  })

  it('registers a schema that accepts the carrier and projects the same meta', () => {
    const def = captureTool(registerAstGrep)
    expect(def.name).toBe('ast_grep')
    expect(def.output.schema.properties.displayContent.type).toBe('string')
    expect(def.output.schema.properties.matchCount.type).toBe('number')

    const value = { text: 'x', displayContent: AST_DISPLAY, cwd: BASE, files: ['a.ts'], matchCount: 1, truncated: false }
    expect(def.output.presentationMeta({ pat: 'const needle = $A' }, value)).toEqual(
      searchMatchesCardMeta(value),
    )
    // 引擎实跑的空结果形状：matchCount=0 → 出空卡；脏输入仍然显式 null。
    expect(def.output.presentationMeta({ pat: 'x' }, { text: 'No matches found', matchCount: 0, fileCount: 0, files: [] })).toEqual({
      kind: 'search',
      shape: 'matches',
      files: [],
      truncated: false,
      total: 0,
    })
    expect(def.output.presentationMeta({ pat: 'x' }, { text: 'No matches found' })).toBeNull()
    expect(def.output.render({}, value)).toEqual([{ type: 'text', text: 'x' }])
  })

  it('projects a real engine run', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-plus-astgrep-'))
    try {
      fs.writeFileSync(path.join(dir, 'a.ts'), 'const x = 1\nconst needle = 2\n')
      const settings = new Settings(resolveConfig({}), getDefault)
      const session: any = { cwd: dir, settings, hasEditTool: true }
      const result = await new AstGrepTool(session).execute(
        'ast_grep',
        { pat: 'const needle = $A', path: '.' } as never,
        undefined,
      )
      const meta = searchMatchesCardMeta(toAstGrepToolResult(result))
      expect(meta).toEqual({
        kind: 'search',
        shape: 'matches',
        files: [{ path: path.resolve(dir, 'a.ts'), matches: [{ lineNumber: 2, line: 'const needle = 2' }] }],
        truncated: false,
        total: 1,
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
