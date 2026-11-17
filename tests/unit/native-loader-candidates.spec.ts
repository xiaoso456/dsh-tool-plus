/**
 * 加载器候选顺序：`~/.omp/natives/<version>/` 的暂存副本可以顶掉平台包，
 * 但只能顶掉**同一个构建**。
 *
 * 那个缓存目录只按上游版本号命名（`18.12.6`），谁装过这个版本都会留在里头：
 * 早期 tool-plus（或上游自己）把自家的 addon 放进去以后，新装的平台包就一直
 * 被它遮住，缺少只有新构建才有的导出——`hideHostConsole` 就是这么丢的，症状
 * 是桌面端每条命令闪一个控制台窗口。这里钉住：大小不同（= 不是同一份字节）
 * 的暂存副本不得排在平台包前面，同时保留上游「同一份构建优先用缓存」的原意。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveLoaderCandidates } from '../../src/vendor/pi-natives/loader-state.js'

const FILENAME = 'pi_natives.win32-x64-baseline.node'

let root: string
let versionedDir: string
let leafPackageDir: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-plus-loader-'))
  versionedDir = path.join(root, 'natives', '18.12.6')
  leafPackageDir = path.join(root, 'node_modules', '@xiaoso', 'dsh-tool-plus-natives-win32-x64')
  fs.mkdirSync(versionedDir, { recursive: true })
  fs.mkdirSync(leafPackageDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function stage(bytes: string): string {
  const target = path.join(versionedDir, FILENAME)
  fs.writeFileSync(target, bytes)
  return target
}

function install(bytes: string): string {
  const target = path.join(leafPackageDir, FILENAME)
  fs.writeFileSync(target, bytes)
  return target
}

function candidates(overrides: { leafPackageDir?: string | null } = {}): string[] {
  return resolveLoaderCandidates({
    addonFilenames: [FILENAME],
    isCompiledBinary: false,
    stageFromNodeModules: true,
    nativeDir: leafPackageDir,
    leafPackageDir: overrides.leafPackageDir === undefined ? leafPackageDir : overrides.leafPackageDir,
    execDir: path.join(root, 'exec'),
    versionedDir,
    userDataDir: path.join(root, 'user-data'),
  })
}

describe('loader candidates: staged cache identity', () => {
  it('暂存副本和平台包不是同一份字节（大小不同）→ 平台包优先，暂存副本不再出现', () => {
    const staged = stage('old-build')
    const leaf = install('new-build-with-one-more-export')
    const list = candidates()

    expect(list[0]).toBe(leaf)
    expect(list).not.toContain(staged)
  })

  it('暂存副本就是平台包那一份（大小相同）→ 仍用缓存（上游更新安全的原意）', () => {
    const staged = stage('abc')
    install('abc')
    expect(candidates()[0]).toBe(staged)
  })

  it('解析不到平台包时没有可比对象 → 缓存照旧优先', () => {
    const staged = stage('only-copy')
    const list = candidates({ leafPackageDir: null })
    expect(list[0]).toBe(staged)
  })

  it('不启用暂存（非 Windows / 开发目录）→ 只有平台包参与', () => {
    const staged = stage('old-build')
    const leaf = install('new-build')
    const list = resolveLoaderCandidates({
      addonFilenames: [FILENAME],
      isCompiledBinary: false,
      stageFromNodeModules: false,
      nativeDir: leafPackageDir,
      leafPackageDir,
      execDir: path.join(root, 'exec'),
      versionedDir,
      userDataDir: path.join(root, 'user-data'),
    })

    expect(list[0]).toBe(leaf)
    expect(list).not.toContain(staged)
  })
})
