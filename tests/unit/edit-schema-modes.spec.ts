/**
 * A 方案：edit 按 editMode 只暴露该模式的参数表。
 *
 * - replace 必填 path / old_string / new_string，edits[] 不再暴露；
 * - patch 必填 path / patch；
 * - hashline / apply_patch 只暴露必填 input；
 * - 单条 replace 缺 new_string 时 adapter 拒绝，不能静默删除。
 * @module tests
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../../src/config/settings.ts'
import { EDIT_MODE_DESCRIPTIONS, executeEditTool, registerEdit } from '../../src/tools/edit/adapter/index.ts'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-edit-schema-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function execFor(cwd: string): any {
  return { agent: { session: { header: { cwd } } }, signal: undefined }
}

function schemaFor(mode: 'replace' | 'patch' | 'hashline' | 'apply_patch'): any {
  let definition: any
  const ctx = {
    tools: {
      register: (value: any) => {
        definition = value
        return () => undefined
      },
    },
  } as any
  registerEdit(ctx, () => resolveConfig({ editMode: mode }))
  return definition.parameters
}

describe('edit schema 按模式暴露', () => {
  it('replace：path / old_string / new_string 必填，不再暴露 edits', () => {
    const schema = schemaFor('replace')
    expect(Object.keys(schema.properties).sort()).toEqual(['new_string', 'old_string', 'path', 'replace_all'])
    expect([...schema.required].sort()).toEqual(['new_string', 'old_string', 'path'])
    expect(schema.properties.edits).toBeUndefined()
    expect(schema.properties.patch).toBeUndefined()
    expect(schema.properties.input).toBeUndefined()
  })

  it('patch：只暴露 path / edits，两者必填（OMP 18.12.6 形状）', () => {
    const schema = schemaFor('patch')
    expect(Object.keys(schema.properties).sort()).toEqual(['edits', 'path'])
    expect([...schema.required].sort()).toEqual(['edits', 'path'])
    expect(schema.properties.old_string).toBeUndefined()
    expect(schema.properties.input).toBeUndefined()
    expect(schema.properties.patch, '旧 patch: string 别名已按 A 方案删除').toBeUndefined()
    expect(schema.properties.edits.type).toBe('array')
    // 条目形状守护：op/rename/diff（不是 replace 的 oldText/newText）
    const entry = schema.properties.edits.items
    expect(Object.keys(entry.properties).sort()).toEqual(['diff', 'op', 'rename'])
    expect(entry.properties.op.enum).toEqual(['update', 'create', 'delete'])
  })

  it('hashline / apply_patch：只暴露必填 input', () => {
    for (const mode of ['hashline', 'apply_patch'] as const) {
      const schema = schemaFor(mode)
      expect(Object.keys(schema.properties)).toEqual(['input'])
      expect(schema.required).toEqual(['input'])
      expect(schema.properties.path).toBeUndefined()
      expect(schema.properties.patch).toBeUndefined()
    }
  })
})

describe('单条 replace 的 new_string 守卫', () => {
  it('缺失 new_string 时报错，文件保持原样', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'a.txt')
    fs.writeFileSync(file, 'hello world\n')

    const error = await executeEditTool(
      execFor(dir),
      resolveConfig({ editMode: 'replace', writeBackend: 'native', writeRetryEnabled: false }),
      { path: file, old_string: 'hello' },
      null,
    ).then(() => null, (err: Error) => err)

    expect(error?.message).toContain('new_string is required')
    expect(fs.readFileSync(file, 'utf8')).toBe('hello world\n')
  })

  it('显式传空字符串仍然允许删除', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'a.txt')
    fs.writeFileSync(file, 'hello world\n')

    await executeEditTool(
      execFor(dir),
      resolveConfig({ editMode: 'replace', writeBackend: 'native', writeRetryEnabled: false }),
      { file_path: file, old_string: 'hello', new_string: '' },
      null,
    )
    expect(fs.readFileSync(file, 'utf8')).toBe(' world\n')
  })
})


describe('replace 提示词里的 shell 指令与实际环境一致', () => {
  const replaceDesc = () => (EDIT_MODE_DESCRIPTIONS as Record<string, string>).replace ?? ''

  // 18.12.6 的 replace.md 在命令表里教 `sed -E -i`；我们原来是 `sd`。
  // 实测本 shell 里没有 `sd`（command -v 为空），`sed -E -i` 可用（brush 的 uutils sed）。
  // 这条守卫钉住文案不许再退回一个跑不通的命令。
  it('教的是 sed -E -i，不是不存在的 sd', () => {
    const text = replaceDesc()
    expect(text).toContain("`sed -E -i 's/pattern/replacement/g' file`")
    expect(text).not.toContain("`sd 'pattern'")
  })
})
