/**
 * OpenAI Chat Completions 线格式构造器。
 *
 * 纯函数、零 IO —— 只拼 SSE 帧，不管路由与时序。格式事实来源是 pi-ai 的
 * `src/providers/openai-completions.ts`：它认的推理字段是 `reasoning_content`
 * （也接受 `reasoning` / `reasoning_text`），`usage` 尾包的 `choices` 必须是空数组。
 *
 * 为什么要单独一层：帧的形状错了，被测方会静默丢掉内容（比如不发
 * `reasoning_content` 界面上就永远没有思考块），把帧构造隔离成纯函数才能用单测钉住。
 *
 * @module tests/support/mock-openai
 */

/** 一次回答的用量；`usageChunk` 尾包用。 */
export interface MockUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

/** 流式 tool_calls 分片；同一 `index` 的分片由客户端聚合。 */
export interface MockToolCallDelta {
  index: number
  id?: string
  type?: 'function'
  function?: { name?: string; arguments?: string }
}

/** 已聚合的完整 tool_call（非流式响应体用）。 */
export interface MockToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** 非流式回答的 message 体。 */
export interface MockAssistantMessage {
  role: 'assistant'
  content: string | null
  reasoning_content?: string
  tool_calls?: MockToolCall[]
}

/** 单帧可选项。 */
export interface MockChunkOptions {
  /** 非 null 时写进 `choices[0].finish_reason`。 */
  finishReason?: string | null
  created?: number
}

/** OpenAI 流的终止帧，必须逐字节完全一致。 */
export const SSE_DONE_FRAME = 'data: [DONE]\n\n'

/** 秒级时间戳（OpenAI 的 `created` 就是秒）。 */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

let completionSeq = 0

/** 每次调用给一个不同的 completion id。 */
export function newCompletionId(): string {
  completionSeq += 1
  return `chatcmpl-mock-${completionSeq.toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** 一帧 SSE。 */
export function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** 按 chunkSize 切段；`chunkSize <= 0` 或文本更短时原样一段。 */
export function splitText(text: string, chunkSize: number): string[] {
  if (chunkSize <= 0 || text.length <= chunkSize) return [text]
  const parts: string[] = []
  for (let index = 0; index < text.length; index += chunkSize) parts.push(text.slice(index, index + chunkSize))
  return parts
}

function envelope(id: string, model: string, created: number): Record<string, unknown> {
  return { id, object: 'chat.completion.chunk', created, model }
}

function deltaChunk(
  id: string,
  model: string,
  delta: Record<string, unknown>,
  options: MockChunkOptions,
): Record<string, unknown> {
  return {
    ...envelope(id, model, options.created ?? nowSeconds()),
    choices: [{ index: 0, delta, finish_reason: options.finishReason ?? null }],
  }
}

/** 角色帧：先说自己是 assistant，再给内容。 */
export function roleChunk(id: string, model: string, options: MockChunkOptions = {}): Record<string, unknown> {
  return deltaChunk(id, model, { role: 'assistant', content: '' }, options)
}

/** 正文分片。 */
export function textChunk(id: string, model: string, text: string, options: MockChunkOptions = {}): Record<string, unknown> {
  return deltaChunk(id, model, { content: text }, options)
}

/**
 * 推理分片。字段名是 `reasoning_content` —— pi-ai 只有在这个字段非空时才产
 * `thinking_delta`，界面上才有「思考」。不发它，工具调用一样会跑，但思考块永远不出现。
 */
export function reasoningChunk(id: string, model: string, text: string, options: MockChunkOptions = {}): Record<string, unknown> {
  return deltaChunk(id, model, { reasoning_content: text }, options)
}

/** tool_calls 分片。 */
export function toolCallsChunk(
  id: string,
  model: string,
  deltas: readonly MockToolCallDelta[],
  options: MockChunkOptions = {},
): Record<string, unknown> {
  return deltaChunk(id, model, { tool_calls: deltas }, options)
}

/** 结算帧：只带 finish_reason。 */
export function finishChunk(
  id: string,
  model: string,
  finishReason: string,
  options: MockChunkOptions = {},
): Record<string, unknown> {
  return deltaChunk(id, model, {}, { ...options, finishReason })
}

/** usage 尾包：`choices` 必须为空数组（OpenAI 规范），pi 从 `usage` 字段读。 */
export function usageChunk(
  id: string,
  model: string,
  usage: MockUsage,
  options: MockChunkOptions = {},
): Record<string, unknown> {
  return { ...envelope(id, model, options.created ?? nowSeconds()), choices: [], usage }
}

/** 非流式回答体。 */
export function completionResponse(
  id: string,
  model: string,
  message: MockAssistantMessage,
  finishReason: string,
  usage: MockUsage,
  created: number = nowSeconds(),
): Record<string, unknown> {
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage,
  }
}

/** 单个模型对象。 */
export function modelObject(id: string, created: number = nowSeconds()): Record<string, unknown> {
  return { id, object: 'model', created, owned_by: 'mock' }
}

/** `GET /v1/models` 的响应体。 */
export function modelsResponse(ids: readonly string[], created: number = nowSeconds()): Record<string, unknown> {
  return { object: 'list', data: ids.map((id) => modelObject(id, created)) }
}

/** 错误体：形状必须符合 openai SDK 的期望 `{ error: { message, type, param, code } }`。 */
export function errorPayload(
  message: string,
  options: { type?: string; param?: string | null; code?: string | null } = {},
): Record<string, unknown> {
  return {
    error: {
      message,
      type: options.type ?? 'invalid_request_error',
      param: options.param ?? null,
      code: options.code ?? null,
    },
  }
}
