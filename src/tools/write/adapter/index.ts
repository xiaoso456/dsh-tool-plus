/**
 * DSH write tool — adapter that wires the verbatim OMP write engine
 * (`src/tools/write/adapter/omp/`) into DSH's `defineTool` contract.
 *
 * This file is pure glue. All write logic lives in `omp/` (copied verbatim);
 * this adapter only:
 *  - builds an OMP `ToolSession` from the DSH exec context + tool-plus config,
 *  - constructs the verbatim `WriteTool` and calls its `execute`,
 *  - converts the `AgentToolResult` back to a DSH tool result.
 *
 * LSP/ACP/TUI are absent in DSH (plan.md §2): writethrough writes through
 * ctx.fs, diagnostics are never produced, and no TUI rendering happens.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AgentToolResult } from '@oh-my-pi/pi-agent-core'
import type { RuntimeConfig } from '../../../config/settings.ts'
import { renderOmpPrompt, sanitizeWritePrompt } from '../../shared/omp-prompt.ts'
import { attachOmpSessionState, persistOmpSessionState } from '../../shared/session-state.ts'
import { Settings } from './config/settings.ts'
import { getDefault } from './config/settings-schema.ts'
import type { ToolSession } from './sdk.ts'
import { WriteTool } from './omp/write.ts'
import writeMd from './prompts/tools/write.md' with { type: 'text' }

// OMP tools import `Settings` from the tools barrel (`..`); surface it here.
export type { Settings } from './config/settings.ts'
export type { ToolSession } from './sdk.ts'

/** Build the OMP ToolSession facade over a DSH exec context. */
function createToolSession(exec: any, cfg: RuntimeConfig): ToolSession {
  const cwd: string = exec?.agent?.session?.header?.cwd ?? process.cwd()
  const settings = new Settings(cfg, getDefault)
  const session: ToolSession = { cwd, settings, enableLsp: false, hasEditTool: true }
  // 恢复本 DSH session 上次调用保存的 OMP 引擎状态（冲突注册表等，T11-2）。
  attachOmpSessionState(session, exec?.agent?.session)
  return session
}

/** Extract the text content of an OMP AgentToolResult (throws on isError). */
function toText(result: AgentToolResult<any>): string {
  const text = result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  if (result.isError) {
    throw new Error(text || 'write failed')
  }
  return text
}

/** DSH write 工具输出形状（output.schema 镜像）。 */
export interface WriteToolOutput {
  path: string
  text: string
}

/** 完整执行链路（defineTool.execute 与单测共用）。 */
export async function executeWriteTool(exec: any, cfg: RuntimeConfig, args: any): Promise<WriteToolOutput> {
  const session = createToolSession(exec, cfg)
  const tool = new WriteTool(session)
  const result = await tool.execute(
    'write',
    { path: String(args.path ?? ''), content: String(args.content ?? '') },
    exec.signal,
  )
  // 引擎可能惰性新建了 ConflictHistory 等状态，写回共享存储供下次调用恢复。
  persistOmpSessionState(exec?.agent?.session, session)
  const text = toText(result)
  const details = (result.details ?? {}) as Record<string, unknown>
  return {
    path: String(details.resolvedPath ?? args.path ?? ''),
    text,
  }
}

/**
 * Register the write tool (OMP native `path` + `content` parameters).
 */
export function registerWrite(ctx: Context, getConfig: () => RuntimeConfig): void {
  ctx.tools.register(defineTool({
    name: 'write',
    // OMP 原版提示词（prompts/tools/write.md verbatim，无 DSH 不适用提法）。
    description: renderOmpPrompt(sanitizeWritePrompt(writeMd), {}),
    parameters: {
      path: { type: 'string', required: true, description: 'File path to write, or archive/sqlite target, or hashline header.' },
      content: { type: 'string', required: true, description: 'Full file content.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args: any, value: any) => [{ type: 'text', text: String(value.text ?? '') }],
      presentationMeta: (_args: any, value: any) => ({
        ...(value.path !== undefined ? { path: value.path } : {}),
      }) as any,
    },
    async execute(args: any, exec: any) {
      return executeWriteTool(exec, getConfig(), args)
    },
    presentCall: (args: any) => ({
      card: 'generic',
      title: `Write ${String(args.path).slice(0, 80)}`,
      kind: 'execute',
      rawInput: String(args.path),
    }),
    presentResult: (_args: any, result: any) => {
      if ((result as any)?.isError) return undefined
      return undefined
    },
  }))
}

// Aliases for integration
export const applyWrite = registerWrite
export const registerWriteTool = registerWrite
export default registerWrite
