/**
 * OMP prompt.md → DSH tool description 适配层（verbatim md 不动，适配在此）。
 *
 * OMP 的 prompts/tools/*.md 用 Handlebars 条件渲染，DSH 的 defineTool
 * description 是静态字符串，这里提供：
 * - `renderOmpPrompt`：完全委托 OMP 自家引擎（@oh-my-pi/pi-utils 的
 *   prompt.render = 结构化 Handlebars 解析 + post-render format 后处理，
 *   与上游 read.ts 渲染工具描述同一条管线）。按「移植绝不允许第二套实现」
 *   （notebook T10-1 同类教训）：自写 regex 渲染器已删除——其全文懒匹配
 *   会跨条件边界吞并并在真值分支残留孤立 `{{/if}}`（2026-08-28 tools:sdk
 *   "malformed prompt variable" 事故根源）。strict:false → 未传变量按 falsy
 *   取 else 分支；畸形模板 compile 期抛错（注册期 fail-loud）。
 * - `sanitizeOmpPrompt`：按工具剔除 DSH 不适用的 OMP 提法（内部协议
 *   artifact:// ssh:// memory:// xd://、browser、scout/Task 子代理、inspect_image），
 *   全部剔除点记录在 step.md「提示词接入」节；md 源文件保持 verbatim 不变。
 */

import { prompt as ompPrompt } from '@oh-my-pi/pi-utils'


export interface OmpPromptVars {
  /** read 输出是否带 [PATH#TAG] hashline 锚点头（= edit.mode === 'hashline'） */
  IS_HL_MODE?: boolean
  /** DSH 无 inspect_image 工具：read.md 图片条件句恒渲染 else 分支（引擎内部
   *  #renderDescription 用），DSH 面再经 sanitizeReadPrompt 改写为附件提交语义
   *  （拍板#22：图片经 attachments 入库，非 vision 路由降级 metadata 文本）。 */
  INSPECT_IMAGE_ENABLED?: boolean
  /** DSH 无 OMP Task/scout 子代理，恒 false → 相关句在 sanitize 中整体剔除，无需变量 */
  scoutAvailable?: boolean
}

/** 渲染 {{#if KEY}}A{{else}}B{{/if}} 与 {{#if KEY}}A{{/if}}——委托 OMP 引擎
 *  （@oh-my-pi/pi-utils prompt.render，strict:false：未传变量按 falsy 取 else
 *  分支；畸形模板 compile 期抛错，注册期 fail-loud）。保留首尾 trim 对齐
 *  既有调用点行为。 */
export function renderOmpPrompt(text: string, vars: OmpPromptVars): string {
  return ompPrompt.render(text, { ...vars }).trim()
}

/** 剔除非空白/注释行——供剔除后再次 trim。 */
export function cleanLines(text: string): string {
  return text
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trim()
}

const SCOUT_IF_LINE = /^\s*.*\{\{#if scoutAvailable\}\}.*\{\{\/if\}\}.*$/m

/** grep.md：internal URLs 提法 + scout 句剔除。 */
export function sanitizeGrepPrompt(text: string): string {
  return text
    .replace(/files\/internal URLs/, 'files')
    .replace(/`path`: known files, directories, globs, internal URLs; roots `;`-separated\./, '`path`: known files, directories, globs; roots `;`-separated.')
    .replace(/Open-ended multi-round search MUST use \{\{#if scoutAvailable\}\}Task \+ scout,\{\{else\}\}Task,\{\{\/if\}\} not chained calls\./, '')
    .replace(/\n{3,}/g, '\n\n')
}

/** glob.md：internal URL/memory:// 提法 + scout avoid 句剔除。 */
export function sanitizeGlobPrompt(text: string): string {
  return text
    .replace('Globs files, directories, and path-backed internal URLs with fast pattern matching.', 'Globs files and directories with fast pattern matching.')
    .replace(/`memory:\/\/` glob patterns are supported\. `ssh:\/\/` has no local path; use `read`\. Other internal URLs accept exact paths only\.\n?/, '')
    .replace(/\n{3,}/g, '\n\n')
}

/** read.md：browser 提法剔除 + 图片句改为 DSH 实际行为（拍板#22 附件提交）+ internal URIs 段删除（{{#if}} 由 renderer 处理）。 */
export function sanitizeReadPrompt(text: string): string {
  return text
    .replace(
      'Images → {{#if INSPECT_IMAGE_ENABLED}}metadata; call `inspect_image`{{else}}decoded inline{{/if}}.',
      'Images (PNG/JPEG/WebP/GIF) → returned as an image block beside a `<path>` envelope; large images are downscaled before display, and text-only models get a metadata note instead.',
    )
    .replace('- SHOULD use `read` (not browser) for web content; browser only when `read` can\'t deliver.\n', '')
    .replace(/\n- Internal URIs — all schemes take selectors.*?\n  Literal `:`, `?`, `#` → percent-encode \(`%3A`\/`%3F`\/`%23`\)\. Requires POSIX shell \(else `ssh` tool\)\.\n?/s, '\n')
    .replace(/\n{3,}/g, '\n\n')
}

/** ast-edit.md：xd://resolve 预演确认协议已随内部路由删除；DSH 为预览后自动落盘（拍板#14）。 */
export function sanitizeAstEditPrompt(text: string): string {
  return text.replace(
    '- Matches are STAGED as a proposal, not applied: finalize by writing a one-sentence reason to `xd://resolve` (apply) or `xd://reject` (discard).',
    '- Matches are STAGED as a preview, then automatically applied in the same call (DSH auto-apply after preview).',
  )
}

/** ast-grep.md：scout 句剔除。 */
export function sanitizeAstGrepPrompt(text: string): string {
  return text.replace(/\n- Broad cross-subsystem exploration → \{\{#if scoutAvailable\}\}Task tool \+ scout\{\{else\}\}Task tool\{\{\/if\}\} subagent first\.?/, '')
}

/** write.md / patch.md / apply-patch.md / replace.md / hashline prompt.md：无 DSH 不适用提法。 */
export function sanitizeWritePrompt(text: string): string {
  return text.trim()
}
export function sanitizePatchPrompt(text: string): string {
  return text.trim()
}
export function sanitizeApplyPatchPrompt(text: string): string {
  return text.trim()
}
export function sanitizeReplacePrompt(text: string): string {
  return text.trim()
}
export function sanitizeHashlinePrompt(text: string): string {
  return text.trim()
}
