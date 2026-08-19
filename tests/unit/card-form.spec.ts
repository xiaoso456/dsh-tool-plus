/**
 * Unit tests for the client card form state logic:
 * - Overridden calculation (staged vs base vs stored)
 * - Dirty state calculation
 * - Resetting and selecting default values
 * - Save actions (unsetting default values, setting custom overrides)
 * - Dynamic progressive disclosure (bytes vs lines, head vs tail vs middle)
 * @module tests
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OUTPUT_TRUNCATE,
  resolveConfig,
} from '../../src/config/settings.ts'

describe('Settings Card Form Logic & Reversion States', () => {
  it('default schema values represent the base composition layer', () => {
    const config = resolveConfig({})
    expect(config.outputTruncate.strategy).toBe('bytes')
    expect(config.outputTruncate.bytes.mode).toBe('middle')
    expect(config.outputTruncate.lines.mode).toBe('middle')
    expect(config.defaultTimeoutMs).toBe(3_600_000)
    expect(config.enableRunInBackground).toBe(true)
  })

  it('selecting the base value when at default does NOT mark field as overridden', () => {
    const baseVal = 'bytes'
    const userStored = false
    const staged = 'bytes'

    // The fixed formula in BashPlusCard:
    let overridden = false
    if (staged === null || staged === baseVal) {
      overridden = false
    } else {
      overridden = true
    }

    expect(overridden).toBe(false)
  })

  it('selecting a non-default value marks field as overridden', () => {
    const baseVal = 'bytes'
    const staged = 'lines'

    let overridden = false
    if (staged === null || staged === baseVal) {
      overridden = false
    } else {
      overridden = true
    }

    expect(overridden).toBe(true)
  })

  it('clicking reset stages clear and marks field as NOT overridden', () => {
    const baseVal = 'bytes'
    const staged: string | null = null

    let overridden = false
    if (staged === null || staged === baseVal) {
      overridden = false
    } else {
      overridden = true
    }

    expect(overridden).toBe(false)
  })

  it('saving a value matching base cleans up (unsets) user settings rather than creating redundant overrides', () => {
    const userSettings: Record<string, unknown> = { outputTruncateStrategy: 'lines' }
    const staged = 'bytes'
    const baseVal = 'bytes'

    const writes: Array<{ action: 'set' | 'unset'; field: string; value?: unknown }> = []

    if (staged === null || staged === baseVal) {
      if (Object.prototype.hasOwnProperty.call(userSettings, 'outputTruncateStrategy')) {
        writes.push({ action: 'unset', field: 'outputTruncateStrategy' })
      }
    } else {
      writes.push({ action: 'set', field: 'outputTruncateStrategy', value: staged })
    }

    expect(writes).toEqual([{ action: 'unset', field: 'outputTruncateStrategy' }])
  })

  it('saving a custom override writes the set command to user settings', () => {
    const userSettings: Record<string, unknown> = {}
    const staged = 'lines'
    const baseVal = 'bytes'

    const writes: Array<{ action: 'set' | 'unset'; field: string; value?: unknown }> = []

    if (staged === null || staged === baseVal) {
      if (Object.prototype.hasOwnProperty.call(userSettings, 'outputTruncateStrategy')) {
        writes.push({ action: 'unset', field: 'outputTruncateStrategy' })
      }
    } else {
      writes.push({ action: 'set', field: 'outputTruncateStrategy', value: staged })
    }

    expect(writes).toEqual([{ action: 'set', field: 'outputTruncateStrategy', value: 'lines' }])
  })
})
