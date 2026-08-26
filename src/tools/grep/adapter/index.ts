/**
 * DSH grep tool — adapter that wires the verbatim OMP grep engine
 * (`src/tools/grep/adapter/omp/`) into DSH's `defineTool` contract.
 *
 * This file is pure glue. All grep logic lives in `omp/` (copied verbatim);
 * this adapter only:
 *  - builds an OMP `ToolSession` from the DSH exec context + tool-plus config,
 *  - constructs the verbatim `GrepTool` and calls its `execute`,
 *  - converts the `AgentToolResult` back to a DSH tool result.
 *
 * Parameters follow OMP's native style (`pattern` regex + `path` with inline
 * `:N-M` selectors); the DSH tool exposes the same schema so nothing is lost.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AgentToolResult } from '@oh-my-pi/pi-agent-core'
import type { RuntimeConfig } from '../../../config/settings.ts'
import { renderOmpPrompt, sanitizeGrepPrompt } from '../../shared/omp-prompt.ts'
import { Settings } from '../../shared/omp/config/settings.ts'
import { getDefault } from '../../shared/omp/config/settings-schema.ts'
import type { ToolSession } from '../../shared/omp/sdk.ts'
import { GrepTool } from './omp/grep.ts'
import grepMd from './prompts/tools/grep.md' with { type: 'text' }

// OMP tools import `Settings` from the tools barrel (`..`); surface it here.
export type { Settings } from '../../shared/omp/config/settings.ts'
export type { ToolSession } from '../../shared/omp/sdk.ts'

/** Build the OMP ToolSession facade over a DSH exec context. */
function createToolSession(exec: any, cfg: RuntimeConfig): ToolSession {
  const cwd: string = exec?.agent?.session?.header?.cwd ?? process.cwd()
  const settings = new Settings(cfg, getDefault)
  return { cwd, settings, enableLsp: false, hasEditTool: true }
}

/** Extract the text content of an OMP AgentToolResult (throws on isError). */
function toText(result: AgentToolResult<any>): string {
  const text = result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  if (result.isError) {
    throw new Error(text || 'grep failed')
  }
  return text
}

/**
 * Register the grep tool (OMP-native `pattern` + `path` parameters; the `path`
 * accepts an inline `:N-M` selector and may be a semicolon-delimited list).
 */
export function registerGrep(ctx: Context, getConfig: () => RuntimeConfig): void {
  ctx.tools.register(defineTool({
    name: 'grep',
    // OMP 原版提示词（prompts/tools/grep.md verbatim），剔除 internal URL/scout 提法。
    description: renderOmpPrompt(sanitizeGrepPrompt(grepMd), {}),
    parameters: {
      pattern: { type: 'string', required: true, description: 'Regex pattern to search for.' },
      path: { type: 'string', description: 'File/directory/glob/internal-URL target with optional inline ":N-M" selector, or a ";"-delimited list; omitted = workspace root (".").' },
      case: { type: 'boolean', description: 'Case-sensitive search (default: true — pass false to ignore case).' },
      gitignore: { type: 'boolean', description: 'Respect .gitignore (default: true).' },
      skip: { type: 'number', description: 'Files to skip before collecting results (paginate past a prior file limit).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          matchCount: { type: 'number' },
          fileCount: { type: 'number' },
          files: { type: 'array', items: { type: 'string' } },
          scopePath: { type: 'string' },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args: any, value: any) => [{ type: 'text', text: String(value.text ?? '') }],
      presentationMeta: (_args: any, value: any) => ({
        ...(typeof value.matchCount === 'number' ? { matches: value.matchCount } : {}),
        ...(typeof value.fileCount === 'number' ? { files: value.fileCount } : {}),
        ...(value.scopePath !== undefined ? { path: value.scopePath } : {}),
      }) as any,
    },
    async execute(args: any, exec: any) {
      const session = createToolSession(exec, getConfig())
      const tool = new GrepTool(session)
      const params: Record<string, unknown> = { pattern: String(args.pattern ?? '') }
      if (args.path !== undefined && args.path !== null && args.path !== '') {
        params.path = String(args.path)
      }
      if (typeof args.case === 'boolean') params.case = args.case
      if (typeof args.gitignore === 'boolean') params.gitignore = args.gitignore
      if (typeof args.skip === 'number') params.skip = args.skip
      const result = await tool.execute('grep', params as never, exec.signal)
      const text = toText(result)
      const details = (result.details ?? {}) as Record<string, unknown>
      return {
        text,
        ...(typeof details.matchCount === 'number' ? { matchCount: details.matchCount } : {}),
        ...(typeof details.fileCount === 'number' ? { fileCount: details.fileCount } : {}),
        ...(Array.isArray(details.files) ? { files: details.files as string[] } : {}),
        ...(typeof details.scopePath === 'string' ? { scopePath: details.scopePath } : {}),
        ...(details.truncated === true ? { truncated: true } : {}),
      }
    },
    presentCall: (args: any) => ({
      card: 'generic',
      title: `Grep ${String(args.pattern ?? '').slice(0, 60)}`,
      kind: 'execute',
      rawInput: String(args.path ?? '.'),
    }),
    presentResult: (_args: any, result: any) => {
      if ((result as any)?.isError) return undefined
      return undefined
    },
  }))
}

// Aliases for integration
export const applyGrep = registerGrep
export const registerGrepTool = registerGrep
export default registerGrep
