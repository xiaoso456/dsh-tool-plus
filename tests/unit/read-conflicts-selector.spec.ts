/**
 * T11-1 回归：read `:conflicts` 选择器（Windows NTFS ADS 假阳性）。
 *
 * 两层验证：
 *  1. 集成层：`path:conflicts` 在普通文件系统上能正确输出冲突列表
 *     （临时目录 lstat 直接 ENOENT，probe 走 "missing" 分支，拆分正常）。
 *  2. 单元层：修正版 probe 的判定逻辑——Windows 上 `lstat('file:stream')`
 *     可能落到基文件（ADS 语义）造成假阳性，修正版在 lstat 成功后对含
 *     冒号的 Windows 路径再 open 验证；open 失败 → "missing"（选择器拆分
 *     生效），open 成功 → "exists"（真实文件/真实 ADS）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { executeReadTool } from '../../src/tools/read/adapter/index.ts'
import { resolveProbeResult } from '../../src/tools/shared/win-path-fixes.ts'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-plus-conflicts-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const CONFLICTED = [
  'def choose():',
  '<<<<<<< HEAD',
  '    print("ours")',
  '=======',
  '    print("theirs")',
  '>>>>>>> feature',
  '    return None',
  '',
].join('\n')

function execFor(cwd: string): any {
  return { agent: { session: { header: { cwd } } }, signal: undefined }
}

describe('read :conflicts 选择器（T11-1）', () => {
  it('`path:conflicts` 输出冲突块列表（#1 L2-6）', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'conflicted.py')
    fs.writeFileSync(file, CONFLICTED)

    const out = await executeReadTool(execFor(dir), {} as never, { path: `${file}:conflicts` }, null as never)

    expect(out.text).toContain('1 unresolved conflict')
    expect(out.text).toContain('#1')
    expect(out.text).toContain('L2-6')
  })
})

describe('win-path-fixes probe 判定（T11-1 单元）', () => {
  it('lstat 成功 + open 失败（Windows ADS 假阳性）→ missing，选择器拆分生效', () => {
    expect(resolveProbeResult(true, false, true)).toBe('missing')
  })

  it('lstat 成功 + open 成功（真实文件/真实 ADS）→ exists', () => {
    expect(resolveProbeResult(true, true, true)).toBe('exists')
  })

  it('非冒号路径不做 open 验证：lstat 成功 → exists', () => {
    expect(resolveProbeResult(true, false, false)).toBe('exists')
  })

  it('lstat 失败 → missing（原版语义）', () => {
    expect(resolveProbeResult(false, false, true)).toBe('missing')
  })
})
