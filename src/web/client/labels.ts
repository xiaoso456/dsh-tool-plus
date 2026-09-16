/**
 * Card copy for the browser tool views: every string the six row components
 * and the shared shell draw, in its own locale namespace so it can never
 * collide with the settings card's `tool-plus` bundle (the slots registry
 * merges namespaces, and re-declaring one would be a compile error).
 *
 * zh is the source of truth for the key set; both dictionaries are
 * `Record<ToolCardLocaleKey, string>`, so a missing or extra key in either is
 * a compile error. Template parameters use the host's `{name}` placeholder
 * convention (the seat interpolates the params record into the string).
 *
 * The wording mirrors the shipped conversation namespace for the same
 * primitives (diff / read / search / terminal chrome) so a takeover does not
 * change how the cards read; tool titles and the generic-row copy are ours.
 * @module @xiaoso/dsh-tool-plus/web/client/labels
 */

/** Locale namespace of the tool-card bundle (registered by `registerToolCards`). */
export const CARD_LOCALE_NS = 'tool-plus-cards'

/** Every copy key of the tool-card namespace. */
export type ToolCardLocaleKey =
  // Primitive chrome shared by the diff family and the generic shell.
  | 'copy' | 'copied' | 'collapse' | 'expand'
  | 'collapseAria' | 'expandAria' | 'expandRest'
  | 'files.one' | 'files.other'
  // Run state words used for the shell's assistive-technology status line.
  | 'running' | 'done' | 'failed' | 'stopped' | 'cancelled' | 'timedOut' | 'noOutput'
  // One title per tool key this plugin renders.
  | 'title.bash' | 'title.read' | 'title.write' | 'title.edit'
  | 'title.grep' | 'title.glob' | 'title.astGrep' | 'title.astEdit'
  // write card header.
  | 'write.lines' | 'write.madeExecutable'
  // ast_edit card header, rule line, and footer.
  | 'astEdit.replacements' | 'astEdit.files' | 'astEdit.parseErrors'
  | 'astEdit.rules' | 'astEdit.rulesRest'
  // read card chrome.
  | 'read.window' | 'read.collapseAria' | 'read.expandAria' | 'read.expandRest'
  // search card chrome (grep / glob / ast_grep).
  | 'search.paths' | 'search.paths.truncated'
  | 'search.matches' | 'search.matches.truncated' | 'search.noResults' | 'search.scope'
  | 'search.collapseAria' | 'search.expandAria' | 'search.expandRest'
  // terminal card chrome.
  | 'terminal.signal' | 'terminal.exitCode'
  | 'terminal.running' | 'terminal.failed' | 'terminal.done' | 'terminal.noOutput'
  // Background bash hand-off (generic shell).
  | 'bash.background'
  // Image card: loader states, the open affordance, and the lightbox chrome.
  | 'image.loading' | 'image.loadFailed' | 'image.open' | 'image.openNamed'
  | 'image.dialog' | 'image.close' | 'image.unnamed' | 'image.caption'
  // Generic shell fallbacks.
  | 'generic.params' | 'generic.noDetail' | 'inspect'

/** Simplified Chinese copy (the source dictionary). */
export const zh: Record<ToolCardLocaleKey, string> = {
  copy: '复制',
  copied: '已复制',
  collapse: '收起',
  expand: '展开',
  collapseAria: '收起',
  expandAria: '展开其余 {count} 行',
  expandRest: '… 其余 {count} 行',
  'files.one': '{count} 个文件',
  'files.other': '{count} 个文件',
  running: '运行中',
  done: '完成',
  failed: '失败',
  // The shipped word for a call that was stopped rather than failed
  // (`row.stopped`); a stopped call is not a failed one, and the row's own
  // summary already says timed out / cancelled in the reader's language.
  stopped: '已停止',
  cancelled: '已取消',
  timedOut: '已超时',
  noOutput: '无输出',
  'title.bash': 'Bash',
  'title.read': '读取',
  'title.write': '写入',
  'title.edit': '编辑',
  'title.grep': 'Grep',
  'title.glob': 'Glob',
  'title.astGrep': 'AST Grep',
  'title.astEdit': 'AST Edit',
  'write.lines': '{count} 行',
  'write.madeExecutable': '已赋予可执行权限',
  'astEdit.replacements': '{count} 处替换',
  'astEdit.files': '{count} 个文件',
  'astEdit.parseErrors': '解析错误',
  'astEdit.rules': '规则',
  'astEdit.rulesRest': '… 其余 {count} 条',
  'read.window': '显示 {shown} / {total} 行',
  'read.collapseAria': '收起内容',
  'read.expandAria': '展开其余 {count} 行',
  'read.expandRest': '… 其余 {count} 行',
  'search.paths': '{shown} 个路径',
  'search.paths.truncated': '显示 {shown} / 共 {total} 个路径',
  'search.matches': '{shown} 处匹配 · {files} 个文件',
  'search.matches.truncated': '显示 {shown} / 共 {total} 处匹配 · {files} 个文件',
  'search.noResults': '无结果',
  'search.scope': '范围 {path}',
  'search.collapseAria': '收起结果',
  'search.expandAria': '展开其余 {count} 行结果',
  'search.expandRest': '… 其余 {count} 行',
  'terminal.signal': '信号 {signal}',
  'terminal.exitCode': '退出码 {code}',
  'terminal.running': '运行中',
  'terminal.failed': '失败',
  'terminal.done': '已完成',
  'terminal.noOutput': '无输出',
  'bash.background': '后台任务 {jobId}',
  'image.loading': '加载中',
  'image.loadFailed': '加载失败',
  'image.open': '查看原图',
  'image.openNamed': '查看原图：{name}',
  'image.dialog': '原图预览',
  'image.close': '关闭',
  'image.unnamed': '图片',
  'image.caption': '{name} · {width}×{height} · {size}',
  'generic.params': '{count} 个参数',
  'generic.noDetail': '没有更多可展示的细节',
  inspect: '查看',
}

/** English dictionary, checked complete against the zh key set. */
export const en: Record<ToolCardLocaleKey, string> = {
  copy: 'Copy',
  copied: 'Copied',
  collapse: 'Collapse',
  expand: 'Expand',
  collapseAria: 'Collapse',
  expandAria: 'Expand {count} more lines',
  expandRest: '… {count} more lines',
  'files.one': '{count} file',
  'files.other': '{count} files',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  cancelled: 'Cancelled',
  timedOut: 'Timed out',
  noOutput: 'No output',
  'title.bash': 'Bash',
  'title.read': 'Read',
  'title.write': 'Write',
  'title.edit': 'Edit',
  'title.grep': 'Grep',
  'title.glob': 'Glob',
  'title.astGrep': 'AST Grep',
  'title.astEdit': 'AST Edit',
  'write.lines': '{count} lines',
  'write.madeExecutable': 'Made executable',
  'astEdit.replacements': '{count} replacements',
  'astEdit.files': '{count} files',
  'astEdit.parseErrors': 'Parse errors',
  'astEdit.rules': 'Rules',
  'astEdit.rulesRest': '… {count} more',
  'read.window': 'Showing {shown} of {total} lines',
  'read.collapseAria': 'Collapse content',
  'read.expandAria': 'Expand {count} more lines',
  'read.expandRest': '… {count} more lines',
  'search.paths': '{shown} paths',
  'search.paths.truncated': 'Showing {shown} of {total} paths',
  'search.matches': '{shown} matches · {files} files',
  'search.matches.truncated': 'Showing {shown} of {total} matches · {files} files',
  'search.noResults': 'No results',
  'search.scope': 'in {path}',
  'search.collapseAria': 'Collapse results',
  'search.expandAria': 'Expand {count} more result lines',
  'search.expandRest': '… {count} more lines',
  'terminal.signal': 'signal {signal}',
  'terminal.exitCode': 'exit code {code}',
  'terminal.running': 'Running',
  'terminal.failed': 'Failed',
  'terminal.done': 'Done',
  'terminal.noOutput': 'No output',
  'bash.background': 'Background job {jobId}',
  'image.loading': 'Loading',
  'image.loadFailed': 'Load failed',
  'image.open': 'View original',
  'image.openNamed': 'View original: {name}',
  'image.dialog': 'Original image',
  'image.close': 'Close',
  'image.unnamed': 'Image',
  'image.caption': '{name} · {width}×{height} · {size}',
  'generic.params': '{count} params',
  'generic.noDetail': 'No further detail',
  inspect: 'Inspect',
}

/** The bilingual bundle handed to `ctx.locale.register(CARD_LOCALE_NS, …)`. */
export const cardLocales: { zh: Record<ToolCardLocaleKey, string>; en: Record<ToolCardLocaleKey, string> } = {
  zh,
  en,
}

/** Merge this plugin's card namespace into the slot locale table (official pattern). */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy for the browser tool cards. */
    'tool-plus-cards': ToolCardLocaleKey
  }
}
