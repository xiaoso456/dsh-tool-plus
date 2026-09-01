/**
 * rmSafe: rm 重定义脚本生成与快照注入。
 *
 * - rmSafeScript：生成 bash 函数定义（rm → node trash-cli）；
 * - injectRmSafe：向快照文件内联追加函数定义，幂等（不重复追加）；
 * - win32 快照：getOrCreateSnapshot 在 Windows 上不再返回 null，而是生成
 *   "仅注入"快照文件，让 rmSafe 在 Windows Git bash 也生效。
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { injectRmSafe, rmSafeScript } from '../../src/tools/bash/rm-safe.ts'
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

describe('injectRmSafe', () => {
  it('向快照文件内联追加 rm 函数定义', () => {
    const dir = tmpDir()
    const snapshot = path.join(dir, 'snapshot.sh')
    fs.writeFileSync(snapshot, '# header\n')
    injectRmSafe(snapshot, 'C:/node.exe', 'C:/plugin/lib/trash-cli.mjs')
    const content = fs.readFileSync(snapshot, 'utf8')
    expect(content).toContain('# dsh-tool-plus rmSafe')
    expect(content).toContain('rm()')
    expect(content).toContain("'C:/node.exe' 'C:/plugin/lib/trash-cli.mjs' \"$@\"")
    expect(content.startsWith('# header\n')).toBe(true)
  })

  it('幂等：重复注入不追加第二遍', () => {
    const dir = tmpDir()
    const snapshot = path.join(dir, 'snapshot.sh')
    fs.writeFileSync(snapshot, '# header\n')
    injectRmSafe(snapshot, 'C:/node.exe', 'C:/plugin/lib/trash-cli.mjs')
    injectRmSafe(snapshot, 'C:/node.exe', 'C:/plugin/lib/trash-cli.mjs')
    const content = fs.readFileSync(snapshot, 'utf8')
    expect(content.match(/rm\(\)/g)).toHaveLength(1)
  })

  it('快照文件不可读时返回 false（不抛异常）', () => {
    const dir = tmpDir()
    const missing = path.join(dir, 'no-such-snapshot.sh')
    expect(injectRmSafe(missing, 'C:/node.exe', 'C:/plugin/lib/trash-cli.mjs')).toBe(false)
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
