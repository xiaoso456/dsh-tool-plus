/**
 * preset 差异清单（src/presets/delta.ts）单测。
 *
 * 起因：面板只拿得到 `templateDiffers: boolean`，于是「与自带模板不同」和
 * 「无需调整」并列时读起来自相矛盾 —— 前者说的是**我改过内容**，后者说的是
 * **4 个工具冲突行都已禁用**。这份纯函数把"哪里不同"说清楚，面板才有话可说。
 *
 * 契约：只比顶层行自己的键值；冲突行的 `disabled` 归 conflicts 管，不在差异里
 * 重复；形状不可识别 → 空；顺序＝用户这份的行序在前，模板独有的行补在后。
 */
import { describe, expect, it } from 'vitest'
import { presetDelta } from '../../src/presets/delta.ts'

const TEMPLATE = `- id: persona
  name: '@deepseek-ai/dsh-persona'

- id: compaction
  name: '@deepseek-ai/dsh-compaction'
  thresholdRatio: 0.8

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: true

- id: only-in-template
  name: '@deepseek-ai/dsh-extra'
`

/** 用户那份：compaction 调过参、bash 那行是官方原样（!!js）、多了一行自己加的。 */
const USER = `- id: persona
  name: '@deepseek-ai/dsh-persona'

- id: compaction
  name: '@deepseek-ai/dsh-compaction'
  thresholdRatio: 0.4

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'

- id: mine
  name: '@xiaoso/dsh-mine'
`

describe('presetDelta', () => {
  it('逐键报出改动与单边键，并按用户行序在前', () => {
    const { items, total } = presetDelta(USER, TEMPLATE)
    expect(total).toBe(items.length)
    expect(items).toEqual([
      { kind: 'changed', row: 'compaction', path: 'thresholdRatio', yours: '0.4', template: '0.8' },
      { kind: 'row-only-yours', row: 'mine', path: '' },
      { kind: 'row-only-template', row: 'only-in-template', path: '' },
    ])
  })

  it('冲突行的 disabled 不重复报（那是 conflicts 的职责）', () => {
    const { items } = presetDelta(USER, TEMPLATE)
    expect(items.some(item => item.row === 'tool-bash')).toBe(false)
    // 显式传入冲突清单时才跳过；不传时 disabled 也算差异（那是调用方的选择）。
    const all = presetDelta(USER, TEMPLATE, { conflictIds: ['tool-bash'] })
    expect(all.items.some(item => item.row === 'tool-bash')).toBe(false)
  })

  it('单边键分别标 only-yours / only-template', () => {
    const yours = `- id: a\n  name: x\n  extra: 1\n`
    const theirs = `- id: a\n  name: x\n  gone: 2\n`
    expect(presetDelta(yours, theirs).items).toEqual([
      { kind: 'only-yours', row: 'a', path: 'extra', yours: '1' },
      { kind: 'only-template', row: 'a', path: 'gone', template: '2' },
    ])
  })

  it('limit 截断 items 但 total 仍是全量（面板据此说"等 N 项"）', () => {
    const many = `- id: a\n${Array.from({ length: 12 }, (_, i) => `  k${i}: ${i}`).join('\n')}\n`
    const { items, total } = presetDelta(many, '- id: a\n', { limit: 5 })
    expect(items).toHaveLength(5)
    expect(total).toBe(12)
  })

  it('完全一致 → 空；形状不可识别 → 空（不猜）', () => {
    expect(presetDelta(TEMPLATE, TEMPLATE)).toEqual({ items: [], total: 0, yoursCount: 0, behindCount: 0 })
    expect(presetDelta('不是行列表\n随便什么\n', TEMPLATE)).toEqual({ items: [], total: 0, yoursCount: 0, behindCount: 0 })
    expect(presetDelta(USER, '')).toEqual({ items: [], total: 0, yoursCount: 0, behindCount: 0 })
  })

  it('忽略注释与引号（值相同就不报），但嵌套叶子改了必须报出来', () => {
    const noisy = `- id: a  # 行尾注释\n  # 整行注释\n  name: 'x'\n  config:\n    deep: 1\n`
    const clean = `- id: a\n  name: x\n  config:\n    deep: 1\n`
    expect(presetDelta(noisy, clean)).toEqual({ items: [], total: 0, yoursCount: 0, behindCount: 0 })
    // 只比顶层键会漏掉这种差异（真机上的 thresholdRatio 就藏在这一层）。
    expect(presetDelta(noisy, clean.replace('deep: 1', 'deep: 2'))).toEqual({
      items: [{ kind: 'changed', row: 'a', path: 'config.deep', yours: '1', template: '2' }],
      total: 1,
      yoursCount: 1,
      behindCount: 0,
    })
  })

  it('分组计数按全量算（items 被截断也不会把分组的数量说错）', () => {
    const mine = `- id: a\n  x: 1\n  y: 2\n  z: 3\n  w: 4\n`
    const theirs = `- id: a\n  t: 9\n`
    const { items, total, yoursCount, behindCount } = presetDelta(mine, theirs, { limit: 2 })
    expect(items).toHaveLength(2)
    expect(total).toBe(5)
    expect(yoursCount).toBe(4)
    expect(behindCount).toBe(1)
  })

  it('列表项按 [i] 编号，能定位到第几项', () => {
    const mine = `- id: a\n  tools:\n    - id: t1\n      disabled: true\n    - id: t2\n`
    const theirs = `- id: a\n  tools:\n    - id: t1\n      disabled: false\n    - id: t2\n`
    expect(presetDelta(mine, theirs).items).toEqual([
      { kind: 'changed', row: 'a', path: 'tools[0].disabled', yours: 'true', template: 'false' },
    ])
  })
})
