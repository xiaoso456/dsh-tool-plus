/**
 * preset 差异清单（src/presets/delta.ts）单测。
 *
 * 起因：面板只拿得到"与随包声明不同"这一个布尔值，于是它与"冲突行都已关掉、
 * 无需调整"并列时读起来自相矛盾 —— 前者说的是**内容被改过**，后者说的是
 * **那 4 个官方工具行**。这份纯函数把"哪里不同"逐条说清楚。
 *
 * 与旧文本版的唯一区别是**输入**：以前喂两段 YAML 文本，现在喂两侧解析好的
 * `config.plugins`。语义一字未改：比到叶子、冲突行的 `disabled` 归 conflicts 管、
 * 顺序＝你这份的行序在前、`total` 全量而 `items` 可截断。
 */
import { describe, expect, it } from 'vitest'
import { presetDelta } from '../../src/presets/delta.ts'
import type { PresetRow } from '../../src/presets/rows.ts'

const row = (id: string, extra: Record<string, unknown> = {}): PresetRow => ({ id, name: `@deepseek-ai/dsh-${id}`, ...extra })

const TEMPLATE: PresetRow[] = [
  row('persona'),
  row('compaction', { thresholdRatio: 0.8 }),
  row('tool-bash', { disabled: true }),
  row('only-in-template'),
]

const MINE: PresetRow[] = [
  row('persona'),
  row('compaction', { thresholdRatio: 0.4 }),
  row('tool-bash', { disabled: { __jsExpr: "process.platform === 'win32'" } }),
  { id: 'mine', name: '@xiaoso/dsh-mine' },
]

describe('presetDelta', () => {
  it('reports per-leaf changes and one-sided rows, yours first', () => {
    const { items, total } = presetDelta(MINE, TEMPLATE)
    expect(total).toBe(items.length)
    expect(items).toEqual([
      { kind: 'changed', row: 'compaction', path: 'thresholdRatio', yours: '0.4', template: '0.8' },
      { kind: 'row-only-yours', row: 'mine', path: '' },
      { kind: 'row-only-template', row: 'only-in-template', path: '' },
    ])
  })

  it('leaves a conflict row disabled switch to the conflicts analysis', () => {
    const { items } = presetDelta(MINE, TEMPLATE)
    expect(items.some(item => item.row === 'tool-bash')).toBe(false)
  })

  it('separates one-sided leaves from changed ones', () => {
    const mine = [row('a', { extra: 1 })]
    const theirs = [row('a', { gone: 2 })]
    expect(presetDelta(mine, theirs).items).toEqual([
      { kind: 'only-yours', row: 'a', path: 'extra', yours: '1' },
      { kind: 'only-template', row: 'a', path: 'gone', template: '2' },
    ])
  })

  it('caps items but keeps total and the group counts on the full population', () => {
    const many = [row('a', Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, i])))]
    const { items, total } = presetDelta(many, [row('a')], { limit: 5 })
    expect(items).toHaveLength(5)
    expect(total).toBe(12)

    const mine = [row('a', { x: 1, y: 2, z: 3, w: 4 })]
    const grouped = presetDelta(mine, [row('a', { t: 9 })], { limit: 2 })
    expect(grouped.items).toHaveLength(2)
    expect(grouped).toMatchObject({ total: 5, yoursCount: 4, behindCount: 1 })
  })

  it('reports nested leaves, list indexes and group children by path', () => {
    const mine = [
      row('a', { config: { deep: 1 }, tools: [{ id: 't1', disabled: true }, { id: 't2' }] }),
      { id: 'delegation', name: 'cordis:group', group: true, config: [row('tool-ralph')] },
    ]
    const theirs = [
      row('a', { config: { deep: 2 }, tools: [{ id: 't1', disabled: false }, { id: 't2' }] }),
      { id: 'delegation', name: 'cordis:group', group: true, config: [row('tool-ralph', { disabled: true })] },
    ]
    const paths = presetDelta(mine, theirs).items.map(item => `${item.row}|${item.path}`)
    expect(paths).toContain('a|config.deep')
    expect(paths).toContain('a|tools[0].disabled')
    expect(paths).toContain('delegation/tool-ralph|disabled')
  })

  it('does not confuse a string "false" with boolean false', () => {
    const { items } = presetDelta([row('a', { disabled: 'false' })], [row('a', { disabled: false })])
    expect(items).toEqual([
      { kind: 'changed', row: 'a', path: 'disabled', yours: '"false"', template: 'false' },
    ])
  })

  it('is empty for identical content and for an unreadable side (never guesses)', () => {
    const empty = { items: [], total: 0, yoursCount: 0, behindCount: 0 }
    expect(presetDelta(TEMPLATE, structuredClone(TEMPLATE))).toEqual(empty)
    expect(presetDelta('not a row list', TEMPLATE)).toEqual(empty)
    expect(presetDelta(MINE, {})).toEqual(empty)
  })
})
