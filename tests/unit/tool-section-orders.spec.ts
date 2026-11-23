/**
 * 把插件写死的工具段位置钉在宿主集中分配表上：上游改号时这里先红，
 * 提醒在升级 review 里同步常量，而不是让运行时查表去赌解析得到。
 * @module tests
 */

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it } from 'vitest'
import { TOOL_SECTION_ORDERS } from '../../src/tool-section-orders.ts'

/** 写死值对应的宿主具名位置（dsh 0.2.x 的 SECTION_ORDERS）。 */
const HOST_SLOTS = [
  ['bash', 'TOOL_BASH'],
  ['read', 'TOOL_READ'],
  ['write', 'TOOL_WRITE'],
  ['edit', 'TOOL_EDIT'],
  ['glob', 'TOOL_GLOB'],
  ['grep', 'TOOL_GREP'],
] as const

describe('tool section orders', () => {
  let ctx: Context | undefined

  afterEach(async () => {
    await ctx?.fiber.dispose()
    ctx = undefined
  })

  async function prompt(): Promise<Context> {
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    return ctx
  }

  it('matches the host allocation table', async () => {
    const service = (await prompt()).systemPrompt
    for (const [key, slot] of HOST_SLOTS) {
      expect(TOOL_SECTION_ORDERS[key]).toBe(service.getSectionOrder(slot))
    }
  })

  it('keeps mode rules before tools, the SDK after, and the shell first', async () => {
    const service = (await prompt()).systemPrompt
    for (const anchor of ['PLAN_POLICY', 'PTC_ONLY', 'FILE_REFERENCE'] as const) {
      expect(TOOL_SECTION_ORDERS.bash).toBeGreaterThan(service.getSectionOrder(anchor))
    }
    expect(TOOL_SECTION_ORDERS.bash).toBeLessThan(TOOL_SECTION_ORDERS.read)
    expect(TOOL_SECTION_ORDERS.read).toBeLessThan(TOOL_SECTION_ORDERS.write)
    expect(TOOL_SECTION_ORDERS.write).toBeLessThan(TOOL_SECTION_ORDERS.edit)
    expect(TOOL_SECTION_ORDERS.edit).toBeLessThan(TOOL_SECTION_ORDERS.glob)
    expect(TOOL_SECTION_ORDERS.glob).toBeLessThan(TOOL_SECTION_ORDERS.grep)
    expect(TOOL_SECTION_ORDERS.grep).toBeLessThan(service.getSectionOrder('TOOLS_SDK'))
  })
})
