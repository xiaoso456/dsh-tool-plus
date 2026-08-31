/**
 * coreutils tests/rm/ 移植套件。
 *
 * 上游对照：refs/coreutils-tests/rm/（verbatim 下载，50 个官方用例）。
 * 分类：
 * - A = 直接移植（语义对齐，仅 -i/-I/--interactive 交互忽略）；
 * - C = 回收站语义重解释（trash 原子移动 vs rm 递归删除的差异）；
 * - D = 天然免疫验证（trash 原子移动无递归遍历，深层/海量目录直接成功）。
 *
 * 铁律：只在自己新建的临时目录操作，绝不触碰系统/现有文件；
 * trash 层用 fake 注入，不污染系统回收站。
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { runTrashCli } from '../../src/tools/bash/trash-cli.ts'
import { makeDeps } from '../helpers/trash-deps.ts'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rm-coreutils-'))
}

describe('A 类：直接移植', () => {
  it('empty-name-1：rm -r "" 失败（empty-name.pl / sunos-1）', async () => {
    const { deps, err, code } = makeDeps()
    await runTrashCli(['-r', ''], deps)
    expect(code()).toBe(1)
    expect(err.join('\n')).toContain("cannot remove '': No such file or directory")
  })

  it('empty-name-2：rm a "" b → a/b 进回收站，空名报错', async () => {
    const dir = tmpDir()
    const a = path.join(dir, 'a')
    const b = path.join(dir, 'b')
    fs.writeFileSync(a, '')
    fs.writeFileSync(b, '')
    const { deps, trashCalls, err, code } = makeDeps()
    await runTrashCli([a, '', b], deps)
    expect(code()).toBe(1)
    expect(err.join('\n')).toContain("cannot remove '': No such file or directory")
    expect(trashCalls).toEqual([[a, b]])
  })

  it('d-3：rm -i -d --verbose 空目录 → 进回收站并输出 removed directory', async () => {
    const dir = tmpDir()
    const d = path.join(dir, 'd')
    fs.mkdirSync(d)
    const { deps, trashCalls, out, code } = makeDeps()
    await runTrashCli(['-i', '-d', '--verbose', d], deps)
    expect(code()).toBe(0)
    expect(out).toEqual([`removed directory '${d}'`])
    expect(trashCalls).toEqual([[d]])
  })

  it('ignorable：rm -f 普通文件路径下的子段 → 静默成功', async () => {
    const dir = tmpDir()
    const f = path.join(dir, 'existing-non-dir')
    fs.writeFileSync(f, '')
    const { deps, trashCalls, out, err, code } = makeDeps()
    await runTrashCli(['-f', `${f}/child`], deps)
    expect(code()).toBe(0)
    expect(out).toHaveLength(0)
    expect(err).toHaveLength(0)
    expect(trashCalls).toHaveLength(0)
  })

  it('i-no-r：rm -i dir（无 -r）→ 失败，目录保留', async () => {
    const dir = tmpDir()
    const d = path.join(dir, 'dir')
    fs.mkdirSync(d)
    const { deps, trashCalls, err, code } = makeDeps()
    await runTrashCli(['-i', d], deps)
    expect(code()).toBe(1)
    expect(err.join('\n')).toContain('Is a directory')
    expect(fs.existsSync(d)).toBe(true)
    expect(trashCalls).toHaveLength(0)
  })
})

describe('C 类：回收站语义重解释', () => {
  it('cycle：rm -rf a a 重复参数 + trash 失败 → 报错退出 1', async () => {
    const dir = tmpDir()
    const a = path.join(dir, 'a')
    fs.mkdirSync(path.join(a, 'b'), { recursive: true })
    fs.writeFileSync(path.join(a, 'b', 'file'), '')
    const { deps, err, code } = makeDeps({
      trash: async () => {
        throw new Error('EACCES')
      },
    })
    await runTrashCli(['-rf', a, a], deps)
    expect(code()).toBe(1)
    expect(err.join('\n')).toContain('cannot remove')
  })

  it('d-2 重解释：rm -d 非空目录 → 进回收站成功（trash 原子移动，GNU 报 ENOTEMPTY）', async () => {
    const dir = tmpDir()
    const d = path.join(dir, 'd')
    fs.mkdirSync(d)
    fs.writeFileSync(path.join(d, 'a'), '')
    const { deps, trashCalls, code } = makeDeps()
    await runTrashCli(['-d', d], deps)
    expect(code()).toBe(0)
    expect(trashCalls).toEqual([[d]])
  })

  it('r-2 重解释：rm --verbose -r t/a → 只输出顶层项（trash 原子移动，不递归输出子项）', async () => {
    const dir = tmpDir()
    const t = path.join(dir, 't')
    const a = path.join(t, 'a')
    fs.mkdirSync(path.join(a, 'b'), { recursive: true })
    fs.writeFileSync(path.join(a, 'f'), '')
    fs.writeFileSync(path.join(a, 'b', 'g'), '')
    const { deps, out, code } = makeDeps()
    await runTrashCli(['--verbose', '-r', a], deps)
    expect(code()).toBe(0)
    expect(out).toEqual([`removed directory '${a}'`])
  })

  it('ir-1 重解释：rm -ir t → 忽略交互，全部进回收站', async () => {
    const dir = tmpDir()
    const t = path.join(dir, 't')
    fs.mkdirSync(path.join(t, 'a'), { recursive: true })
    fs.mkdirSync(path.join(t, 'b'))
    fs.mkdirSync(path.join(t, 'c'))
    fs.writeFileSync(path.join(t, 'a', 'a'), '')
    fs.writeFileSync(path.join(t, 'b', 'bb'), '')
    fs.writeFileSync(path.join(t, 'c', 'cc'), '')
    const { deps, trashCalls, code } = makeDeps()
    await runTrashCli(['-i', '-r', t], deps)
    expect(code()).toBe(0)
    expect(trashCalls).toEqual([[t]])
  })

  it('rm1 重解释：trash 失败（权限）→ 报错退出 1，未移动的保留', async () => {
    const dir = tmpDir()
    const b = path.join(dir, 'b')
    fs.mkdirSync(path.join(b, 'a', 'p'), { recursive: true })
    fs.mkdirSync(path.join(b, 'c'))
    fs.mkdirSync(path.join(b, 'd'))
    const { deps, err, code } = makeDeps({
      trash: async () => {
        throw new Error('EACCES')
      },
    })
    await runTrashCli(['-rf', b], deps)
    expect(code()).toBe(1)
    expect(err.join('\n')).toContain('cannot remove')
    // 目录未被 fake 移动，仍在原处
    expect(fs.existsSync(path.join(b, 'a', 'p'))).toBe(true)
  })
})

describe('D 类：天然免疫验证（trash 原子移动）', () => {
  it('deep-1 简化：50 层嵌套目录 rm -r → 成功', async () => {
    const dir = tmpDir()
    const t = path.join(dir, 't')
    let deep = t
    for (let i = 0; i < 50; i++) deep = path.join(deep, 'k')
    fs.mkdirSync(deep, { recursive: true })
    const { deps, trashCalls, code } = makeDeps()
    await runTrashCli(['-r', t], deps)
    expect(code()).toBe(0)
    expect(trashCalls).toEqual([[t]])
  })

  it('r-3：500 文件目录 rm -rf → 成功', async () => {
    const dir = tmpDir()
    const t = path.join(dir, 't')
    fs.mkdirSync(t)
    for (let i = 0; i < 500; i++) fs.writeFileSync(path.join(t, `f${i}`), '')
    const { deps, trashCalls, code } = makeDeps()
    await runTrashCli(['-rf', t], deps)
    expect(code()).toBe(0)
    expect(trashCalls).toEqual([[t]])
  })

  it('readdir-bug：250 个 40 位文件名 rm -rf → 成功', async () => {
    const dir = tmpDir()
    const b = path.join(dir, 'b')
    fs.mkdirSync(b)
    for (let i = 1; i <= 250; i++) fs.writeFileSync(path.join(b, String(i).padStart(40, '0')), '')
    const { deps, trashCalls, code } = makeDeps()
    await runTrashCli(['-rf', b], deps)
    expect(code()).toBe(0)
    expect(trashCalls).toEqual([[b]])
  })

  it('hash 简化：多层多树 rm -r → 成功', async () => {
    const dir = tmpDir()
    const t = path.join(dir, 't')
    for (const i of ['1', '2', '3']) {
      for (const j of ['a', 'b', 'c']) {
        let deep = path.join(t, i, j)
        for (let k = 0; k < 20; k++) deep = path.join(deep, 'y')
        fs.mkdirSync(deep, { recursive: true })
      }
    }
    const { deps, trashCalls, code } = makeDeps()
    await runTrashCli(['-r', t], deps)
    expect(code()).toBe(0)
    expect(trashCalls).toEqual([[t]])
  })
})
