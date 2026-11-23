/**
 * bash 的工具描述：**由当前配置决定**，不再是写死的一段话。
 *
 * 为什么必须随配置变（issue #4）：持久性取决于两条路径的选择——
 * - autoBackgroundMs > 0（默认）：每条命令都登记成作业，作业在独立 Shell（键里带 :async: 与 jobId）里跑完即删，
 *   所以只有会话工作目录（插件层回写 state.cwd）会跟随 cd，变量/别名/函数都不保留；
 * - autoBackgroundMs === 0：命令直接走直连路径，复用会话的持久 Shell，变量与函数都保持；
 * - useShellCommandWrapper：命令被 bash -c 包一层子进程，变量回流不到会话 Shell，即使上一条成立也不持久。
 *
 * 写死一句话就等于对其中一种配置说假话。上游 oh-my-pi 的做法也是按配置渲染描述
 * （它的提示词模板按 autoBackgroundEnabled 分支），这里是同一思路的 DSH 版本：
 * 工具描述在注册时按当前 cfg 拼字符串，配置热更新时重注册即可换文案。
 * @module @xiaoso/dsh-tool-plus/tools/bash/description
 */

import type { RuntimeConfig } from '../../config/settings.ts'
import { formatTimeoutSeconds } from './timeout-meta.ts'

/** 描述里与持久性有关的三个事实。 */
export interface BashDescriptionFacts {
  /**
   * 每次调用是否可能换一个 Shell（= 不能承诺变量保持）。
   * 自动后台开着时成立；bash -c 包裹时也成立，因为它把命令放进子进程。
   */
  perCallShell: boolean
  /** 超阈值的长命令是否会自动转后台（影响要不要写那段提示）。 */
  autoBackground: boolean
  /** 模型能否显式 `async: true`：设置页关掉时 schema 里没有该参数，描述也不能提。 */
  explicitAsync: boolean
}

/**
 * 从运行时配置取出描述需要的事实。
 * @param cfg - 解析后的运行时配置。
 * @returns 三个事实。
 */
export function bashDescriptionFacts(cfg: RuntimeConfig): BashDescriptionFacts {
  return {
    perCallShell: cfg.autoBackgroundMs > 0 || cfg.useShellCommandWrapper === true,
    autoBackground: cfg.autoBackgroundMs > 0,
    explicitAsync: cfg.enableRunInBackground,
  }
}

/** 持久时的第一句：工作目录与导出变量都保持。 */
const PERSISTENT = 'The bash tool runs commands in one persistent shell: the session working directory and exported shell variables '
  + '(including aliases and shell functions) carry over between calls. '

/** 非持久时的第一句：只有工作目录跟随 cd。 */
const PER_CALL = 'The bash tool runs a command in a shell; the session working directory follows `cd` across calls, but other shell state '
  + '(`export`-ed variables, aliases, shell functions) does not persist between calls. '

/** 命令形态：两种 shell 配置下都成立，接在持久性说明之后。 */
const COMMAND_STYLE = 'One fact command/pipeline; dependencies use `&&`. '

/**
 * 自动后台的说明（只有开着时才成立）。
 * 阈值、死线前 1s 转后台、job cap 都按实际行为写；
 * "结果自动送达 / NEVER poll" 与 OMP 的 bash.md 保持一致。
 * @param cfg - 解析后的运行时配置。
 * @returns 与当前配置相符的说明段落。
 */
function autoBackgroundGuidance(cfg: RuntimeConfig): string {
  const thresholdSeconds = formatTimeoutSeconds(cfg.autoBackgroundMs / 1000)
  return `Calls still running after ${thresholdSeconds}s (or 1s before the deadline, if sooner) usually move to a background job `
    + 'and keep running under the same deadline (if any), unless the background-job cap is reached; '
    + 'the result arrives automatically as a follow-up message. NEVER poll. '
}

/** 输出说明，两种配置共用。 */
const TAIL = 'No `head`/`tail`/redirection; output trunc by default, full result saved to a log file whose path is printed with the result. '

/**
 * 显式后台的说明，只在设置页允许模型主动转后台时成立（schema 同时才会带 `async`）。
 * 省略 `timeout` 时的死线由 defaultTimeoutMs 与 maxTimeoutMs 共同决定，必须写出来：
 * OMP 的 bash.md 同样渲染 default Ns，否则模型不知道默认死线是多少。
 * @param cfg - 解析后的运行时配置。
 * @returns 与当前配置相符的说明段落。
 */
function explicitAsyncGuidance(cfg: RuntimeConfig): string {
  if (cfg.defaultTimeoutMs === 0) {
    return '`async` defers finite results. No deadline applies by default; pass `timeout: <seconds>` to set one. '
  }
  const defaultSeconds = Math.max(1_000, Math.min(cfg.defaultTimeoutMs, cfg.maxTimeoutMs)) / 1000
  return `\`async\` defers finite results but keeps the deadline (default ${formatTimeoutSeconds(defaultSeconds)}s); `
    + '`timeout: 0` for watchers and long jobs. '
}

/**
 * 工具描述（模型看到的 schema description）。
 * @param cfg - 解析后的运行时配置。
 * @returns 当前配置下为真的描述。
 */
export function bashToolDescription(cfg: RuntimeConfig): string {
  const facts = bashDescriptionFacts(cfg)
  return (facts.perCallShell ? PER_CALL : PERSISTENT)
    + COMMAND_STYLE
    + TAIL
    + (facts.explicitAsync ? explicitAsyncGuidance(cfg) : '')
    + (facts.autoBackground ? autoBackgroundGuidance(cfg) : '')
}

