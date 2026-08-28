/**
 * A-4 回归：OMP session 级状态（fileSnapshotStore）跨调用桥接。
 *
 * 背景（second-impl-audit.md A-4）：上游 read/write/edit 引擎把
 * fileSnapshotStore 挂在 ToolSession 上跨调用共享（refs tools/index.ts:358-362）；
 * DSH 每次 execute 新建 ToolSession，session-state.ts 目前只桥接
 * conflictHistory，fileSnapshotStore "预留暂未接入"——导致跨调用 seen-lines
 * 校验、锚点漂移恢复、tag 路径恢复三项能力静默失效。
 *
 * 契约：attach/persist 必须对称覆盖 fileSnapshotStore，与 conflictHistory 相同。
 */
import { describe, expect, it } from 'vitest'
import { attachOmpSessionState, persistOmpSessionState } from '../../src/tools/shared/session-state.ts'

describe('OMP session 状态桥接（A-4）', () => {
  it('fileSnapshotStore 经 persist → attach 跨调用 round-trip', () => {
    const sessionKey = {}
    const store = { snapshots: new Map<string, string>() }

    // 第一次调用结束：引擎在 ToolSession 上建好的快照存储写回共享态
    persistOmpSessionState(sessionKey, {
      conflictHistory: { nextId: 2 } as unknown as object,
      fileSnapshotStore: store,
    } as never)

    // 第二次调用开始：新 ToolSession 应拿到上次的快照存储（同一实例）
    const nextSession: { conflictHistory?: unknown; fileSnapshotStore?: unknown } = {}
    attachOmpSessionState(nextSession, sessionKey)

    expect(nextSession.conflictHistory).toEqual({ nextId: 2 })
    expect(nextSession.fileSnapshotStore).toBe(store)
  })

  it('无 sessionKey 时跳过（不挂状态），与 conflictHistory 语义一致', () => {
    const session: { conflictHistory?: unknown; fileSnapshotStore?: unknown } = {}
    attachOmpSessionState(session, undefined)
    expect(session.fileSnapshotStore).toBeUndefined()
    expect(session.conflictHistory).toBeUndefined()

    expect(() => persistOmpSessionState(undefined, { fileSnapshotStore: {} } as never)).not.toThrow()
  })
})