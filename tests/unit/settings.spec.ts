/**
 * Unit tests for the settings surface: flat schema defaults, the mapping onto
 * the nested runtime config, and the OMP-parity truncation policy.
 * @module tests
 */

import { describe, expect, it } from 'vitest'
import {
  BASH_PLUS_SETTINGS_NS,
  DEFAULT_OUTPUT_TRUNCATE,
  resolveConfig,
} from '../../src/config/settings.ts'

describe('resolveConfig', () => {
  it('resolves a bare config to the full OMP-parity defaults (default timeout 1h)', () => {
    const cfg = resolveConfig({})
    expect(cfg.enableRunInBackground).toBe(true)
    expect(cfg.autoBackgroundMs).toBe(60_000)
    // Aligned with OMP bashDefaultTimeoutSec = 3600 → 3_600_000 ms.
    expect(cfg.defaultTimeoutMs).toBe(3_600_000)
    expect(cfg.maxTimeoutMs).toBe(3_600_000)
    expect(cfg.outputMaxBytes).toBe(51_200)
    expect(cfg.outputSinkTailBytes).toBe(51_200)
    expect(cfg.outputSinkHeadBytes).toBe(20_480)
    expect(cfg.minimizer).toEqual({ enabled: true, only: [], except: [], maxCaptureBytes: 512 * 1024 })
    expect(cfg.interceptorEnabled).toBe(true)
    expect(cfg.nonInteractiveEnv).toBe(true)
    expect(cfg.snapshotEnabled).toBe(true)
    expect(cfg.useShellCommandWrapper).toBe(false)
    expect(cfg.maxBackgroundJobs).toBe(15)
    expect(cfg.outputTruncate).toEqual(DEFAULT_OUTPUT_TRUNCATE)
  })

  it('maps flat settings keys onto the nested runtime config', () => {
    const cfg = resolveConfig({
      autoBackgroundMs: 5_000,
      minimizerEnabled: false,
      outputTruncateStrategy: 'lines',
      outputTruncateByteMode: 'head',
      outputTruncateByteHeadBytes: 64,
      outputTruncateLineTailLines: 200,
    })
    expect(cfg.autoBackgroundMs).toBe(5_000)
    expect(cfg.minimizer.enabled).toBe(false)
    expect(cfg.outputTruncate.strategy).toBe('lines')
    expect(cfg.outputTruncate.bytes).toEqual({ mode: 'head', headBytes: 64, tailBytes: 4_096 })
    // Untouched groups inherit the OMP defaults.
    expect(cfg.outputTruncate.lines.mode).toBe('middle')
    expect(cfg.outputTruncate.lines.tailLines).toBe(200)
    expect(cfg.outputTruncate.lines.headLines).toBe(50)
    expect(cfg.outputTruncate.triggerBytes).toBe(DEFAULT_OUTPUT_TRUNCATE.triggerBytes)
    expect(cfg.outputTruncate.triggerLines).toBe(DEFAULT_OUTPUT_TRUNCATE.triggerLines)
    // on/except/maxCaptureBytes stay at their native constants.
    expect(cfg.minimizer).toEqual({ enabled: false, only: [], except: [], maxCaptureBytes: 512 * 1024 })
  })

  it('truncation defaults mirror the documented OMP values', () => {
    expect(DEFAULT_OUTPUT_TRUNCATE.strategy).toBe('bytes')
    expect(DEFAULT_OUTPUT_TRUNCATE.triggerBytes).toBe(10_240)
    expect(DEFAULT_OUTPUT_TRUNCATE.triggerLines).toBe(100)
    expect(DEFAULT_OUTPUT_TRUNCATE.bytes).toEqual({ mode: 'middle', headBytes: 4_096, tailBytes: 4_096 })
    expect(DEFAULT_OUTPUT_TRUNCATE.lines).toEqual({ mode: 'middle', headLines: 50, tailLines: 100 })
  })
})

describe('BASH_PLUS_SETTINGS_NS', () => {
  it('is the `bash-plus` namespace used by the client card', () => {
    expect(BASH_PLUS_SETTINGS_NS).toBe('bash-plus')
  })
})
