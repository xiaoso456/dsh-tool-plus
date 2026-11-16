/**
 * Windows：给宿主进程补一个**不可见**控制台，让它的 console 子进程去继承。
 *
 * 宿主是 GUI 子系统镜像（`DeepSeek Harness.exe` + `ELECTRON_RUN_AS_NODE=1`），
 * Windows 从不给它分配控制台；父进程没有控制台时子进程会**新建**一个，而默认
 * 终端是 Windows Terminal → 每条命令闪一个窗口。宿主自己 `AllocConsole()` +
 * `SW_HIDE` 之后，子进程就只是继承它，不再新建。
 *
 * Win32 那半在 Rust 里（`crates/pi-natives/src/hostconsole.rs`，本地补丁 0007），
 * 经本包自己的 addon 暴露成 `hideHostConsole()`：**不再依赖 koffi**，消费者安装时
 * 也就没有安装脚本要放行。句柄保存/还原在原生侧完成（`AllocConsole` 会重指标准
 * 句柄，而宿主 stdio 是启动方给的 pipe）。
 *
 * 三条硬约束（都有测试钉住）：只在 win32 生效、addon 没有该导出或调用抛错时只降级
 * 不抛、未知返回值按不可用处理。
 * @module @xiaoso/dsh-tool-plus/host/win32-console
 */

import * as natives from '@oh-my-pi/pi-natives'

/** 一次安装的结果；调用方只用来记日志。 */
export type HiddenConsoleOutcome =
  | 'not-windows'
  | 'native-unavailable'
  | 'console-present'
  | 'alloc-failed'
  | 'allocated'

/** 原生侧会返回的三种结果；其余（含空串）都按不可用处理。 */
const NATIVE_OUTCOMES = ['console-present', 'alloc-failed', 'allocated'] as const
type NativeOutcome = (typeof NATIVE_OUTCOMES)[number]

function isNativeOutcome(value: string): value is NativeOutcome {
  return (NATIVE_OUTCOMES as readonly string[]).includes(value)
}

/** 补丁 0007 新增的导出；上游 `.d.ts` 没有，故按结构收窄。 */
interface HostConsoleNative {
  hideHostConsole?: () => string
}

/**
 * 安装隐藏控制台（幂等）。宿主已有控制台时原生侧返回 `console-present` 且零副作用。
 * @param platform - 当前平台（注入以便测试非 win32 分支）。
 * @param call - 调原生导出；addon 没有这个符号（回落到上游 addon）时传 undefined。
 * @returns 本次安装的结果。
 */
export function installHiddenHostConsole(
  platform: NodeJS.Platform,
  call: (() => string) | undefined,
): HiddenConsoleOutcome {
  if (platform !== 'win32') return 'not-windows'
  if (call === undefined) return 'native-unavailable'
  let outcome: string
  try {
    outcome = call()
  } catch {
    // napi 会把 Rust panic 转成 JS 异常，ABI 不符也在这里冒出来：一样只降级。
    return 'native-unavailable'
  }
  if (isNativeOutcome(outcome)) return outcome
  // JS 侧比 addon 新（拿到的是别的字符串）：当没有这个能力处理，别把未知状态当成功。
  return 'native-unavailable'
}

/**
 * 取本包 addon 的原生导出。回落到上游 addon（没装我们的平台包）时为 undefined。
 */
function loadHostConsoleCall(): (() => string) | undefined {
  const fn = (natives as unknown as HostConsoleNative).hideHostConsole
  return typeof fn === 'function' ? () => fn() : undefined
}

/**
 * 插件入口调用：win32 且 addon 带该导出时才安装，结果只用于日志。
 * @returns 本次安装的结果。
 */
export function ensureInheritableHiddenConsole(): HiddenConsoleOutcome {
  return installHiddenHostConsole(process.platform, loadHostConsoleCall())
}
