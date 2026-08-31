/**
 * rmSafe/status 结果 → 本地化文案的纯映射测试。
 */
import { describe, expect, it } from 'vitest'
import { rmSafeStatusText } from '../../src/client/rm-safe-status-text.ts'
import { zh } from '../../src/client/locales.ts'

const t = (key: Parameters<typeof rmSafeStatusText>[0] extends (k: infer K) => string ? K : never): string => zh[key]

describe('rmSafeStatusText', () => {
  it('announces a verified injection', () => {
    expect(rmSafeStatusText(t, { status: 'injected', runtime: 'function' }))
      .toBe('安全 rm 已注入并验证：rm 进入回收站')
  })

  it('announces an unverified injection', () => {
    expect(rmSafeStatusText(t, { status: 'injected', runtime: 'unknown' }))
      .toBe('安全 rm 已注入（运行时验证不可用）')
  })

  it('maps every failure reason into the failed message', () => {
    const reasons = [
      'snapshot-unavailable',
      'cli-missing',
      'script-write-failed',
      'snapshot-write-failed',
      'runtime-not-effective',
    ] as const
    for (const reason of reasons) {
      const text = rmSafeStatusText(t, { status: 'failed', reason })
      expect(text).toContain('安全 rm 注入失败')
      expect(text).not.toContain('{reason}')
    }
  })

  it('maps disabled to the empty string', () => {
    expect(rmSafeStatusText(t, { status: 'disabled' })).toBe('')
  })
})
