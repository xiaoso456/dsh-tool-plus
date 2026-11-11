/**
 * Bash session init script: the user-editable seam that runs once per shell
 * creation, after the user's rc snapshot and before the command.
 *
 * This is the general fix for issue #5 (a bare bash resolving to Windows'
 * WSL relay stub): the built-in default prepends the real Git Bash directories
 * from {@link INIT_PATH_PREFIX_ENV}, which the host computes per platform and
 * hands to the shell through sessionEnv. Nothing platform-specific is ever
 * written into the script file itself, so one default works everywhere.
 * @module @xiaoso/dsh-tool-plus/bash/init-script
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { quoteShellArg } from './shell-quote.ts'
import { resolveGitBashDirs } from './windows-shell.ts'

/** Env var that carries the platform-specific PATH prefix into the shell. */
export const INIT_PATH_PREFIX_ENV = 'TOOL_PLUS_PATH_PREFIX'

/** Directory (under $DSH_HOME) of the default user script. */
const INIT_DIR = 'tool-plus'
const INIT_FILE = 'bash-init.sh'

/**
 * Built-in default script, shown by the settings dialog and sourced whenever no
 * user copy exists. Deliberately platform-neutral: the Windows-only PATH fix is
 * driven by {@link INIT_PATH_PREFIX_ENV}, which is empty on POSIX.
 */
export const DEFAULT_INIT_SCRIPT = [
  '# Tool Plus · bash 初始化：每次建 shell 时执行（rc 之后、命令之前），出错不中断。',
  '# 日志与编辑入口：设置 → Tool Plus → Bash；保存后生成本文件的个人副本，删掉即回到内置默认。',
  '',
  '# Windows 上把真实 Git Bash 排到 System32 的 WSL stub 之前；其它平台自动跳过。',
  'if [ -n "${TOOL_PLUS_PATH_PREFIX:-}" ]; then export PATH="${TOOL_PLUS_PATH_PREFIX}${PATH}"; fi',
  '',
  '# 自己的 export / alias 写在下面：',
  '# export EDITOR=vim',
].join('\n')

/** Default script path: $DSH_HOME/tool-plus/bash-init.sh. */
export function defaultInitScriptPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
  return path.join(home, INIT_DIR, INIT_FILE)
}

/** Effective script path: the configured one when set, the default otherwise. */
export function resolveInitScriptPath(
  configured: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const trimmed = configured?.trim()
  return trimmed ? path.resolve(trimmed) : defaultInitScriptPath(env)
}

/** State of the init script as the settings row and the shell both need it. */
export interface InitScriptInfo {
  /** Whether the script is sourced at all (config bashInitEnabled). */
  enabled: boolean
  /** Absolute path of the user copy (may not exist). */
  path: string
  /** Which content a shell would source right now. */
  source: 'user' | 'default'
  /** Content a shell would source right now. */
  content: string
  /** Whether the user copy exists on disk. */
  exists: boolean
  /** Read failure of an existing user copy, if any. */
  error?: string
}

/**
 * Read the effective init script. A missing user copy falls back to the
 * built-in default; an unreadable one keeps the default and reports why.
 */
export function readInitScript(
  configured: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  enabled = true,
): InitScriptInfo {
  const scriptPath = resolveInitScriptPath(configured, env)
  try {
    const content = fs.readFileSync(scriptPath, 'utf8')
    return { enabled, path: scriptPath, source: 'user', content, exists: true }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return {
      enabled,
      path: scriptPath,
      source: 'default',
      content: DEFAULT_INIT_SCRIPT,
      exists: false,
      error: code === 'ENOENT' ? undefined : String(err),
    }
  }
}

/**
 * Platform-specific PATH prefix, ending with the platform separator.
 *
 * Windows only: the real Git Bash directories (issue #5). POSIX returns an
 * empty string, which makes the default script's guard a no-op.
 */
export function computePathPrefix(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  whereGit?: () => string | undefined,
): string {
  if (platform !== 'win32') return ''
  const dirs = resolveGitBashDirs(env, whereGit)
  if (!dirs) return ''
  const toPosix = (value: string): string => value.replace(/\\/g, '/')
  return [dirs.bin, dirs.usrBin]
    .filter((dir): dir is string => Boolean(dir))
    .map(toPosix)
    .join(';') + ';'
}

/** Where the shell writes init-script errors (settings row shows the tail). */
export function initLogPath(): string {
  return process.env.TOOL_PLUS_INIT_LOG?.trim() || path.join(os.tmpdir(), 'tool-plus-bash-init.log')
}

/**
 * The line appended to the shell snapshot. Errors go to the log and never
 * abort the session: `|| true` keeps a broken user script from turning every
 * command into a failure (the settings dialog's 试运行 is where errors surface).
 */
export function buildInitSourceLine(
  scriptPath: string,
  logPath: string = initLogPath(),
): string {
  return `source ${quoteShellArg(scriptPath)} 2>>${quoteShellArg(logPath)} || true`
}

/** Cache file the built-in default is materialized to when no user copy exists. */
export function defaultInitCachePath(): string {
  return path.join(os.tmpdir(), 'tool-plus-init-default.sh')
}

/**
 * Path a shell should actually source: the user copy when it exists, otherwise
 * a materialized copy of the built-in default.
 *
 * Native snapshot sourcing takes a path, not a string, so the default has to
 * live on disk somewhere; keeping it in the temp dir means nothing is written
 * next to the user's config and a deleted user copy still gets the default.
 * @returns the path to source, or undefined when the default cannot be written.
 */
export function materializeInitScript(scriptPath: string): string | undefined {
  try {
    if (fs.statSync(scriptPath).isFile()) return scriptPath
  } catch {
    // missing user copy: fall through to the materialized default
  }
  const cachePath = defaultInitCachePath()
  try {
    if (fs.readFileSync(cachePath, 'utf8') === DEFAULT_INIT_SCRIPT) return cachePath
  } catch {
    // missing or unreadable cache: rewrite below
  }
  try {
    fs.writeFileSync(cachePath, DEFAULT_INIT_SCRIPT, { mode: 0o600 })
    return cachePath
  } catch {
    return undefined
  }
}


/** What one shell creation needs from the init-script feature. */
export interface InitScriptSetup {
  /** Snapshot line that sources the script; absent when the feature is off. */
  sourceLine?: string
  /** Session env the default script consumes; empty when nothing applies. */
  env: Record<string, string>
}

/**
 * Resolve the init-script wiring for one shell creation: whether a script is
 * sourced at all, and the platform-specific env its default content consumes
 * (the Windows Git PATH prefix; empty elsewhere).
 *
 * The executor calls this once and stays about running commands — the policy
 * (default path, materialized default, prefix computation) lives here.
 */
export function initScriptSetup(input: {
  enabled: boolean
  /** Configured user path (already resolved; undefined when unset). */
  scriptPath?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  whereGit?: () => string | undefined
}): InitScriptSetup {
  if (!input.enabled || input.scriptPath === undefined) return { env: {} }
  const sourceable = materializeInitScript(input.scriptPath)
  const prefix = computePathPrefix(
    input.env ?? process.env,
    input.platform ?? process.platform,
    input.whereGit,
  )
  return {
    ...(sourceable !== undefined ? { sourceLine: buildInitSourceLine(sourceable) } : {}),
    ...(prefix.length > 0 ? { env: { [INIT_PATH_PREFIX_ENV]: prefix } } : { env: {} }),
  }
}

