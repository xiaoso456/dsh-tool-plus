/**
 * Windows：让宿主进程自己持有一个「不可见控制台」。
 *
 * 为什么需要（2026-09-25 实测）：桌面端宿主是 GUI 子系统镜像
 * （`DeepSeek Harness.exe` + `ELECTRON_RUN_AS_NODE=1`），Windows 永远不会给它
 * 分配控制台；于是它的每个 console 子进程（pi-shell 的 `where git` 探测、快照
 * `bash.exe`、任何插件 spawn 的 CLI）都要**新建**一个控制台，而默认终端应用是
 * Windows Terminal → 每条命令闪一个窗口。
 *
 * 控制台是「父进程有 → 子进程默认继承；父进程没有 → 子进程新建」：宿主自己先
 * `AllocConsole()` 再立刻 `SW_HIDE`，之后所有 console 子进程都继承它，不再新建
 * 窗口。实测（无控制台宿主里 spawn 一个 `where.exe`）：不装 → 新开一个可见 WT
 * 窗口（窗口里的进程正是那个 where.exe）；装了 → 子进程报「继承了我的控制台」、
 * 零新窗口。代价：分配那一刻会出现一个 WT 窗口、可见约 1.8s —— 默认终端是 WT 时
 * `ShowWindow(GetConsoleWindow())` 只藏得住 conhost 侧那个窗口对象，藏不住
 * wt.exe 宿主窗口。这一次性的窗口只能在源头消除（上游给 `where` 探测加
 * `CREATE_NO_WINDOW`，或让宿主从 console 子系统父进程继承一个 CREATE_NO_WINDOW
 * 的控制台）。
 *
 * 三条硬约束（都有测试钉住）：
 *  - 只在 win32 生效；宿主**已经有**控制台（CLI 在终端里跑）时什么都不做，否则会
 *    凭空多出一个控制台；
 *  - `AllocConsole` 会重指 STD_INPUT/OUTPUT/ERROR，而宿主的 stdio 是启动方给的
 *    pipe → 必须先存后还，否则可能污染宿主输出、弄断 shell 的管道；
 *  - 任何失败（没有 koffi、句柄取不到、`AllocConsole` 失败）都只降级，不抛。
 * @module @xiaoso/dsh-tool-plus/host/win32-console
 */

import { createRequire } from 'node:module'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

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

/** 从「宿主入口所在目录」解析依赖：打包运行时的 koffi 装在宿主 node_modules 里。 */
function hostRequire(): NodeRequire | undefined {
  const entry = process.argv[1]
  if (entry === undefined || entry.length === 0) return undefined
  try {
    // 传一个该目录下的虚构文件名，让解析从这里往上走：
    // 桌面端 → app.asar/dsh/node_modules/koffi，CLI → @deepseek-ai/dsh/node_modules/koffi。
    return createRequire(pathToFileURL(path.join(path.dirname(entry), 'tool-plus-host-console.js')))
  } catch {
    return undefined
  }
}

/** 真实加载：先本包依赖的 koffi，再宿主运行时自带的 koffi。 */
function loadKoffiBindings(): Win32ConsoleBindings | undefined {
  const requires: NodeRequire[] = [createRequire(import.meta.url)]
  const host = hostRequire()
  if (host !== undefined) requires.push(host)

  for (const requireKoffi of requires) {
    try {
      const koffi = requireKoffi('koffi') as KoffiLike
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
      // 换下一个候选；都拿不到就是 ffi-unavailable（插件照常工作）。
    }
  }
  return undefined
}

/**
 * 插件入口调用：win32 且能拿到 FFI 时才安装，结果只用于日志。
 * @returns 本次安装的结果。
 */
export function ensureInheritableHiddenConsole(): HiddenConsoleOutcome {
  return installHiddenHostConsole(process.platform, loadKoffiBindings)
}
