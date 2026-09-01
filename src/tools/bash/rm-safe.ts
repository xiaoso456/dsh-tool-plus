/**
 * rmSafe: rm 重定义脚本的生成与快照注入。
 *
 * 生成 bash 函数定义（rm → `node <trash-cli.mjs> "$@"`），直接内联进
 * 快照文件（会话 shell 创建时 source 一次）：
 * - POSIX：追加到用户环境快照末尾（幂等，带标记行）；
 * - Windows：getOrCreateSnapshot 生成"仅注入"快照文件后同样追加。
 *
 * 内联而非独立脚本文件：快照随进程重建（重启后重新生成），node/trash-cli
 * 路径在进程内是常量，不存在"路径漂移"；独立脚本文件反而引入跨进程共享
 * 缓存（不同安装路径的实例、测试进程互相覆盖，测试进程的 import.meta.url
 * 指向 src 会把共享缓存重写成不存在的路径）。
 *
 * rmSafe 关闭时调用方不注入，快照保持原样，系统 rm 生效。
 * @module @xiaoso/dsh-tool-plus/bash/rm-safe
 */
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 注入标记行：injectRmSafe 以此判断是否已注入（幂等）。 */
export const RM_SAFE_MARKER = '# dsh-tool-plus rmSafe'

/** trash-cli 构建产物路径（lib/trash-cli.mjs，与主 bundle 同目录）。 */
export function rmSafeCliPath(): string {
  return fileURLToPath(new URL('./trash-cli.mjs', import.meta.url))
}

/** 单引号转义（bash 单引号内 `'\''` 表示一个字面单引号）。 */
export function quote(s: string): string {
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
 * 向快照文件内联追加 rm 重定义（幂等：已有标记则跳过）。
 * 返回是否注入成功；快照文件不可读/不可写时返回 false（不抛异常）。
 */
export function injectRmSafe(snapshotPath: string, nodePath: string, cliPath: string): boolean {
  let content: string
  try {
    content = fs.readFileSync(snapshotPath, 'utf8')
  } catch {
    return false
  }
  if (content.includes(RM_SAFE_MARKER)) return true
  try {
    fs.appendFileSync(snapshotPath, `\n${rmSafeScript(nodePath, cliPath)}`)
    return true
  } catch {
    return false
  }
}
