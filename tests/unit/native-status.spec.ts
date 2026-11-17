/**
 * native/status 的判定契约。这条状态决定设置页那一行与启动日志，判错会让用户
 * 以为「内建命令坏了」或者反过来「明明装好了却没生效」。
 *
 * 2026-11-17 起判定从**包级**升到**运行级**：不是「我们的包装没装」，而是
 * 「这次真正 require 的是不是我们包的构建」。起因是共享缓存目录
 * `~/.omp/natives/<上游版本>/` 里的旧副本把新包遮住了，包级事实完全正常
 * （装着 plus.2、版本也同源），实际跑的却是没有新导出的旧 addon。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  NATIVE_PACKAGE_TAGS,
  loadedAddonIsOurs,
  nativePackageName,
  nativeStatusFromFacts,
  pinBaseOf,
} from '../../src/tools/shared/native-status.ts'

/** Facts of a healthy Windows install running the addon it shipped. */
const healthy = {
  tag: 'win32-x64',
  pinVersion: '18.12.6',
  own: { version: '18.12.6-plus.3' },
  loaded: { path: 'C:\\pkgs\\natives\\pi_natives.win32-x64-baseline.node', stale: false, ours: true },
}

describe('native status: package facts', () => {
  it('我们自己的包、版本同源、加载的也是它 → active，带上包名/版本/实际路径', () => {
    expect(nativeStatusFromFacts(healthy)).toEqual({
      status: 'active',
      platformTag: 'win32-x64',
      packageName: '@xiaoso/dsh-tool-plus-natives-win32-x64',
      version: '18.12.6-plus.3',
      loadedPath: healthy.loaded.path,
    })
  })

  it('平台不在发布列表里 → platform-unsupported（不是"包没装"）', () => {
    const value = nativeStatusFromFacts({
      ...healthy,
      tag: 'linux-s390x',
      own: null,
      loaded: null,
      supported: NATIVE_PACKAGE_TAGS,
    })
    expect(value).toEqual({ status: 'fallback', reason: 'platform-unsupported', platformTag: 'linux-s390x' })
  })

  it('平台支持但可选依赖没落地 → package-missing', () => {
    expect(nativeStatusFromFacts({ ...healthy, tag: 'linux-arm64', own: null, loaded: null }))
      .toEqual({ status: 'fallback', reason: 'package-missing', platformTag: 'linux-arm64' })
  })

  it('我们的包落后于已装 pi-natives → version-mismatch（戳校验会拒绝，实际跑上游包）', () => {
    expect(nativeStatusFromFacts({ ...healthy, tag: 'darwin-arm64', pinVersion: '18.13.0', own: { version: '18.12.6-plus.1' }, loaded: null }))
      .toEqual({ status: 'fallback', reason: 'version-mismatch', platformTag: 'darwin-arm64' })
  })

  it('pi-natives 装不上时同样按版本不符处理，不谎报 active', () => {
    expect(nativeStatusFromFacts({ ...healthy, tag: 'linux-x64', pinVersion: null, own: { version: '18.12.6-plus.1' }, loaded: null }))
      .toMatchObject({ status: 'fallback', reason: 'version-mismatch' })
  })
})

describe('native status: what actually loaded', () => {
  it('包都正常但加载的是别的构建 → foreign-addon，并点出那个文件', () => {
    const stale = 'C:\\Users\\me\\.omp\\natives\\18.12.6\\pi_natives.win32-x64-baseline.node'
    expect(nativeStatusFromFacts({ ...healthy, loaded: { path: stale, stale: true, ours: false } }))
      .toEqual({ status: 'fallback', reason: 'foreign-addon', platformTag: 'win32-x64', loadedPath: stale })
  })

  it('装好了但还没加载 → addon-not-loaded（既不是成功也不是失败）', () => {
    expect(nativeStatusFromFacts({ ...healthy, loaded: null }))
      .toEqual({ status: 'fallback', reason: 'addon-not-loaded', platformTag: 'win32-x64' })
  })

  it('加载的是我们的文件但它报的版本对不上 → version-mismatch，照样带上路径', () => {
    const loaded = { ...healthy.loaded, stale: true }
    expect(nativeStatusFromFacts({ ...healthy, loaded }))
      .toEqual({ status: 'fallback', reason: 'version-mismatch', platformTag: 'win32-x64', loadedPath: loaded.path })
  })
})

describe('loadedAddonIsOurs', () => {
  let root: string
  let packageDir: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-plus-native-status-'))
    packageDir = path.join(root, 'node_modules', '@xiaoso', 'dsh-tool-plus-natives-win32-x64')
    fs.mkdirSync(packageDir, { recursive: true })
    fs.writeFileSync(path.join(packageDir, 'pi_natives.win32-x64-baseline.node'), 'the-build-we-shipped')
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('直接从平台包装载 → 是我们', () => {
    expect(loadedAddonIsOurs(path.join(packageDir, 'pi_natives.win32-x64-baseline.node'), packageDir)).toBe(true)
  })

  it('从共享缓存装载，但字节与平台包一致（就是它的一份拷贝）→ 仍然算我们', () => {
    const staged = path.join(root, '.omp', 'natives', '18.12.6', 'pi_natives.win32-x64-baseline.node')
    fs.mkdirSync(path.dirname(staged), { recursive: true })
    fs.copyFileSync(path.join(packageDir, 'pi_natives.win32-x64-baseline.node'), staged)
    expect(loadedAddonIsOurs(staged, packageDir)).toBe(true)
  })

  it('共享缓存里是别的构建（大小不同）→ 不是我们，这正是旧版本遮住新包的那次', () => {
    const foreign = path.join(root, '.omp', 'natives', '18.12.6', 'pi_natives.win32-x64-baseline.node')
    fs.mkdirSync(path.dirname(foreign), { recursive: true })
    fs.writeFileSync(foreign, 'an-older-build-from-another-distribution')
    expect(loadedAddonIsOurs(foreign, packageDir)).toBe(false)
  })

  it('路径不存在 / 平台包目录不存在 → 不谎报是我们', () => {
    expect(loadedAddonIsOurs(path.join(root, 'nowhere.node'), packageDir)).toBe(false)
    expect(loadedAddonIsOurs(path.join(packageDir, 'pi_natives.win32-x64-baseline.node'), path.join(root, 'missing'))).toBe(false)
  })
})

describe('native status: naming', () => {
  it('平台标签直接拼进包名，prerelease 只去掉自己的后缀', () => {
    expect(nativePackageName('win32-arm64')).toBe('@xiaoso/dsh-tool-plus-natives-win32-arm64')
    expect(pinBaseOf('18.12.6-plus.1')).toBe('18.12.6')
    expect(pinBaseOf('18.12.6')).toBe('18.12.6')
  })
})
