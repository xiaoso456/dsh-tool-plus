/**
 * A-5 回归：shell-snapshot 目录不可用时必须降级，不得炸 bash 调用。
 *
 * 背景（second-impl-audit.md A-5）：插件版 getOrCreateSnapshot 把
 * mkdirSync + 0600 预创建写在 spawn 的 try **之外**（shell-snapshot.ts:267-288），
 * 共享机器/只读 tmp/目录被他人占有时异常逃逸 executeBash → 整个 bash 工具
 * 调用失败。上游 refs packages/coding-agent/src/utils/shell-snapshot.ts:596-631
 * 已修：per-uid 目录 + 整体 try 包裹 + `logger.debug` + `return null` 降级
 * （注释明确该 bug 形态曾"打爆每一次 bash 调用"）。
 *
 * 契约：目录不可用 → getOrCreateSnapshot 返回 null（调用方跳过快照继续跑），
 * 绝不抛异常。
 *
 * 注意：被测码是 `import * as fs from "node:fs"`（命名空间导入），mock 必须
 * 同时覆盖命名空间顶层与 default 导出，才能跨平台确定性地打中 EACCES 分支
 * （否则 Windows 被 win32 早退掩盖、POSIX 上 mock 不生效）。工厂内联 thrower，
 * 不引用顶层变量（vi.mock 工厂会被提升到文件顶部）。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const mkdirSyncThrows = () => {
    throw Object.assign(new Error('EACCES: permission denied, mkdir'), { code: 'EACCES' })
  }
  return {
    ...actual,
    // 命名空间导入（import * as fs）走这一层
    mkdirSync: mkdirSyncThrows,
    default: {
      ...actual.default,
      // default 导入走这一层
      mkdirSync: mkdirSyncThrows,
    },
  }
})

import { getOrCreateSnapshot } from '../../src/tools/bash/shell-snapshot.ts'

describe('shell-snapshot 目录不可用降级（A-5）', () => {
  it('mkdir 失败时返回 null 降级（不向 executeBash 抛异常）', async () => {
    const result = await getOrCreateSnapshot('bash', {})
    expect(result).toBeNull()
  })
})