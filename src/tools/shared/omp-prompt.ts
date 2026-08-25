/**
 * OMP prompt.md → DSH tool description 适配层（verbatim md 不动，适配在此）。
 *
 * OMP 的 prompts/tools/*.md 用 Handlebars 条件渲染（prompt.render），DSH 的
 * defineTool description 是静态字符串，这里提供：
 * - `renderOmpPrompt`：支持 `{{#if KEY}}A{{else}}B{{/if}}` 与
 *   `{{#if KEY}}A{{/if}}` 两种条件（md 内无嵌套、无插值变量，无需完整引擎）
 * - `sanitizeOmpPrompt`：按工具剔除 DSH 不适用的 OMP 提法（内部协议
 *   artifact:// ssh:// memory:// xd://、browser、scout/Task 子代理、inspect_image），
 *   全部剔除点记录在 step.md「提示词接入」节；md 源文件保持 verbatim 不变。
 */

export interface OmpPromptVars {
  /** read 输出是否带 [PATH#TAG] hashline 锚点头（= edit.mode === 'hashline'） */
  IS_HL_MODE?: boolean
  /** DSH 无 inspect_image 工具（有 read_image），恒 false → 取 else 分支 */
  INSPECT_IMAGE_ENABLED?: boolean
  /** DSH 无 OMP Task/scout 子代理，恒 false → 相关句在 sanitize 中整体剔除，无需变量 */
  scoutAvailable?: boolean
}

/** 渲染 {{#if KEY}}A{{else}}B{{/if}} 与 {{#if KEY}}A{{/if}}（不支持嵌套）。 */
export function renderOmpPrompt(text: string, vars: OmpPromptVars): string {
  const pick = (key: string): boolean => vars[key as keyof OmpPromptVars] === true
  return text
    .replace(/\{\{#if\s+([A-Za-z_]+)\}\}([\s\S]*?)\{\{else\}\}([\s\S]*?)\{\{\/if\}\}/g, (_m, key, a, b) =>
      pick(key) ? a : b,
    )
    .replace(/\{\{#if\s+([A-Za-z_]+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (m, key, body) => (pick(key) ? body : ''))
    .trim()
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

/** read.md：browser/inspect_image 提法剔除 + internal URIs 段删除（{{#if}} 由 renderer 处理）。 */
export function sanitizeReadPrompt(text: string): string {
  return text
    .replace('Read files, directories, archives, SQLite, images, documents, internal resources, and web URLs via `path`.', 'Read files, directories, archives, SQLite, images, documents, and web URLs via `path`.')
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
