/**
 * 回归：POSIX 快照必须让生成快照的子 shell 继承宿主环境。
 *
 * 背景：插件在 POSIX 上把 shellConfig.env 压缩成 `{ SHELL }`（上游传的是整个
 * 进程环境），而 `spawn(shell, ["-c", script], { env })` 的 env 是**整体替换**。
 * 于是快照子 shell 里没有 PATH，bash 填自己的编译期默认值，脚本末尾那句
 * `export PATH='$PATH'` 就把默认值烘进快照；快照在会话创建时**最后**才被 source
 * （refs/oh-my-pi/crates/pi-shell/src/shell.rs:891），又把 brush 从 process.env
 * 继承来的正确 PATH 覆盖掉。
 *
 * 现象（2026-11-21 benchmark，tool-plus 0.2.1，Linux）：镜像 ENV 里的
 * `/usr/local/cargo/bin`、`/usr/local/go/bin`、JDK bin、conda 的 python3 全部消失，
 * `cargo` / `go` / `python3` / `javac` / `gofmt` 一律 `command not found`。
 * 同批官方 bash 0 次 not-found（它 spawn 子进程，天然继承 process.env）。
 *
 * Windows 不受影响：那边的分支写最小快照，文件里没有 PATH 那一行。
 *
 * 契约：快照子 shell 的起点环境 = 宿主环境 + shell 配置覆盖（配置优先），
 * 且 BASH_ENV / ENV 不得透传。
 *
 * 测法说明：Windows 上的 Git Bash 在自身没有 PATH 时会拿宿主 PATH 做默认值
 * （实测过），所以「快照文件里有没有 marker」在本机分辨不出真假；契约钉在
 * spawn 边界上，跨平台确定。真正的文件级断言（POSIX 上快照里必须出现宿主
 * PATH）留成第二个用例，非 POSIX 跳过。
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: spawnMock }
})

import { cleanupSnapshots, getOrCreateSnapshot } from '../../src/tools/bash/shell-snapshot.ts'

/** 宿主 PATH 里塞进去的临时目录名，断言只认这个名字，避开路径风格差异。 */
const HOST_MARKER = 'toolplus-snapshot-host-marker'

const shellFor = (): string => (process.platform === 'win32' ? 'bash.exe' : 'bash')

/** 取最近一次 spawn 的 env，按大小写不敏感查键（Windows 上 PATH 常写作 Path）。 */
const spawnedEnv = (): Record<string, string> => {
  const call = spawnMock.mock.calls.at(-1) as unknown as [string, string[], { env?: Record<string, string> }]
  return call?.[2]?.env ?? {}
}

const envValue = (env: Record<string, string>, name: string): string | undefined => {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name)
  return key === undefined ? undefined : env[key]
}

describe('shell-snapshot 子 shell 的环境', () => {
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'toolplus-snap-home-'))
    cleanupSnapshots()
    spawnMock.mockReset()
    // 快照函数等子 shell 的 close(0)；用假 child 即可，不真起进程。
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter()
      setImmediate(() => child.emit('close', 0))
      return child
    })
  })

  afterEach(() => {
    cleanupSnapshots()
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('子 shell 的 env 带宿主 PATH（POSIX 分支）', async () => {
    const hostDir = path.join(os.tmpdir(), HOST_MARKER)
    vi.stubEnv('PATH', `${hostDir}${path.delimiter}${process.env.PATH ?? ''}`)
    vi.stubEnv('BASH_ENV', '/tmp/probe-bash-env')

    const created = await getOrCreateSnapshot(shellFor(), { SHELL: shellFor(), HOME: home }, { platform: 'linux' })

    expect(created).not.toBeNull()
    const env = spawnedEnv()
    expect(envValue(env, 'PATH')).toContain(HOST_MARKER)
    // BASH_ENV 会让子 shell 额外 source 一份文件，必须在透传前剔掉。
    expect(envValue(env, 'BASH_ENV')).toBeUndefined()
  })

  it('shell 配置里的值覆盖宿主同名变量', async () => {
    const hostDir = path.join(os.tmpdir(), HOST_MARKER)
    vi.stubEnv('PATH', `${hostDir}${path.delimiter}${process.env.PATH ?? ''}`)

    const shellDir = path.join(os.tmpdir(), 'toolplus-snapshot-shell-marker')
    // 配置里给一份不含宿主 marker 的 PATH：合并方向反了的话宿主那份会盖回来。
    const configuredPath = `${shellDir}${path.delimiter}${path.dirname(process.execPath)}`
    await getOrCreateSnapshot(
      shellFor(),
      { SHELL: shellFor(), HOME: home, PATH: configuredPath },
      { platform: 'linux' },
    )

    const childPath = envValue(spawnedEnv(), 'PATH') ?? ''
    expect(childPath).toContain('toolplus-snapshot-shell-marker')
    expect(childPath).not.toContain(HOST_MARKER)
  })

  it('Windows 分支不 spawn，产出的最小快照没有 PATH 行', async () => {
    const created = await getOrCreateSnapshot(shellFor(), { SHELL: shellFor(), HOME: home }, { platform: 'win32' })

    expect(created).not.toBeNull()
    expect(spawnMock).not.toHaveBeenCalled()
    expect(existsSync(created as string)).toBe(true)
    expect(readFileSync(created as string, 'utf8')).not.toContain('export PATH')
  })

  it.skipIf(process.platform === 'win32')('POSIX 上宿主 PATH 真的落进快照文件', async () => {
    const hostDir = path.join(os.tmpdir(), HOST_MARKER)
    vi.stubEnv('PATH', `${hostDir}${path.delimiter}${process.env.PATH ?? ''}`)

    // 这里要真起一个 shell，才看得到脚本写出的 PATH 行。
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    spawnMock.mockImplementation(actual.spawn as unknown as typeof spawnMock)
    const created = await getOrCreateSnapshot(shellFor(), { SHELL: shellFor(), HOME: home }, { platform: 'linux' })

    expect(created).not.toBeNull()
    expect(readFileSync(created as string, 'utf8')).toContain(HOST_MARKER)
  })
})
