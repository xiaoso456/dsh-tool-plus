/**
 * A-1 回归：bash 输出管线与 OMP 上游 streaming-output 行为对齐。
 *
 * 背景（second-impl-audit.md A-1）：仓库内同一上游模块存在两份——
 * `src/tools/omp/session/streaming-output.ts`（与 refs 17.3.5 逐字节一致）与
 * `src/tools/bash/streaming-output.ts`（initial commit 时代的旧快照，被
 * bash-executor/background/config/truncate.ts 消费）。旧快照缺上游已修的三处
 * 机制，本文件用行为断言钉住：
 *  1. CR 归一（上游 #normalizeCarriageReturns）：进度条输出按 CR 边界成行；
 *  2. headBytes 钳制（上游 :807 min(headBytes, spillThreshold/2)）：
 *     head+tail 组合体 ≤ spillThreshold（"by construction" 不变量）；
 *  3. dispose()（上游 :1379，防 EMFILE issue #6463）：存在且幂等。
 *
 * S-2 联动：A-1 改用 verbatim 实现后，其 sanitizeText 依赖 `Bun.stripANSI`，
 * bun-shim 必须提供（否则含 ANSI 输出 TypeError）。
 */
import { describe, expect, it } from 'vitest'
import { OutputSink } from '../../src/tools/bash/streaming-output.ts'

describe('OutputSink 与 OMP 上游行为对齐（A-1）', () => {
  it('CR 进度行折叠为多行（上游 #normalizeCarriageReturns 语义）', async () => {
    const sink = new OutputSink({ spillThreshold: 50_000 })
    sink.push('Downloading 10%\rDownloading 50%\r100%\rDone\n')
    const summary = await sink.dump()
    // 旧快照把 \r 直接剥掉 → 黏成一行；上游按 CR 边界成行
    expect(summary.output).not.toContain('\r')
    const lines = summary.output.split('\n').filter((l) => l.trim().length > 0)
    expect(lines.length).toBeGreaterThanOrEqual(3)
    expect(summary.totalLines).toBeGreaterThanOrEqual(3)
  })

  it('headBytes 超过 spillThreshold/2 时被钳制：组合体 ≤ spillThreshold（by construction）', async () => {
    // head 8KB > spillThreshold/2=5KB → 上游钳制 headLimit=5KB、tail 预算=5KB
    const sink = new OutputSink({ spillThreshold: 10_000, headBytes: 8_000 })
    const chunk = `${'x'.repeat(999)}\n`
    for (let i = 0; i < 60; i++) sink.push(chunk) // ~60KB，远超内联预算
    const summary = await sink.dump()
    // 组装体（head + marker + tail）不得突破内联字节上限（留 marker 容差）
    expect(Buffer.byteLength(summary.output, 'utf-8')).toBeLessThanOrEqual(11_000)
  })

  it('dispose() 存在且幂等（防 EMFILE fd 泄漏，上游 issue #6463）', async () => {
    const sink = new OutputSink({ spillThreshold: 5_000 })
    sink.push('hello\n')
    const anySink = sink as unknown as { dispose?: () => Promise<void> }
    expect(typeof anySink.dispose).toBe('function')
    await anySink.dispose!()
    await anySink.dispose!() // 幂等，不得抛错
  })
})

describe('Bun.stripANSI shim（S-2，A-1 硬前置）', () => {
  it('shim 提供 stripANSI 且剥离 ANSI 序列', () => {
    const bun = (globalThis as unknown as { Bun: Record<string, unknown> }).Bun
    expect(typeof bun.stripANSI).toBe('function')
    expect((bun.stripANSI as (t: string) => string)('\x1b[31mred\x1b[0m ok')).toBe('red ok')
  })
})