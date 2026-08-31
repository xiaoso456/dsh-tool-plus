/**
 * rmSafe: rm 重定义脚本生成与快照注入。
 *
 * - rmSafeScript：生成 bash 函数定义（rm → node trash-cli）；
 * - ensureRmSafeScript：写脚本文件，内容不变时幂等（不重写）；
 * - injectRmSafe：向快照文件追加 source 行，幂等（不重复追加）；
 * - win32 快照：getOrCreateSnapshot 在 Windows 上不再返回 null，而是生成
 *   "仅注入"快照文件，让 rmSafe 在 Windows Git bash 也生效。
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ensureRmSafeScript, injectRmSafe, rmSafeScript } from '../../src/tools/bash/rm-safe.ts'
import { getOrCreateSnapshot } from '../../src/tools/bash/shell-snapshot.ts'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rm-safe-test-'))
}

describe('rmSafeScript', () => {
  it('生成 bash 函数定义，内嵌 node 与 cli 绝对路径', () => {
    const script = rmSafeScript('C:/node.exe', 'C:/plugin/lib/trash-cli.mjs')
    expect(script).toContain('rm()')
    expect(script).toContain("'C:/node.exe'")
    expect(script).toContain("'C:/plugin/lib/trash-cli.mjs'")
    expect(script).toContain('"$@"')
  })

  it('路径含单引号时正确转义', () => {
    const script = rmSafeScript('/opt/node', "/opt/it's/lib/trash-cli.mjs")
    expect(script).toContain("'/opt/it'\\''s/lib/trash-cli.mjs'")
  })
})

describe('ensureRmSafeScript', () => {
  it('生成脚本文件并返回路径', () => {
    const dir = tmpDir()
    const p = ensureRmSafeScript(dir, 'node', 'cli')
    expect(fs.existsSync(p)).toBe(true)
    expect(fs.readFileSync(p, 'utf8')).toContain('rm()')
  })

  it('内容不变时幂等（不重写文件）', () => {
    const dir = tmpDir()
    const p1 = ensureRmSafeScript(dir, 'node', 'cli')
    const mtime1 = fs.statSync(p1).mtimeMs
    const p2 = ensureRmSafeScript(dir, 'node', 'cli')
    expect(p2).toBe(p1)
    expect(fs.statSync(p2).mtimeMs).toBe(mtime1)
  })

  it('node/cli 路径变化时重写', () => {
    const dir = tmpDir()
    const p1 = ensureRmSafeScript(dir, 'node-v1', 'cli')
    const p2 = ensureRmSafeScript(dir, 'node-v2', 'cli')
    expect(p2).toBe(p1)
    expect(fs.readFileSync(p2, 'utf8')).toContain('node-v2')
  })

  it('目录不可用时返回 null（不抛异常）', () => {
    const dir = tmpDir()
    const fileAsDir = path.join(dir, 'not-a-dir')
    fs.writeFileSync(fileAsDir, '')
    const p = ensureRmSafeScript(fileAsDir, 'node', 'cli')
    expect(p).toBeNull()
  })
})

describe('injectRmSafe', () => {
  it('向快照文件追加 source 行', () => {
    const dir = tmpDir()
    const snapshot = path.join(dir, 'snapshot.sh')
    fs.writeFileSync(snapshot, '# header\n')
    injectRmSafe(snapshot, '/tmp/rm-safe.sh')
    const content = fs.readFileSync(snapshot, 'utf8')
    expect(content).toContain("source '/tmp/rm-safe.sh'")
    expect(content.startsWith('# header\n')).toBe(true)
  })

  it('幂等：重复注入不追加第二遍', () => {
    const dir = tmpDir()
    const snapshot = path.join(dir, 'snapshot.sh')
    fs.writeFileSync(snapshot, '# header\n')
    injectRmSafe(snapshot, '/tmp/rm-safe.sh')
    injectRmSafe(snapshot, '/tmp/rm-safe.sh')
    const content = fs.readFileSync(snapshot, 'utf8')
    expect(content.match(/source '\/tmp\/rm-safe\.sh'/g)).toHaveLength(1)
  })

  it('快照文件不可读时返回 false（不抛异常）', () => {
    const dir = tmpDir()
    const missing = path.join(dir, 'no-such-snapshot.sh')
    expect(injectRmSafe(missing, '/tmp/rm-safe.sh')).toBe(false)
  })
})

describe('win32 快照注入点', () => {
  it('Windows 上 getOrCreateSnapshot 返回非 null 的注入文件', async () => {
    if (process.platform !== 'win32') return
    const snapshotPath = await getOrCreateSnapshot('bash', {})
    expect(snapshotPath).not.toBeNull()
    expect(fs.existsSync(snapshotPath!)).toBe(true)
  })
})
