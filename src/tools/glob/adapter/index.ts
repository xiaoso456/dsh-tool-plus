/**
 * DSH glob tool — adapter that wires the verbatim OMP glob engine
 * (`src/tools/glob/adapter/omp/glob.ts`) into DSH's `defineTool` contract.
 *
 * This file is pure glue. All glob logic lives in `omp/` (copied verbatim);
 * this adapter only:
 *  - builds an OMP `ToolSession` from the DSH exec context + tool-plus config,
 *  - constructs the verbatim `GlobTool` and calls its `execute`,
 *  - converts the `AgentToolResult` back to a DSH tool result.
 *
 * plan.md 拍板：glob keeps OMP's native single-param style (`path` with a
 * semicolon-delimited multi-target list). DSH `hidden`/`gitignore`/`limit`
 * are surfaced verbatim as optional parameters.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AgentToolResult } from '@oh-my-pi/pi-agent-core'
import type { RuntimeConfig } from '../../../config/settings.ts'
import { renderOmpPrompt, sanitizeGlobPrompt } from '../../shared/omp-prompt.ts'
import { Settings } from '../../omp/config/settings.ts'
import { getDefault } from '../../omp/config/settings-schema.ts'
import type { ToolSession } from '../../omp/sdk.ts'
import { GlobTool } from '../../omp/tools/glob.ts'
import globMd from './prompts/tools/glob.md' with { type: 'text' }

// OMP tools import `Settings` from the tools barrel (`..`); surface it here.
export type { Settings } from '../../omp/config/settings.ts'
export type { ToolSession } from '../../omp/sdk.ts'

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
    throw new Error(text || 'glob failed')
  }
  return text
}

/**
 * Register the glob tool (OMP native `path` + optional `hidden`/`gitignore`/
 * `limit` parameters).
 */
export function registerGlob(ctx: Context, getConfig: () => RuntimeConfig): void {
  ctx.tools.register(defineTool({
    name: 'glob',
    // OMP 原版提示词（prompts/tools/glob.md verbatim），剔除 memory:///scout 提法。
    description: renderOmpPrompt(sanitizeGlobPrompt(globMd), {}),
    parameters: {
      path: { type: 'string', description: 'Glob, file, or directory to search — a single path or a semicolon-delimited list ("src/**/*.ts; test/**/*.ts").' },
      hidden: { type: 'boolean', description: 'Include hidden files (default true).' },
      gitignore: { type: 'boolean', description: 'Respect gitignore (default true). Set false for ignored files such as .env*.', },
      limit: { type: 'number', description: 'Max results (default 200, max 200).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          text: { type: 'string', required: true },
          fileCount: { type: 'number' },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args: any, value: any) => [{ type: 'text', text: String(value.text ?? '') }],
      presentationMeta: (_args: any, value: any) => ({
        ...(value.fileCount !== undefined ? { files: value.fileCount } : {}),
        ...(value.truncated !== undefined ? { truncated: value.truncated } : {}),
      }) as any,
    },
    async execute(args: any, exec: any) {
      const session = createToolSession(exec, getConfig())
      const tool = new GlobTool(session)
      const result = await tool.execute('glob', {
        path: args.path !== undefined ? String(args.path) : undefined,
        hidden: args.hidden,
        gitignore: args.gitignore,
        limit: args.limit,
      }, exec.signal)
      const text = toText(result)
      const details = (result.details ?? {}) as Record<string, unknown>
      return {
        path: String(details.scopePath ?? args.path ?? ''),
        text,
        ...(typeof details.fileCount === 'number' ? { fileCount: details.fileCount } : {}),
        ...(typeof details.truncated === 'boolean' ? { truncated: details.truncated } : {}),
      }
    },
    presentCall: (args: any) => ({
      card: 'generic',
      title: `Glob ${String(args.path ?? '*').slice(0, 80)}`,
      kind: 'execute',
      rawInput: String(args.path ?? '*'),
    }),
    presentResult: (_args: any, result: any) => {
      if ((result as any)?.isError) return undefined
      return undefined
    },
  }))
}

// Aliases for integration
export const applyGlob = registerGlob
export const registerGlobTool = registerGlob
export default registerGlob
