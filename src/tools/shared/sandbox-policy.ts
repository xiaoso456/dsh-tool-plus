/**
 * Per-call sandbox policy resolution for DSH file mutations (方案A, 2026-08-27).
 *
 * Mirrors the official `@deepseek-ai/dsh-tool-fs` FsSandboxController semantics:
 * the mounted `ctx.fs` reports `sandboxMode` (the capability fact — undefined
 * means no confining backend, mutations go unfenced); when a confining backend
 * is mounted, the shared `sandboxPolicy` service resolves the SESSION's
 * standing mode + workspace root into the per-call policy that
 * `ctx.fs.writeText` / `ctx.fs.editText` take as their final argument.
 *
 * Differences from the official controller (deliberate, adapter-scoped):
 *  - No escalation advertisement: OMP-native tool schemas carry no
 *    `sandbox_permissions`/`justification` fields, so nothing is advertised
 *    and `FS_SANDBOX_DENIED` surfaces as the provider's own error text.
 *  - Degradation instead of fail-fast: if `ctx.sandboxPolicy` is missing in a
 *    composition (host builds always pair it with a confining `ctx.fs`; test
 *    doubles may not), the policy resolves to `undefined` and the mutation
 *    falls back to the deployment default — never crash registration.
 */

/** Minimal structural type of the policy object produced by `sandboxPolicy.resolve`.
 * `mode` mirrors the host's closed `SandboxMode` vocabulary
 * (read-only / workspace-write / danger-full-access) so the object is
 * structurally assignable to `SandboxExecutionPolicy` without importing the
 * host-internal type. */
export type SandboxPolicyMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export interface SandboxPolicyLike {
  mode: SandboxPolicyMode
  /** Required: the host SandboxExecutionPolicy always carries the workspace
   * root (session cwd, or the deployment fallback root). */
  workspaceRoot: string
}

/** Minimal structural type of the `sandboxPolicy` service. */
interface SandboxPolicyService {
  resolve(request: { session?: unknown }): SandboxPolicyLike | undefined | null
}

/**
 * Resolve the per-call mutation policy for the given exec context, or
 * `undefined` when the mounted filesystem does not confine (or the policy
 * service is unavailable). Pass the result as the final argument of
 * `ctx.fs.writeText` / `ctx.fs.editText`.
 */
export function resolveSandboxPolicy(ctx: any, exec: any): SandboxPolicyLike | undefined {
  const defaultMode: string | undefined = ctx?.fs?.sandboxMode
  if (defaultMode === undefined) return undefined
  const policy = ctx.get('sandboxPolicy') as SandboxPolicyService | undefined
  if (!policy || typeof policy.resolve !== 'function') return undefined
  const request = exec?.agent ? { session: exec.agent.session } : {}
  return policy.resolve(request) ?? undefined
}
