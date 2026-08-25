/**
 * DSH adapter shim for OMP `memories/` — the memory system.
 *
 * plan.md 判定：DSH 无 OMP 内部 URL 协议（internal-urls canHandle=false），
 * 因此 memory:// 解析后端（`../internal-urls/memory-protocol.ts` 中除
 * `splitMemoryGlobPattern` 之外的部分）是不可达的。这里仅提供该模块顶层的
 * `getMemoryRoot` 表面，使 verbatim 的 memory-protocol.ts 能编译；后端置空。
 */

/** DSH: no memory root — return an empty path (memory:// backend inert). */
export function getMemoryRoot(_agentDir: string, _cwd: string): string {
  return ''
}
