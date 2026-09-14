/**
 * `write` 卡片的宿主投影与适配层接线（计划 §4.1）。
 *
 * write 卡片是"写入内容预览"，meta 只带 `path` + 可选 `lang` —— 不读 before、
 * 不算 hunk、不出 ±。`lang` 用 OMP 的 `getLanguageFromPath` 纯计算得出；认不出
 * 语言时**省略该键**（meta 里出现 `undefined` 会把成功调用变成 isError）。
 *
 * 适配层接线只加一行：`presentationMeta` 走投影函数，`output.schema` 增可选
 * `lang`；模型可见的输出文本与 `render` 一字不变。
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { executeWriteTool, registerWrite } from '../../src/tools/write/adapter/index.ts'
import { projectWriteCardMeta } from '../../src/web/host/write.ts'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-card-meta-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function execFor(cwd: string): any {
  return { agent: { session: { header: { cwd } } }, signal: undefined }
}

/** Capture the tool definition `registerWrite` hands to the host registry. */
function captureDefinition(): any {
  let definition: any
  registerWrite(
    { tools: { register: (value: any) => { definition = value; return () => {} } } } as never,
    (() => ({})) as never,
  )
  return definition
}

describe('write 卡片投影：path + lang', () => {
  it('resolvedPath 优先，lang 由路径算出', () => {
    expect(projectWriteCardMeta({ resolvedPath: '/w/src/a.ts' }, { path: 'a.ts' })).toEqual({
      kind: 'write',
      path: '/w/src/a.ts',
      lang: 'typescript',
    })
  })

  it('没有 resolvedPath 时回退 args.path', () => {
    expect(projectWriteCardMeta(null, { path: '/w/notes.md' })).toEqual({
      kind: 'write',
      path: '/w/notes.md',
      lang: 'markdown',
    })
  })

  it('认不出语言时省略 lang，而不是放一个 undefined 值', () => {
    const meta = projectWriteCardMeta({ path: '/w/weird.zzz' }, null)
    expect(meta).toEqual({ kind: 'write', path: '/w/weird.zzz' })
    expect(meta).not.toBeNull()
    expect(Object.keys(meta!)).toEqual(['kind', 'path'])
    expect(JSON.stringify(meta)).not.toContain('undefined')
  })

  it('没有可用路径时不产 meta（走通用行）', () => {
    expect(projectWriteCardMeta({}, {})).toBeNull()
    expect(projectWriteCardMeta({ path: '   ' }, null)).toBeNull()
    expect(projectWriteCardMeta(undefined, undefined)).toBeNull()
    expect(projectWriteCardMeta(null, { path: 7 })).toBeNull()
  })

  it('畸形输入不抛异常', () => {
    for (const bad of [42, 'x', [], () => {}, { path: 7 }, { resolvedPath: {} }, Symbol('x')]) {
      expect(() => projectWriteCardMeta(bad as never, bad as never)).not.toThrow()
    }
  })
})

describe('write 适配层接线', () => {
  it('output.schema 声明可选 lang，render 仍只吐 value.text', () => {
    const definition = captureDefinition()
    expect(definition.output.schema.properties).toHaveProperty('lang')
    expect(definition.output.schema.properties.lang.type).toBe('string')
    expect(definition.output.render({}, { text: 'hello', path: '/w/a.ts', lang: 'typescript' })).toEqual([
      { type: 'text', text: 'hello' },
    ])
  })

  it('presentationMeta 返回契约形状（kind/path/lang）', () => {
    const definition = captureDefinition()
    expect(
      definition.output.presentationMeta(
        { path: 'a.ts' },
        { text: 'hello', path: '/w/b.ts', lang: 'typescript' },
      ),
    ).toEqual({ kind: 'write', path: '/w/b.ts', lang: 'typescript' })
    // 认不出语言 → 没有 lang 键（narrowWriteCardMeta 才收）
    expect(
      definition.output.presentationMeta({ path: 'a.ts' }, { text: 'hello', path: '/w/c.zzz' }),
    ).toEqual({ kind: 'write', path: '/w/c.zzz' })
    // value 没有路径（异常形态）→ 不产 meta（null，不是 undefined）
    expect(definition.output.presentationMeta({ path: '' }, { text: 'hello', path: '' })).toBeNull()
  })

  it('executeWriteTool：value 带 lang，输出文本仍是引擎原文', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'a.ts')
    const out = await executeWriteTool(execFor(dir), {} as never, { path: file, content: 'const a = 1\n' })
    expect(out.lang).toBe('typescript')
    expect(out.path.endsWith('a.ts')).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('const a = 1\n')
    // 模型可见文本：仍由引擎产出（本改动没有碰 toText/render）。
    expect(out.text).toMatch(/Successfully wrote 12 bytes to a\.ts$/)
  })

  it('回归：失败文案一字未变（auto-generated 守卫）', async () => {
    const dir = tmpDir()
    const guard = path.join(dir, 'zz_generated.go')
    fs.writeFileSync(guard, '// original\n')
    await expect(
      executeWriteTool(execFor(dir), {} as never, { path: guard, content: '// x' }),
    ).rejects.toThrow(/auto-generated/i)
  })
})
