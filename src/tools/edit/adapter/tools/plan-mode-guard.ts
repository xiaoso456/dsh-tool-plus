/**
 * DSH adapter for OMP `tools/plan-mode-guard.ts`.
 *
 * plan.md 判定：plan-mode 硬拦截**去掉**（DSH 的 plan 模式是纯提示层，
 * `exit_plan_mode` 工具 + 提示段，官方 write/edit 不做硬拦截）。因此：
 * - `resolvePlanPath` 保留完整解析（hashline 头剥除 + 相对 cwd 解析）——
 *   引擎依赖它做目标路径解析；
 * - `enforcePlanModeWrite` / `targetsLocalSandbox` 为适配空实现
 *   （DSH 无 local:// 沙箱、无 plan 硬拦截）。
 */
import * as path from 'node:path'
import { HL_FILE_HASH_LENGTH, HL_FILE_HASH_SEP, HL_FILE_PREFIX, HL_FILE_SUFFIX } from '@oh-my-pi/hashline'
import type { ToolSession } from './index.ts'
import { resolveToCwd } from './path-utils.ts'
import { ToolError } from './tool-errors.ts'

const HL_TRAILING_TAG_RE = new RegExp(`${HL_FILE_HASH_SEP}[0-9A-Fa-f]{${HL_FILE_HASH_LENGTH}}$`)

/**
 * Strip the hashline `[path#TAG]` wrapper from a write/edit target so the inner
 * filesystem path drives both authorization and resolution (verbatim OMP).
 */
export function unwrapHashlineHeaderPath(targetPath: string): string {
  const trimmed = targetPath.trimEnd()
  if (
    trimmed.length < HL_FILE_PREFIX.length + HL_FILE_SUFFIX.length ||
    trimmed[0] !== HL_FILE_PREFIX ||
    trimmed[trimmed.length - 1] !== HL_FILE_SUFFIX
  ) {
    return targetPath
  }
  const inner = trimmed.slice(HL_FILE_PREFIX.length, trimmed.length - HL_FILE_SUFFIX.length)
  const tagMatch = HL_TRAILING_TAG_RE.exec(inner)
  const pathPart = tagMatch ? inner.slice(0, tagMatch.index) : inner
  if (pathPart.length === 0 || pathPart.includes(HL_FILE_HASH_SEP)) return targetPath
  return pathPart
}

/** True when `targetPath` resolves inside the local sandbox (DSH: none). */
export function targetsLocalSandbox(_session: ToolSession, _targetPath: string): boolean {
  return false
}

/**
 * Resolve a write/edit target to its absolute filesystem path (verbatim OMP
 * resolution, minus local:// / vault:// schemes which DSH does not have).
 */
export function resolvePlanPath(session: ToolSession, targetPath: string): string {
  const unwrapped = unwrapHashlineHeaderPath(targetPath)
  return resolveToCwd(unwrapped, session.cwd)
}

/**
 * Plan mode hard-gate — deliberately a no-op in DSH (plan mode is a hint
 * layer; official write/edit do not hard-block, plan.md §3 判定去掉).
 */
export function enforcePlanModeWrite(
  _session: ToolSession,
  _targetPath: string,
  _options?: { move?: string; op?: 'create' | 'update' | 'delete' },
): void {}
