/**
 * rmSafe: rm 命令的回收站重定义核心。
 *
 * 参数解析与行为语义对齐 GNU coreutils rm（tests/rm/ 用例移植），差异：
 * - 删除目标 = 系统回收站（trash 包），非永久删除；
 * - `-i`/`-I`/`--interactive[=WHEN]` 接受但忽略交互（直接进回收站）；
 * - verbose 只输出顶层项（trash 是原子移动，不递归输出子项）。
 *
 * 保护语义（r-root / r-4 移植）：默认 --preserve-root 拒绝 `/` 及其同义词
 * （`//`、`///`、realpath 后是根目录的路径）；拒绝 `.` / `..` 结尾的路径。
 *
 * 本模块零外部依赖（trash 包在 trash-cli-main.ts 入口动态加载），
 * 便于单测注入 fake trash。
 * @module @xiaoso/dsh-tool-plus/bash/trash-cli
 */

/** 解析后的 rm 参数。 */
export interface ParsedRmArgs {
  recursive: boolean
  force: boolean
  interactive: boolean
  verbose: boolean
  dir: boolean
  /** --preserve-root（默认开启，对齐 GNU rm）。 */
  preserveRoot: boolean
  /** --one-file-system（接受并忽略：trash 原子移动无递归遍历）。 */
  oneFileSystem: boolean
  paths: string[]
  error?:
    | { kind: 'missing-operand' }
    | { kind: 'invalid-option'; option: string }
    | { kind: 'unrecognized-option'; option: string }
    | { kind: 'invalid-argument'; option: string; value: string }
    | { kind: 'option-argument'; option: string }
}

const SHORT_OPTIONS: Record<string, keyof Omit<ParsedRmArgs, 'paths' | 'error'>> = {
  r: 'recursive',
  R: 'recursive',
  f: 'force',
  i: 'interactive',
  I: 'interactive',
  v: 'verbose',
  d: 'dir',
}

const LONG_OPTIONS: Record<string, { field: keyof Omit<ParsedRmArgs, 'paths' | 'error'>; value: boolean }> = {
  '--recursive': { field: 'recursive', value: true },
  '--force': { field: 'force', value: true },
  '--interactive': { field: 'interactive', value: true },
  '--verbose': { field: 'verbose', value: true },
  '--dir': { field: 'dir', value: true },
  '--preserve-root': { field: 'preserveRoot', value: true },
  '--no-preserve-root': { field: 'preserveRoot', value: false },
  '--one-file-system': { field: 'oneFileSystem', value: true },
}

/** --interactive=WHEN 的合法取值（GNU rm 语义）。 */
const INTERACTIVE_WHEN = new Set(['once', 'always', 'never'])

/**
 * 解析 rm 风格参数（coreutils rm 语义）：
 * - 短选项支持组合（`-rf`），`-r`/`-R`/`--recursive` 等价，`-i`/`-I` 等价；
 * - `--` 结束符后全部视为路径（允许 `-` 开头的文件名）；
 * - `--interactive[=once|always|never]` 接受（回收站模式忽略交互）；
 * - 未知短选项 → invalid-option，未知长选项 → unrecognized-option；
 * - 无路径 → missing-operand。
 */
export function parseRmArgs(argv: string[]): ParsedRmArgs {
  const parsed: ParsedRmArgs = {
    recursive: false,
    force: false,
    interactive: false,
    verbose: false,
    dir: false,
    preserveRoot: true,
    oneFileSystem: false,
    paths: [],
  }
  let afterDoubleDash = false
  for (const arg of argv) {
    if (afterDoubleDash) {
      parsed.paths.push(arg)
      continue
    }
    if (arg === '--') {
      afterDoubleDash = true
      continue
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const name = eq >= 0 ? arg.slice(0, eq) : arg
      const value = eq >= 0 ? arg.slice(eq + 1) : undefined
      // GNU 测试内部选项（模拟 tty 输入）；我们无交互，接受并忽略。
      if (name === '---presume-input-tty') continue
      const flag = LONG_OPTIONS[name]
      if (flag === undefined) {
        parsed.error = { kind: 'unrecognized-option', option: name }
        return parsed
      }
      if (value !== undefined) {
        if (name === '--interactive') {
          if (!INTERACTIVE_WHEN.has(value)) {
            parsed.error = { kind: 'invalid-argument', option: name, value }
            return parsed
          }
          parsed.interactive = true
        } else if (name === '--preserve-root') {
          if (value === 'all') {
            parsed.preserveRoot = true
          } else {
            parsed.error = { kind: 'invalid-argument', option: name, value }
            return parsed
          }
        } else {
          parsed.error = { kind: 'option-argument', option: name }
          return parsed
        }
      } else {
        parsed[flag.field] = flag.value
      }
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (const ch of arg.slice(1)) {
        const flag = SHORT_OPTIONS[ch]
        if (flag === undefined) {
          parsed.error = { kind: 'invalid-option', option: ch }
          return parsed
        }
        parsed[flag] = true
      }
      continue
    }
    parsed.paths.push(arg)
  }
  if (parsed.paths.length === 0 && parsed.error === undefined) {
    parsed.error = { kind: 'missing-operand' }
  }
  return parsed
}

/** trash 层与 IO 依赖（单测注入 fake）。 */
export interface TrashCliDeps {
  trash: (paths: string[]) => Promise<void>
  /** lstat 语义：链接本身存在即可删；返回 null = 不存在。 */
  lstat: (p: string) => Promise<{ isDirectory: boolean } | null>
  /** stat 语义：返回 dev/ino 用于根目录判定（GNU preserve-root 的 dev/ino 比较）；失败返回 null。 */
  stat: (p: string) => Promise<{ dev: number; ino: number } | null>
  stdout: (s: string) => void
  stderr: (s: string) => void
  exit: (code: number) => void
}

/** 规范化 verbose 输出的目录尾部斜杠（`a///` → `a/`，对齐 rm）。 */
function normalizeTrailingSlash(p: string): string {
  return p.replace(/[\\/]+$/, '/')
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 路径规范化后以 `.` 或 `..` 结尾（r-4 移植：拒绝删除）。 */
function isDotOrDotDot(p: string): boolean {
  const trimmed = p.replace(/[\\/]+$/, '')
  const last = trimmed.split(/[\\/]/).pop()
  return last === '.' || last === '..'
}

/**
 * 路径是 `/` 或其同义词（`//`、`///`、符号链接/junction 指向根目录）。
 * 根判定用 dev/ino 比较（GNU preserve-root 的精确语义）：字符串比较在
 * Windows 上会漏判（junction 指向 C:\ 时 realpath 是 "C:\\" 而非 "/"），
 * 而 dev/ino 在 Windows 与 POSIX 上都正确。空串不是根。
 *
 * Windows 语义说明：Node 的 `/` 解析为当前盘根（随 cwd 变化），而 Git
 * bash 的 `/` 是 MSYS 根——两者都只保护"字面 `/` 及其 dev/ino 等价物"，
 * 与 GNU rm 在 Git bash 的行为一致（GNU 同样不保护指向盘根的链接）。
 */
async function isRootPath(p: string, deps: TrashCliDeps): Promise<boolean> {
  if (p.length > 0 && p.replace(/[\\/]+$/, '') === '') return true
  const st = await deps.stat(p)
  if (st === null) return false
  const root = await deps.stat('/')
  return root !== null && st.dev === root.dev && st.ino === root.ino
}

/**
 * 执行一次 rm 语义的回收站删除。
 *
 * 行为对齐 coreutils rm：
 * - 无 -r/-d 时目录报 `Is a directory` 并保留（rm4）；
 * - 不存在路径：-f 静默忽略（f-1），否则报 `No such file or directory`；
 * - `.`/`..` 结尾路径拒绝（r-4）；`/` 及同义词拒绝（r-root，preserve-root 默认开）；
 * - 符号链接按链接本身处理（lstat，dangling-symlink 移植）；
 * - trash 失败：-f 静默但退出 1，否则报 `cannot remove`；
 * - -v 输出 `removed 'x'` / `removed directory 'x'`（r-1/d-1/v-slash）；
 * - 退出码：全部成功 0，任一失败 1。
 */
export async function runTrashCli(argv: string[], deps: TrashCliDeps): Promise<void> {
  const parsed = parseRmArgs(argv)
  if (parsed.error !== undefined) {
    if (parsed.error.kind === 'missing-operand') {
      deps.stderr('rm: missing operand')
    } else if (parsed.error.kind === 'invalid-option') {
      deps.stderr(`rm: invalid option -- '${parsed.error.option}'`)
    } else if (parsed.error.kind === 'unrecognized-option') {
      deps.stderr(`rm: unrecognized option '${parsed.error.option}'`)
    } else if (parsed.error.kind === 'invalid-argument') {
      deps.stderr(`rm: invalid argument '${parsed.error.value}' for '${parsed.error.option}'`)
    } else {
      deps.stderr(`rm: option '${parsed.error.option}' doesn't allow an argument`)
    }
    deps.exit(1)
    return
  }

  const { recursive, force, verbose, dir, preserveRoot, paths } = parsed
  const items: Array<{ path: string; isDir: boolean }> = []
  let failed = false

  for (const p of paths) {
    if (isDotOrDotDot(p)) {
      deps.stderr(`rm: refusing to remove '.' or '..' directory: skipping '${p}'`)
      failed = true
      continue
    }
    if (preserveRoot && (await isRootPath(p, deps))) {
      deps.stderr("rm: it is dangerous to operate recursively on '/'")
      deps.stderr('rm: use --no-preserve-root to override this failsafe')
      failed = true
      continue
    }
    const st = await deps.lstat(p)
    if (st === null) {
      if (!force) {
        deps.stderr(`rm: cannot remove '${p}': No such file or directory`)
        failed = true
      }
      continue
    }
    if (st.isDirectory && !recursive && !dir) {
      deps.stderr(`rm: cannot remove '${p}': Is a directory`)
      failed = true
      continue
    }
    items.push({ path: p, isDir: st.isDirectory })
  }

  if (items.length > 0) {
    try {
      await deps.trash(items.map((item) => item.path))
    } catch (err) {
      // GNU rm -f 只静默"不存在"，删除失败（权限等）仍报错（cycle.sh 用
      // `rm -rf` 期望输出 cannot remove）。
      deps.stderr(`rm: cannot remove '${items[0].path}': ${errorMessage(err)}`)
      failed = true
    }
  }

  if (verbose && !failed) {
    for (const { path: p, isDir } of items) {
      deps.stdout(isDir ? `removed directory '${normalizeTrailingSlash(p)}'` : `removed '${p}'`)
    }
  }

  deps.exit(failed ? 1 : 0)
}
