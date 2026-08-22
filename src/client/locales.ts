/**
 * Locale bundles for the bash-plus settings card. zh is the source of truth
 * for the key set; en is checked complete against it — both dictionaries are
 * `Record<BashPlusLocaleKey, string>`, so a missing or extra key in either is
 * a compile error (the official registration enforces bilingual balance).
 * @module @xiaoso/dsh-tool-plus/client
 */

export type BashPlusLocaleKey =
  | 'title' | 'description'
  | 'groupTiming' | 'groupOutput' | 'groupTruncation' | 'groupBehavior'
  | 'autoBackgroundMs' | 'autoBackgroundMsHint'
  | 'defaultTimeoutMs' | 'defaultTimeoutMsHint'
  | 'maxTimeoutMs' | 'maxTimeoutMsHint'
  | 'maxBackgroundJobs' | 'maxBackgroundJobsHint'
  | 'outputMaxBytes' | 'outputMaxBytesHint'
  | 'outputSinkTailBytes' | 'outputSinkTailBytesHint'
  | 'outputSinkHeadBytes' | 'outputSinkHeadBytesHint'
  | 'minimizerEnabled' | 'minimizerEnabledHint'
  | 'enableRunInBackground' | 'enableRunInBackgroundHint'
  | 'interceptorEnabled' | 'interceptorEnabledHint'
  | 'nonInteractiveEnv' | 'nonInteractiveEnvHint'
  | 'snapshotEnabled' | 'snapshotEnabledHint'
  | 'useShellCommandWrapper' | 'useShellCommandWrapperHint'
  | 'outputTruncateStrategy' | 'outputTruncateStrategyHint'
  | 'outputTruncateTriggerBytes' | 'outputTruncateTriggerBytesHint'
  | 'outputTruncateTriggerLines' | 'outputTruncateTriggerLinesHint'
  | 'outputTruncateByteMode' | 'outputTruncateByteModeHint'
  | 'outputTruncateByteHeadBytes' | 'outputTruncateByteHeadBytesHint'
  | 'outputTruncateByteTailBytes' | 'outputTruncateByteTailBytesHint'
  | 'outputTruncateLineMode' | 'outputTruncateLineModeHint'
  | 'outputTruncateLineHeadLines' | 'outputTruncateLineHeadLinesHint'
  | 'outputTruncateLineTailLines' | 'outputTruncateLineTailLinesHint'
  | 'optBytes' | 'optLines' | 'optHead' | 'optTail' | 'optMiddle'
  | 'overridden' | 'reset' | 'readOnly' | 'expand' | 'collapse'
  | 'save' | 'saving' | 'discard' | 'unsaved' | 'saveFailed' | 'invalidNumber'
  | 'appliesTo'

/** Simplified Chinese copy. */
export const zh: Record<BashPlusLocaleKey, string> = {
  title: 'Bash（bash-plus）',
  description: '持久化 shell 工具：超时、后台化、命令拦截与运行环境。',
  groupTiming: '超时与后台',
  groupOutput: '输出',
  groupTruncation: '完成消息截断',
  groupBehavior: '行为',
  autoBackgroundMs: '自动后台阈值（毫秒）',
  autoBackgroundMsHint: '前台命令运行超过该时长会转入后台（0 表示关闭）。',
  defaultTimeoutMs: '默认超时（毫秒）',
  defaultTimeoutMsHint: '模型未指定命令超时时采用的默认值（上限 1 小时）。',
  maxTimeoutMs: '最大超时上限（毫秒）',
  maxTimeoutMsHint: '对显式超时的上限钳制。',
  maxBackgroundJobs: '最大后台任务数',
  maxBackgroundJobsHint: '并发后台任务上限，超出即拒绝新任务。',
  outputMaxBytes: '输出预算（字节）',
  outputMaxBytesHint: '实时预览与后台任务读取的保留输出预算。',
  outputSinkTailBytes: '尾部窗口（字节）',
  outputSinkTailBytesHint: '输出滚动保留的尾部窗口大小。',
  outputSinkHeadBytes: '开头窗口（字节）',
  outputSinkHeadBytesHint: '在尾部之外额外保留的开头窗口大小。',
  minimizerEnabled: '输出最小化',
  minimizerEnabledHint: '用原生智能压缩处理 git / npm / cargo 等命令的长输出。',
  enableRunInBackground: '允许模型主动执行后台 bash 任务',
  enableRunInBackgroundHint: '开启后，模型可主动让长任务转入后台执行，完成时自动收到结果；关闭则只能前台等待。',
  interceptorEnabled: '命令拦截',
  interceptorEnabledHint: '拦截 cat / grep / find / sed -i 这类命令，并建议改用对应的专用工具。',
  nonInteractiveEnv: '非交互式环境',
  nonInteractiveEnvHint: '对非交互使用加固环境：关闭分页器与彩色输出，不弹交互提示。',
  snapshotEnabled: 'Shell 快照',
  snapshotEnabledHint: '把用户的 rc 文件（别名、函数、选项）快照进会话 shell。',
  useShellCommandWrapper: '用 bash -c 包裹命令',
  useShellCommandWrapperHint: '把每条命令用 bash -c 包裹，以获得完整的 bash 环境。',
  outputTruncateStrategy: '截断按',
  outputTruncateStrategyHint: '后台任务完成消息达到阈值时的截断单位。',
  outputTruncateTriggerBytes: '字节触发阈值',
  outputTruncateTriggerBytesHint: '完成文本超过该字节数才截断。',
  outputTruncateTriggerLines: '行触发阈值',
  outputTruncateTriggerLinesHint: '完成文本超过该行数才截断。',
  outputTruncateByteMode: '字节保留方式',
  outputTruncateByteModeHint: '仅开头 / 仅结尾 / 头尾各保留一段。',
  outputTruncateByteHeadBytes: '字节保留 — 开头',
  outputTruncateByteHeadBytesHint: '开头（或头尾各留）模式下保留的开头字节数。',
  outputTruncateByteTailBytes: '字节保留 — 结尾',
  outputTruncateByteTailBytesHint: '结尾（或头尾各留）模式下保留的结尾字节数。',
  outputTruncateLineMode: '行保留方式',
  outputTruncateLineModeHint: '仅开头 / 仅结尾 / 头尾各保留一段（按行）。',
  outputTruncateLineHeadLines: '行保留 — 开头',
  outputTruncateLineHeadLinesHint: '开头（或头尾各留）模式下保留的开头行数。',
  outputTruncateLineTailLines: '行保留 — 结尾',
  outputTruncateLineTailLinesHint: '结尾（或头尾各留）模式下保留的结尾行数。',
  optBytes: '按字节',
  optLines: '按行',
  optHead: '仅开头',
  optTail: '仅结尾',
  optMiddle: '头尾各留',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  expand: '展开设置',
  collapse: '收起设置',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  unsaved: '未保存',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalidNumber: '请填写数字；留空表示使用默认值。',
  appliesTo: '保存后对新调用生效。',
}

/** English copy. */
export const en: Record<BashPlusLocaleKey, string> = {
  title: 'Bash (bash-plus)',
  description: 'Persistent shell tool: timeouts, backgrounding, interception, and environment.',
  groupTiming: 'Timeouts & backgrounding',
  groupOutput: 'Output',
  groupTruncation: 'Completion truncation',
  groupBehavior: 'Behavior',
  autoBackgroundMs: 'Auto-background threshold (ms)',
  autoBackgroundMsHint: 'Foreground commands running longer move to the background (0 disables).',
  defaultTimeoutMs: 'Default timeout (ms)',
  defaultTimeoutMsHint: 'Deadline applied when the model omits timeoutMs (capped at 1 hour).',
  maxTimeoutMs: 'Max timeout clamp (ms)',
  maxTimeoutMsHint: 'Upper clamp for explicit timeouts.',
  maxBackgroundJobs: 'Max background jobs',
  maxBackgroundJobsHint: 'Concurrent background job cap; extra requests are rejected.',
  outputMaxBytes: 'Output budget (bytes)',
  outputMaxBytesHint: 'Retained output budget for live previews and background reads.',
  outputSinkTailBytes: 'Tail window (bytes)',
  outputSinkTailBytesHint: 'Rolling tail window the output sink keeps.',
  outputSinkHeadBytes: 'Head window (bytes)',
  outputSinkHeadBytesHint: 'Leading window kept in addition to the tail.',
  minimizerEnabled: 'Output minimizer',
  minimizerEnabledHint: 'Native intelligent compression for git / npm / cargo long outputs.',
  enableRunInBackground: 'Allow the model to run background bash tasks',
  enableRunInBackgroundHint: 'When on, the model can proactively move long-running commands to the background and receives the result automatically; when off, everything runs in the foreground.',
  interceptorEnabled: 'Command interception',
  interceptorEnabledHint: 'Block cat / grep / find / sed -i style commands and suggest the dedicated tool instead.',
  nonInteractiveEnv: 'Non-interactive environment',
  nonInteractiveEnvHint: 'Harden the environment for non-interactive use: no pagers, no prompts, no color.',
  snapshotEnabled: 'Shell snapshot',
  snapshotEnabledHint: "Capture the user's rc file (aliases, functions, options) into the session shell.",
  useShellCommandWrapper: 'Wrap commands in bash -c',
  useShellCommandWrapperHint: 'Wrap every command in bash -c for a full bash environment.',
  outputTruncateStrategy: 'Truncate by',
  outputTruncateStrategyHint: 'Unit used when a background completion message crosses its threshold.',
  outputTruncateTriggerBytes: 'Byte trigger threshold',
  outputTruncateTriggerBytesHint: 'Truncate only when the completion text exceeds this many bytes.',
  outputTruncateTriggerLines: 'Line trigger threshold',
  outputTruncateTriggerLinesHint: 'Truncate only when the completion text exceeds this many lines.',
  outputTruncateByteMode: 'Byte retention mode',
  outputTruncateByteModeHint: 'Keep head only, tail only, or both.',
  outputTruncateByteHeadBytes: 'Byte retention — head',
  outputTruncateByteHeadBytesHint: 'Leading bytes kept in head (or middle) mode.',
  outputTruncateByteTailBytes: 'Byte retention — tail',
  outputTruncateByteTailBytesHint: 'Trailing bytes kept in tail (or middle) mode.',
  outputTruncateLineMode: 'Line retention mode',
  outputTruncateLineModeHint: 'Keep head only, tail only, or both (by line).',
  outputTruncateLineHeadLines: 'Line retention — head',
  outputTruncateLineHeadLinesHint: 'Leading lines kept in head (or middle) mode.',
  outputTruncateLineTailLines: 'Line retention — tail',
  outputTruncateLineTailLinesHint: 'Trailing lines kept in tail (or middle) mode.',
  optBytes: 'Bytes',
  optLines: 'Lines',
  optHead: 'Head only',
  optTail: 'Tail only',
  optMiddle: 'Head and tail',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  expand: 'Show settings',
  collapse: 'Hide settings',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  unsaved: 'Unsaved',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
  appliesTo: 'Values apply to new calls.',
}

/** Merge this plugin's namespace into the slot locale table (official pattern). */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This plugin's own settings-card copy. */
    'tool-plus': BashPlusLocaleKey
  }
}
