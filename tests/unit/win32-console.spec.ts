/**
 * 宿主隐藏控制台（Win32 那半在 Rust，见本地补丁 0007）的行为契约。
 *
 * TS 这层只剩四个决定：非 win32 不碰原生、addon 没有该导出时降级、把原生侧的三种
 * 已知结果原样往上递、以及任何异常/未知值都折算成 `native-unavailable`——最后一条是
 * 插件 `apply()` 不被带崩的唯一保证，所以它跟其余三条分开断言。
 *
 * **刻意不调用真实入口** `ensureInheritableHiddenConsole()`：在 Windows 上那会真的给
 * 测试进程分配一个控制台，污染测试运行器（见仓库测试守则「full-suite safe」）。
 * @module tests
 */

import { describe, expect, it, vi } from 'vitest'
import { installHiddenHostConsole } from '../../src/host/win32-console.ts'

describe('installHiddenHostConsole', () => {
  it('非 win32：直接跳过，连原生都不调', () => {
    const call = vi.fn(() => 'allocated')
    expect(installHiddenHostConsole('linux', call)).toBe('not-windows')
    expect(installHiddenHostConsole('darwin', call)).toBe('not-windows')
    expect(call).not.toHaveBeenCalled()
  })

  it('addon 没有该导出（回落到上游 addon）：降级', () => {
    expect(installHiddenHostConsole('win32', undefined)).toBe('native-unavailable')
  })

  it('原生侧的三种已知结果原样透传', () => {
    for (const outcome of ['console-present', 'alloc-failed', 'allocated'] as const) {
      expect(installHiddenHostConsole('win32', () => outcome)).toBe(outcome)
    }
  })

  it('原生调用抛错：降级，不把插件的 apply() 带崩', () => {
    expect(installHiddenHostConsole('win32', () => { throw new Error('napi: panic') })).toBe('native-unavailable')
  })

  it('原生返回未知字符串（JS 侧比 addon 新）：当不可用，别当成功', () => {
    expect(installHiddenHostConsole('win32', () => '')).toBe('native-unavailable')
    expect(installHiddenHostConsole('win32', () => 'console-hidden')).toBe('native-unavailable')
  })
})
