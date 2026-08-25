/**
 * DSH adapter shim for OMP `mnemopi/state.ts` — the mnemopi memory backend.
 *
 * plan.md 判定：DSH 无内部 URL 协议，memory:// 后端（含 mnemopi 记忆库）在
 * DSH 中不可达（internal-urls canHandle=false）。因此这里仅提供
 * `../internal-urls/memory-protocol.ts` 顶层引用的表面：`MnemopiSessionState`
 * 类与 `getMnemopiSessionState`，后端全部置空。`splitMemoryGlobPattern`（纯
 * 解析逻辑，不触达 mnemopi）保留在 memory-protocol.ts 内 verbatim。
 */

/** 存储后端标识（verbatim OMP 表面；DSH 不使用）。 */
export type MnemopiMemoryStore = 'working' | 'episodic' | 'fact'

/** 全行查找结果（verbatim OMP 表面；DSH 恒无命中）。 */
export interface MnemopiScopedMemoryHit {
  bank: string
  store: MnemopiMemoryStore
  row: {
    id: string
    content: string
    source: string | null
    timestamp: string | null
    importance: number | null
    veracity: string | null
    created_at: string | null
    session_id: string | null
    memory_type: string | null
    metadata: unknown
  }
}

/** 会话级 mnemopi 状态（verbatim 表面；DSH 恒为空后端）。 */
export class MnemopiSessionState {
  readonly aliasOf?: MnemopiSessionState
  readonly sessionId: string

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  getScopedMemory(_id: string): MnemopiScopedMemoryHit | null {
    return null
  }
}

/**
 * DSH: no mnemopi backend — return undefined so registry lookups short-circuit
 * to "no mnemonic state".
 */
export function getMnemopiSessionState(_session: unknown): MnemopiSessionState | undefined {
  return undefined
}
