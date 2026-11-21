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
import { executeEditTool, registerEdit } from '../../src/tools/edit/adapter/index.ts'

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

  it('patch：只暴露 path / patch，两者必填', () => {
    const schema = schemaFor('patch')
    expect(Object.keys(schema.properties).sort()).toEqual(['patch', 'path'])
    expect([...schema.required].sort()).toEqual(['patch', 'path'])
    expect(schema.properties.old_string).toBeUndefined()
    expect(schema.properties.input).toBeUndefined()
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
