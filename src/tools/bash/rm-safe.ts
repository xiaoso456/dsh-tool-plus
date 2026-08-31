/**
 * rmSafe: rm 重定义脚本的生成与快照注入。
 *
 * 生成一个 bash 函数定义脚本（rm → `node <trash-cli.mjs> "$@"`），
 * 通过快照文件（会话 shell 创建时 source 一次）注入：
 * - POSIX：追加到用户环境快照末尾（幂等，带标记行）；
 * - Windows：getOrCreateSnapshot 生成"仅注入"快照文件后同样追加。
 *
 * rmSafe 关闭时调用方不注入，快照保持原样，系统 rm 生效。
 * @module @xiaoso/dsh-tool-plus/bash/rm-safe
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 注入标记行：injectRmSafe 以此判断是否已注入（幂等）。 */
export const RM_SAFE_MARKER = '# dsh-tool-plus rmSafe'

/** rm-safe 脚本缓存目录（tmpdir 下，跨会话复用）。 */
export function rmSafeScriptDir(): string {
  return path.join(os.tmpdir(), 'dsh-bash-plus')
}

/** trash-cli 构建产物路径（lib/trash-cli.mjs，与主 bundle 同目录）。 */
export function rmSafeCliPath(): string {
  return fileURLToPath(new URL('./trash-cli.mjs', import.meta.url))
}

/** 单引号转义（bash 单引号内 `'\''` 表示一个字面单引号）。 */
function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * 生成 rm 重定义脚本内容：bash 函数 `rm()` 把参数原样转交 trash-cli。
 * 逃生口：`command rm`（bash 的 command 关键字跳过函数/alias 查找）或
 * 绝对路径（/usr/bin/rm）走系统真删除。注意 `\rm` 反斜杠只抑制 alias
 * 展开、不抑制函数查找，对函数重定义无效——不是逃生口。
 */
export function rmSafeScript(nodePath: string, cliPath: string): string {
  return [
    RM_SAFE_MARKER,
    'rm() {',
    `  ${quote(nodePath)} ${quote(cliPath)} "$@"`,
    '}',
    '',
  ].join('\n')
}

/**
 * 确保 rm-safe 脚本存在（内容不变时幂等，不重写文件）。
 * 返回脚本路径；目录/写入失败时返回 null（不抛异常，调用方降级并告警）。
 */
export function ensureRmSafeScript(dir: string, nodePath: string, cliPath: string): string | null {
  const target = path.join(dir, 'rm-safe.sh')
  const content = rmSafeScript(nodePath, cliPath)
  try {
    if (fs.readFileSync(target, 'utf8') === content) return target
  } catch {
    // 不存在或不可读 → 重写
  }
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(target, content, { mode: 0o600 })
    return target
  } catch {
    return null
  }
}

/**
 * 向快照文件追加 `source <rm-safe.sh>`（幂等：已有标记则跳过）。
 * 返回是否注入成功；快照文件不可读/不可写时返回 false（不抛异常）。
 */
export function injectRmSafe(snapshotPath: string, scriptPath: string): boolean {
  let content: string
  try {
    content = fs.readFileSync(snapshotPath, 'utf8')
  } catch {
    return false
  }
  if (content.includes(RM_SAFE_MARKER)) return true
  try {
    fs.appendFileSync(snapshotPath, `\n${RM_SAFE_MARKER}\nsource ${quote(scriptPath)}\n`)
    return true
  } catch {
    return false
  }
}
