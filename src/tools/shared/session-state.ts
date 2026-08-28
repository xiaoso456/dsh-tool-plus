/**
 * OMP 引擎 session 级状态（跨工具调用保持）。
 *
 * OMP 的 read/write/edit 引擎把冲突注册表（ConflictHistory）、hashline 快照
 * 等挂在 ToolSession 对象上，同一 agent 会话内跨工具调用共享。DSH 适配层
 * 每次 execute 都新建 ToolSession，导致这些状态丢失（T11-2：read 注册的
 * 冲突 id 在 write 时找不到）。本模块按 DSH Session 对象
 * （exec.agent.session）持久化这些状态：WeakMap 键控，session 销毁自动
 * 回收，无泄漏。
 *
 * 用法（适配层）：
 *   1. execute 开始时 `attachOmpSessionState(session, exec?.agent?.session)`
 *      把上次调用保存的状态挂到新建的 ToolSession 上；
 *   2. execute 结束后 `persistOmpSessionState(exec?.agent?.session, session)`
 *      把引擎惰性新建/更新的状态写回共享存储。
 *
 * 类型说明：read/write 各自 verbatim 拷贝了一份 conflict-detect.ts，两个
 * ConflictHistory class 因 `#nextId` 私有字段互不兼容（名义类型）。本模块
 * 只搬运状态、不调用其方法，故用 `unknown` 宽松承载，避免跨拷贝类型耦合。
 */
export interface OmpSessionState {
  /** 冲突注册表（read 注册 / write 消费）。 */
  conflictHistory?: unknown
  /**
   * hashline 快照存储（read 锚点 / edit seen-lines 校验 / 锚点漂移恢复；
   * A-4 桥接，与 conflictHistory 对称：attach/persist round-trip）。
   */
  fileSnapshotStore?: unknown
}

const states = new WeakMap<object, OmpSessionState>()

/** 取（或惰性建）某个 DSH session 的 OMP 状态。 */
export function getOmpSessionState(sessionKey: object): OmpSessionState {
  let state = states.get(sessionKey)
  if (!state) {
    state = {}
    states.set(sessionKey, state)
  }
  return state
}

/**
 * 把共享状态挂到新建的 ToolSession 上（execute 开始时调用）。
 * 无 sessionKey（无会话上下文）时跳过——状态不跨调用保持。
 */
export function attachOmpSessionState(
  session: { conflictHistory?: unknown; fileSnapshotStore?: unknown },
  sessionKey: object | undefined,
): void {
  if (!sessionKey) return
  const state = getOmpSessionState(sessionKey)
  if (state.conflictHistory) session.conflictHistory = state.conflictHistory
  if (state.fileSnapshotStore) session.fileSnapshotStore = state.fileSnapshotStore
}

/**
 * 把 ToolSession 上引擎新建/更新的状态写回共享存储（execute 结束后调用）。
 * OMP 引擎会惰性新建 ConflictHistory / fileSnapshotStore 并赋到 session
 * 对象上（如 read.ts 经 getFileSnapshotStore 挂快照库），必须回写才能被
 * 下一次调用恢复。
 */
export function persistOmpSessionState(
  sessionKey: object | undefined,
  session: { conflictHistory?: unknown; fileSnapshotStore?: unknown },
): void {
  if (!sessionKey) return
  const state = getOmpSessionState(sessionKey)
  if (session.conflictHistory) state.conflictHistory = session.conflictHistory
  if (session.fileSnapshotStore) state.fileSnapshotStore = session.fileSnapshotStore
}
