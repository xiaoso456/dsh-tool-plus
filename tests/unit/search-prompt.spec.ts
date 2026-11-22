/**
 * grep / glob 提示词：18.12.6 逐字文案 + DSH 条件变量渲染后的样子。
 *
 * 两件事要钉住：
 * 1. 渲染后不能残留模板标记（模板里有 #if/#ifAny，渲染器 strict:false）；
 * 2. 上游受条件控制的 find / eagerDelegation / scout 段落必须整段消失，
 *    不能变成半截句子留在描述里。
 */
import { describe, expect, it } from 'vitest'
import { renderOmpPrompt, sanitizeGlobPrompt, sanitizeGrepPrompt } from '../../src/tools/shared/omp-prompt.ts'
import grepMd from '../../src/tools/grep/adapter/prompts/tools/grep.md' with { type: 'text' }
import globMd from '../../src/tools/glob/adapter/prompts/tools/glob.md' with { type: 'text' }

const grepDesc = () => renderOmpPrompt(sanitizeGrepPrompt(grepMd), {})
const globDesc = () => renderOmpPrompt(sanitizeGlobPrompt(globMd), {})

describe('grep 提示词', () => {
  it('渲染后无模板残留', () => {
    expect(grepDesc()).not.toContain('{{')
    expect(grepDesc()).not.toContain('}}')
  })

  it('保留 18.12.6 的核心承诺句', () => {
    const text = grepDesc()
    expect(text).toContain('Rust, then PCRE2')
    expect(text).toContain('Default case-sensitive, gitignore respected')
    expect(text).toContain('`skip` paginates files')
    expect(text).toContain('Bare glob `*.ts` matches any depth')
    expect(text).toContain("only `dir`'s direct children")
  })

  it('URL 目标保留（session facade 已接 artifacts 目录，实测可搜）', () => {
    const text = grepDesc()
    expect(text).toContain('file/dir/glob/URL')
  })

  it('不渲染 find / Task 委派句（DSH 无 find 工具、无 Task 子代理）', () => {
    const text = grepDesc()
    expect(text).not.toContain('`find`')
    expect(text).not.toContain('Task')
    expect(text).not.toContain('scout')
  })
})

describe('glob 提示词', () => {
  it('渲染后无模板残留', () => {
    expect(globDesc()).not.toContain('{{')
  })

  it('保留 hidden / gitignore 默认值与排序说明', () => {
    const text = globDesc()
    expect(text).toContain('gitignore')
    expect(text.toLowerCase()).toContain('default true')
    expect(text).toContain('/')
  })

  it('不渲染 find / Task 句', () => {
    const text = globDesc()
    expect(text).not.toContain('`find`')
    expect(text).not.toContain('scout')
  })
})
