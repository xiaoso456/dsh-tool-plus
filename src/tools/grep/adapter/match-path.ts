/**
 * Windows 路径分隔符修正版 matchAbsolutePath（适配层，非 verbatim）。
 *
 * OMP 原版对绝对路径直接返回。Windows 上 searchPath 经
 * `normalizePathSeparators` 转正斜杠 → native grep 返回正斜杠 match.path，
 * 而 `rangesByAbsPath` 的 key 用 `path.resolve`（反斜杠）——分隔符不一致
 * 导致 Map 查找失败、行区间过滤静默失效（T13-9）。统一经 `path.resolve`
 * 规范化后与 key 一致。
 *
 * grep.ts 内部函数移到本模块 + import 调整（调用点不变）。
 */
import * as path from 'node:path'

export function matchAbsolutePath(matchPath: string, searchPath: string): string {
  if (matchPath === '') return searchPath
  if (path.isAbsolute(matchPath)) return path.resolve(matchPath)
  return path.resolve(searchPath, matchPath)
}
