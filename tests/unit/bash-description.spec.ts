/**
 * bash 的工具描述与系统提示段落必须跟着配置走：只有真的走同一个持久 shell 时才能承诺变量保持。
 *
 * 背景（issue #4）：自动后台开着时，每次调用都会新建一个 Shell（作业独立的 :async: 键），
 * export/别名/函数都不跨调用保留；只有 autoBackgroundMs=0 且没开 bash -c 包裹时才是真持久。
 * 描述写死一句"状态跨调用保持"就等于对默认配置说假话。
 */
import { describe, expect, it } from 'vitest'
import { bashSystemPromptText, bashToolDescription } from '../../src/tools/bash/description.ts'
import { resolveConfig } from '../../src/config/settings.ts'

const cfg = (over: Record<string, unknown> = {}) => resolveConfig({ autoBackgroundMs: 60_000, ...over })

describe('bash 描述随配置分支', () => {
  it('默认配置（自动后台开着）说明其他 shell 状态不跨调用保持', () => {
    const text = bashToolDescription(cfg())
    expect(text).toContain('does not persist between calls')
    expect(text).not.toContain('carry over between calls')
  })

  it('autoBackgroundMs=0 时说明变量跨调用保持', () => {
    const text = bashToolDescription(cfg({ autoBackgroundMs: 0 }))
    expect(text).toContain('carry over between calls')
    expect(text).not.toContain('does not persist between calls')
  })

  it('开着 bash -c 包裹时不承诺持久（即使 autoBackgroundMs=0）', () => {
    const text = bashToolDescription(cfg({ autoBackgroundMs: 0, useShellCommandWrapper: true }))
    expect(text).toContain('does not persist between calls')
  })

  it('系统提示段落用同一套分支', () => {
    expect(bashSystemPromptText(cfg())).toContain('does not persist between calls')
    expect(bashSystemPromptText(cfg({ autoBackgroundMs: 0 }))).toContain('carry over between calls')
    expect(bashSystemPromptText(cfg({ autoBackgroundMs: 0, useShellCommandWrapper: true })))
      .toContain('does not persist between calls')
  })
})
