/**
 * bash 的工具描述与系统提示段落：**由当前配置决定**，不再是写死的一段话。
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

import { DSH_ENV_PREFIX } from '@deepseek-ai/dsh-shell'
import type { RuntimeConfig } from '../../config/settings.ts'

/** 描述里与持久性有关的两个事实。 */
export interface BashDescriptionFacts {
  /**
   * 每次调用是否可能换一个 Shell（= 不能承诺变量保持）。
   * 自动后台开着时成立；bash -c 包裹时也成立，因为它把命令放进子进程。
   */
  perCallShell: boolean
  /** 超阈值的长命令是否会自动转后台（影响要不要写那段提示）。 */
  autoBackground: boolean
}

/**
 * 从运行时配置取出描述需要的事实。
 * @param cfg - 解析后的运行时配置。
 * @returns 两个事实。
 */
export function bashDescriptionFacts(cfg: RuntimeConfig): BashDescriptionFacts {
  return {
    perCallShell: cfg.autoBackgroundMs > 0 || cfg.useShellCommandWrapper === true,
    autoBackground: cfg.autoBackgroundMs > 0,
  }
}

/** 持久时的第一句：工作目录与导出变量都保持。 */
const PERSISTENT = 'The bash tool runs commands in one persistent shell: the session working directory and exported shell variables '
  + '(including aliases and shell functions) carry over between calls. '

/** 非持久时的第一句：只有工作目录跟随 cd。 */
const PER_CALL = 'The bash tool runs a command in a shell; the session working directory follows `cd` across calls, but other shell state '
  + '(`export`-ed variables, aliases, shell functions) does not persist between calls — pass `workdir` to run elsewhere. '

/** 自动后台那一段（只有开着时才成立）。 */
const AUTO_BACKGROUND = 'Commands exceeding the auto-background threshold are moved to the background automatically. '

/** 输出与后台的说明，两种配置共用。 */
const TAIL = 'Non-zero exits are reported as `[exit code: N]`. Long output is minimized and/or truncated to head+tail; '
  + 'whenever anything is dropped, the full raw stream is saved to a log file whose path is printed with the result — '
  + 're-read elided ranges with the read tool using :N-M selectors on that path. '
  + 'Set `run_in_background: true` for long-running commands: the call returns a job id immediately; '
  + 'the result is delivered automatically when it finishes — do not poll for it. '

/**
 * 工具描述（模型看到的 schema description）。
 * @param cfg - 解析后的运行时配置。
 * @returns 当前配置下为真的描述。
 */
export function bashToolDescription(cfg: RuntimeConfig): string {
  const facts = bashDescriptionFacts(cfg)
  return 'Execute a bash command and return its output. '
    + (facts.perCallShell ? PER_CALL : PERSISTENT)
    + TAIL
    + (facts.autoBackground ? AUTO_BACKGROUND : '')
    + 'Current harness environment facts are exposed through managed $' + DSH_ENV_PREFIX + '* variables; inspect them when needed.'
}

/** 系统提示里那一节的后半段（退出码提醒）。 */
const EXIT_HINT = 'Check the [exit code: N] marker on every bash result; investigate failures before moving on.'

/**
 * 系统提示里的 tool:bash 段落。
 * @param cfg - 解析后的运行时配置。
 * @returns 当前配置下为真的段落文本。
 */
export function bashSystemPromptText(cfg: RuntimeConfig): string {
  const facts = bashDescriptionFacts(cfg)
  return (facts.perCallShell ? PER_CALL : PERSISTENT)
    + (facts.autoBackground
      ? 'Long-running commands are moved to the background automatically (the call returns a job id; the result is delivered '
        + 'automatically when it finishes — do not poll for it). '
      : '')
    + EXIT_HINT
}
