/**
 * Windows：给宿主进程补一个**不可见**控制台，让它的 console 子进程去继承。
 *
 * 宿主是 GUI 子系统镜像（`DeepSeek Harness.exe` + `ELECTRON_RUN_AS_NODE=1`），
 * Windows 从不给它分配控制台；父进程没有控制台时子进程会**新建**一个，而默认
 * 终端是 Windows Terminal → 每条命令闪一个窗口。宿主自己 `AllocConsole()` +
 * `SW_HIDE` 之后，子进程就只是继承它，不再新建。
 *
 * 三条硬约束（都有测试钉住）：只在 win32 生效、宿主已有控制台时零副作用；
 * `AllocConsole` 会重指标准句柄，必须先存后还（宿主 stdio 是启动方给的 pipe）；
 * 任何失败只降级不抛。FFI 只从本包自己的依赖取，拿不到就降级。
 * @module @xiaoso/dsh-tool-plus/host/win32-console
 */

import { createRequire } from 'node:module'

/** Win32 调用集合；真实实现走 koffi，测试注入 fake。 */
export interface Win32ConsoleBindings {
  /** 本进程当前的控制台窗口；没有控制台时为 null。 */
  getConsoleWindow(): unknown
  /** 分配一个控制台；本进程已有控制台时返回 false。 */
  allocConsole(): boolean
  /** 显示/隐藏窗口（`SW_HIDE` = 0）。 */
  showWindow(window: unknown, show: number): unknown
  /** 读标准句柄（-10 输入 / -11 输出 / -12 错误）。 */
  getStdHandle(index: number): unknown
  /** 写回标准句柄。 */
  setStdHandle(index: number, handle: unknown): unknown
}

/** 一次安装的结果；调用方只用来记日志。 */
export type HiddenConsoleOutcome =
  | 'not-windows'
  | 'ffi-unavailable'
  | 'console-present'
  | 'alloc-failed'
  | 'allocated'

/** 三个标准句柄的 Win32 编号，顺序即存取顺序。 */
const STD_HANDLES = [-10, -11, -12] as const

/** `ShowWindow` 的 `SW_HIDE`。 */
const SW_HIDE = 0

/**
 * 安装隐藏控制台（幂等）。宿主已有控制台时返回 `console-present` 且零副作用。
 * @param platform - 当前平台（注入以便测试非 win32 分支）。
 * @param load - 取 Win32 调用集合；拿不到（没有 koffi）时返回 undefined。
 * @returns 本次安装的结果。
 */
export function installHiddenHostConsole(
  platform: NodeJS.Platform,
  load: () => Win32ConsoleBindings | undefined,
): HiddenConsoleOutcome {
  if (platform !== 'win32') return 'not-windows'
  try {
    const bindings = load()
    if (bindings === undefined) return 'ffi-unavailable'
    if (bindings.getConsoleWindow() !== null) return 'console-present'

    // 先存标准句柄：AllocConsole 会把它们指向新控制台，而宿主的 stdio 是启动方
    // 给的 pipe（shell 那侧 `stdio: ['ignore','pipe','pipe','ipc']`）。
    const saved = STD_HANDLES.map(index => bindings.getStdHandle(index))
    if (!bindings.allocConsole()) return 'alloc-failed'

    const window = bindings.getConsoleWindow()
    // 没有窗口的控制台是合法的（宿主本来就被 CREATE_NO_WINDOW 启动时就是这种），
    // 此时不要给 null 调 ShowWindow。
    if (window !== null) bindings.showWindow(window, SW_HIDE)
    STD_HANDLES.forEach((index, at) => bindings.setStdHandle(index, saved[at]))
    return 'allocated'
  } catch {
    // FFI 加载成功但调用失败（缺符号、ABI 不符等）：一样只降级。
    return 'ffi-unavailable'
  }
}

/** koffi 的最小结构面（不引 koffi 的类型，加载失败也要能编译）。 */
interface KoffiLike {
  load(library: string): { func(signature: string): (...args: never[]) => unknown }
}

/** 把 koffi 的 `func()` 产物收窄成本模块的调用签名。 */
function asCall<T>(value: unknown): T {
  return value as T
}

/**
 * 真实加载：只从**本包自己的依赖**解析 koffi（`optionalDependencies`）。
 *
 * 刻意不去宿主运行时的 node_modules 里找：宿主的内部布局不是契约，跨包按路径解析
 * 是耦合。拿不到（没装、平台没有预编译包）就返回 undefined，功能降级。
 */
function loadKoffiBindings(): Win32ConsoleBindings | undefined {
  try {
    const koffi = createRequire(import.meta.url)('koffi') as KoffiLike
    const kernel32 = koffi.load('kernel32.dll')
    const user32 = koffi.load('user32.dll')
    return {
      getConsoleWindow: asCall<Win32ConsoleBindings['getConsoleWindow']>(kernel32.func('void *GetConsoleWindow()')),
      allocConsole: asCall<Win32ConsoleBindings['allocConsole']>(kernel32.func('bool AllocConsole()')),
      showWindow: asCall<Win32ConsoleBindings['showWindow']>(user32.func('bool ShowWindow(void *hWnd, int nCmdShow)')),
      getStdHandle: asCall<Win32ConsoleBindings['getStdHandle']>(kernel32.func('void *GetStdHandle(int nStdHandle)')),
      setStdHandle: asCall<Win32ConsoleBindings['setStdHandle']>(kernel32.func('bool SetStdHandle(int nStdHandle, void *h)')),
    }
  } catch {
    return undefined
  }
}

/**
 * 插件入口调用：win32 且能拿到 FFI 时才安装，结果只用于日志。
 * @returns 本次安装的结果。
 */
export function ensureInheritableHiddenConsole(): HiddenConsoleOutcome {
  return installHiddenHostConsole(process.platform, loadKoffiBindings)
}
