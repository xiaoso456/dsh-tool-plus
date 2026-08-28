/**
 * A-2 回归：bash-interceptor 与 OMP 上游匹配面对齐。
 *
 * 背景（second-impl-audit.md A-2）：上游 checkBashInterception（refs
 * packages/coding-agent/src/tools/bash-interceptor.ts:212-263）对三类候选
 * 逐一匹配——整条命令、shell-tokenize 分词段（跳过管道 stdin 段）、剥离前置
 * `NAME=value` 赋值后的段；规则表 10 条（含 echo/printf 重定向 → write）。
 * 插件旧实现只测整条命令、6 条规则 → 复合命令/前置赋值/重定向写全部放行。
 */
import { describe, expect, it } from 'vitest'
import { checkBashInterception } from '../../src/tools/bash/bash-interceptor.ts'

const TOOLS = ['read', 'grep', 'glob', 'edit', 'write']

describe('bash-interceptor 与 OMP 匹配面对齐（A-2）', () => {
  it('分词段匹配：cd x && cat y → 拦截到 read（上游三类候选之二）', () => {
    const r = checkBashInterception('cd x && cat y', TOOLS)
    expect(r.block).toBe(true)
    expect(r.suggestedTool).toBe('read')
  })

  it('前置环境变量赋值剥离：FOO=1 grep pattern file → 拦截到 grep', () => {
    const r = checkBashInterception('FOO=1 grep pattern file', TOOLS)
    expect(r.block).toBe(true)
    expect(r.suggestedTool).toBe('grep')
  })

  it('重定向写规则：echo hi > file.txt → 拦截到 write（上游规则表 10 条之一）', () => {
    const r = checkBashInterception('echo hi > file.txt', TOOLS)
    expect(r.block).toBe(true)
    expect(r.suggestedTool).toBe('write')
  })

  it('管道 stdin 段不作候选：curl … | cat 不拦截（上游 :215-219）', () => {
    const r = checkBashInterception('curl https://example.com/data.json | cat', TOOLS)
    expect(r.block).toBe(false)
  })

  it('既有行为回归：cat foo.txt → 拦截到 read', () => {
    const r = checkBashInterception('cat foo.txt', TOOLS)
    expect(r.block).toBe(true)
    expect(r.suggestedTool).toBe('read')
  })

  it('既有行为回归：find . -name "*.ts" → 拦截到 glob', () => {
    const r = checkBashInterception('find . -name "*.ts"', TOOLS)
    expect(r.block).toBe(true)
    expect(r.suggestedTool).toBe('glob')
  })
})