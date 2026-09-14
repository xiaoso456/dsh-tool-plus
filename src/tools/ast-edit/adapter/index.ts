/**
 * DSH ast_edit tool — adapter that wires the verbatim OMP AST edit engine
 * (`src/tools/ast-edit/adapter/omp/ast-edit.ts`) into DSH's `defineTool` contract.
 *
 * This file is pure glue. All edit logic lives in `omp/` (copied verbatim from
 * OMP `tools/ast-edit.ts`); this adapter only:
 *  - builds an OMP `ToolSession` from the DSH exec context + tool-plus config,
 *  - constructs the verbatim `AstEditTool` and calls its `execute`,
 *  - converts the `AgentToolResult` back to a DSH tool result.
 *
 * Parameter shape is OMP-native (`ops[{pat,out}]` + `paths[]`), mirroring
 * `tools/ast-edit.ts` verbatim (plan.md 拍板#11 keeps this shape). No TUI/ACP
 * rendering happens in DSH; the model-facing `result.text` is surfaced directly.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AgentToolResult } from '@oh-my-pi/pi-agent-core'
import type { RuntimeConfig } from '../../../config/settings.ts'
import { renderOmpPrompt, sanitizeAstEditPrompt } from '../../shared/omp-prompt.ts'
import { Settings } from '../../omp/config/settings.ts'
import { getDefault } from '../../omp/config/settings-schema.ts'
import type { ToolSession } from './sdk.ts'
import type { ResolveInvoker } from './sdk.ts'
import { AstEditTool } from '../../omp/tools/ast-edit.ts'
// Web 卡片投影（plan web-tool-cards §4.3）：预览取引擎 displayContent，计数取 fileReplacements。
import { projectAstEditCardMeta } from '../../../web/host/ast-edit.ts'
import type { AstEditCardMeta } from '../../../web/contract.ts'
import astEditMd from '../../omp/prompts/tools/ast-edit.md' with { type: 'text' }

export type { ToolSession } from './sdk.ts'

/**
 * Build the OMP ToolSession facade over a DSH exec context.
 *
 * DSH resolve channel (ast_edit "预览后真实落盘", plan.md 拍板#14): OMP's
 * preview/apply mechanism routes through `session.getToolChoiceQueue()`; DSH
 * has no tool-choice queue, so the adapter installs one that CAPTURES the
 * preview's apply invoker. After the verbatim execute() returns the preview,
 * the adapter runs the captured invoker with {action:'apply'} — the original
 * `apply` callback (runAstEditOnce dryRun:false) performs the real write.
 * The OMP ast-edit.ts algorithm is untouched; this is pure glue.
 */
function createToolSession(exec: any, cfg: RuntimeConfig): ToolSession {
  const cwd: string = exec?.agent?.session?.header?.cwd ?? process.cwd()
  const settings = new Settings(cfg, getDefault)
  const session: ToolSession = { cwd, settings, hasEditTool: true }
  session.getToolChoiceQueue = () => ({
    registerPendingInvoker: (_id: string, _toolName: string, onInvoked: ResolveInvoker) => {
      // Capture the pending apply; adapter executes it after the preview returns.
      session.pendingInvoker = () => onInvoked({ action: 'apply', reason: 'DSH auto-apply' })
    },
    removePendingInvoker: () => {},
  })
  return session
}

/** Extract the text content of an OMP AgentToolResult (throws on isError). */
function toText(result: AgentToolResult<any>): string {
  const text = result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  if (result.isError) {
    throw new Error(text || 'ast_edit failed')
  }
  return text
}

/**
 * ast_edit 卡片 value 字段（output.schema 镜像）。预览已按 AST_EDIT_META_MAX_BYTES
 * 在投影里截断，这里只做搬运，保证 meta 里不出现 undefined。
 */
function astEditCardFields(card: AstEditCardMeta): {
  preview: string
  files: { path: string; count: number }[]
  replacements: number
  applied: boolean
} {
  return {
    preview: card.preview,
    files: card.files,
    replacements: card.replacements,
    applied: card.applied,
  }
}

/**
 * Register the ast_edit tool. Argument shape matches OMP verbatim:
 * `ops` is a non-empty array of `{ pat, out }` rewrite rules, and `paths` is a
 * non-empty array of files, directories, globs, or internal URLs.
 */
export function registerAstEdit(ctx: Context, getConfig: () => RuntimeConfig): () => void {
  return ctx.tools.register(defineTool({
    name: 'ast_edit',
    // OMP 原版提示词（omp/prompts/tools/ast-edit.md verbatim），xd:// 预演
    // 确认句替换为 DSH 预览后自动落盘语义（拍板#14）。
    description: renderOmpPrompt(sanitizeAstEditPrompt(astEditMd), {}),
    parameters: {
      ops: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pat: { type: 'string', required: true, description: 'ast pattern to match' },
            out: { type: 'string', required: true, description: 'replacement template' },
          },
        },
        description: 'rewrite ops',
      } as any,
      paths: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'files, directories, globs, or internal URLs to rewrite',
      } as any,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          preview: { type: 'string' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                count: { type: 'integer', required: true },
              },
            },
          },
          replacements: { type: 'integer' },
          applied: { type: 'boolean' },
        },
      },
      render: (_args: any, value: any) => [{ type: 'text', text: String(value.text ?? '') }],
      // ast_edit 卡片 meta（preview/files/replacements/applied）；无预览 → 不产 meta
      // （null，不能是 undefined：宿主对 undefined 判 non-lossless JSON 并改写成 isError）。
      presentationMeta: (_args: any, value: any) =>
        (typeof value?.preview === 'string' && value.preview !== ''
          ? {
              kind: 'ast_edit',
              preview: value.preview,
              files: Array.isArray(value.files) ? value.files : [],
              replacements: typeof value.replacements === 'number' ? value.replacements : 0,
              applied: value.applied === true,
            }
          : null) as any,
    },
    async execute(args: any, exec: any) {
      const session = createToolSession(exec, getConfig())
      const tool = new AstEditTool(session)
      const result = await tool.execute(
        'ast_edit',
        { ops: Array.isArray(args.ops) ? args.ops : [], paths: Array.isArray(args.paths) ? args.paths : [] },
        exec.signal,
      )
      // Preview/apply (plan.md 拍板#14): the verbatim execute() returned the
      // preview; if a pending apply was staged (replacements > 0), run it now
      // so the edits are REALLY written, and surface the applied result.
      const previewDetails = (result.details ?? {}) as Record<string, unknown>
      if (session.pendingInvoker) {
        const applied = await session.pendingInvoker()
        // The resolve wrapper puts the engine's details under
        // `details.sourceResultDetails` (ResolveDetails); older/plain results
        // carry them directly.
        const resolveDetails = (applied.details ?? {}) as Record<string, unknown>
        const appliedDetails =
          typeof resolveDetails.sourceResultDetails === 'object' && resolveDetails.sourceResultDetails !== null
            ? (resolveDetails.sourceResultDetails as Record<string, unknown>)
            : resolveDetails
        // 应用腿的 details 不带 displayContent，预览腿才有——卡片用预览的显示文本。
        const card = projectAstEditCardMeta({
          ...appliedDetails,
          displayContent: appliedDetails.displayContent ?? previewDetails.displayContent,
        })
        const text = toText(applied)
        return card === null ? { text } : { text, ...astEditCardFields(card) }
      }
      const card = projectAstEditCardMeta(previewDetails)
      const text = toText(result)
      return card === null ? { text } : { text, ...astEditCardFields(card) }
    },
    presentCall: (args: any) => ({
      card: 'generic',
      title: `AST Edit ${String((args.paths ?? []).length)} path(s)`,
      kind: 'execute',
      rawInput: JSON.stringify({ ops: args.ops, paths: args.paths }),
    }),
    presentResult: (_args: any, result: any) => {
      if ((result as any)?.isError) return undefined
      return undefined
    },
  }))
}

export const applyAstEdit = registerAstEdit
export const registerAstEditTool = registerAstEdit
export default registerAstEdit
