/**
 * DSH ast_grep tool — adapter that wires the verbatim OMP AST grep engine
 * (`src/tools/ast-grep/adapter/omp/ast-grep.ts`) into DSH's `defineTool`
 * contract.
 *
 * This file is pure glue. All search logic lives in `omp/` (copied verbatim
 * from OMP `tools/ast-grep.ts`); this adapter only:
 *  - builds an OMP `ToolSession` from the DSH exec context + tool-plus config,
 *  - constructs the verbatim `AstGrepTool` and calls its `execute`,
 *  - converts the `AgentToolResult` back to a DSH tool result.
 *
 * ast_grep is a READ-ONLY query: it matches AST patterns and returns hashline
 * headers + line-numbered matches. There is no preview or apply step.
 *
 * Parameter shape is OMP-native (`pat` + optional `path`/`skip`), mirroring
 * `tools/ast-grep.ts` verbatim. No TUI/ACP rendering happens in DSH; the
 * model-facing `result.text` is surfaced directly.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AgentToolResult } from '@oh-my-pi/pi-agent-core'
import type { RuntimeConfig } from '../../../config/settings.ts'
import { renderOmpPrompt, sanitizeAstGrepPrompt } from '../../shared/omp-prompt.ts'
import { Settings } from '../../omp/config/settings.ts'
import { getDefault } from '../../omp/config/settings-schema.ts'
import type { ToolSession } from './sdk.ts'
import { AstGrepTool } from '../../omp/tools/ast-grep.ts'
import astGrepMd from '../../omp/prompts/tools/ast-grep.md' with { type: 'text' }

export type { ToolSession } from './sdk.ts'

/** Build the OMP ToolSession facade over a DSH exec context. */
function createToolSession(exec: any, cfg: RuntimeConfig): ToolSession {
  const cwd: string = exec?.agent?.session?.header?.cwd ?? process.cwd()
  const settings = new Settings(cfg, getDefault)
  return { cwd, settings, hasEditTool: true }
}

/** Extract the text content of an OMP AgentToolResult (throws on isError). */
function toText(result: AgentToolResult<any>): string {
  const text = result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  if (result.isError) {
    throw new Error(text || 'ast_grep failed')
  }
  return text
}

/**
 * Register the ast_grep tool. Argument shape matches OMP verbatim:
 * `pat` is a required AST pattern; `path` optionally selects files,
 * directories, globs, or internal URLs (semicolon-delimited list); `skip`
 * optionally skips the first N matches.
 */
export function registerAstGrep(ctx: Context, getConfig: () => RuntimeConfig): () => void {
  return ctx.tools.register(defineTool({
    name: 'ast_grep',
    // OMP 原版提示词（omp/prompts/tools/ast-grep.md verbatim），剔除 scout 提法。
    description: renderOmpPrompt(sanitizeAstGrepPrompt(astGrepMd), {}),
    parameters: {
      pat: { type: 'string', required: true, description: 'ast pattern to match' },
      path: {
        type: 'string',
        description: 'file, directory, glob, or internal URL to search; semicolon-delimited list',
      } as any,
      skip: { type: 'number', description: 'matches to skip' },
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
      const tool = new AstGrepTool(session)
      const result = await tool.execute(
        'ast_grep',
        {
          pat: String(args.pat ?? ''),
          ...(args.path !== undefined ? { path: String(args.path) } : {}),
          ...(args.skip !== undefined ? { skip: Number(args.skip) } : {}),
        },
        exec.signal,
      )
      return { text: toText(result) }
    },
    presentCall: (args: any) => ({
      card: 'generic',
      title: `AST Grep ${String(args.pat ?? '')}`,
      kind: 'execute',
      rawInput: JSON.stringify({ pat: args.pat, path: args.path, skip: args.skip }),
    }),
    presentResult: (_args: any, result: any) => {
      if ((result as any)?.isError) return undefined
      return undefined
    },
  }))
}

export const applyAstGrep = registerAstGrep
export const registerAstGrepTool = registerAstGrep
export default registerAstGrep
