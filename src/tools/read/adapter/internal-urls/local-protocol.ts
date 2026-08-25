/**
 * DSH adapter for OMP `internal-urls/local-protocol.ts`.
 *
 * plan.md 判定：DSH 无 local:// 内部协议（internal-urls 空路由
 * canHandle 恒 false），local:// 解析实现整体删除；仅保留 verbatim 的
 * `LocalProtocolOptions` 类型面，供 `internal-urls/types.ts` 与 grep 的
 * verbatim grep.ts 类型引用。
 */
export interface LocalProtocolOptions {
  getArtifactsDir?: () => string | null
  getSessionId?: () => string | null
}
