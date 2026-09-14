/**
 * `ast_edit` 卡片的宿主投影与适配层接线（计划 §4.3）。
 *
 * meta = `{ kind:'ast_edit', preview, files, replacements, applied }`：预览文本
 * 取引擎的 `displayContent`（截到 64 KiB），计数取 `fileReplacements` /
 * `totalReplacements` / `applied`。没有 replacement（`No replacements made`）
 * 或没有预览文本时不产 meta，走通用行。
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { registerAstEdit } from '../../src/tools/ast-edit/adapter/index.ts'
import { AST_EDIT_META_MAX_BYTES, jsonByteLength, narrowAstEditCardMeta } from '../../src/web/contract.ts'
import { projectAstEditCardMeta } from '../../src/web/host/ast-edit.ts'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ast-edit-card-meta-')))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** Tool definition `registerAstEdit` hands to the host registry. */
function captureDefinition(): any {
  let definition: any
  registerAstEdit(
    { tools: { register: (value: any) => { definition = value; return () => {} } } } as never,
    (() => ({})) as never,
  )
  return definition
}

const APPLIED_DETAILS = {
  totalReplacements: 2,
  filesTouched: 1,
  applied: true,
  displayContent: 'a.ts\n│1│ const a = 1\n│2│ const b = 2',
  fileReplacements: [{ path: 'a.ts', count: 2 }],
}

describe('ast_edit 卡片投影', () => {
  it('契约形状：preview + files + replacements + applied', () => {
    const meta = projectAstEditCardMeta(APPLIED_DETAILS)
    expect(meta).toEqual({
      kind: 'ast_edit',
      preview: APPLIED_DETAILS.displayContent,
      files: [{ path: 'a.ts', count: 2 }],
      replacements: 2,
      applied: true,
    })
    expect(narrowAstEditCardMeta(meta)).not.toBeNull()
  })

  it('没有 replacement → null（No replacements made 走通用行）', () => {
    expect(projectAstEditCardMeta({ ...APPLIED_DETAILS, totalReplacements: 0, fileReplacements: [] })).toBeNull()
    expect(projectAstEditCardMeta({ ...APPLIED_DETAILS, totalReplacements: 0 })).toBeNull()
    expect(projectAstEditCardMeta({ ...APPLIED_DETAILS, totalReplacements: undefined, fileReplacements: [] })).toBeNull()
  })

  it('没有预览文本 → null', () => {
    expect(projectAstEditCardMeta({ ...APPLIED_DETAILS, displayContent: undefined })).toBeNull()
    expect(projectAstEditCardMeta({ ...APPLIED_DETAILS, displayContent: '' })).toBeNull()
  })

  it('多文件：files 按引擎顺序给出，畸形条目丢弃', () => {
    const meta = projectAstEditCardMeta({
      ...APPLIED_DETAILS,
      totalReplacements: 3,
      fileReplacements: [
        { path: 'a.ts', count: 2 },
        { path: '', count: 1 },
        { path: 'b.ts', count: 'nope' },
        { path: 'c.ts', count: 1 },
      ],
    })
    expect(meta?.files).toEqual([
      { path: 'a.ts', count: 2 },
      { path: 'c.ts', count: 1 },
    ])
    expect(meta?.replacements).toBe(3)
  })

  it('applied 非布尔 → false（dry run 语义），且 meta 里没有 undefined', () => {
    const meta = projectAstEditCardMeta({ ...APPLIED_DETAILS, applied: undefined })
    expect(meta?.applied).toBe(false)
    expect(JSON.stringify(meta)).not.toContain('undefined')
  })

  it('畸形输入不抛异常', () => {
    for (const bad of [42, 'x', [], () => {}, { fileReplacements: 'nope' }, { displayContent: 7 }]) {
      expect(() => projectAstEditCardMeta(bad as never)).not.toThrow()
    }
  })
})

describe('ast_edit 卡片投影：64 KiB 预览上限', () => {
  it('超长 displayContent 截断到上限内，且整体仍是合法 meta', () => {
    const meta = projectAstEditCardMeta({
      ...APPLIED_DETAILS,
      totalReplacements: 5,
      displayContent: 'x'.repeat(200_000),
      fileReplacements: [{ path: 'a.ts', count: 5 }],
    })
    expect(meta).not.toBeNull()
    expect(jsonByteLength(meta)).toBeLessThanOrEqual(AST_EDIT_META_MAX_BYTES)
    expect(meta!.preview.length).toBeGreaterThan(60_000)
    expect(meta!.preview.length).toBeLessThan(200_000)
    // 计数与文件列表保留（截断只动预览）
    expect(meta!.replacements).toBe(5)
    expect(meta!.files).toEqual([{ path: 'a.ts', count: 5 }])
    expect(narrowAstEditCardMeta(meta)).not.toBeNull()
  })

  it('文件列表本身就超限时仍不产超限 meta', () => {
    const files = Array.from({ length: 1200 }, (_, index) => ({
      path: `src/${index}/${'deep/'.repeat(6)}file-${index}-with-a-long-name.ts`,
      count: 1,
    }))
    const meta = projectAstEditCardMeta({ ...APPLIED_DETAILS, totalReplacements: files.length, fileReplacements: files })
    if (meta !== null) {
      expect(jsonByteLength(meta)).toBeLessThanOrEqual(AST_EDIT_META_MAX_BYTES)
      expect(narrowAstEditCardMeta(meta)).not.toBeNull()
    }
  })
})

describe('ast_edit 适配层接线', () => {
  it('output.schema 声明 preview/files/replacements/applied，render 不变', () => {
    const definition = captureDefinition()
    for (const key of ['preview', 'files', 'replacements', 'applied']) {
      expect(definition.output.schema.properties, key).toHaveProperty(key)
    }
    expect(definition.output.render({}, { text: 'ok' })).toEqual([{ type: 'text', text: 'ok' }])
  })

  it('presentationMeta 由 value 收窄成 ast_edit meta；缺预览走兜底', () => {
    const definition = captureDefinition()
    const value = {
      text: 'Applied 2 replacements in 1 file.',
      preview: 'a.ts\n│1│ const a = 1',
      files: [{ path: 'a.ts', count: 2 }],
      replacements: 2,
      applied: true,
    }
    expect(definition.output.presentationMeta({}, value)).toEqual({
      kind: 'ast_edit',
      preview: value.preview,
      files: value.files,
      replacements: 2,
      applied: true,
    })
    expect(definition.output.presentationMeta({}, { text: 'No replacements made.' })).toBeNull()
  })

  it('端到端：真实 ast_edit 调用产出预览并落盘（值形状可被投影消化）', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'a.ts')
    fs.writeFileSync(file, 'const alpha = 1\nconst beta = 2\n')

    const definition = captureDefinition()
    const out = await definition.execute(
      { ops: [{ pat: 'const alpha = $A', out: 'const alpha = 42' }], paths: [file] },
      { agent: { session: { header: { cwd: dir } } }, signal: undefined },
    )
    expect(fs.readFileSync(file, 'utf8')).toContain('const alpha = 42')
    expect(out.replacements).toBeGreaterThan(0)
    expect(typeof out.preview).toBe('string')
    expect(out.preview.length).toBeGreaterThan(0)
    expect(out.text).toMatch(/Applied 1 replacement in 1 file\./)
  })
})
