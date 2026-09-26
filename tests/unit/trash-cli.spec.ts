/**
 * rmSafe: trash-cli 参数解析、CLI 行为、coreutils 移植与失败诊断。
 *
 * 本文件是 trash-cli 的规范单元测试，合并自四个文件：
 * - trash-cli.spec.ts（原内容：parseRmArgs / 行为移植 / rm 保护 / 符号链接 / 选项接受）
 * - trash-cli-coreutils.spec.ts（coreutils tests/rm 移植 A/C/D 三类）
 * - trash-cli-fallback.spec.ts（失败诊断 describeProbeCode + win32 探测）
 * - trash-cli-msys.spec.ts（MSYS 盘符别名）
 *
 * 用例语义移植自 GNU coreutils tests/rm/（rm4 / f-1 / r-1 / d-1 / dot-rel /
 * v-slash / i-1 ...），差异点：
 * - 删除目标 = 系统回收站（trash 包），非永久删除；
 * - `-i` 接受但忽略交互（用户拍板：也进回收站）；
 * - verbose 只输出顶层项（trash 是原子移动，不递归输出子项）。
 *
 * coreutils 移植分类：
 * - A = 直接移植（语义对齐，仅 -i/-I/--interactive 交互忽略）；
 * - C = 回收站语义重解释（trash 原子移动 vs rm 递归删除的差异）；
 * - D = 天然免疫验证（trash 原子移动无递归遍历，深层/海量目录直接成功）。
 *
 * 失败诊断：trash 包的 windows-trash.exe 失败时 stderr 为空、退出码
 * 0x8000FFFF（E_UNEXPECTED），用户只看到 "Command failed: <exe> <args>"。
 * 修的是 **信息丢失** 这一根因：用 rename 探测拿文件系统的真实回答（能否移动），
 * 把 errno 映射成可读原因。不同 errno 必须分开报——权限不足不是"被占用"。
 * 不做"换一条通道再删一次"的绕行：文件被占用是真实运行时条件，任何通道都
 * 删不掉它，绕行只会掩盖原因。平台：win32 才做探测。
 *
 * MSYS 盘符别名：bash 会话把 `rm` 重定义为 `node trash-cli.mjs "$@"`，argv
 * 原样来自 shell——包括 `/d/code/foo` 这类 MSYS 盘符别名。Node 的 fs 会把
 * 前导盘符别名解析成当前盘的根相对路径而非目标盘路径，不转换就会静默指向
 * 错误目录（误删风险）。CLI 必须在任何 fs/trash 调用前转换盘符别名，同时在
 * verbose/错误消息里保留用户输入的拼写（Git-bash rm 打印用户打的字）。
 *
 * 铁律：测试只在自己新建的临时目录里操作，绝不触碰系统/现有文件；
 * trash 层用 fake 注入，不污染系统回收站。
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describeProbeCode, parseRmArgs, runTrashCli } from '../../src/tools/bash/trash-cli.ts'
import { makeDeps } from '../helpers/trash-deps.ts'

const IS_WIN32 = process.platform === 'win32'

// fake lstat：把每个删除目标都当作已存在的普通文件（失败诊断用例专用）。
const lstatOk = async () => ({ isDirectory: false })

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-trash-cli-test-'))
}

/**
 * 建一个「链接」夹具：POSIX 用真 symlink，Windows 用 junction。
 *
 * Windows 的 `CreateSymbolicLink` 需要管理员权限或开发者模式，普通用户/CI 直接
 * EPERM（2026-09-25 实测本机：未提权且未开开发者模式 → "此操作需要管理员权限"）。
 * 测试夹具不该依赖系统权限：junction 是同一种重解析点，Node 的 `lstat` 对它同样报
 * `isSymbolicLink=true` / `isDirectory=false`（与指向目录的 symlink 同形，正是这两个
 * 用例要断言的形状），而普通用户在 NTFS 上就能建。
 * @param target - 链接指向的目标（Windows 上必须是**已存在**的目录）。
 * @param link - 链接自身路径。
 */
function makeLink(target: string, link: string): void {
  fs.symlinkSync(target, link, IS_WIN32 ? 'junction' : 'file')
}

/**
 * 建一个悬空链接：先建目标目录并链接，再删掉目标目录，链接就悬空了。
 * POSIX 下 symlink 允许直接指向不存在的路径，但这条统一路径在两边都成立（少一个分支），
 * 且「lstat 看得见链接本身、stat 追不到目标」的语义与原始夹具一致。
 * @param dir - 夹具目录。
 * @param link - 链接自身路径。
 */
function makeDanglingLink(dir: string, link: string): void {
  const target = path.join(dir, 'gone')
  fs.mkdirSync(target)
  makeLink(target, link)
  fs.rmdirSync(target)
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
    makeDanglingLink(dir, dangling)
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
    makeLink(target, link)
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

describe('coreutils tests/rm 移植（原 trash-cli-coreutils.spec.ts）', () => {
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

})

describe('失败诊断（原 trash-cli-fallback.spec.ts）', () => {
  describe('describeProbeCode', () => {
    it('maps EBUSY/ENOTEMPTY/PROBE_STUCK to a locked-or-unmovable reason', () => {
      for (const code of ['EBUSY', 'ENOTEMPTY', 'PROBE_STUCK']) {
        expect(describeProbeCode(code)).toContain('locked or cannot be moved')
      }
    })

    it('maps EPERM/EACCES to a permission reason, not a lock reason', () => {
      for (const code of ['EPERM', 'EACCES']) {
        const reason = describeProbeCode(code)
        expect(reason).toContain('permission denied')
        expect(reason).not.toContain('locked')
      }
    })

    it('maps ENOENT/ENOTDIR to a vanished-path reason', () => {
      for (const code of ['ENOENT', 'ENOTDIR']) {
        expect(describeProbeCode(code)).toContain('no longer exists')
      }
    })

    it('returns null for a movable path and for unknown codes', () => {
      expect(describeProbeCode(null)).toBeNull()
      expect(describeProbeCode('UNKNOWN')).toBeNull()
      expect(describeProbeCode('EMFILE')).toBeNull()
    })
  })

  describe('runTrashCli failure diagnostics (win32 only)', () => {
    it.skipIf(!IS_WIN32)('appends the probed lock reason when trash fails', async () => {
      const h = makeDeps({
        lstat: lstatOk,
        trash: async () => {
          throw new Error('Command failed: windows-trash.exe C:\\x\\a')
        },
        probeRename: async () => 'EBUSY',
      })
      await runTrashCli(['C:\\x\\a'], h.deps)
      expect(h.code()).toBe(1)
      const err = h.err.join('\n')
      expect(err).toContain("cannot remove 'C:\\x\\a'")
      expect(err).toContain('locked or cannot be moved')
      expect(err).not.toContain('Command failed')
    })

    it.skipIf(!IS_WIN32)('reports permission failures as such', async () => {
      const h = makeDeps({
        lstat: lstatOk,
        trash: async () => {
          throw new Error('Command failed: windows-trash.exe C:\\x\\a')
        },
        probeRename: async () => 'EPERM',
      })
      await runTrashCli(['C:\\x\\a'], h.deps)
      expect(h.code()).toBe(1)
      expect(h.err.join('\n')).toContain('permission denied')
    })

    it.skipIf(!IS_WIN32)('stays quiet for entries trash already removed (partial success)', async () => {
      const h = makeDeps({
        lstat: lstatOk,
        trash: async () => {
          throw new Error('Command failed: windows-trash.exe C:\\x\\a C:\\x\\b')
        },
        probeRename: async from => (from.endsWith('a') ? 'ENOENT' : 'EBUSY'),
      })
      await runTrashCli(['C:\\x\\a', 'C:\\x\\b'], h.deps)
      expect(h.code()).toBe(1)
      const err = h.err.join('\n')
      expect(err).not.toContain("cannot remove 'C:\\x\\a'")
      expect(err).toContain("cannot remove 'C:\\x\\b'")
    })

    it.skipIf(!IS_WIN32)('falls back to the trash message when the probe has no verdict', async () => {
      const h = makeDeps({
        lstat: lstatOk,
        trash: async () => {
          throw new Error('Command failed: windows-trash.exe C:\\x\\a')
        },
        probeRename: async () => null,
      })
      await runTrashCli(['C:\\x\\a'], h.deps)
      expect(h.code()).toBe(1)
      expect(h.err.join('\n')).toContain('Command failed')
    })

    it('keeps the original message on non-win32', async () => {
      const h = makeDeps({
        lstat: lstatOk,
        trash: async () => {
          throw new Error('Command failed: windows-trash.exe C:\\x\\a')
        },
      })
      await runTrashCli(['C:\\x\\a'], h.deps)
      if (!IS_WIN32) expect(h.err.join('\n')).toContain('Command failed')
      else expect(h.code()).toBe(1)
    })
  })

})

describe('MSYS 盘符别名（原 trash-cli-msys.spec.ts）', () => {
  describe('trash-cli MSYS drive-alias paths', () => {
    it('passes the native drive path to lstat/trash, keeps the authored spelling in verbose output', async () => {
      const lstatCalls: string[] = []
      const h = makeDeps({
        lstat: async (p) => {
          lstatCalls.push(p)
          return { isDirectory: false }
        },
      })
      await runTrashCli(['-v', '/d/code/probe.txt'], h.deps)
      const native = IS_WIN32 ? 'D:\\code\\probe.txt' : '/d/code/probe.txt'
      expect(lstatCalls).toEqual([native])
      expect(h.trashCalls).toEqual([[native]])
      expect(h.code()).toBe(0)
      expect(h.out).toEqual(["removed '/d/code/probe.txt'"])
      expect(h.err).toHaveLength(0)
    })

    it('reports a missing MSYS path using the authored spelling', async () => {
      const h = makeDeps()
      await runTrashCli(['/d/code/missing-probe-xyz'], h.deps)
      expect(h.code()).toBe(1)
      expect(h.err.join('\n')).toContain("rm: cannot remove '/d/code/missing-probe-xyz': No such file or directory")
    })

    it('converts mixed-form entries in one call independently', async () => {
      const lstatCalls: string[] = []
      const h = makeDeps({
        lstat: async (p) => {
          lstatCalls.push(p)
          return { isDirectory: false }
        },
      })
      await runTrashCli(['/d/code/a.txt', 'D:/code/b.txt', 'rel.txt'], h.deps)
      // Only MSYS aliases are converted; the drive-letter + forward-slash form and
      // relative paths are already natively consumable by Node's fs.
      const expectedA = IS_WIN32 ? 'D:\\code\\a.txt' : '/d/code/a.txt'
      const expectedB = 'D:/code/b.txt'
      const expectedRel = 'rel.txt'
      expect(lstatCalls).toEqual([expectedA, expectedB, expectedRel])
      expect(h.trashCalls).toEqual([[expectedA, expectedB, expectedRel]])
    })
  })

})
