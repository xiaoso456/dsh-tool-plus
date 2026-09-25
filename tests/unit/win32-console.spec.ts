/**
 * C3a（宿主隐藏控制台）的行为契约。
 *
 * 模块唯一的可观察输出就是它对外发出的 Win32 调用序列和返回的 outcome，所以这里
 * 断言的是顺序与结果，而不是实现细节。**刻意不调用真实入口**
 * `ensureInheritableHiddenConsole()`：那会在测试进程里真的分配一个控制台，污染
 * 测试运行器（见仓库测试守则「full-suite safe」）。
 * @module tests
 */

import { describe, expect, it, vi } from 'vitest'
import { installHiddenHostConsole, type Win32ConsoleBindings } from '../../src/host/win32-console.ts'

interface FakeBindings {
  bindings: Win32ConsoleBindings
  calls: string[]
}

/**
 * 一组可对账的 fake Win32 调用。
 * @param options.consoleWindow - 首次 `GetConsoleWindow()` 的返回值（null = 无控制台）。
 * @param options.allocOk - `AllocConsole()` 是否成功。
 * @param options.windowAfterAlloc - 分配之后 `GetConsoleWindow()` 的返回值。
 */
function fakeBindings(options: {
  consoleWindow?: unknown
  allocOk?: boolean
  windowAfterAlloc?: unknown
} = {}): FakeBindings {
  const { consoleWindow = null, allocOk = true, windowAfterAlloc = { hwnd: 1 } } = options
  const calls: string[] = []
  const handles = new Map<number, unknown>([[-10, 'h-in'], [-11, 'h-out'], [-12, 'h-err']])
  let allocated = false

  return {
    calls,
    bindings: {
      getConsoleWindow: () => {
        calls.push('getConsoleWindow')
        return allocated ? windowAfterAlloc : consoleWindow
      },
      allocConsole: () => {
        calls.push('allocConsole')
        allocated = true
        return allocOk
      },
      showWindow: (_window, show) => {
        calls.push(`showWindow(${String(show)})`)
        return true
      },
      getStdHandle: index => {
        calls.push(`getStdHandle(${String(index)})`)
        return handles.get(index)
      },
      setStdHandle: (index, handle) => {
        calls.push(`setStdHandle(${String(index)},${String(handle)})`)
        handles.set(index, handle)
        return true
      },
    },
  }
}

describe('installHiddenHostConsole', () => {
  it('非 win32：直接跳过，连 FFI 都不加载', () => {
    const load = vi.fn(() => fakeBindings().bindings)

    expect(installHiddenHostConsole('linux', load)).toBe('not-windows')
    expect(installHiddenHostConsole('darwin', load)).toBe('not-windows')
    expect(load).not.toHaveBeenCalled()
  })

  it('拿不到 FFI（没装 koffi）：降级，不抛', () => {
    expect(installHiddenHostConsole('win32', () => undefined)).toBe('ffi-unavailable')
  })

  it('宿主已经有控制台（CLI 在终端里跑）：什么都不做，绝不新建第二个', () => {
    const fake = fakeBindings({ consoleWindow: { hwnd: 1 } })

    expect(installHiddenHostConsole('win32', () => fake.bindings)).toBe('console-present')
    expect(fake.calls).toEqual(['getConsoleWindow'])
  })

  it('分配失败：不隐藏窗口、不动标准句柄', () => {
    const fake = fakeBindings({ allocOk: false })

    expect(installHiddenHostConsole('win32', () => fake.bindings)).toBe('alloc-failed')
    expect(fake.calls).toEqual([
      'getConsoleWindow',
      'getStdHandle(-10)', 'getStdHandle(-11)', 'getStdHandle(-12)',
      'allocConsole',
    ])
  })

  it('成功：分配 → 隐藏 → 按原值还原三个标准句柄', () => {
    const fake = fakeBindings()

    expect(installHiddenHostConsole('win32', () => fake.bindings)).toBe('allocated')
    expect(fake.calls).toEqual([
      'getConsoleWindow',
      'getStdHandle(-10)', 'getStdHandle(-11)', 'getStdHandle(-12)',
      'allocConsole',
      'getConsoleWindow',
      'showWindow(0)',
      'setStdHandle(-10,h-in)', 'setStdHandle(-11,h-out)', 'setStdHandle(-12,h-err)',
    ])
  })

  it('分配成功但没有窗口（宿主本来就被 CREATE_NO_WINDOW 启动）：跳过隐藏，句柄照样还原', () => {
    const fake = fakeBindings({ windowAfterAlloc: null })

    expect(installHiddenHostConsole('win32', () => fake.bindings)).toBe('allocated')
    expect(fake.calls).not.toContain('showWindow(0)')
    expect(fake.calls.slice(-3)).toEqual([
      'setStdHandle(-10,h-in)', 'setStdHandle(-11,h-out)', 'setStdHandle(-12,h-err)',
    ])
  })

  it('FFI 调用中途抛错：同样降级，不把插件的 apply() 带崩', () => {
    const bindings = fakeBindings().bindings
    bindings.allocConsole = () => { throw new Error('koffi: symbol not found') }

    expect(installHiddenHostConsole('win32', () => bindings)).toBe('ffi-unavailable')
  })
})
