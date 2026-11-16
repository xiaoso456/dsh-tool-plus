/**
 * native/status 的判定契约：装的是不是我们自己的原生包，不是的话原因是什么。
 * 这条状态直接决定设置页那一行与启动日志——判错会让用户以为内建命令"坏了"，
 * 而不是"没装我们的包"。
 */
import { describe, expect, it } from 'vitest'
import {
  NATIVE_PACKAGE_TAGS,
  nativePackageName,
  nativeStatusFromFacts,
  pinBaseOf,
} from '../../src/tools/shared/native-status.ts'

describe('native status', () => {
  it('我们自己的包且版本与已装 pi-natives 同源 → active，带上包名与版本', () => {
    const value = nativeStatusFromFacts({
      tag: 'win32-x64',
      pinVersion: '18.12.6',
      own: { version: '18.12.6-plus.3' },
    })
    expect(value).toEqual({
      status: 'active',
      platformTag: 'win32-x64',
      packageName: '@xiaoso/dsh-tool-plus-natives-win32-x64',
      version: '18.12.6-plus.3',
    })
  })

  it('平台不在发布列表里 → platform-unsupported（不是"包没装"）', () => {
    const value = nativeStatusFromFacts({
      tag: 'linux-s390x',
      pinVersion: '18.12.6',
      own: null,
      supported: NATIVE_PACKAGE_TAGS,
    })
    expect(value).toEqual({ status: 'fallback', reason: 'platform-unsupported', platformTag: 'linux-s390x' })
  })

  it('平台支持但可选依赖没落地 → package-missing', () => {
    expect(nativeStatusFromFacts({ tag: 'linux-arm64', pinVersion: '18.12.6', own: null }))
      .toEqual({ status: 'fallback', reason: 'package-missing', platformTag: 'linux-arm64' })
  })

  it('我们的包落后于已装 pi-natives → version-mismatch（戳校验会拒绝，实际跑上游包）', () => {
    expect(nativeStatusFromFacts({ tag: 'darwin-arm64', pinVersion: '18.13.0', own: { version: '18.12.6-plus.1' } }))
      .toEqual({ status: 'fallback', reason: 'version-mismatch', platformTag: 'darwin-arm64' })
  })

  it('pi-natives 装不上时同样按版本不符处理，不谎报 active', () => {
    expect(nativeStatusFromFacts({ tag: 'linux-x64', pinVersion: null, own: { version: '18.12.6-plus.1' } }))
      .toMatchObject({ status: 'fallback', reason: 'version-mismatch' })
  })

  it('平台标签直接拼进包名，prerelease 只去掉自己的后缀', () => {
    expect(nativePackageName('win32-arm64')).toBe('@xiaoso/dsh-tool-plus-natives-win32-arm64')
    expect(pinBaseOf('18.12.6-plus.1')).toBe('18.12.6')
    expect(pinBaseOf('18.12.6')).toBe('18.12.6')
  })
})
