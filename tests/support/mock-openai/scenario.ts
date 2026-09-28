/**
 * mock 场景模型：类型、JSON 校验、轮次匹配与解析。
 *
 * 设计要点（照抄 pi 的 `test/support/mock-openai/scenario.ts`）：
 * 1. **轮次由 `match` 谓词选择，不是靠计数器**。计数器会被任何一次额外请求（最典型的是
 *    会话标题请求）带偏，而谓词看的是这次请求长什么样。
 * 2. **按会话分桶**（`bucketBy`）。标题请求没有 user 消息，用 `firstUserMessage` 分桶就天然
 *    和主对话分在不同的队列里，互不消耗。
 * 3. 除 `loadScenarioFile` 外全是纯函数，方便单测。
 *
 * @module tests/support/mock-openai
 */

import { readFileSync } from 'node:fs'
import type { MockUsage } from './protocol.ts'

/** 可注入的故障类型。 */
export type MockFaultKind = 'httpError' | 'errorChunk' | 'abortMidStream' | 'delay'

const FAULT_KINDS: readonly MockFaultKind[] = ['httpError', 'errorChunk', 'abortMidStream', 'delay']

/** 一次注入的故障。 */
export interface MockFault {
  kind: MockFaultKind
  /** httpError：HTTP 状态码，默认 500。 */
  status?: number
  message?: string
  /** errorChunk / abortMidStream：第几帧之后触发，默认 1。 */
  afterChunks?: number
  /** delay：毫秒。 */
  delayMs?: number
}

/** 轮次匹配谓词；给出的每一项都必须成立。 */
export interface MockTurnMatch {
  model?: string
  /** 本会话内第几次 chat/completions 请求（0 起）。 */
  requestIndex?: number
  messageCount?: number
  /** 所有消息的文本拼接后包含该子串。 */
  messageContains?: string
  /** 所有 `role === "tool"` 的消息拼接后包含该子串。 */
  toolResultContains?: string
  /** 第一条 `role === "user"` 的文本恰好包含该子串；无 user 消息时按 `""` 比对。 */
  firstUserMessageContains?: string
}

/** 轮次要发起的工具调用。 */
export interface MockTurnToolCall {
  id?: string
  name: string
  /** 已经序列化好的参数 JSON 字符串。 */
  arguments: string
  /** 参数切成几段下发，默认 1（复现真实流式）。 */
  argumentChunks?: number
}

/** 一条脚本化轮次。 */
export interface MockTurn {
  name?: string
  match?: MockTurnMatch
  text?: string
  reasoning?: string
  toolCalls?: MockTurnToolCall[]
  finishReason?: string
  /** 省略 = 按内容推导；`null` = 不发 usage 尾包。 */
  usage?: Partial<MockUsage> | null
  chunkSize?: number
  fault?: MockFault
}

/** 场景级默认值。 */
export interface MockScenarioDefaults {
  chunkSize?: number
}

/** 轮次队列的分桶键来源；默认 `firstUserMessage`（标题请求与主对话天然分桶）。 */
export type MockBucketBy = 'header' | 'model' | 'firstUserMessage' | 'none'

const BUCKET_KINDS: readonly MockBucketBy[] = ['header', 'model', 'firstUserMessage', 'none']

/** 一个场景。 */
export interface MockScenario {
  name: string
  /** `/v1/models` 对外宣告的模型 id，默认 `["mock-model"]`。 */
  models?: string[]
  /** 轮次队列分桶方式，默认 `firstUserMessage`。 */
  bucketBy?: MockBucketBy
  /** `bucketBy === "header"` 时读取的 header 名；`x-mock-session` 始终最高优先。 */
  bucketHeader?: string
  turns: MockTurn[]
  /** 没有轮次匹配时兜底；不配则回结构化 500。 */
  fallback?: MockTurn
  defaults?: MockScenarioDefaults
}

/** 一次请求的只读视图，供 `match` 判定。 */
export interface MockRequestView {
  model: string
  /** 本会话内第几次 chat/completions 请求（0 起）。 */
  requestIndex: number
  messageCount: number
  messageText: string
  toolResultText: string
  firstUserMessage: string
  stream: boolean
}

/** 每个 bucket 一份的轮次状态。 */
export interface MockSessionState {
  requestIndex: number
  usedTurns: Set<number>
}

/** 解析并补全默认值后的轮次。 */
export interface ResolvedTurn {
  name: string
  text: string
  reasoning: string
  toolCalls: Required<MockTurnToolCall>[]
  finishReason: string
  usage: MockUsage | null
  chunkSize: number
  fault: MockFault | null
}

/** 没有轮次匹配（且无 fallback）时抛这个，服务器据此回结构化 500。 */
export class MockScenarioExhaustedError extends Error {
  constructor(readonly scenarioName: string, readonly view: MockRequestView) {
    super(`mock-openai: scenario "${scenarioName}" has no turn matching request #${String(view.requestIndex)} `
      + `(messages=${String(view.messageCount)}, firstUser=${JSON.stringify(view.firstUserMessage.slice(0, 40))})`)
    this.name = 'MockScenarioExhaustedError'
  }
}

/* -------------------------------------------------------------------------- */
/* JSON 读取与校验                                                             */
/* -------------------------------------------------------------------------- */

function objectOf(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`mock-openai: ${where} 必须是对象`)
  }
  return value as Record<string, unknown>
}

function stringOf(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new Error(`mock-openai: ${where} 必须是字符串`)
  return value
}

function optionalString(value: unknown, where: string): string | undefined {
  return value === undefined ? undefined : stringOf(value, where)
}

function numberOr(value: unknown, where: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`mock-openai: ${where} 必须是数字`)
  return value
}

function parseMatch(raw: unknown, where: string): MockTurnMatch | undefined {
  if (raw === undefined) return undefined
  const source = objectOf(raw, where)
  const match: MockTurnMatch = {}
  if (source.model !== undefined) match.model = stringOf(source.model, `${where}.model`)
  if (source.requestIndex !== undefined) match.requestIndex = numberOr(source.requestIndex, `${where}.requestIndex`, 0)
  if (source.messageCount !== undefined) match.messageCount = numberOr(source.messageCount, `${where}.messageCount`, 0)
  if (source.messageContains !== undefined) match.messageContains = stringOf(source.messageContains, `${where}.messageContains`)
  if (source.toolResultContains !== undefined) match.toolResultContains = stringOf(source.toolResultContains, `${where}.toolResultContains`)
  if (source.firstUserMessageContains !== undefined) match.firstUserMessageContains = stringOf(source.firstUserMessageContains, `${where}.firstUserMessageContains`)
  return match
}

function parseFault(raw: unknown, where: string): MockFault | undefined {
  if (raw === undefined) return undefined
  const source = objectOf(raw, where)
  const kind = stringOf(source.kind, `${where}.kind`) as MockFaultKind
  if (!FAULT_KINDS.includes(kind)) throw new Error(`mock-openai: ${where}.kind 非法：${kind}`)
  const fault: MockFault = { kind }
  if (source.status !== undefined) fault.status = numberOr(source.status, `${where}.status`, 500)
  if (source.message !== undefined) fault.message = stringOf(source.message, `${where}.message`)
  if (source.afterChunks !== undefined) fault.afterChunks = numberOr(source.afterChunks, `${where}.afterChunks`, 1)
  if (source.delayMs !== undefined) fault.delayMs = numberOr(source.delayMs, `${where}.delayMs`, 0)
  return fault
}

function parseToolCalls(raw: unknown, where: string): MockTurnToolCall[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new Error(`mock-openai: ${where} 必须是数组`)
  return raw.map((entry, index) => {
    const source = objectOf(entry, `${where}[${String(index)}]`)
    return {
      id: optionalString(source.id, `${where}[${String(index)}].id`),
      name: stringOf(source.name, `${where}[${String(index)}].name`),
      arguments: stringOf(source.arguments, `${where}[${String(index)}].arguments`),
      argumentChunks: source.argumentChunks === undefined
        ? undefined
        : numberOr(source.argumentChunks, `${where}[${String(index)}].argumentChunks`, 1),
    }
  })
}

function parseUsage(raw: unknown, where: string): Partial<MockUsage> | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  const source = objectOf(raw, where)
  return {
    prompt_tokens: numberOr(source.prompt_tokens, `${where}.prompt_tokens`, 0),
    completion_tokens: numberOr(source.completion_tokens, `${where}.completion_tokens`, 0),
    total_tokens: numberOr(source.total_tokens, `${where}.total_tokens`, 0),
  }
}

function parseTurn(raw: unknown, where: string): MockTurn {
  const source = objectOf(raw, where)
  const turn: MockTurn = {
    name: optionalString(source.name, `${where}.name`),
    match: parseMatch(source.match, `${where}.match`),
    text: optionalString(source.text, `${where}.text`),
    reasoning: optionalString(source.reasoning, `${where}.reasoning`),
    toolCalls: parseToolCalls(source.toolCalls, `${where}.toolCalls`),
    finishReason: optionalString(source.finishReason, `${where}.finishReason`),
    usage: parseUsage(source.usage, `${where}.usage`),
    chunkSize: source.chunkSize === undefined ? undefined : numberOr(source.chunkSize, `${where}.chunkSize`, 0),
    fault: parseFault(source.fault, `${where}.fault`),
  }
  if (turn.text === undefined && turn.toolCalls === undefined && turn.fault === undefined) {
    throw new Error(`mock-openai: ${where} 至少要给出 text / toolCalls / fault 之一`)
  }
  return turn
}

/** 把解析出来的原始对象规整成场景。 */
export function normalizeScenario(raw: unknown, where = 'scenario'): MockScenario {
  const source = objectOf(raw, where)
  if (!Array.isArray(source.turns) || source.turns.length === 0) {
    throw new Error(`mock-openai: ${where}.turns 必须是非空数组`)
  }
  const bucketBy = source.bucketBy === undefined ? undefined : stringOf(source.bucketBy, `${where}.bucketBy`) as MockBucketBy
  if (bucketBy !== undefined && !BUCKET_KINDS.includes(bucketBy)) {
    throw new Error(`mock-openai: ${where}.bucketBy 非法：${bucketBy}`)
  }
  const models = source.models === undefined
    ? undefined
    : (Array.isArray(source.models) ? source.models.map((id, index) => stringOf(id, `${where}.models[${String(index)}]`)) : (() => {
      throw new Error(`mock-openai: ${where}.models 必须是数组`)
    })())
  return {
    name: stringOf(source.name, `${where}.name`),
    models,
    bucketBy,
    bucketHeader: optionalString(source.bucketHeader, `${where}.bucketHeader`),
    turns: source.turns.map((turn, index) => parseTurn(turn, `${where}.turns[${String(index)}]`)),
    fallback: source.fallback === undefined ? undefined : parseTurn(source.fallback, `${where}.fallback`),
    defaults: source.defaults === undefined
      ? undefined
      : { chunkSize: numberOr(objectOf(source.defaults, `${where}.defaults`).chunkSize, `${where}.defaults.chunkSize`, 0) },
  }
}

/**
 * 读一个场景 JSON。
 * @param path - 场景文件路径。
 * @param options.tokens - 文本替换表，形如 `{ '<scratch>': 'C:/tmp/x' }`；在 JSON.parse **前**对原文做**原样**
 *   替换（不做 JSON 转义——占位符可能嵌在 `arguments` 这种「字符串里还是 JSON」的位置，转义层级交给调用方：
 *   给正斜杠路径就不存在转义问题）。
 * @returns 规整好的场景。
 */
export function loadScenarioFile(path: string, options: { tokens?: Record<string, string> } = {}): MockScenario {
  let text = readFileSync(path, 'utf8')
  for (const [token, value] of Object.entries(options.tokens ?? {})) {
    text = text.split(token).join(value)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`mock-openai: ${path} 不是合法 JSON：${String(error)}`)
  }
  return normalizeScenario(parsed, path)
}

/* -------------------------------------------------------------------------- */
/* 请求视图、分桶、选轮                                                         */
/* -------------------------------------------------------------------------- */

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (typeof part === 'object' && part !== null) {
          const text = (part as { text?: unknown }).text
          if (typeof text === 'string') return text
        }
        return ''
      })
      .join('')
  }
  return ''
}

interface MessageLike {
  role?: unknown
  content?: unknown
}

/**
 * 把一次请求投影成 `match` 判定要用的视图。
 * @param body - 已解析的请求体。
 * @param requestIndex - 本会话内这次请求的序号。
 * @returns 只读视图。
 */
export function buildRequestView(body: unknown, requestIndex: number): MockRequestView {
  const source = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const messages = Array.isArray(source.messages) ? (source.messages as MessageLike[]) : []
  const texts = messages.map((message) => contentText(message?.content))
  const toolResultText = messages
    .filter((message) => message?.role === 'tool')
    .map((message) => contentText(message.content))
    .join('\n')
  const firstUser = messages.find((message) => message?.role === 'user')
  return {
    model: typeof source.model === 'string' ? source.model : '',
    requestIndex,
    messageCount: messages.length,
    messageText: texts.join('\n'),
    toolResultText,
    firstUserMessage: firstUser === undefined ? '' : contentText(firstUser.content),
    stream: source.stream === true,
  }
}

/**
 * 算这次请求落在哪个轮次队列。
 * `x-mock-session` 头始终最高优先（同一个进程里跑多会话时用它隔离）。
 * @param scenario - 场景。
 * @param sessionHeader - `x-mock-session` 的值，缺省 undefined。
 * @param view - 请求视图。
 * @param bucketHeaderValue - `bucketBy === "header"` 时 `bucketHeader` 指定的那个头的值；缺省视为没给。
 * @returns 队列 key。
 */
export function resolveBucketKey(
  scenario: MockScenario,
  sessionHeader: string | undefined,
  view: MockRequestView,
  bucketHeaderValue?: string | undefined,
): string {
  if (sessionHeader !== undefined && sessionHeader !== '') return sessionHeader
  switch (scenario.bucketBy ?? 'firstUserMessage') {
    case 'none': return 'default'
    case 'model': return `model:${view.model}`
    case 'firstUserMessage': return `user:${view.firstUserMessage.slice(0, 120)}`
    case 'header': return bucketHeaderValue === undefined || bucketHeaderValue === ''
      ? 'default'
      : `header:${bucketHeaderValue}`
  }
}

/** 新建一份队列状态。 */
export function createSessionState(): MockSessionState {
  return { requestIndex: 0, usedTurns: new Set<number>() }
}

function matches(match: MockTurnMatch | undefined, view: MockRequestView): boolean {
  if (match === undefined) return true
  if (match.model !== undefined && match.model !== view.model) return false
  if (match.requestIndex !== undefined && match.requestIndex !== view.requestIndex) return false
  if (match.messageCount !== undefined && match.messageCount !== view.messageCount) return false
  if (match.messageContains !== undefined && !view.messageText.includes(match.messageContains)) return false
  if (match.toolResultContains !== undefined && !view.toolResultText.includes(match.toolResultContains)) return false
  if (match.firstUserMessageContains !== undefined && !view.firstUserMessage.includes(match.firstUserMessageContains)) return false
  return true
}

/**
 * 挑这一轮的脚本：按声明顺序取**第一条既没用过、谓词又成立**的轮次。
 * @param scenario - 场景。
 * @param view - 请求视图。
 * @param state - 该队列的状态；命中后把该轮的序号记进 `usedTurns`。
 * @returns 命中的轮次；都没命中且有 fallback 时返回 fallback（fallback 不消耗）。
 * @throws {MockScenarioExhaustedError} 都没命中且没有 fallback。
 */
export function selectTurn(scenario: MockScenario, view: MockRequestView, state: MockSessionState): MockTurn {
  for (const [index, turn] of scenario.turns.entries()) {
    if (state.usedTurns.has(index)) continue
    if (!matches(turn.match, view)) continue
    state.usedTurns.add(index)
    return turn
  }
  if (scenario.fallback !== undefined) return scenario.fallback
  throw new MockScenarioExhaustedError(scenario.name, view)
}

/** 补全默认值后的轮次。 */
export function resolveTurn(turn: MockTurn, defaults: MockScenarioDefaults | undefined): ResolvedTurn {
  const chunkSize = turn.chunkSize ?? defaults?.chunkSize ?? 0
  const toolCalls = (turn.toolCalls ?? []).map((call, index) => ({
    id: call.id ?? `call_mock_${String(index + 1)}`,
    name: call.name,
    arguments: call.arguments,
    argumentChunks: call.argumentChunks ?? 1,
  }))
  const text = turn.text ?? ''
  const reasoning = turn.reasoning ?? ''
  const finishReason = turn.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop')
  let usage: MockUsage | null
  if (turn.usage === null) {
    usage = null
  } else if (turn.usage !== undefined) {
    usage = {
      prompt_tokens: turn.usage.prompt_tokens ?? 0,
      completion_tokens: turn.usage.completion_tokens ?? 0,
      total_tokens: turn.usage.total_tokens ?? 0,
    }
  } else {
    const completion = Math.max(1, Math.ceil((text.length + reasoning.length) / 4))
    usage = { prompt_tokens: 0, completion_tokens: completion, total_tokens: completion }
  }
  return {
    name: turn.name ?? `turn-${finishReason}`,
    text,
    reasoning,
    toolCalls,
    finishReason,
    usage,
    chunkSize,
    fault: turn.fault ?? null,
  }
}
