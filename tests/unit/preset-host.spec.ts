/**
 * 宿主适配层（src/host/preset-host.ts）单测：假 `configEditor` + 假 `agentPresets`。
 *
 * 这一层是本次改造的"接线正确性"证据：我们**不再自己写文件**，而是把动作委托给
 * 宿主的 `ctx.configEditor.edit()`。所以测试要钉住的是：
 * - 事实收集（我们的两份永远在列表里、roster 的 name/broken/isDefault 要合进来）；
 * - 三个动作分别交给 `edit()` 什么回调（upgrade 禁用冲突行、align 换整份 plugins、
 *   revert 把 inherited 原样交回去让宿主删覆盖）；
 * - no-op 时**一次都不调用** `edit()`（它每次调用都会重写文件）；
 * - 缺服务 / 行不可寻址时给出可读的失败原因，而不是抛。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  applyPresetAction,
  comparePresetAgainstTemplate,
  listPresetStatuses,
  type ConfigEditorLike,
  type PresetHostCtx,
} from '../../src/host/preset-host.ts'
import type { PresetRow } from '../../src/presets/rows.ts'

const row = (id: string, extra: Record<string, unknown> = {}): PresetRow => ({ id, name: `@deepseek-ai/dsh-${id}`, ...extra })

const CLEAN: PresetRow[] = [row('persona'), row('tool-pwsh', { disabled: true })]
const DIRTY: PresetRow[] = [row('persona'), row('tool-fs')]
const TEMPLATE_PTC: PresetRow[] = [row('persona'), row('tool-presentation')]

/** 一个可寻址的 preset 行（模拟宿主的 configuration() 三元组）。 */
interface FakeRow {
  id: string
  config: Record<string, unknown>
  inherited: Record<string, unknown>
  override: Record<string, unknown>
}

/** 假 configEditor：记录每次 edit 的回调返回值，不落盘。 */
function fakeEditor(
  rows: readonly FakeRow[],
  documentPath = join(tmpdir(), 'tool-plus-nonexistent', 'cordis.patch.yml'),
): { editor: ConfigEditorLike; writes: Array<Record<string, unknown>>; edit: ReturnType<typeof vi.fn> } {
  const entries = rows.map(r => ({ options: { id: r.id, name: '@deepseek-ai/dsh-agent-preset', config: r.config } }))
  const writes: Array<Record<string, unknown>> = []
  const edit = vi.fn(async (entry: { options: { id: string; config?: unknown } }, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>) => {
    const source = rows.find(r => r.id === entry.options.id)
    writes.push(change(entry.options.config as Record<string, unknown>, source?.inherited ?? {}))
  })
  return {
    editor: {
      documentPath,
      entries: () => entries,
      configuration: () => rows.map((r, index) => ({ entry: entries[index]!, inherited: r.inherited, override: r.override })),
      edit: edit as unknown as ConfigEditorLike['edit'],
    },
    writes,
    edit,
  }
}

/** 假 ctx：只回答 configEditor / agentPresets。 */
function fakeCtx(editor: ConfigEditorLike | undefined, roster?: readonly Record<string, unknown>[]): PresetHostCtx {
  return {
    get: (name: string) => {
      if (name === 'configEditor') return editor
      if (name === 'agentPresets') return roster === undefined ? undefined : { list: async () => roster }
      return undefined
    },
  }
}

const standard = (over: Partial<FakeRow> = {}): FakeRow => ({
  id: 'preset-tool-plus-standard',
  config: { id: 'tool-plus-standard', name: '标准增强版', order: 20, plugins: CLEAN },
  inherited: { id: 'tool-plus-standard', name: '标准增强版', order: 20, plugins: CLEAN },
  override: {},
  ...over,
})

const ptc = (over: Partial<FakeRow> = {}): FakeRow => ({
  id: 'preset-tool-plus-ptc',
  config: { id: 'tool-plus-ptc', name: 'PTC 增强版', order: 21, plugins: TEMPLATE_PTC },
  inherited: { id: 'tool-plus-ptc', name: 'PTC 增强版', order: 21, plugins: TEMPLATE_PTC },
  override: {},
  ...over,
})

describe('listPresetStatuses', () => {
  it('always lists our two ids first, even when nothing knows them', async () => {
    const list = await listPresetStatuses(fakeCtx(undefined))
    expect(list.presets.map(preset => preset.id)).toEqual(['tool-plus-standard', 'tool-plus-ptc'])
    expect(list.presets.every(preset => preset.source === 'ours')).toBe(true)
    expect(list.presets[0]?.entryId).toBeUndefined()
    expect(list.presets[0]?.unrecognized).toBe(true)
    expect(list.writable).toBe(false)
  })

  it('merges registry identity and diagnostics onto the same ids', async () => {
    const { editor } = fakeEditor([standard()])
    const list = await listPresetStatuses(fakeCtx(editor, [
      { id: 'tool-plus-standard', isDefault: true, broken: 'row "x" names a plugin that cannot be resolved' },
      { id: 'standard', name: 'standard' },
    ]))
    expect(list.writable).toBe(true)
    const ours = list.presets[0]
    expect(ours?.isDefault).toBe(true)
    expect(ours?.broken).toContain('cannot be resolved')
    // 别人的 declaration 按 roster 顺序排在后面，且只读。
    expect(list.presets.map(preset => preset.id)).toEqual(['tool-plus-standard', 'tool-plus-ptc', 'standard'])
    expect(list.presets[2]?.source).toBe('other')
  })

  it('survives a registry that throws', async () => {
    const { editor } = fakeEditor([standard()])
    const ctx: PresetHostCtx = {
      get: (name: string) => (name === 'configEditor' ? editor : { list: async () => { throw new Error('offline') } }),
    }
    const list = await listPresetStatuses(ctx)
    expect(list.presets.map(preset => preset.id)).toEqual(['tool-plus-standard', 'tool-plus-ptc'])
    expect(list.presets[0]?.clean).toBe(true)
  })

  it('prefers the exported roster, because only it marks the default', async () => {
    // `list()` has no `isDefault`; the official client reads `remoteExportList()`.
    const { editor } = fakeEditor([standard()])
    const ctx: PresetHostCtx = {
      get: (name: string) => (name === 'configEditor'
        ? editor
        : {
            list: async () => { throw new Error('list() must not be the preferred path') },
            remoteExportList: async () => ({ presets: [{ id: 'tool-plus-standard', isDefault: true }] }),
          }),
    }
    const list = await listPresetStatuses(ctx)
    expect(list.presets[0]?.isDefault).toBe(true)
    expect(list.presets[1]?.id).toBe('tool-plus-ptc')
  })
})

describe('applyPresetAction', () => {
  it('refuses an unknown preset without touching the editor', async () => {
    const { editor, edit } = fakeEditor([standard()])
    const result = await applyPresetAction(fakeCtx(editor), 'nope', 'upgrade')
    expect(result).toEqual({ ok: false, changed: false, reason: 'unknown preset: nope', changes: [] })
    expect(edit).not.toHaveBeenCalled()
  })

  it('writes nothing when an upgrade has nothing to do', async () => {
    const { editor, edit } = fakeEditor([standard()])
    const result = await applyPresetAction(fakeCtx(editor), 'tool-plus-standard', 'upgrade')
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(false)
    expect(edit).not.toHaveBeenCalled()
  })

  it('disables the conflicting rows through the editor and reports them', async () => {
    const dirty = { id: 'tool-plus-standard', name: '标准增强版', order: 20, plugins: DIRTY }
    const { editor, writes } = fakeEditor([standard({ config: dirty, inherited: dirty, override: dirty })])
    const result = await applyPresetAction(fakeCtx(editor), 'tool-plus-standard', 'upgrade')
    expect(result.changed).toBe(true)
    expect(result.changes).toEqual([{ id: 'tool-fs', action: 'disabled' }])
    // 写进去的是完整 config + 已禁用的行（不许只写 plugins）。
    expect(writes[0]).toMatchObject({ id: 'tool-plus-standard', order: 20 })
    const written = (writes[0]?.plugins ?? []) as PresetRow[]
    expect(written.find(item => item.id === 'tool-fs')?.disabled).toBe(true)
  })

  it('aligns by handing the template plugin list to the editor', async () => {
    const { editor, writes } = fakeEditor([standard(), ptc()])
    const result = await applyPresetAction(fakeCtx(editor), 'tool-plus-standard', 'align', 'tool-plus-ptc')
    expect(result).toEqual({ ok: true, changed: true, changes: [] })
    expect(writes[0]?.plugins).toEqual(TEMPLATE_PTC)
    // 元数据必须一起重述：profile 覆盖替换的是整份 config。
    expect(writes[0]?.id).toBe('tool-plus-standard')
    expect(writes[0]?.name).toBe('标准增强版')
  })

  it('reverts by handing the inherited config straight back', async () => {
    const dirty = { id: 'tool-plus-standard', name: '标准增强版', order: 20, plugins: DIRTY }
    const { editor, writes } = fakeEditor([standard({ config: dirty, override: dirty })])
    const result = await applyPresetAction(fakeCtx(editor), 'tool-plus-standard', 'revert')
    expect(result.changed).toBe(true)
    // 交回去的正是 inherited（宿主据此删掉覆盖里的 config 键）。
    expect(writes[0]?.plugins).toEqual(CLEAN)
  })

  it('copies the profile patch aside before writing, once and never overwriting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-preset-'))
    try {
      const documentPath = join(dir, 'cordis.patch.yml')
      writeFileSync(documentPath, '[]\n')
      const dirty = { id: 'tool-plus-standard', name: '标准增强版', order: 20, plugins: DIRTY }
      const { editor } = fakeEditor([standard({ config: dirty, override: dirty })], documentPath)
      const first = await applyPresetAction(fakeCtx(editor), 'tool-plus-standard', 'upgrade')
      expect(first.changed).toBe(true)
      expect(first.backupPath?.startsWith(`${documentPath}.bak-`)).toBe(true)
      expect(readFileSync(first.backupPath as string, 'utf8')).toBe('[]\n')

      // 第二次动作面对的是已经变过的文件，但同名备份不再被覆盖 ——
      // 它永远留着最早那份"改动前"。
      writeFileSync(documentPath, '- id: x\n')
      const second = await applyPresetAction(fakeCtx(editor), 'tool-plus-standard', 'upgrade')
      expect(second.backupPath).toBe(first.backupPath)
      expect(readFileSync(first.backupPath as string, 'utf8')).toBe('[]\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('cannot write at all without an editable profile, because no fact carries content', async () => {
    const list = await listPresetStatuses(fakeCtx(undefined))
    expect(list.writable).toBe(false)
    for (const action of ['upgrade', 'align', 'revert'] as const) {
      const result = await applyPresetAction(fakeCtx(undefined), 'tool-plus-standard', action, 'tool-plus-ptc')
      expect(result).toMatchObject({ ok: true, changed: false })
    }
  })

  it('explains an unaddressable row instead of failing silently', async () => {
    const { editor } = fakeEditor([standard({ override: { id: 'tool-plus-standard', plugins: DIRTY } })])
    const list = await listPresetStatuses(fakeCtx(editor))
    // 我们随包的 ptc 在这个 profile 里没有行 → 写不了，原因要说清楚。
    expect(list.presets[1]?.entryId).toBeUndefined()
  })

  it('never throws: an editor failure comes back as a reason', async () => {
    const rows = [standard({ override: { id: 'tool-plus-standard', plugins: DIRTY } })]
    const { editor } = fakeEditor(rows)
    const failing: ConfigEditorLike = {
      ...editor,
      edit: async () => { throw new Error('Configuration for "preset-tool-plus-standard" is overridden by a home patch or command-line overlay') },
    }
    const result = await applyPresetAction(fakeCtx(failing), 'tool-plus-standard', 'revert')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('overridden by a home patch')
  })
})

describe('comparePresetAgainstTemplate', () => {
  it('compares any preset against one of our declarations', async () => {
    const { editor } = fakeEditor([standard(), ptc()])
    const value = await comparePresetAgainstTemplate(fakeCtx(editor), 'tool-plus-standard', 'tool-plus-ptc')
    expect(value.status).toBe('ok')
    expect(value.identical).toBe(false)
    expect(value.items.length).toBeGreaterThan(0)
  })

  it('reports unreadable rather than throwing when a side cannot be resolved', async () => {
    const { editor } = fakeEditor([standard()])
    expect((await comparePresetAgainstTemplate(fakeCtx(editor), 'nope', 'tool-plus-standard')).status).toBe('unreadable')
    expect((await comparePresetAgainstTemplate(fakeCtx(editor), 'tool-plus-standard', 'nope')).status).toBe('unreadable')
  })
})
