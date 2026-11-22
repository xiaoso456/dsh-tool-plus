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



/**
 * grep.md：无需改写。
 *
 * 18.12.6 的文案里 `find`、`eagerDelegation`、`scoutAvailable` 三段都在
 * {{#if}} 里，DSH 不传这些变量（strict:false → falsy），渲染时自动消失；
 * 剩下的每一句都对得上我们的实现：native 层 Rust→PCRE2（lookbehind 实测生效，
 * 内置 Rust regex 做不到）、`skip` 分页、file-only 选择器、跨行 `\n`、
 * 裸 glob 任意深度 vs 目录锚定（本轮刚修）。
 *
 * `URL` 那句是真的：grep 搜 http 目标时，引擎把抓取结果写进
 * `getArtifactsDir()` 再搜（`materializeReadUrlContent`）。DSH 没有 host 侧
 * artifact 存储，原先把这里判成「不支持」并收窄文案；后来在 grep 的 session
 * facade 上接了 `src/tools/shared/artifacts.ts`（tmpdir，与 bash spill 同法），
 * 实测 http 页面能搜出命中（matchCount=1）、无命中报 No matches，文案随之恢复逐字。
 */
export function sanitizeGrepPrompt(text: string): string {
  return text.trim()
}

/**
 * glob.md：只改 internal URL 的 scheme 举例，其余逐字。
 *
 * 上游例子用的是 `local://` 与 `omp://`（后者还带任意深度模式），这两个 scheme 在 DSH 都不存在：
 * `local://` 的内部协议解析已按既有决定整体删除（local-protocol.ts 里 canHandle 恒 false），
 * `omp://` 是 OMP 宿主自己的命名空间。DSH 能 glob 的是「有落地文件的」internal URL
 * （glob.ts 在 canHandle 为真且能解析出 backing file 时才展开，否则明确报错），
 * 所以把这句改写成本仓的事实，能力本身不删也不减。
 *
 * `find` / `eagerDelegation` / `scoutAvailable` 段落由 `{{#ifAny}}` 控制，
 * DSH 不传这些变量（strict:false → falsy），渲染时整段消失。
 */
export function sanitizeGlobPrompt(text: string): string {
  return text
    .replace(
      'Glob files/dirs: `;`-separated paths or internal URLs (`local://*.md`, `omp://**/*.md`); default workspace root.',
      'Glob files/dirs: `;`-separated paths or path-backed internal URLs; default workspace root.',
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * read.md：只剔除 DSH 没有的「read 与 browser 二选一」那一处，其余逐字。
 *
 * 18.12.6 的 read.md 全部条件段都走 {{#if}}：
 * - {{#if IS_HL_MODE}} 由 editMode 决定（既有的两种文案）；
 * - {{#if BINARY_VIEWS}} 整行不渲染，我们没移植 read-binary（它依赖 ida 子系统），
 *   用上游自己的开关关掉，不是私自删条目。
 *
 * 唯一剔除的是「read 与 browser 二选一」：DSH 没有 browser 工具。URL 那句留着，
 * 因为本仓**真的支持**（`read.ts` 导入 `executeReadUrl` / `fetchReadUrl`，
 * `tools/fetch.ts` 与 `web/` 子系统都在库里）。实测：非 raw 走 native 后端输出
 * 带 frontmatter 的 markdown（`Method: native`），`:raw` 返回原 HTML，与文案一致。
 * 教训：判断「某能力有没有移植」要看 import 与实跑，不能只 grep 字面量——
 * 抽掉的 URL 分支就是这样误判过一次。
 *
 * 其余每一句都已对上实现（本轮补齐后）：:-N 尾巴、范围补 1 前 3 后（:raw 精确）、
 * :img 栅格化与「栅格图带 :img 报错」、视频 ffmpeg 预览网格与取帧、JSON 查询、
 * 归档全格式、SQLite、:conflicts、目录子项上限 12。
 * 所以这里不再改写任何能力描述，只删掉一句关于「本仓没有 browser 工具」的选择建议。
 */
export function sanitizeReadPrompt(text: string): string {
  return text
    .replace('Use `read` for static web; browser only if needed.\n\n', '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
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
