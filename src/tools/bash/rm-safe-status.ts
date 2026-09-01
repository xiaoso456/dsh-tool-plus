/**
 * rmSafe 注入状态查询：文件层（快照标记 + 脚本 + trash-cli 产物）与
 * 运行时层（一次性 bash 会话 source 快照后探测 `rm` 是否被重定义）。
 *
 * 分层语义：
 * - 文件层成功只证明"注入已写入快照"，不证明"会话里生效"——快照是会话
 *   创建时 source 的，注入只对之后创建的会话生效；trash-cli 产物缺失或
 *   node 路径不可用时函数调用会直接失败。
 * - 运行时层用一次性 bash 会话模拟"新会话创建"（source 快照 + `type rm`），
 *   验证的正是注入承诺的语义：新会话里 `rm` 是函数而非系统命令。探测
 *   无副作用，不触碰任何真实会话。
 * @module @xiaoso/dsh-tool-plus/bash/rm-safe-status
 */
import { spawn } from 'node:child_process'
import { quote } from './rm-safe.ts'

/** 运行时探测结果：`rm` 是函数（生效）/ 系统命令（未生效）/ 探测不可用。 */
export type RmSafeRuntime = 'function' | 'system' | 'unknown'

/** 注入失败原因（client 侧映射为本地化文案）。 */
export type RmSafeFailureReason =
  | 'snapshot-unavailable'
  | 'cli-missing'
  | 'snapshot-write-failed'
  | 'runtime-not-effective'

/** rmSafe/status 查询结果（host RPC 返回值，client 直接消费）。 */
export type RmSafeStatus =
  | { status: 'disabled' }
  | { status: 'failed'; reason: RmSafeFailureReason }
  | { status: 'injected'; runtime: RmSafeRuntime }

/** 查询依赖（host 侧绑定真实实现；测试注入 fake）。 */
export interface RmSafeStatusDeps {
  /** 取快照路径（幂等；可能触发创建）。null = 快照不可用。 */
  getOrCreateSnapshot: () => Promise<string | null>
  /** trash-cli 构建产物是否存在。 */
  cliExists: () => boolean
  /** node 可执行文件路径（注入内容的一部分）。 */
  nodePath: () => string
  /** trash-cli 路径（注入内容的一部分）。 */
  cliPath: () => string
  /** 向快照内联追加注入（幂等）。false = 快照不可写。 */
  inject: (snapshotPath: string, nodePath: string, cliPath: string) => boolean
  /** 运行时探测：新会话里 `rm` 是否被重定义。 */
  probe: (snapshotPath: string) => Promise<RmSafeRuntime>
}

/**
 * 解析 `type rm` / `declare -f rm` 探测输出。
 * `rm is a function` → 函数重定义生效；其余（`rm is /usr/bin/rm`、
 * `rm is hashed (...)`、空输出）→ 系统命令。
 */
export function parseProbeOutput(stdout: string): RmSafeRuntime {
  return /rm is a function/.test(stdout) ? 'function' : 'system'
}

/**
 * Windows 路径转 Git Bash 形式（`C:\Users\x` → `/c/Users/x`）。
 * 非 Windows 原样返回；非盘符路径仅把反斜杠转正斜杠。
 */
export function toGitBashPath(p: string): string {
  if (process.platform !== 'win32') return p
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(p)
  if (drive === null) return p.replace(/\\/g, '/')
  return `/${drive[1]!.toLowerCase()}/${drive[2]!.replace(/\\/g, '/')}`
}

/** 一次性 shell 进程的探测结果。 */
export interface ProbeSpawnResult {
  stdout: string
  /** 超时被杀时为 true（与退出码无关）。 */
  timedOut: boolean
}

/** spawn 依赖（测试注入 fake）。 */
export interface ProbeSpawnDeps {
  spawnShell: (shell: string, args: string[], timeoutMs: number) => Promise<ProbeSpawnResult>
}

/** 默认 spawn 实现：收集 stdout，超时 kill 并标记 timedOut。 */
const defaultSpawnDeps: ProbeSpawnDeps = {
  spawnShell: (shell, args, timeoutMs) => new Promise((resolve, reject) => {
    const child = spawn(shell, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', () => { clearTimeout(timer); resolve({ stdout, timedOut }) })
  }),
}

/**
 * 运行时探测：在一次性 bash 会话里 source 快照（模拟新会话创建），
 * 然后 `type rm` + `declare -f rm` 看 `rm` 是否被重定义为函数。
 * spawn 失败或超时 → 'unknown'（探测不可用，不代表注入失败）。
 */
export async function probeRmSafeRuntime(
  shell: string,
  snapshotPath: string,
  deps: ProbeSpawnDeps = defaultSpawnDeps,
  timeoutMs = 5_000,
): Promise<RmSafeRuntime> {
  const probePath = toGitBashPath(snapshotPath)
  const script = `source ${quote(probePath)}; type rm; declare -f rm`
  try {
    const { stdout, timedOut } = await deps.spawnShell(shell, ['-c', script], timeoutMs)
    if (timedOut) return 'unknown'
    return parseProbeOutput(stdout)
  } catch {
    return 'unknown'
  }
}

/**
 * 查询 rmSafe 注入状态（查询即确保注入：幂等，与 executeBash 的注入
 * 路径一致）。rmSafe 关闭时调用方不应调用本函数（返回 disabled 由
 * 调用方短路）；此处仍兜底返回 disabled 语义由调用方保证。
 */
export async function queryRmSafeStatus(deps: RmSafeStatusDeps): Promise<RmSafeStatus> {
  const snapshotPath = await deps.getOrCreateSnapshot()
  if (snapshotPath === null) return { status: 'failed', reason: 'snapshot-unavailable' }
  if (!deps.cliExists()) return { status: 'failed', reason: 'cli-missing' }
  if (!deps.inject(snapshotPath, deps.nodePath(), deps.cliPath())) return { status: 'failed', reason: 'snapshot-write-failed' }
  const runtime = await deps.probe(snapshotPath)
  if (runtime === 'system') return { status: 'failed', reason: 'runtime-not-effective' }
  return { status: 'injected', runtime }
}
