/**
 * renderOmpPrompt 条件渲染回归：跨条件边界匹配缺陷 + 真实 md 渲染无残留守卫。
 *
 * 背景（2026-08-28 tools:sdk 报错排查）：旧实现的两支 regex 用 `[\s\S]*?`
 * 贪遍全文——当「无 else 的 {{#if A}}」在前、「带 else 的 {{#if B}}」在后时，
 * 第一支 regex 会从 A 的开标签一路懒匹配到 B 的 {{else}}…{{/if}}，把两段
 * 文本并成一个条件；A 为真时输出残留孤立的 `{{/if}}` 与未闭合的
 * `{{#if B}}`，Code Mode（tools:sdk section 嵌入工具描述）下即触发
 * dsh-system-prompt 的 "malformed prompt variable reference" 使整轮 run 失败。
 *
 * 本文件两类用例：
 *  1. 条件边界回归（RED→GREEN 的主体：else 只绑定"属于自己"的那个 if）
 *  2. 真实工具 md × 真实变量集渲染后不得残留任何 `{{`（发布守卫，
 *     防止 sanitize 精确串失配时泄漏模板语法——旧构建事故的根源）
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  renderOmpPrompt,
  sanitizeReadPrompt,
  sanitizeGrepPrompt,
  sanitizeGlobPrompt,
  sanitizeAstGrepPrompt,
  sanitizeAstEditPrompt,
  sanitizeWritePrompt,
  sanitizePatchPrompt,
  sanitizeApplyPatchPrompt,
  sanitizeReplacePrompt,
  sanitizeHashlinePrompt,
  type OmpPromptVars,
} from '../../src/tools/shared/omp-prompt.ts'

/** read.md 原文（与 adapter 相同的 verbatim md）。 */
const readMd = readFileSync(
  new URL('../../src/tools/omp/prompts/tools/read.md', import.meta.url),
  'utf8',
)

describe('renderOmpPrompt 条件边界（跨条件 span 回归）', () => {
  it('前面的无 else 条件为真时，不得吞并后面带 else 的条件', () => {
    const out = renderOmpPrompt(
      'A {{#if X}}x-body{{/if}} B {{#if Y}}y-a{{else}}y-b{{/if}} C',
      { X: true, Y: false },
    )
    expect(out).toBe('A x-body B y-b C')
    expect(out).not.toContain('{{')
  })

  it('前面的无 else 条件为假时，同样不得吞并后面的条件', () => {
    const out = renderOmpPrompt(
      'A {{#if X}}x{{/if}} B {{#if Y}}y-a{{else}}y-b{{/if}} C',
      { X: false, Y: false },
    )
    expect(out).toBe('A  B y-b C')
    expect(out).not.toContain('{{')
  })

  it('未闭合的 {{#if}} 在注册期抛错（fail-loud，不静默残留）', () => {
    // OMP 引擎（prompt.render）对畸形模板 compile 期抛 "Parse error: unclosed block"；
    // 注册期炸掉好过带残留描述上线再在 Code Mode 下炸整轮 run。
    expect(() => renderOmpPrompt('A {{#if X}}x B', {})).toThrow(/unclosed/i)
  })
})

describe('renderOmpPrompt 既有行为保持', () => {
  it('无 else 条件：假删真留', () => {
    expect(renderOmpPrompt('a{{#if ON}}b{{/if}}c', { ON: true })).toBe('abc')
    expect(renderOmpPrompt('a{{#if ON}}b{{/if}}c', {})).toBe('ac')
  })

  it('带 else 条件：真假各取分支', () => {
    expect(renderOmpPrompt('a{{#if ON}}b{{else}}d{{/if}}c', { ON: true })).toBe('abc')
    expect(renderOmpPrompt('a{{#if ON}}b{{else}}d{{/if}}c', {})).toBe('adc')
  })

  it('多个相邻条件各自独立渲染', () => {
    expect(
      renderOmpPrompt('{{#if A}}1{{/if}}-{{#if B}}2{{else}}3{{/if}}', { A: true, B: false }),
    ).toBe('1-3')
  })

  it('渲染结果首尾 trim', () => {
    expect(renderOmpPrompt('  x{{#if ON}}y{{/if}}z  ', { ON: true })).toBe('xyz')
  })
})

describe('全工具 md × sanitize × 变量矩阵（同类问题全面守卫）', () => {
  const load = (rel: string): string => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
  const MD = {
    read: 'src/tools/omp/prompts/tools/read.md',
    write: 'src/tools/omp/prompts/tools/write.md',
    'ast-grep': 'src/tools/omp/prompts/tools/ast-grep.md',
    'ast-edit': 'src/tools/omp/prompts/tools/ast-edit.md',
    glob: 'src/tools/glob/adapter/prompts/tools/glob.md',
    grep: 'src/tools/grep/adapter/prompts/tools/grep.md',
    patch: 'src/tools/edit/adapter/prompts/tools/patch.md',
    'apply-patch': 'src/tools/edit/adapter/prompts/tools/apply-patch.md',
    replace: 'src/tools/edit/adapter/prompts/tools/replace.md',
    hashline: 'src/tools/hashline/engine/prompt.md',
  }

  it('sanitize 精确匹配串仍存在于对应 md（上游 drift 静默失配报警）', () => {
    expect(readMd).toContain('Images → {{#if INSPECT_IMAGE_ENABLED}}metadata; call `inspect_image`{{else}}decoded inline{{/if}}.')
    expect(readMd).toContain("- SHOULD use `read` (not browser) for web content; browser only when `read` can't deliver.\n")
    expect(load(MD.grep)).toContain('Open-ended multi-round search MUST use {{#if scoutAvailable}}Task + scout,{{else}}Task,{{/if}} not chained calls.')
    expect(load(MD.grep)).toContain('Searches files/internal URLs')
    expect(load(MD.glob)).toContain('Globs files, directories, and path-backed internal URLs with fast pattern matching.')
    expect(load(MD.glob)).toContain('`memory://` glob patterns are supported.')
    expect(load(MD['ast-grep'])).toContain('Broad cross-subsystem exploration → {{#if scoutAvailable}}Task tool + scout{{else}}Task tool{{/if}} subagent first.')
    expect(load(MD['ast-edit'])).toContain('- Matches are STAGED as a proposal, not applied: finalize by writing a one-sentence reason to `xd://resolve` (apply) or `xd://reject` (discard).')
  })

  it('全 md 渲染后无 {{ 残留，且应剔除的 OMP 提法不出现', () => {
    const cases: Array<{ md: string; sanitize: (t: string) => string; vars?: OmpPromptVars; forbidden: string[] }> = [
      { md: MD.read, sanitize: sanitizeReadPrompt, forbidden: ['{{', 'decoded inline', 'not browser'] },
      { md: MD.grep, sanitize: sanitizeGrepPrompt, forbidden: ['{{', 'files/internal URLs', 'scout'] },
      { md: MD.glob, sanitize: sanitizeGlobPrompt, forbidden: ['{{', 'memory://'] },
      { md: MD['ast-grep'], sanitize: sanitizeAstGrepPrompt, forbidden: ['{{', 'scout'] },
      { md: MD['ast-edit'], sanitize: sanitizeAstEditPrompt, forbidden: ['{{', 'xd://resolve'] },
      { md: MD.write, sanitize: sanitizeWritePrompt, forbidden: ['{{'] },
      { md: MD.patch, sanitize: sanitizePatchPrompt, forbidden: ['{{'] },
      { md: MD['apply-patch'], sanitize: sanitizeApplyPatchPrompt, forbidden: ['{{'] },
      { md: MD.replace, sanitize: sanitizeReplacePrompt, forbidden: ['{{'] },
      { md: MD.hashline, sanitize: sanitizeHashlinePrompt, forbidden: ['{{'] },
    ]
    for (const { md, sanitize, vars, forbidden } of cases) {
      const out = renderOmpPrompt(sanitize(load(md)), vars ?? {})
      for (const f of forbidden) expect(out, `${md} 残留 "${f}"`).not.toContain(f)
    }
  })

  it('read 两种 editMode 变量下均无 {{ 残留', () => {
    for (const hl of [true, false]) {
      const out = renderOmpPrompt(sanitizeReadPrompt(readMd), { IS_HL_MODE: hl, INSPECT_IMAGE_ENABLED: false })
      expect(out).not.toContain('{{')
    }
  })
})