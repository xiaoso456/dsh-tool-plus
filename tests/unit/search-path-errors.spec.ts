/**
 * 搜索工具的缺失路径文案：相对路径补 working directory，绝对路径只报一行，
 * 多路径之间空一行。不改变路径本身，也不做自动纠偏。
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-search-path-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function execIn(dir: string): any {
  return { agent: { session: { header: { cwd: dir } } }, signal: undefined }
}

async function grepError(dir: string, args: any): Promise<string> {
  const error = await executeGrepTool(execIn(dir), resolveConfig({}), args, undefined as never).then(
    () => null,
    (err: Error) => err,
  )
  return error?.message ?? ''
}

async function globError(dir: string, args: any): Promise<string> {
  const error = await executeGlobTool(execIn(dir), resolveConfig({}), args, undefined as never).then(
    () => null,
    (err: Error) => err,
  )
  return error?.message ?? ''
}

describe('grep/glob 缺失路径文案', () => {
  it('grep 相对路径：补 working directory', async () => {
    const dir = tmpDir()
    await expect(grepError(dir, { pattern: 'x', path: 'missing-dir' }))
      .resolves.toBe(`Path not found: missing-dir\nworking directory: ${dir}`)
  })

  it('grep 多路径：每条补 working directory，组间空一行', async () => {
    const dir = tmpDir()
    await expect(grepError(dir, { pattern: 'x', path: 'missing-a; missing-b' }))
      .resolves.toBe(`Path not found: missing-a\nworking directory: ${dir}\n\nPath not found: missing-b\nworking directory: ${dir}`)
  })

  it('grep 绝对路径：只报第一行', async () => {
    const dir = tmpDir()
    const missing = path.join(dir, 'missing-abs')
    await expect(grepError(dir, { pattern: 'x', path: missing })).resolves.toBe(`Path not found: ${missing}`)
  })

  it('glob 相对路径：补 working directory', async () => {
    const dir = tmpDir()
    await expect(globError(dir, { path: 'missing-dir/**/*.ts' }))
      .resolves.toBe(`Path not found: missing-dir\nworking directory: ${dir}`)
  })

  it('glob 绝对路径：只报第一行', async () => {
    const dir = tmpDir()
    const missing = path.join(dir, 'missing-abs', '**', '*.ts')
    await expect(globError(dir, { path: missing })).resolves.toBe(`Path not found: ${missing.replace(/\\/g, '/')}`)
  })
})
