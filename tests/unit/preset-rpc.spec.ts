/**
 * 预设端点（src/host/preset-rpc.ts）单测：payload 校验 + 派发。
 *
 * 这一层是纯 wire adapter，所以测试只用假 deps：真正读配置、写 profile 的是
 * `src/host/preset-host.ts`（另有 `preset-host.spec.ts`），决策的是
 * `src/presets/plan.ts`。这里要钉住的是"半成品请求进不来"和"错误不炸到调用方"。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  handlePresetEndpoint,
  parsePresetActionPayload,
  parsePresetComparePayload,
  type PresetRpcDeps,
} from '../../src/host/preset-rpc.ts'
import type { PresetStatusListValue } from '../../src/tools/shared/browser-rpc-channel.ts'

const STATUS: PresetStatusListValue = {
  presets: [{
    id: 'tool-plus-standard',
    entryId: 'preset-tool-plus-standard',
    source: 'ours',
    isDefault: false,
    conflicts: [],
    clean: true,
    unrecognized: false,
    customized: false,
    templateDiffers: false,
    rowCount: 2,
  }],
  templates: [{ id: 'tool-plus-standard', name: '标准增强版' }],
  writable: true,
}

/** 假 deps：只有被点到的方法才有实现，便于断言"没被调用"。 */
function deps(over: Partial<PresetRpcDeps> = {}): PresetRpcDeps {
  return {
    listPresets: vi.fn(async () => STATUS),
    applyAction: vi.fn(async () => ({ ok: true, changed: true, changes: [] })),
    comparePreset: vi.fn(async (_ctx, presetId, templateId) => ({
      presetId,
      templateId,
      status: 'ok' as const,
      conflicts: [],
      identical: true,
      yoursCount: 0,
      behindCount: 0,
      items: [],
    })),
    ...over,
  }
}

const ctx = { get: () => undefined }

describe('parsePresetComparePayload', () => {
  it('accepts exactly two non-empty ids', () => {
    expect(parsePresetComparePayload({ presetId: 'a', templateId: 'b' })).toEqual({ presetId: 'a', templateId: 'b' })
    expect(parsePresetComparePayload({ presetId: '', templateId: 'b' })).toBeUndefined()
    expect(parsePresetComparePayload({ presetId: 'a' })).toBeUndefined()
    expect(parsePresetComparePayload(['a', 'b'])).toBeUndefined()
    expect(parsePresetComparePayload(null)).toBeUndefined()
  })
})

describe('parsePresetActionPayload', () => {
  it('accepts the three documented actions and rejects the retired one', () => {
    expect(parsePresetActionPayload({ id: 'a', action: 'upgrade' })).toEqual({ id: 'a', action: 'upgrade' })
    expect(parsePresetActionPayload({ id: 'a', action: 'align', templateId: 'b' })).toEqual({ id: 'a', action: 'align', templateId: 'b' })
    expect(parsePresetActionPayload({ id: 'a', action: 'revert' })).toEqual({ id: 'a', action: 'revert' })
    // 旧目录机制的动作名必须被拒绝，否则面板与宿主会各说各话。
    expect(parsePresetActionPayload({ id: 'a', action: 'reset' })).toBeUndefined()
  })

  it('rejects a half-formed request rather than repairing it', () => {
    expect(parsePresetActionPayload({ action: 'upgrade' })).toBeUndefined()
    expect(parsePresetActionPayload({ id: '', action: 'upgrade' })).toBeUndefined()
    expect(parsePresetActionPayload({ id: 'a', action: 'align', templateId: '' })).toBeUndefined()
    expect(parsePresetActionPayload({ id: 'a', action: 'upgrade', templateId: 7 })).toBeUndefined()
  })
})

describe('handlePresetEndpoint', () => {
  it('owns only its three endpoints', async () => {
    const fake = deps()
    expect(await handlePresetEndpoint(ctx, fake, 'browser/detect', {})).toBeUndefined()
    expect(await handlePresetEndpoint(ctx, fake, 'rmSafe/status', {})).toBeUndefined()
    expect(fake.listPresets).not.toHaveBeenCalled()
  })

  it('answers presets/status', async () => {
    const result = await handlePresetEndpoint(ctx, deps(), 'presets/status', {})
    expect(result).toEqual({ ok: true, value: STATUS })
  })

  it('rejects a malformed payload with bad-request and never reaches the host', async () => {
    const fake = deps()
    const compared = await handlePresetEndpoint(ctx, fake, 'presets/compare', { presetId: 'a' })
    expect(compared).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    const applied = await handlePresetEndpoint(ctx, fake, 'presets/apply', { id: 'a', action: 'reset' })
    expect(applied).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(fake.comparePreset).not.toHaveBeenCalled()
    expect(fake.applyAction).not.toHaveBeenCalled()
  })

  it('forwards a valid apply request with its template id', async () => {
    const fake = deps()
    const result = await handlePresetEndpoint(ctx, fake, 'presets/apply', { id: 'tool-plus-ptc', action: 'align', templateId: 'tool-plus-standard' })
    expect(result).toEqual({ ok: true, value: { ok: true, changed: true, changes: [] } })
    expect(fake.applyAction).toHaveBeenCalledWith(ctx, 'tool-plus-ptc', 'align', 'tool-plus-standard')
  })

  it('turns a host failure into an error result instead of throwing', async () => {
    const fake = deps({
      listPresets: async () => { throw new Error('ctx.configEditor is unavailable') },
      applyAction: async () => ({ ok: false, changed: false, reason: 'refused by a home patch', changes: [] }),
    })
    expect(await handlePresetEndpoint(ctx, fake, 'presets/status', {})).toMatchObject({
      ok: false,
      error: { code: 'internal', message: 'ctx.configEditor is unavailable' },
    })
    // 宿主自己的失败结果照原样返回（它是"没写成"，不是调用失败）。
    expect(await handlePresetEndpoint(ctx, fake, 'presets/apply', { id: 'a', action: 'revert' })).toEqual({
      ok: true,
      value: { ok: false, changed: false, reason: 'refused by a home patch', changes: [] },
    })
  })
})
