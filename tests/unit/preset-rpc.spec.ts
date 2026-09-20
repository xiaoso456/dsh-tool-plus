/**
 * Unit tests for the host half of the preset RPC (`src/host/preset-rpc.ts`):
 * payload validation for `presets/apply` and the roster mapping that feeds
 * `presets/status`. Both are pure — no filesystem, no Connection service.
 * @module tests
 */

import { describe, expect, it, vi } from 'vitest'
import { handlePresetEndpoint, parsePresetActionPayload, parsePresetComparePayload, toRosterEntry } from '../../src/host/preset-rpc.ts'
import {
  PRESET_ACTION_ENDPOINT,
  PRESET_COMPARE_ENDPOINT,
  PRESET_STATUS_ENDPOINT,
} from '../../src/tools/shared/browser-rpc-channel.ts'

describe('parsePresetActionPayload', () => {
  it('accepts an upgrade request', () => {
    expect(parsePresetActionPayload({ id: 'tool-plus-standard', action: 'upgrade' }))
      .toEqual({ id: 'tool-plus-standard', action: 'upgrade' })
  })

  it('accepts a reset request', () => {
    expect(parsePresetActionPayload({ id: 'tool-plus-ptc', action: 'reset' }))
      .toEqual({ id: 'tool-plus-ptc', action: 'reset' })
  })

  it('rejects a non-object payload', () => {
    for (const payload of [undefined, null, 'upgrade', 42, ['x']]) {
      expect(parsePresetActionPayload(payload)).toBeUndefined()
    }
  })

  it('rejects a missing or empty id', () => {
    expect(parsePresetActionPayload({ action: 'upgrade' })).toBeUndefined()
    expect(parsePresetActionPayload({ id: '', action: 'upgrade' })).toBeUndefined()
    expect(parsePresetActionPayload({ id: 7, action: 'upgrade' })).toBeUndefined()
  })

  it('rejects an unknown action', () => {
    expect(parsePresetActionPayload({ id: 'x', action: 'delete' })).toBeUndefined()
    expect(parsePresetActionPayload({ id: 'x' })).toBeUndefined()
  })
})

describe('toRosterEntry', () => {
  it('keeps the identity fields of a roster preset', () => {
    expect(toRosterEntry({
      id: 'standard',
      trust: 'system',
      path: '/root/standard',
      name: 'Standard',
      description: 'shipped',
    })).toEqual({
      id: 'standard',
      trust: 'system',
      path: '/root/standard',
      name: 'Standard',
      description: 'shipped',
      broken: undefined,
    })
  })

  it('treats any non-system trust as user', () => {
    expect(toRosterEntry({ id: 'mine', trust: 'user', path: '/home/.agent-presets/mine' }).trust).toBe('user')
    expect(toRosterEntry({ id: 'mine', trust: 'weird', path: '/p' }).trust).toBe('user')
  })

  it('carries the broken reason through', () => {
    expect(toRosterEntry({ id: 'x', trust: 'user', path: '/p', broken: 'row 3 has no name' }).broken)
      .toBe('row 3 has no name')
  })
})

/** A context whose only useful surface is `get('agentPresets')`. */
function ctxWith(service: unknown) {
  return { get: (name: string) => (name === 'agentPresets' ? service : undefined) } as never
}

/** One roster entry shaped like the official service's. */
const rosterEntry = { id: 'tool-plus-standard', trust: 'user', path: '/home/.agent-presets/tool-plus-standard' }

describe('handlePresetEndpoint', () => {
  it('leaves foreign endpoints to the caller (so the shared channel can serve them)', async () => {
    const deps = { listStatuses: vi.fn(), applyAction: vi.fn() }
    expect(await handlePresetEndpoint(ctxWith({ list: async () => [] }), deps, 'browser/detect', {})).toBeUndefined()
  })

  it('answers presets/status from the roster the service reports', async () => {
    const status = { id: 'tool-plus-standard', source: 'ours', path: '/p', conflicts: [], clean: true }
    const listStatuses = vi.fn((roster: unknown[]) => [status])
    const list = vi.fn(async () => [rosterEntry])
    const result = await handlePresetEndpoint(
      ctxWith({ list }),
      compareDeps({ listStatuses }),
      PRESET_STATUS_ENDPOINT,
      {},
    )
    expect(list).toHaveBeenCalledTimes(1)
    expect(listStatuses.mock.calls[0][0]).toEqual([{
      id: 'tool-plus-standard',
      trust: 'user',
      path: '/home/.agent-presets/tool-plus-standard',
      name: undefined,
      description: undefined,
      broken: undefined,
    }])
    expect(result).toEqual({
      ok: true,
      value: { presets: [status], templates: [{ id: 'tool-plus-standard', name: '标准增强版' }] },
    })
  })

  it('reports a missing agent-presets service instead of throwing', async () => {
    const result = await handlePresetEndpoint(ctxWith(undefined), { listStatuses: vi.fn(), applyAction: vi.fn() } as never, PRESET_STATUS_ENDPOINT, {})
    expect(result?.ok).toBe(false)
    expect(result?.ok === false && result.error.message).toMatch(/not available/u)
  })

  it('rejects a malformed presets/apply payload without touching the filesystem', async () => {
    const applyAction = vi.fn()
    const result = await handlePresetEndpoint(ctxWith({ list: async () => [] }), { listStatuses: vi.fn(), applyAction } as never, PRESET_ACTION_ENDPOINT, { id: 'x' })
    expect(applyAction).not.toHaveBeenCalled()
    expect(result?.ok === false && result.error.code).toBe('bad-request')
  })

  it('applies a valid presets/apply request', async () => {
    const applied = { ok: true, changed: false, changes: [] }
    const applyAction = vi.fn(() => applied)
    const result = await handlePresetEndpoint(ctxWith({ list: async () => [] }), { listStatuses: vi.fn(), applyAction } as never, PRESET_ACTION_ENDPOINT, { id: 'zz-smoke', action: 'upgrade' })
    expect(applyAction).toHaveBeenCalledWith('zz-smoke', 'upgrade', undefined)
    expect(result).toEqual({ ok: true, value: applied })
  })

  it('passes the picked template through on reset, and rejects an empty templateId', async () => {
    const applyAction = vi.fn(() => ({ ok: true, changed: true, changes: [] }))
    const deps = { listStatuses: vi.fn(), applyAction } as never
    await handlePresetEndpoint(ctxWith({ list: async () => [] }), deps, PRESET_ACTION_ENDPOINT, {
      id: 'mine',
      action: 'reset',
      templateId: 'tool-plus-ptc',
    })
    expect(applyAction).toHaveBeenCalledWith('mine', 'reset', 'tool-plus-ptc')
    const bad = await handlePresetEndpoint(ctxWith({ list: async () => [] }), deps, PRESET_ACTION_ENDPOINT, {
      id: 'mine',
      action: 'reset',
      templateId: '',
    })
    expect(bad?.ok === false && bad.error.code).toBe('bad-request')
  })

  it('turns a throwing analysis into an internal error result', async () => {
    const result = await handlePresetEndpoint(
      ctxWith({ list: async () => { throw new Error('boom') } }),
      { listStatuses: vi.fn(), applyAction: vi.fn() } as never,
      PRESET_STATUS_ENDPOINT,
      {},
    )
    expect(result?.ok === false && result.error.message).toBe('boom')
  })
})

/** Minimal deps for the compare endpoint (roster + two templates). */
function compareDeps(over: Record<string, unknown> = {}) {
  const comparison = {
    status: 'ok' as const,
    conflicts: [] as string[],
    identical: false,
    yoursCount: 1,
    behindCount: 0,
    items: [{ kind: 'only-yours' as const, row: 'compaction', path: 'config.thresholdRatio', yours: '0.4' }],
  }
  return {
    listStatuses: vi.fn(),
    applyAction: vi.fn(),
    listTemplates: vi.fn(() => [{ id: 'tool-plus-standard', name: '标准增强版' }]),
    comparePreset: vi.fn(() => comparison),
    ...over,
  } as never
}

describe('parsePresetComparePayload', () => {
  it('accepts exactly two non-empty ids', () => {
    expect(parsePresetComparePayload({ presetId: 'a', templateId: 'b' })).toEqual({ presetId: 'a', templateId: 'b' })
  })

  it('rejects anything else', () => {
    for (const payload of [undefined, null, [], 'x', { presetId: 'a' }, { templateId: 'b' }, { presetId: '', templateId: 'b' }, { presetId: 1, templateId: 'b' }]) {
      expect(parsePresetComparePayload(payload)).toBeUndefined()
    }
  })
})

describe('presets/compare endpoint', () => {
  it('returns the comparison plus both ids', async () => {
    const deps = compareDeps()
    const result = await handlePresetEndpoint(ctxWith({ list: async () => [rosterEntry] }), deps, PRESET_COMPARE_ENDPOINT, {
      presetId: 'tool-plus-standard',
      templateId: 'tool-plus-standard',
    })
    expect(result?.ok).toBe(true)
    expect(result?.ok === true && result.value).toMatchObject({
      presetId: 'tool-plus-standard',
      templateId: 'tool-plus-standard',
      status: 'ok',
      identical: false,
      items: [{ row: 'compaction', path: 'config.thresholdRatio' }],
    })
  })

  it('rejects a malformed payload without calling the comparison', async () => {
    const deps = compareDeps()
    const result = await handlePresetEndpoint(ctxWith({ list: async () => [rosterEntry] }), deps, PRESET_COMPARE_ENDPOINT, { presetId: 'x' })
    expect((deps as { comparePreset: { mock: { calls: unknown[] } } }).comparePreset.mock.calls).toHaveLength(0)
    expect(result?.ok === false && result.error.code).toBe('bad-request')
  })

  it('rejects an unknown preset or template with a clear message', async () => {
    const unknownPreset = await handlePresetEndpoint(ctxWith({ list: async () => [rosterEntry] }), compareDeps(), PRESET_COMPARE_ENDPOINT, {
      presetId: 'nope',
      templateId: 'tool-plus-standard',
    })
    expect(unknownPreset?.ok === false && unknownPreset.error.message).toMatch(/unknown preset/u)
    const unknownTemplate = await handlePresetEndpoint(ctxWith({ list: async () => [rosterEntry] }), compareDeps(), PRESET_COMPARE_ENDPOINT, {
      presetId: 'tool-plus-standard',
      templateId: 'nope',
    })
    expect(unknownTemplate?.ok === false && unknownTemplate.error.message).toMatch(/unknown template/u)
  })
})
