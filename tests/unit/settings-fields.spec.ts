/**
 * Single-source-of-truth tests for the tool-plus configuration surface: the
 * field table (`src/config/fields.ts`) must cover exactly the schema keys of
 * the settings namespace, its defaults must match what `Config.parse({})` and
 * `resolveConfig({})` produce, tool grouping must be complete and
 * non-overlapping, and the deleted `bash-plus` back-compat namespace must not
 * be re-exported.
 * @module tests
 */

import { describe, expect, it } from 'vitest'
import {
  TOOL_PLUS_FIELDS,
  TOOL_PLUS_FIELD_NAMES,
  TOOL_PLUS_TABS,
  TOOL_PLUS_GROUP_LABELS,
  toolPlusField,
  type ToolPlusField,
} from '../../src/config/fields.ts'
import {
  BASH_PLUS_SETTINGS_NS,
  Config,
  resolveConfig,
} from '../../src/config/settings.ts'
import * as settingsModule from '../../src/config/settings.ts'

/** Schema keys of the flat settings namespace (schemastery object dict). */
function schemaKeys(): string[] {
  const dict = (Config as unknown as { dict?: Record<string, unknown> }).dict
  if (!dict) throw new Error('Config schema exposes no .dict')
  return Object.keys(dict)
}

/**
 * Fields that carry a schema key: `action` fields (e.g. the 探测浏览器 button)
 * are UI-only — no settings value, no schema key, no default comparison.
 */
const CONFIG_FIELDS = TOOL_PLUS_FIELDS.filter(field => field.kind !== 'action')

describe('fields vs settings schema', () => {
  it('field table covers exactly the schema keys (no missing, no extra)', () => {
    const schema = schemaKeys()
    expect(schema.length).toBeGreaterThan(0)
    const tableKeys = CONFIG_FIELDS.map(field => field.name)
    expect([...tableKeys].sort()).toEqual([...schema].sort())
    // Action-only fields have no schema key by design.
    for (const field of TOOL_PLUS_FIELDS.filter(field => field.kind === 'action')) {
      expect(schema).not.toContain(field.name)
    }
  })

  it('every field has a group label and belongs to exactly one tool tab', () => {
    const tabs = TOOL_PLUS_TABS
    for (const field of TOOL_PLUS_FIELDS) {
      expect(TOOL_PLUS_GROUP_LABELS[field.group]).toBeTruthy()
      const owners = tabs.filter(tab => tab.fields.includes(field.name))
      expect(owners).toHaveLength(1)
      expect(owners[0]!.id).toBe(field.tool)
    }
  })

  it('tool tab fields are disjoint and complete', () => {
    const all = TOOL_PLUS_TABS.flatMap(tab => [...tab.fields])
    expect(new Set(all).size).toBe(all.length) // no duplicates
    expect([...all].sort()).toEqual([...TOOL_PLUS_FIELD_NAMES].sort())
  })

  it('schema defaults equal the field table defaults (resolveConfig on empty)', () => {
    const cfg = resolveConfig({})
    const truncate = cfg.outputTruncate
    const resolvedByField: Record<string, unknown> = {
      ...(cfg as unknown as Record<string, unknown>),
      minimizerEnabled: cfg.minimizer.enabled,
      outputTruncateStrategy: truncate.strategy,
      outputTruncateTriggerBytes: truncate.triggerBytes,
      outputTruncateTriggerLines: truncate.triggerLines,
      outputTruncateByteMode: truncate.bytes.mode,
      outputTruncateByteHeadBytes: truncate.bytes.headBytes,
      outputTruncateByteTailBytes: truncate.bytes.tailBytes,
      outputTruncateLineMode: truncate.lines.mode,
      outputTruncateLineHeadLines: truncate.lines.headLines,
      outputTruncateLineTailLines: truncate.lines.tailLines,
    }
    for (const field of CONFIG_FIELDS) {
      expect(resolvedByField[field.name], field.name).toBe(field.default)
    }
  })

  it('schema parse defaults equal the field table defaults', () => {
    const parsed = Config({}) as Record<string, unknown>
    for (const field of CONFIG_FIELDS) {
      expect(parsed[field.name], field.name).toBe(field.default)
    }
  })

  it('every boolean/number/select field kind maps to a schema-compatible default type', () => {
    for (const field of TOOL_PLUS_FIELDS) {
      if (field.kind === 'action') {
        // Action fields carry a placeholder default (''), never a schema value.
        expect(typeof field.default).toBe('string')
        expect(field.default).toBe('')
        continue
      }
      if (field.kind === 'boolean') expect(typeof field.default).toBe('boolean')
      else if (field.kind === 'select') expect(typeof field.default).toBe('string')
      else expect(typeof field.default).toBe('number')
    }
  })

  it('select options include the default value', () => {
    for (const field of TOOL_PLUS_FIELDS) {
      if (field.kind !== 'select') continue
      const values = field.options?.map(opt => opt.value) ?? []
      expect(values).toContain(field.default)
    }
  })

  it('visibility conditions reference existing fields with matching kinds', () => {
    for (const field of TOOL_PLUS_FIELDS) {
      const visibility = field.visibility
      if (!visibility) continue
      if (visibility.requiresEnabled !== undefined) {
        const target = toolPlusField(visibility.requiresEnabled)
        expect(target, `${field.name}.requiresEnabled → ${visibility.requiresEnabled}`).toBeDefined()
        expect(target!.kind, `${field.name} requires boolean ${visibility.requiresEnabled}`).toBe('boolean')
      }
      for (const cond of [visibility.requiresSelect, visibility.hideWhenSelect]) {
        if (!cond) continue
        const target = toolPlusField(cond.field)
        expect(target, `${field.name} references ${cond.field}`).toBeDefined()
        expect(target!.kind, `${field.name} references select ${cond.field}`).toBe('select')
        expect(target!.options?.some(opt => opt.value === cond.value), `${field.name} references option ${cond.value}`).toBe(true)
      }
    }
  })

  it('master switches (requiresEnabled targets) render before their gated fields', () => {
    for (const field of TOOL_PLUS_FIELDS) {
      const gate = field.visibility?.requiresEnabled
      if (!gate) continue
      const gateIndex = TOOL_PLUS_FIELDS.findIndex(f => f.name === gate)
      const fieldIndex = TOOL_PLUS_FIELDS.findIndex(f => f.name === field.name)
      expect(gateIndex, `${gate} must precede ${field.name}`).toBeLessThan(fieldIndex)
    }
  })

  it('Bash card fields are the bash-tool slice of the table', () => {
    const bash = TOOL_PLUS_FIELDS.filter(f => f.tool === 'bash')
    expect(bash.length).toBeGreaterThan(0)
    expect(bash.every(f => toolPlusField(f.name) === f)).toBe(true)
  })
})

describe('bash-plus back-compat removed', () => {
  it('settings namespace is tool-plus only (no bash-plus legacy namespace export)', () => {
    expect(BASH_PLUS_SETTINGS_NS).toBe('tool-plus')
    const moduleRecord = settingsModule as unknown as Record<string, unknown>
    expect('TOOL_PLUS_SETTINGS_NS' in moduleRecord).toBe(false)
  })
})

describe('grouping sanity', () => {
  it('every group label key exists in the group table', () => {
    const groups = new Set(TOOL_PLUS_FIELDS.map(f => f.group))
    for (const group of groups) expect(TOOL_PLUS_GROUP_LABELS[group]).toBeTruthy()
  })

  it('no-config tabs carry zero fields', () => {
    // grep 已挂配置（grepContextBefore/After + grepCaseDefault/grepGitignoreDefault，
    // 2026-08-25 配置统一、搜索默认值开关上线后 4 项）；
    // glob tab 随搜索默认值开关恢复（globGitignoreDefault/globHiddenDefault，此前
    // 因无配置项被拍板#19 移除）；
    // astGrep/astEdit 已挂启用开关（astGrepEnabled/astEditEnabled，2026-08-25）。
    // readImage tab 已随 read_image 工具删除（2026-08-28，融合后逃生门一并移除）。
    // grep tab 现在有字段（4 个：上下文 2 + 默认值开关 2）
    const grepTab = TOOL_PLUS_TABS.find(t => t.id === 'grep')
    expect(grepTab).toBeDefined()
    expect(grepTab!.fields).toEqual([
      'grepContextBefore',
      'grepContextAfter',
      'grepCaseDefault',
      'grepGitignoreDefault',
    ])
    // glob tab 已恢复（2 个默认值开关）
    const globTab = TOOL_PLUS_TABS.find(t => t.id === 'glob')
    expect(globTab).toBeDefined()
    expect(globTab!.fields).toEqual(['globGitignoreDefault', 'globHiddenDefault'])
    // astGrep/astEdit tab 各有 1 个启用开关
    const astGrepTab = TOOL_PLUS_TABS.find(t => t.id === 'astGrep')
    expect(astGrepTab).toBeDefined()
    expect(astGrepTab!.fields).toEqual(['astGrepEnabled'])
    const astEditTab = TOOL_PLUS_TABS.find(t => t.id === 'astEdit')
    expect(astEditTab).toBeDefined()
    expect(astEditTab!.fields).toEqual(['astEditEnabled'])
  })
})
