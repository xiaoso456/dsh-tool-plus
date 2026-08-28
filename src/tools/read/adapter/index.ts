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
import type { AttachmentsService, ImageBridge, LlmRouteService, SavedImageRef } from '../../shared/image-bridge.ts'
import readMd from '../../omp/prompts/tools/read.md' with { type: 'text' }

// OMP tools import `Settings` from the tools barrel (`..`); surface it here.
export type { Settings } from '../../omp/config/settings.ts'
export type { ToolSession } from '../../omp/sdk.ts'

/** Build the OMP ToolSession facade over a DSH exec context + tool-plus config. */
function createToolSession(exec: any, cfg: RuntimeConfig, ctx: Context): ToolSession {
  const cwd: string = exec?.agent?.session?.header?.cwd ?? process.cwd()
  const settings = new Settings(cfg, getDefault)
  const session: ToolSession = { cwd, settings, hasEditTool: true, imageBridge: () => buildImageBridge(ctx, exec) }
  // 恢复本 DSH session 上次调用保存的 OMP 引擎状态（冲突注册表等，T11-2）。
  attachOmpSessionState(session, exec?.agent?.session)
  return session
}

/**
 * DSH image bridge (拍板#22): attachments + llm services wrapped for the OMP
 * engines, plus the route vision-capability probe mirroring the official
 * read_image gate (`session.requestHeader().config` → agent options →
 * `llm.resolveModelInfo`). 'unknown' (route/model not resolvable) passes —
 * omp-flavored permissiveness; the attachment store's own checks stay
 * authoritative and non-vision routes still get the soft metadata refusal.
 */
function buildImageBridge(ctx: Context, exec: any): ImageBridge {
  const attachments = (ctx as { get?: (k: never) => unknown } | null | undefined)?.get?.('attachments' as never) as AttachmentsService | undefined
  return {
    attachments,
    routeImageSupport: async () => {
      const routed = exec?.agent?.session?.requestHeader?.()?.config
      const provider: string | undefined = routed?.provider ?? exec?.agent?.options?.provider
      const model: string | undefined = routed?.model ?? exec?.agent?.options?.model
      const llm = (ctx as { get?: (k: never) => unknown } | null | undefined)?.get?.('llm' as never) as LlmRouteService | undefined
      if (provider === undefined || model === undefined || typeof llm?.resolveModelInfo !== 'function') return 'unknown'
      try {
        const info = await llm.resolveModelInfo(provider, model, new AbortController().signal)
        if (info?.inputModalities === undefined) return 'unknown'
        return info.inputModalities.includes('image') ? 'supported' : 'unsupported'
      } catch {
        return 'unknown'
      }
    },
  }
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
  /** 拍板#22：图片读取的附件提交结果（信封文本已并入 text，此字段供 UI/审计）。 */
  image?: SavedImageRef
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
    ...(details.image !== undefined && typeof details.image === 'object' ? { image: details.image as SavedImageRef } : {}),
  }
}

/** render：模型可见文本 = 工具文本 + session 层提示（OMP messages.ts 语义）。 */
export function renderReadOutput(value: ReadToolOutput): string {
  return String(value.text ?? '') + (value.notice ?? '')
}

/** 完整执行链路（defineTool.execute 与单测共用）。 */
export async function executeReadTool(exec: any, cfg: RuntimeConfig, args: any, ctx: Context): Promise<ReadToolOutput> {
  const session = createToolSession(exec, cfg, ctx)
  const tool = new ReadTool(session)
  const result = await tool.execute('read', { path: String(args.path ?? '') }, exec.signal)
  // 引擎可能惰性新建了 ConflictHistory / fileSnapshotStore 等状态，写回共享
  // 存储供下次调用恢复（T11-2 / A-4：快照库随会话跨调用保持）。
  persistOmpSessionState(exec?.agent?.session, session)
  return toReadToolResult(result, args)
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
          image: {
            type: 'object',
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              name: { type: 'string' },
              originalDimensions: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  width: { type: 'integer', required: true },
                  height: { type: 'integer', required: true },
                },
              },
            },
          },
        },
      },
      // 模型可见块：文本（信封/正文 + session 层提示）；图片读取成功时附官方
      // attachment 引用块（DSH 内容模型唯一的图片形态，拍板#22）。
      render: (_args: any, value: any) => {
        const blocks: Array<Record<string, unknown>> = [{ type: 'text', text: renderReadOutput(value) }]
        const image = value?.image as SavedImageRef | undefined
        if (image?.attachmentId) {
          blocks.push({
            type: 'image',
            attachment: {
              attachmentId: image.attachmentId,
              mediaType: image.mediaType,
              bytes: image.bytes,
              width: image.width,
              height: image.height,
              ...(image.name === undefined ? {} : { name: image.name }),
              ...(image.originalDimensions === undefined ? {} : { originalDimensions: image.originalDimensions }),
            },
          })
        }
        return blocks as never
      },
      presentationMeta: (_args: any, value: any) => ({
        ...(value.path !== undefined ? { path: value.path } : {}),
        ...(value.offset !== undefined ? { offset: value.offset } : {}),
        ...(value.totalLines !== undefined ? { lines: value.totalLines } : {}),
      }) as any,
    },
    async execute(args: any, exec: any) {
      return executeReadTool(exec, getConfig(), args, ctx)
    },
    // 并发安全声明（read_image 官方 isConcurrencySafe: true 接过来，2026-08-28）：
    // 逐调用分类器，每次调度时求值——readConcurrentSafe 配置改动即时生效，无需重启。
    // `!== false`：默认开启，仅显式关闭才串行（getConfig 可能返回未解析的部分配置）。
    isConcurrencySafe: () => getConfig().readConcurrentSafe !== false,
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
