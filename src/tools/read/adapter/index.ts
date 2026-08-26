/**
 * DSH read tool — adapter that wires the verbatim OMP read engine
 * (`src/tools/read/adapter/omp/`) into DSH's `defineTool` contract.
 *
 * This file is pure glue. All read logic lives in `omp/` (copied verbatim);
 * this adapter only:
 *  - builds an OMP `ToolSession` from the DSH exec context + tool-plus config,
 *  - constructs the verbatim `ReadTool` and calls its `execute`,
 *  - converts the `AgentToolResult` back to a DSH tool result.
 *
 * plan.md 拍板#2: read keeps OMP's native single-param style (`path` with
 * inline `:N-M` selectors); DSH `offset/limit` are not exposed.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AgentToolResult } from '@oh-my-pi/pi-agent-core'
import type { RuntimeConfig } from '../../../config/settings.ts'
import { renderOmpPrompt, sanitizeReadPrompt } from '../../shared/omp-prompt.ts'
import { attachOmpSessionState, persistOmpSessionState } from '../../shared/session-state.ts'
import { Settings } from '../../omp/config/settings.ts'
import { getDefault } from '../../omp/config/settings-schema.ts'
import type { ToolSession } from '../../omp/sdk.ts'
import { formatOutputNotice, type OutputMeta } from '../../omp/tools/output-meta.ts'
import { ReadTool } from '../../omp/tools/read.ts'
import readMd from '../../omp/prompts/tools/read.md' with { type: 'text' }

// OMP tools import `Settings` from the tools barrel (`..`); surface it here.
export type { Settings } from '../../omp/config/settings.ts'
export type { ToolSession } from '../../omp/sdk.ts'

/** Build the OMP ToolSession facade over a DSH exec context. */
function createToolSession(exec: any, cfg: RuntimeConfig): ToolSession {
  const cwd: string = exec?.agent?.session?.header?.cwd ?? process.cwd()
  const settings = new Settings(cfg, getDefault)
  // 临时调试日志：read 实际用到的模式（hashline 排查）。
  console.log(`[tool-plus-debug] read session: cfg.editMode=${cfg.editMode} settings.get(edit.mode)=${String(settings.get('edit.mode'))}`)
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
    throw new Error(text || 'read failed')
  }
  return text
}

/** DSH read 工具输出形状（output.schema 镜像）。 */
export interface ReadToolOutput {
  path: string
  text: string
  /** OMP session 层追加的截断/限量提示（formatOutputNotice 结果，可为空）。 */
  notice?: string
  totalLines?: number
  truncated?: boolean
}

/**
 * 把 OMP AgentToolResult 转成 DSH read 工具输出。
 *
 * OMP 的截断/限量提示不在工具文本里，由 session 层 `formatOutputNotice(meta)`
 * 追加（messages.ts 语义）；DSH 无 session 层，适配层在此补上（T02）。
 */
export function toReadToolResult(result: AgentToolResult<any>, args: any): ReadToolOutput {
  const text = toText(result)
  const details = (result.details ?? {}) as Record<string, unknown>
  const notice = formatOutputNotice(details.meta as OutputMeta | undefined)
  return {
    path: String(details.resolvedPath ?? args.path ?? ''),
    text,
    ...(notice ? { notice } : {}),
    ...(typeof details.totalLines === 'number' ? { totalLines: details.totalLines } : {}),
    ...(typeof details.truncation !== 'undefined' ? { truncated: true } : {}),
  }
}

/** render：模型可见文本 = 工具文本 + session 层提示（OMP messages.ts 语义）。 */
export function renderReadOutput(value: ReadToolOutput): string {
  return String(value.text ?? '') + (value.notice ?? '')
}

/** 完整执行链路（defineTool.execute 与单测共用）。 */
export async function executeReadTool(exec: any, cfg: RuntimeConfig, args: any): Promise<ReadToolOutput> {
  // 临时调试日志：execute 收到的 cfg 与最终输出（hashline 排查）。
  console.log(`[tool-plus-debug] read execute: cfg.editMode=${cfg.editMode} path=${String(args.path ?? '')}`)
  const session = createToolSession(exec, cfg)
  const tool = new ReadTool(session)
  const result = await tool.execute('read', { path: String(args.path ?? '') }, exec.signal)
  // 引擎可能惰性新建了 ConflictHistory 等状态，写回共享存储供下次调用恢复。
  persistOmpSessionState(exec?.agent?.session, session)
  const out = toReadToolResult(result, args)
  console.log(`[tool-plus-debug] read output: text=${JSON.stringify(out.text.slice(0, 120))}`)
  return out
}

/**
 * Register the read tool (OMP native `path` + inline selector parameter,
 * plan.md 拍板#2).
 */
export function registerRead(ctx: Context, getConfig: () => RuntimeConfig): () => void {
  // 返回 disposer：editMode 热更新时重注册以刷新 IS_HL_MODE 描述（见 src/index.ts）。
  return ctx.tools.register(defineTool({
    name: 'read',
    // OMP 原版提示词（prompts/tools/read.md verbatim），经 shared/omp-prompt
    // 剔除 DSH 不适用提法 + 渲染 {{#if}} 条件（IS_HL_MODE 跟随 edit.mode）。
    description: renderOmpPrompt(sanitizeReadPrompt(readMd), {
      IS_HL_MODE: getConfig().editMode === 'hashline',
      INSPECT_IMAGE_ENABLED: false,
    }),
    parameters: {
      path: { type: 'string', required: true, description: 'File path with optional inline selector, e.g. "src/foo.ts:10-20" or "README.md:raw:1-50".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          text: { type: 'string', required: true },
          notice: { type: 'string' },
          truncated: { type: 'boolean' },
          totalLines: { type: 'number' },
          offset: { type: 'number' },
        },
      },
      render: (_args: any, value: any) => [{ type: 'text', text: renderReadOutput(value) }],
      presentationMeta: (_args: any, value: any) => ({
        ...(value.path !== undefined ? { path: value.path } : {}),
        ...(value.offset !== undefined ? { offset: value.offset } : {}),
        ...(value.totalLines !== undefined ? { lines: value.totalLines } : {}),
      }) as any,
    },
    async execute(args: any, exec: any) {
      return executeReadTool(exec, getConfig(), args)
    },
    presentCall: (args: any) => ({
      card: 'generic',
      title: `Read ${String(args.path).slice(0, 80)}`,
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
export const applyRead = registerRead
export const registerReadTool = registerRead
export default registerRead
