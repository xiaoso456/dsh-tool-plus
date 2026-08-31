/**
 * rmSafe: trash-cli 参数解析与 CLI 行为。
 *
 * 用例语义移植自 GNU coreutils tests/rm/（rm4 / f-1 / r-1 / d-1 / dot-rel /
 * v-slash / i-1），差异点：
 * - 删除目标 = 系统回收站（trash 包），非永久删除；
 * - `-i` 接受但忽略交互（用户拍板：也进回收站）；
 * - verbose 只输出顶层项（trash 是原子移动，不递归输出子项）。
 *
 * 铁律：测试只在自己新建的临时目录里操作，绝不触碰系统/现有文件；
 * trash 层用 fake 注入，不污染系统回收站。
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseRmArgs, runTrashCli } from '../../src/tools/bash/trash-cli.ts'
import { makeDeps } from '../helpers/trash-deps.ts'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-trash-cli-test-'))
}

describe('parseRmArgs（coreutils rm 参数语义）', () => {
  it('无参数 → missing operand', () => {
    const parsed = parseRmArgs([])
    expect(parsed.error?.kind).toBe('missing-operand')
  })

  it('未知短选项 → invalid option', () => {
    const parsed = parseRmArgs(['-x'])
    expect(parsed.error).toEqual({ kind: 'invalid-option', option: 'x' })
  })

  it('未知长选项 → unrecognized option', () => {
    const parsed = parseRmArgs(['--unknown'])
    expect(parsed.error).toEqual({ kind: 'unrecognized-option', option: '--unknown' })
  })

  it('组合短选项 -rf', () => {
    const parsed = parseRmArgs(['-rf', 'dir'])
    expect(parsed.recursive).toBe(true)
    expect(parsed.force).toBe(true)
    expect(parsed.paths).toEqual(['dir'])
  })

  it('组合短选项 -rv', () => {
    const parsed = parseRmArgs(['-rv', 'x'])
    expect(parsed.recursive).toBe(true)
    expect(parsed.verbose).toBe(true)
  })

  it('-r / -R / --recursive 等价', () => {
    expect(parseRmArgs(['-r', 'a']).recursive).toBe(true)
    expect(parseRmArgs(['-R', 'a']).recursive).toBe(true)
    expect(parseRmArgs(['--recursive', 'a']).recursive).toBe(true)
  })

  it('--force / --verbose / --dir 长选项', () => {
    expect(parseRmArgs(['--force', 'a']).force).toBe(true)
    expect(parseRmArgs(['--verbose', 'a']).verbose).toBe(true)
    expect(parseRmArgs(['--dir', 'a']).dir).toBe(true)
  })

  it('-i 接受（回收站模式忽略交互）', () => {
    const parsed = parseRmArgs(['-i', 'f'])
    expect(parsed.interactive).toBe(true)
    expect(parsed.paths).toEqual(['f'])
  })

  it('-- 结束符后以 - 开头的路径原样保留', () => {
    const parsed = parseRmArgs(['-f', '--', '-weird'])
    expect(parsed.force).toBe(true)
    expect(parsed.paths).toEqual(['-weird'])
  })

  it('多文件路径', () => {
    const parsed = parseRmArgs(['a', 'b', 'c'])
    expect(parsed.paths).toEqual(['a', 'b', 'c'])
  })
})

describe('runTrashCli（coreutils rm 行为移植）', () => {
  it('rm4 移植：rm dir 无 -r → 失败，目录保留，不进回收站', async () => {
    const dir = tmpDir()
    const target = path.join(dir, 'dir')
    fs.mkdirSync(target)
    const { deps, trashCalls, err, code } = makeDeps()
    await runTrashCli([target], deps)
    expect(code()).toBe(1)
    expect(err.join('\n')).toContain('Is a directory')
    expect(fs.existsSync(target)).toBe(true)
    expect(trashCalls).toHaveLength(0)
  })

  it('f-1 移植：rm -f 不存在 → 成功静默', async () => {
    const dir = tmpDir()
    const { deps, trashCalls, out, err, code } = makeDeps()
    await runTrashCli(['-f', path.join(dir, 'no-such-file')], deps)
    expect(code()).toBe(0)
    expect(out).toHaveLength(0)
    expect(err).toHaveLength(0)
    expect(trashCalls).toHaveLength(0)
  })

  it('非 -f 不存在 → 失败并报 No such file or directory', async () => {
    const dir = tmpDir()
    const { deps, err, code } = makeDeps()
    await runTrashCli([path.join(dir, 'no-such-file')], deps)
    expect(code()).toBe(1)
    expect(err.join('\n')).toContain('No such file or directory')
  })

  it('r-1 移植：rm -r --verbose a b → 输出 removed 行，全部进回收站', async () => {
    const dir = tmpDir()
    const a = path.join(dir, 'a')
    const b = path.join(dir, 'b')
    fs.mkdirSync(path.join(a, 'a'), { recursive: true })
    fs.writeFileSync(b, '')
    const { deps, trashCalls, out, code } = makeDeps()
    await runTrashCli(['-r', '--verbose', a, b], deps)
    expect(code()).toBe(0)
    expect(out).toEqual([`removed directory '${a}'`, `removed '${b}'`])
    expect(trashCalls).toEqual([[a, b]])
  })

  it('d-1 移植：rm --verbose --dir a b → 目录放行', async () => {
    const dir = tmpDir()
    const a = path.join(dir, 'a')
    const b = path.join(dir, 'b')
    fs.mkdirSync(a)
    fs.writeFileSync(b, '')
    const { deps, trashCalls, out, code } = makeDeps()
    await runTrashCli(['--verbose', '--dir', a, b], deps)
    expect(code()).toBe(0)
    expect(out).toEqual([`removed directory '${a}'`, `removed '${b}'`])
    expect(trashCalls).toEqual([[a, b]])
  })

  it('dot-rel 移植：rm -r 两个非空点相对目录 → 成功', async () => {
    const dir = tmpDir()
    const a = path.join(dir, 'a')
    const b = path.join(dir, 'b')
    fs.mkdirSync(a)
    fs.mkdirSync(b)
    fs.writeFileSync(path.join(a, 'f'), '')
    fs.writeFileSync(path.join(b, 'f'), '')
    const { deps, trashCalls, code } = makeDeps()
    await runTrashCli(['-r', a, b], deps)
    expect(code()).toBe(0)
    expect(trashCalls).toEqual([[a, b]])
  })

  it('v-slash 移植：rm --verbose -r a/// → 尾部斜杠规范化为一个', async () => {
    const dir = tmpDir()
    const a = path.join(dir, 'a')
    fs.mkdirSync(a)
    fs.writeFileSync(path.join(a, 'x'), '')
    const { deps, out, code } = makeDeps()
    await runTrashCli(['--verbose', '-r', `${a}///`], deps)
    expect(code()).toBe(0)
    expect(out).toEqual([`removed directory '${a}/'`])
  })

  it('i-1 改造：rm -i file → 不交互，直接进回收站', async () => {
    const dir = tmpDir()
    const f = path.join(dir, 'a')
    fs.writeFileSync(f, '')
    const { deps, trashCalls, code } = makeDeps()
    await runTrashCli(['-i', f], deps)
    expect(code()).toBe(0)
    expect(trashCalls).toEqual([[f]])
  })

  it('多文件一次调用', async () => {
    const dir = tmpDir()
    const a = path.join(dir, 'a')
    const b = path.join(dir, 'b')
    const c = path.join(dir, 'c')
    fs.writeFileSync(a, '')
    fs.writeFileSync(b, '')
    fs.writeFileSync(c, '')
    const { deps, trashCalls, code } = makeDeps()
    await runTrashCli([a, b, c], deps)
    expect(code()).toBe(0)
    expect(trashCalls).toEqual([[a, b, c]])
  })

  it('trash 失败 → 退出 1 并报 cannot remove', async () => {
    const dir = tmpDir()
    const f = path.join(dir, 'a')
    fs.writeFileSync(f, '')
    const { deps, err, code } = makeDeps({
      trash: async () => {
        throw new Error('boom')
      },
    })
    await runTrashCli([f], deps)
    expect(code()).toBe(1)
    expect(err.join('\n')).toContain('cannot remove')
    expect(err.join('\n')).toContain('boom')
  })

  it('trash 失败 + -f → 仍报错退出 1（GNU -f 只静默"不存在"，权限失败仍报）', async () => {
    const dir = tmpDir()
    const f = path.join(dir, 'a')
    fs.writeFileSync(f, '')
    const { deps, err, code } = makeDeps({
      trash: async () => {
        throw new Error('boom')
      },
    })
    await runTrashCli(['-f', f], deps)
    expect(code()).toBe(1)
    expect(err.join('\n')).toContain('cannot remove')
  })

  it('混合：-f 忽略不存在，存在的进回收站', async () => {
    const dir = tmpDir()
    const f = path.join(dir, 'a')
    fs.writeFileSync(f, '')
    const { deps, trashCalls, code } = makeDeps()
    await runTrashCli(['-f', path.join(dir, 'missing'), f], deps)
    expect(code()).toBe(0)
    expect(trashCalls).toEqual([[f]])
  })

  it('-- 分隔符：以 - 开头的文件名进回收站', async () => {
    const dir = tmpDir()
    const weird = path.join(dir, '-weird')
    fs.writeFileSync(weird, '')
    const { deps, trashCalls, code } = makeDeps()
    await runTrashCli(['--', weird], deps)
    expect(code()).toBe(0)
    expect(trashCalls).toEqual([[weird]])
  })
})

describe('rm 保护（coreutils r-root / r-4 移植）', () => {
  it('r-root 移植：rm -rf / 拒绝（preserve-root 默认开启）', async () => {
    const { deps, trashCalls, err, code } = makeDeps()
    await runTrashCli(['-rf', '/'], deps)
    expect(code()).toBe(1)
    expect(err.join('\n')).toContain("it is dangerous to operate recursively on '/'")
    expect(err.join('\n')).toContain('use --no-preserve-root to override')
    expect(trashCalls).toHaveLength(0)
  })

  it('r-root 移植：// 与 /// 同义词拒绝', async () => {
    for (const p of ['//', '///']) {
      const { deps, trashCalls, code } = makeDeps()
      await runTrashCli(['-rf', p], deps)
      expect(code()).toBe(1)
      expect(trashCalls).toHaveLength(0)
    }
  })

  it('r-root 移植：符号链接指向 / 拒绝（dev/ino 判定）', async () => {
    const { deps, trashCalls, code } = makeDeps({
      stat: async (p) => (p === '/rootlink/' || p === '/' ? { dev: 1, ino: 1 } : null),
    })
    await runTrashCli(['-rf', '/rootlink/'], deps)
    expect(code()).toBe(1)
    expect(trashCalls).toHaveLength(0)
  })

  it('r-root 移植：--no-preserve-root 关闭保护后放行', async () => {
    const dir = tmpDir()
    const f = path.join(dir, 'f')
    fs.writeFileSync(f, '')
    const { deps, trashCalls, code } = makeDeps()
    await runTrashCli(['--no-preserve-root', f], deps)
    expect(code()).toBe(0)
    expect(trashCalls).toEqual([[f]])
  })

  it('r-4 移植：rm -rf d/. 拒绝', async () => {
    const dir = tmpDir()
    const d = path.join(dir, 'd')
    fs.mkdirSync(d)
    const { deps, trashCalls, err, code } = makeDeps()
    await runTrashCli(['-rf', `${d}/.`], deps)
    expect(code()).toBe(1)
    expect(err.join('\n')).toContain("refusing to remove '.' or '..' directory")
    expect(trashCalls).toHaveLength(0)
  })

  it('r-4 移植：rm -rf d/.. 拒绝', async () => {
    const dir = tmpDir()
    const d = path.join(dir, 'd')
    fs.mkdirSync(d)
    const { deps, trashCalls, code } = makeDeps()
    await runTrashCli(['-rf', `${d}/..`], deps)
    expect(code()).toBe(1)
    expect(trashCalls).toHaveLength(0)
  })

  it('r-4 移植：d/.//// 拒绝（尾部斜杠规范化）', async () => {
    const dir = tmpDir()
    const d = path.join(dir, 'd')
    fs.mkdirSync(d)
    const { deps, trashCalls, code } = makeDeps()
    await runTrashCli(['-rf', `${d}/.////`], deps)
    expect(code()).toBe(1)
    expect(trashCalls).toHaveLength(0)
  })
})

describe('符号链接（coreutils dangling-symlink 移植）', () => {
  it('悬空链接删除成功（lstat 判断链接本身存在）', async () => {
    const dir = tmpDir()
    const dangling = path.join(dir, 'dangle')
    fs.symlinkSync(path.join(dir, 'no-file'), dangling)
    const { deps, trashCalls, code } = makeDeps()
    await runTrashCli([dangling], deps)
    expect(code()).toBe(0)
    expect(trashCalls).toEqual([[dangling]])
  })

  it('指向目录的链接：rm 删链接本身，不报 Is a directory', async () => {
    const dir = tmpDir()
    const target = path.join(dir, 'target')
    const link = path.join(dir, 'symlink')
    fs.mkdirSync(target)
    fs.symlinkSync(target, link)
    const { deps, trashCalls, err, code } = makeDeps()
    await runTrashCli([link], deps)
    expect(code()).toBe(0)
    expect(err).toHaveLength(0)
    expect(trashCalls).toEqual([[link]])
  })
})

describe('选项接受（coreutils interactive-once / i-never / one-file-system 移植）', () => {
  it('-I 接受并忽略（直接进回收站）', async () => {
    const dir = tmpDir()
    const f = path.join(dir, 'f')
    fs.writeFileSync(f, '')
    const { deps, trashCalls, code } = makeDeps()
    await runTrashCli(['-I', f], deps)
    expect(code()).toBe(0)
    expect(trashCalls).toEqual([[f]])
  })

  it('--interactive=never 接受（i-never 移植）', async () => {
    const dir = tmpDir()
    const f = path.join(dir, 'f')
    fs.writeFileSync(f, '')
    const { deps, trashCalls, code } = makeDeps()
    await runTrashCli(['--interactive=never', f], deps)
    expect(code()).toBe(0)
    expect(trashCalls).toEqual([[f]])
  })

  it('--interactive=once / --interactive=always / 裸 --interactive 接受', async () => {
    for (const opt of ['--interactive=once', '--interactive=always', '--interactive']) {
      const dir = tmpDir()
      const f = path.join(dir, 'f')
      fs.writeFileSync(f, '')
      const { deps, trashCalls, code } = makeDeps()
      await runTrashCli([opt, f], deps)
      expect(code()).toBe(0)
      expect(trashCalls).toEqual([[f]])
    }
  })

  it('--one-file-system 接受（one-file-system2 移植）', async () => {
    const dir = tmpDir()
    const a = path.join(dir, 'a')
    fs.mkdirSync(path.join(a, 'b'), { recursive: true })
    const { deps, trashCalls, code } = makeDeps()
    await runTrashCli(['--one-file-system', '-rf', a], deps)
    expect(code()).toBe(0)
    expect(trashCalls).toEqual([[a]])
  })

  it('--preserve-root=all 接受（one-file-system 移植）', async () => {
    const dir = tmpDir()
    const f = path.join(dir, 'f')
    fs.writeFileSync(f, '')
    const { deps, trashCalls, code } = makeDeps()
    await runTrashCli(['--preserve-root=all', f], deps)
    expect(code()).toBe(0)
    expect(trashCalls).toEqual([[f]])
  })

  it('--preserve-root=bad 拒绝（GNU 只接受 all）', async () => {
    const { deps, err, code } = makeDeps()
    await runTrashCli(['--preserve-root=bad', 'x'], deps)
    expect(code()).toBe(1)
    expect(err.join('\n')).toContain("invalid argument 'bad'")
  })

  it('---presume-input-tty 接受并忽略（GNU 测试内部选项）', async () => {
    const dir = tmpDir()
    const f = path.join(dir, 'f')
    fs.writeFileSync(f, '')
    const { deps, trashCalls, code } = makeDeps()
    await runTrashCli(['---presume-input-tty', f], deps)
    expect(code()).toBe(0)
    expect(trashCalls).toEqual([[f]])
  })
})
