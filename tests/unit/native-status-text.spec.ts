/**
 * native/status → 文案的纯映射。两件事必须钉住：
 *  - 每种 fallback reason 都有对应文案（漏一个界面就会显示原始 key）；
 *  - `foreign-addon` 要把**实际加载的文件**写进文案——这个状态存在的意义
 *    就是“包看着没问题但跑的不是它”，路径是唯一证据。
 */
import { describe, expect, it } from 'vitest'
import { nativeStatusShort, nativeStatusText } from '../../src/client/native-status-text.ts'
import type { BashPlusLocaleKey } from '../../src/client/locales.ts'
import type { NativeStatusValue } from '../../src/tools/shared/browser-rpc-channel.ts'

/** Tiny locale with the placeholders the real one uses. */
const templates: Partial<Record<BashPlusLocaleKey, string>> = {
  nativeStatusActive: '已加载（{package}@{version}）',
  nativeStatusFallback: '未加载我们的构建：{reason}',
  nativeStatusReasonPlatformUnsupported: '当前系统没有对应的原生包',
  nativeStatusReasonPackageMissing: '插件安装时没装上原生包',
  nativeStatusReasonVersionMismatch: '原生包与当前 OMP 版本不匹配',
  nativeStatusReasonForeignAddon: '实际加载的是 {path}，不是这次安装的构建',
  nativeStatusReasonAddonNotLoaded: '原生包已安装，但还没有加载',
  nativeStatusShortActive: '已加载 {version}',
  nativeStatusShortPlatformUnsupported: '当前系统不支持',
  nativeStatusShortPackageMissing: '未安装原生包',
  nativeStatusShortVersionMismatch: '版本不匹配',
  nativeStatusShortForeignAddon: '加载的不是我们的构建',
  nativeStatusShortAddonNotLoaded: '尚未加载',
}

const t = (key: BashPlusLocaleKey): string => templates[key] ?? key

describe('native status text', () => {
  it('active → 包名 + 版本', () => {
    const value: NativeStatusValue = {
      status: 'active',
      platformTag: 'win32-x64',
      packageName: '@xiaoso/dsh-tool-plus-natives-win32-x64',
      version: '18.12.6-plus.2',
      loadedPath: 'C:\\x.node',
    }
    expect(nativeStatusText(t, value)).toBe('已加载（@xiaoso/dsh-tool-plus-natives-win32-x64@18.12.6-plus.2）')
  })

  it('foreign-addon → 文案里带上实际加载的文件', () => {
    const value: NativeStatusValue = {
      status: 'fallback',
      platformTag: 'win32-x64',
      reason: 'foreign-addon',
      loadedPath: 'C:\\Users\\me\\.omp\\natives\\18.12.6\\pi_natives.node',
    }
    const text = nativeStatusText(t, value)
    expect(text).toContain('C:\\Users\\me\\.omp\\natives\\18.12.6\\pi_natives.node')
    expect(text).toContain('不是这次安装的构建')
  })

  it('折叠时的短标签：只给结论和版本，一句话都不带', () => {
    expect(nativeStatusShort(t, {
      status: 'active',
      platformTag: 'win32-x64',
      packageName: '@xiaoso/dsh-tool-plus-natives-win32-x64',
      version: '18.12.6-plus.2',
      loadedPath: 'C:\\x.node',
    })).toBe('已加载 18.12.6-plus.2')
    expect(nativeStatusShort(t, { status: 'fallback', platformTag: 'win32-x64', reason: 'foreign-addon' }))
      .toBe('加载的不是我们的构建')
    expect(nativeStatusShort(t, { status: 'fallback', platformTag: 'win32-x64', reason: 'addon-not-loaded' }))
      .toBe('尚未加载')
  })

  it('短标签覆盖每个原因且不带占位符', () => {
    const reasons = ['platform-unsupported', 'package-missing', 'version-mismatch', 'foreign-addon', 'addon-not-loaded'] as const
    for (const reason of reasons) {
      const text = nativeStatusShort(t, { status: 'fallback', platformTag: 'win32-x64', reason })
      expect(text).not.toContain('nativeStatusShort')
      expect(text).not.toContain('{')
    }
  })

  it('其余原因都落到自己的文案，不泄露 key、不留占位符', () => {
    const reasons = [
      'platform-unsupported',
      'package-missing',
      'version-mismatch',
      'addon-not-loaded',
    ] as const
    for (const reason of reasons) {
      const text = nativeStatusText(t, { status: 'fallback', platformTag: 'win32-x64', reason })
      expect(text).not.toContain('nativeStatusReason')
      expect(text).not.toContain('{')
    }
  })
})
