/**
 * §4.7 glob 结果卡 meta 投影：`details.files` → 官方 search 卡的
 * `{kind:'search', shape:'paths', paths, truncated, total}`。
 *
 * 覆盖：顺序保持、total 取引擎的 fileCount、空结果不产 meta、
 * 超 64 KiB 丢尾部 path 且 total 保持截断前原值、适配层接线。
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveConfig } from '../../src/config/settings.ts'
import { SEARCH_META_MAX_BYTES, jsonByteLength, narrowSearchCardMeta } from '../../src/web/contract.ts'
import { searchPathsCardMeta } from '../../src/web/host/search.ts'
import { executeGlobTool, registerGlob } from '../../src/tools/glob/adapter/index.ts'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-plus-globcard-'))
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

describe('glob card meta — paths projection', () => {
  it('projects the engine file list, in order, with the engine total', () => {
    const meta = searchPathsCardMeta({ paths: ['src/a.ts', 'src/b.ts', 'README.md'], total: 3, truncated: false })
    expect(meta).toEqual({
      kind: 'search',
      shape: 'paths',
      paths: ['src/a.ts', 'src/b.ts', 'README.md'],
      truncated: false,
      total: 3,
    })
    expect(narrowSearchCardMeta(meta)).not.toBeNull()
  })

  it('falls back to the path count for total and keeps the engine truncation flag', () => {
    expect(searchPathsCardMeta({ paths: ['a.ts'] })?.total).toBe(1)
    expect(searchPathsCardMeta({ paths: ['a.ts'], truncated: true })?.truncated).toBe(true)
  })

  it('drops non-string entries instead of failing', () => {
    expect(searchPathsCardMeta({ paths: ['a.ts', 7, null, 'b.ts'], total: 4 })).toEqual({
      kind: 'search',
      shape: 'paths',
      paths: ['a.ts', 'b.ts'],
      truncated: true,
      total: 4,
    })
  })

  it('draws an empty-result card when the engine returns no paths', () => {
    expect(searchPathsCardMeta({ paths: [], total: 0, truncated: false })).toEqual({
      kind: 'search',
      shape: 'paths',
      paths: [],
      truncated: false,
      total: 0,
    })
    expect(searchPathsCardMeta({ paths: ['a.ts', 'b.ts'], total: 0 })).toEqual({
      kind: 'search',
      shape: 'paths',
      paths: ['a.ts', 'b.ts'],
      truncated: false,
      total: 2,
    })
    // 没有 paths 键 = 不是 glob 结果（脏输入 / 别的工具的值）→ 不产卡。
    expect(searchPathsCardMeta({})).toBeNull()
    expect(searchPathsCardMeta(null)).toBeNull()
  })
})

describe('glob card meta — 64 KiB cap', () => {
  it('drops trailing paths, flags truncated, and keeps the pre-cap total', () => {
    const paths = Array.from({ length: 1_200 }, (_, index) => `src/${'y'.repeat(80)}-${index}.ts`)
    const meta = searchPathsCardMeta({ paths, total: 9_999, truncated: false })

    expect(meta).not.toBeNull()
    expect(meta!.paths.length).toBeGreaterThan(0)
    expect(meta!.paths.length).toBeLessThan(paths.length)
    expect(meta!.truncated).toBe(true)
    expect(meta!.total).toBe(9_999)
    expect(jsonByteLength(meta)).toBeLessThanOrEqual(SEARCH_META_MAX_BYTES)
    expect(narrowSearchCardMeta(meta)).not.toBeNull()
    expect(meta!.paths[0]).toBe(paths[0])
  })
})

describe('glob card meta — adapter wiring', () => {
  it('carries the engine file list into the value and leaves the text alone', async () => {
    const dir = tmpDir()
    fs.mkdirSync(path.join(dir, 'src'))
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'x\n')
    fs.writeFileSync(path.join(dir, 'src', 'b.ts'), 'x\n')
    fs.writeFileSync(path.join(dir, 'README.md'), 'x\n')

    const out = await executeGlobTool(execIn(dir), resolveConfig({}), { path: '**/*.ts' }, undefined as never)

    expect(out.text).toContain('b.ts')
    expect(out.paths?.slice().sort()).toEqual(['src/a.ts', 'src/b.ts'])
    expect(out.fileCount).toBe(2)
    expect(searchPathsCardMeta(out)).toEqual({
      kind: 'search',
      shape: 'paths',
      paths: out.paths,
      truncated: false,
      total: 2,
    })
  })

  it('produces an empty-result card for an empty engine result', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'a.ts'), 'x\n')

    const out = await executeGlobTool(execIn(dir), resolveConfig({}), { path: '**/*.rs' }, undefined as never)
    expect(out.text).toContain('No files found')
    expect(out.paths).toEqual([])
    expect(searchPathsCardMeta(out)).toEqual({
      kind: 'search',
      shape: 'paths',
      paths: [],
      truncated: false,
      total: 0,
    })
  })

  it('registers a schema that accepts the paths carrier and projects the same meta', () => {
    const def = captureTool(registerGlob)
    expect(def.name).toBe('glob')
    expect(def.output.schema.properties.paths.type).toBe('array')

    const value = { path: '.', text: 'x', paths: ['src/a.ts'], fileCount: 1, truncated: false }
    expect(def.output.presentationMeta({ path: '*' }, value)).toEqual(
      searchPathsCardMeta(value),
    )
    // 引擎实跑的空结果形状：paths=[] → 出「0 个路径」空卡。
    expect(def.output.presentationMeta({ path: '*' }, { path: '.', text: 'No files found matching pattern', paths: [], fileCount: 0, truncated: false })).toEqual({
      kind: 'search',
      shape: 'paths',
      paths: [],
      truncated: false,
      total: 0,
    })
    expect(def.output.render({}, value)).toEqual([{ type: 'text', text: 'x' }])
  })
})
