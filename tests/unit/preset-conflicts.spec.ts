/**
 * 冲突不变式（src/presets/conflicts.ts）单测。
 *
 * 被钉住的契约：
 * - 只认**顶层**行；group 里嵌套的同名行不碰（那是那个 group 的私有组成）；
 * - 行**不存在** = 这份 preset 本来就不挂它，不是冲突；
 * - 只有布尔 `true` 算已关闭 —— 缺席、`false`、字符串、`!!js` 表达式全算冲突
 *   （`!!js` 挂载时才求值，我们要的是无条件关闭）；
 * - 输出恒为新数组，输入不变；无改动时 `changes` 为空（调用方据此不写盘）。
 */
import { describe, expect, it } from 'vitest'
import {
  PRESET_CONFLICT_IDS,
  analyzePlugins,
  disableConflicts,
  type PresetChange,
} from '../../src/presets/conflicts.ts'
import { flattenRows, isJsExpr, isRowList, rowLeaves, sameValue, type PresetRow } from '../../src/presets/rows.ts'

/** 一行工具行的最小写法。 */
const row = (id: string, extra: Record<string, unknown> = {}): PresetRow => ({ id, name: `@deepseek-ai/dsh-${id}`, ...extra })

describe('analyzePlugins', () => {
  it('treats an absent row as "not mounted here", not as a conflict', () => {
    expect(analyzePlugins([row('persona')])).toEqual({ conflicts: [], clean: true, shape: 'ok' })
  })

  it('accepts only a boolean true as disabled', () => {
    const cases: Array<[unknown, boolean]> = [
      [undefined, false],
      [false, false],
      ['true', false],
      [{ __jsExpr: "process.platform !== 'win32'" }, false],
      [true, true],
    ]
    for (const [disabled, clean] of cases) {
      const plugins = disabled === undefined ? [row('tool-pwsh')] : [row('tool-pwsh', { disabled })]
      const analysis = analyzePlugins(plugins)
      expect(analysis.conflicts, `disabled=${JSON.stringify(disabled)}`).toEqual(clean ? [] : ['tool-pwsh'])
      expect(analysis.clean).toBe(clean)
    }
  })

  it('ignores a same-id row nested inside a group', () => {
    const plugins = [
      { id: 'delegation', name: 'cordis:group', group: true, config: [row('tool-fs')] },
    ]
    expect(analyzePlugins(plugins).conflicts).toEqual([])
  })

  it('reports conflicts in the documented order and refuses unrecognized shapes', () => {
    const plugins = [row('tool-fs-search'), row('tool-bash'), row('tool-fs')]
    expect(analyzePlugins(plugins).conflicts).toEqual(['tool-bash', 'tool-fs', 'tool-fs-search'])
    expect(analyzePlugins('not a list').shape).toBe('unrecognized')
    expect(analyzePlugins([{ id: 'no-name' }]).shape).toBe('unrecognized')
  })
})

describe('disableConflicts', () => {
  it('appends a switch when the row has none, flips an existing one, and never mutates the input', () => {
    const plugins = [row('tool-bash'), row('tool-fs', { disabled: false }), row('persona')]
    const before = structuredClone(plugins)
    const { plugins: next, changes } = disableConflicts(plugins)
    expect(changes).toEqual<PresetChange[]>([
      { id: 'tool-bash', action: 'disabled' },
      { id: 'tool-fs', action: 'flipped' },
    ])
    expect(next[0]?.disabled).toBe(true)
    expect(next[1]?.disabled).toBe(true)
    // persona 那行按引用原样透传（不该为无关行造新对象）。
    expect(next[2]).toBe(plugins[2])
    expect(plugins).toEqual(before)
  })

  it('is idempotent: a second pass reports nothing and returns the same rows', () => {
    const first = disableConflicts([row('tool-bash'), row('tool-fs')]).plugins
    const second = disableConflicts(first)
    expect(second.changes).toEqual([])
    expect(second.plugins).toBe(first)
  })

  it('reports in conflict-id order regardless of row order', () => {
    const { changes } = disableConflicts([row('tool-fs-search'), row('tool-bash')])
    expect(changes.map(change => change.id)).toEqual(['tool-bash', 'tool-fs-search'])
  })

  it('covers exactly the four shipped tool rows', () => {
    expect(PRESET_CONFLICT_IDS).toEqual(['tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search'])
  })
})

describe('rows', () => {
  it('rejects anything that is not a top-level list of named rows', () => {
    expect(isRowList([])).toBe(true)
    expect(isRowList([{ id: 'a', name: 'x' }])).toBe(true)
    expect(isRowList([{ name: '' }])).toBe(false)
    expect(isRowList({})).toBe(false)
    expect(isRowList([null])).toBe(false)
  })

  it('flattens groups under a path and leaves group children out of the group row own leaves', () => {
    const plugins: PresetRow[] = [
      row('persona'),
      { id: 'delegation', name: 'cordis:group', group: true, isolate: { workflowEngine: true }, config: [row('tool-ralph', { disabled: true })] },
    ]
    expect([...flattenRows(plugins).keys()]).toEqual(['persona', 'delegation', 'delegation/tool-ralph'])
    const leaves = rowLeaves(plugins[1] as PresetRow).map(leaf => leaf.path)
    // 子行单独寻址，所以 group 自己的叶子不含 config.*。
    expect(leaves).toContain('isolate.workflowEngine')
    expect(leaves.some(path => path.startsWith('config'))).toBe(false)
  })

  it('canonicalizes values so a string "false" never compares equal to boolean false', () => {
    expect(rowLeaves(row('a', { disabled: false }))).toEqual([{ path: 'name', value: '"@deepseek-ai/dsh-a"' }, { path: 'disabled', value: 'false' }])
    expect(sameValue(false, 'false')).toBe(false)
    expect(sameValue({ a: [1, 2] }, { a: [1, 2] })).toBe(true)
  })

  it('treats a !!js marker as a scalar, not as a structure to descend into', () => {
    // 漏了这一步会造出 `disabled.__jsExpr` 这种假叶子，并让"冲突行的 disabled 归
    // conflicts 管"的跳过规则失效（真机上官方 preset 就带着这种表达式）。
    expect(rowLeaves(row('tool-bash', { disabled: { __jsExpr: "process.platform === 'win32'" } }))).toEqual([
      { path: 'name', value: '"@deepseek-ai/dsh-tool-bash"' },
      { path: 'disabled', value: "!!js process.platform === 'win32'" },
    ])
    expect(isJsExpr({ __jsExpr: 'x' })).toBe(true)
    expect(isJsExpr({ __jsExpr: 'x', other: 1 })).toBe(false)
  })
})
