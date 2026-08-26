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
import { Settings } from '../../shared/omp/config/settings.ts'
import { getDefault } from '../../shared/omp/config/settings-schema.ts'
import type { ToolSession } from './sdk.ts'
import type { ResolveInvoker } from './sdk.ts'
import { AstEditTool } from './omp/ast-edit.ts'
import astEditMd from './omp/prompts/tools/ast-edit.md' with { type: 'text' }

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
  const session: ToolSession = { cwd, settings, enableLsp: false, hasEditTool: true }
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
        },
      },
      render: (_args: any, value: any) => [{ type: 'text', text: String(value.text ?? '') }],
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
      if (session.pendingInvoker) {
        const applied = await session.pendingInvoker()
        return { text: toText(applied) }
      }
      return { text: toText(result) }
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
