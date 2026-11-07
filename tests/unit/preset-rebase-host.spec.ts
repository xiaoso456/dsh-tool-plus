/**
 * 「跟随官方」宿主适配层单测：假 configEditor 下，rebase 取当前官方那一份的 inherited 层、派生后整份写入我们那一行。
 *
 * 钉住：
 * - 官方变了（新增行）→ 写入的正是派生结果，官方新增行原样保留；
 * - 已等于派生结果 → 一次 edit 都不调用（它每次都会重写文件）；
 * - 官方结构变了 / 官方那份读不到 → 报失败并带原因，不写盘；
 * - 对 ptc 同样跟随 ptc 那一份官方声明。
 */
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { applyPresetAction, listPresetStatuses, type ConfigEditorLike, type PresetHostCtx } from '../../src/host/preset-host.ts'
import { rebasePlugins } from '../../src/presets/rebase.ts'
import type { PresetRow } from '../../src/presets/rows.ts'

const row = (id: string, extra: Record<string, unknown> = {}): PresetRow => ({ id, name: '@deepseek-ai/dsh-' + id, ...extra })

/** 官方这一版：含宿主面三行、pwsh，以及一行官方新增的 tool-future。 */
const OFFICIAL_NEW: PresetRow[] = [
  row('persona'), row('tool-bash'), row('tool-pwsh'), row('tool-fs'), row('tool-fs-search'), row('tool-future'),
]
/** 我们之前写下的旧派生结果（官方还没有 tool-future）。 */
const STALE: PresetRow[] = [row('persona'), row('tool-plus', { disabled: true })]

interface FakeRow { id: string; config: Record<string, unknown>; inherited: Record<string, unknown>; override: Record<string, unknown> }

function fakeEditor(rows: readonly FakeRow[]): { editor: ConfigEditorLike; writes: Array<Record<string, unknown>>; edit: ReturnType<typeof vi.fn> } {
  const entries = rows.map(r => ({ options: { id: r.id, name: '@deepseek-ai/dsh-agent-preset', config: r.config } }))
  const writes: Array<Record<string, unknown>> = []
  const edit = vi.fn(async (entry: { options: { id: string; config?: unknown } }, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>) => {
    const source = rows.find(r => r.id === entry.options.id)
    writes.push(change(entry.options.config as Record<string, unknown>, source?.inherited ?? {}))
  })
  return {
    editor: {
      documentPath: join(tmpdir(), 'tool-plus-nonexistent', 'cordis.patch.yml'),
      entries: () => entries,
      configuration: () => rows.map((r, index) => ({ entry: entries[index]!, inherited: r.inherited, override: r.override })),
      edit: edit as unknown as ConfigEditorLike['edit'],
    },
    writes,
    edit,
  }
}

function ctxOf(editor: ConfigEditorLike | undefined): PresetHostCtx {
  return { get: (name: string) => (name === 'configEditor' ? editor : undefined) }
}

/** 我们的 standard 行（当前有覆盖 = 旧派生结果）与官方 standard 行。 */
function standardRows(official: PresetRow[] | undefined, ours: PresetRow[]): FakeRow[] {
  const rows: FakeRow[] = [{
    id: 'preset-tool-plus-standard',
    config: { id: 'tool-plus-standard', name: '标准增强版', order: 20, plugins: ours },
    inherited: { id: 'tool-plus-standard', name: '标准增强版', order: 20, plugins: STALE },
    override: { plugins: ours },
  }]
  if (official !== undefined) {
    rows.push({
      id: 'preset-standard',
      config: { id: 'standard', name: '官方标准', order: 1, plugins: official },
      inherited: { id: 'standard', name: '官方标准', order: 1, plugins: official },
      override: {},
    })
  }
  return rows
}

describe('applyPresetAction(rebase)', () => {
  it('writes the derived plugins from the current official preset over our row', async () => {
    const { editor, writes, edit } = fakeEditor(standardRows(OFFICIAL_NEW, STALE))
    const result = await applyPresetAction(ctxOf(editor), 'tool-plus-standard', 'rebase')
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(true)
    expect(edit).toHaveBeenCalledTimes(1)
    const derived = rebasePlugins(OFFICIAL_NEW)
    expect(derived.ok).toBe(true)
    expect(writes[0]?.plugins).toEqual(derived.ok ? derived.plugins : [])
    // 官方新增的行必须出现在派生结果里——这正是"跟随官方"而不是"再手抄一份"。
    expect((writes[0]?.plugins as PresetRow[]).some(item => item.id === 'tool-future')).toBe(true)
    // 我们这一行的身份元数据不被动。
    expect(writes[0]?.id).toBe('tool-plus-standard')
  })

  it('does not write when our row already equals the derived result', async () => {
    const derived = rebasePlugins(OFFICIAL_NEW)
    const plugins = derived.ok ? derived.plugins : []
    const { editor, edit } = fakeEditor(standardRows(OFFICIAL_NEW, plugins))
    const result = await applyPresetAction(ctxOf(editor), 'tool-plus-standard', 'rebase')
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(false)
    expect(edit).not.toHaveBeenCalled()
  })

  it('reports a failure with the reason when the official list lost a host-plane row', async () => {
    const drifted = OFFICIAL_NEW.filter(item => item.id !== 'tool-fs')
    const { editor, edit } = fakeEditor(standardRows(drifted, STALE))
    const result = await applyPresetAction(ctxOf(editor), 'tool-plus-standard', 'rebase')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('tool-fs')
    expect(edit).not.toHaveBeenCalled()
  })

  it('reports a failure when the official preset is not declared in this environment', async () => {
    const { editor, edit } = fakeEditor(standardRows(undefined, STALE))
    const result = await applyPresetAction(ctxOf(editor), 'tool-plus-standard', 'rebase')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('official preset standard is not declared')
    expect(edit).not.toHaveBeenCalled()
  })

  it('follows the ptc official declaration for the ptc preset', async () => {
    const ptcOfficial: PresetRow[] = [row('persona'), row('tool-bash'), row('tool-pwsh'), row('tool-fs'), row('tool-fs-search'), row('tool-presentation')]
    const rows: FakeRow[] = [
      {
        id: 'preset-tool-plus-ptc',
        config: { id: 'tool-plus-ptc', name: 'PTC', order: 21, plugins: STALE },
        inherited: { id: 'tool-plus-ptc', name: 'PTC', order: 21, plugins: STALE },
        override: { plugins: STALE },
      },
      {
        id: 'preset-ptc',
        config: { id: 'ptc', name: '官方 PTC', order: 2, plugins: ptcOfficial },
        inherited: { id: 'ptc', name: '官方 PTC', order: 2, plugins: ptcOfficial },
        override: {},
      },
    ]
    const { editor, writes } = fakeEditor(rows)
    const result = await applyPresetAction(ctxOf(editor), 'tool-plus-ptc', 'rebase')
    expect(result.ok).toBe(true)
    const derived = rebasePlugins(ptcOfficial)
    expect(writes[0]?.plugins).toEqual(derived.ok ? derived.plugins : [])
  })
})

describe('listPresetStatuses 的推荐依据 followOfficial', () => {
  const statusOf = async (rows: FakeRow[], id: string): Promise<boolean | undefined> => {
    const { editor } = fakeEditor(rows)
    const list = await listPresetStatuses(ctxOf(editor))
    return list.presets.find(item => item.id === id)?.followOfficial
  }

  it('is true when following the official preset would change our row', async () => {
    expect(await statusOf(standardRows(OFFICIAL_NEW, STALE), 'tool-plus-standard')).toBe(true)
  })

  it('is false when our row already equals the derived result', async () => {
    const derived = rebasePlugins(OFFICIAL_NEW)
    expect(await statusOf(standardRows(OFFICIAL_NEW, derived.ok ? derived.plugins : []), 'tool-plus-standard')).toBe(false)
  })

  it('is false when the official preset cannot be read', async () => {
    expect(await statusOf(standardRows(undefined, STALE), 'tool-plus-standard')).toBe(false)
  })
})
