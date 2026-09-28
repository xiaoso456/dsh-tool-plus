/**
 * mock OpenAI 服务：`node:http` 薄 IO 层。
 *
 * 只负责路由、读写、时序与故障注入；协议构造在 `protocol.ts`，场景判定在 `scenario.ts`。
 * 和官方 `@deepseek-ai/dsh-llm-mock-server` 的差别只在协议面：那套说 Anthropic Messages，
 * 这套说 OpenAI Chat Completions（pi-ai 的 `openai-completions` 走的就是它）。
 *
 * 两个非协议端点（照抄 pi 的 `test/support/mock-openai/server.ts`）：
 * - `GET /__mock/requests[?sessionKey=]` 列出收到的请求（跨进程读断言用）
 * - `GET /__mock/requests/:seq` 读单条
 * 以及 `reset()`：清空请求记录与全部会话轮次状态——上一轮跑完的残留状态必须能清掉，
 * 否则下一轮会直接吃到上轮的终文（这是之前踩过的坑）。
 *
 * @module tests/support/mock-openai
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  completionResponse,
  errorPayload,
  finishChunk,
  modelObject,
  modelsResponse,
  newCompletionId,
  reasoningChunk,
  roleChunk,
  SSE_DONE_FRAME,
  splitText,
  sseFrame,
  textChunk,
  toolCallsChunk,
  usageChunk,
  type MockToolCallDelta,
} from './protocol.ts'
import {
  buildRequestView,
  createSessionState,
  MockScenarioExhaustedError,
  resolveBucketKey,
  resolveTurn,
  selectTurn,
  type MockScenario,
  type MockSessionState,
  type ResolvedTurn,
} from './scenario.ts'

/** 一条被记录的请求。 */
export interface RecordedRequest {
  /** 1 起的自增序号；`GET /__mock/requests/:seq` 按它查询。 */
  seq: number
  method: string
  path: string
  /** `x-mock-session` 头的值（缺省 `"default"`）。 */
  sessionKey: string
  /** 实际用于轮次队列分桶的 key。 */
  bucketKey: string
  stream: boolean
  headers: Record<string, string | string[]>
  body: unknown
  /** 命中的轮次名（协议请求才有）。 */
  turn?: string
  receivedAt: number
}

/** 服务参数。 */
export interface MockOpenAIServerOptions {
  scenario: MockScenario
  /** 0 = 由系统分配；默认 0。 */
  port?: number
  host?: string
  /** 每行一条日志的 sink；不给就丢弃。 */
  log?: (line: string) => void
  /** 附加到所有响应的固定响应头。 */
  headers?: Record<string, string>
}

/** 服务句柄。 */
export interface MockOpenAIServer {
  readonly url: string
  readonly port: number
  /** 收到的请求（按序）。 */
  readonly requests: RecordedRequest[]
  /** 清空请求记录与全部会话轮次状态。 */
  reset(): void
  close(): Promise<void>
}

const MAX_BODY_BYTES = 8 * 1024 * 1024

function sendJson(res: ServerResponse, status: number, payload: unknown, headers?: Record<string, string>): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...(headers ?? {}),
  })
  res.end(body)
}

function normalizedHeaders(req: IncomingMessage): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过 ${String(MAX_BODY_BYTES)} 字节`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', reject)
  })
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value[0] : value
}

/** 把一段参数 JSON 切成 `parts` 段（复现真实流式里参数分片到达）。 */
function splitArguments(args: string, parts: number): string[] {
  const count = Math.max(1, parts)
  if (count === 1 || args.length === 0) return [args]
  const size = Math.ceil(args.length / count)
  const out: string[] = []
  for (let index = 0; index < args.length; index += size) out.push(args.slice(index, index + size))
  return out
}

/** 一个 tool_call 的完整分片序列：先开 id/type/name，再逐段补参数。 */
function toolCallDeltas(call: ResolvedTurn['toolCalls'][number], index: number): MockToolCallDelta[] {
  const pieces = splitArguments(call.arguments, call.argumentChunks)
  const [head, ...rest] = pieces
  const deltas: MockToolCallDelta[] = [
    { index, id: call.id, type: 'function', function: { name: call.name, arguments: head ?? '' } },
  ]
  for (const piece of rest) deltas.push({ index, function: { arguments: piece } })
  return deltas
}

/**
 * 起一个 mock OpenAI 服务。
 * @param options - 场景与监听参数。
 * @returns 句柄；`url` 是 `http://host:port/v1`。
 */
export async function startMockOpenAI(options: MockOpenAIServerOptions): Promise<MockOpenAIServer> {
  const { scenario } = options
  const log = options.log ?? (() => {})
  const extraHeaders = options.headers ?? {}
  const requests: RecordedRequest[] = []
  const sessions = new Map<string, MockSessionState>()
  let seq = 0

  function sessionState(key: string): MockSessionState {
    let state = sessions.get(key)
    if (state === undefined) {
      state = createSessionState()
      sessions.set(key, state)
    }
    return state
  }

  function record(entry: Omit<RecordedRequest, 'seq' | 'receivedAt'>): RecordedRequest {
    seq += 1
    const row: RecordedRequest = { seq, receivedAt: Date.now(), ...entry }
    requests.push(row)
    return row
  }

  function handleRequestsList(res: ServerResponse, url: URL): void {
    const sessionKey = url.searchParams.get('sessionKey')
    sendJson(res, 200, {
      requests: requests.filter((row) => sessionKey === null || row.sessionKey === sessionKey),
    }, extraHeaders)
  }

  function handleRequestBySeq(res: ServerResponse, rawSeq: string): void {
    const wanted = Number(rawSeq)
    const row = requests.find((entry) => entry.seq === wanted)
    if (row === undefined) {
      sendJson(res, 404, errorPayload(`no request #${rawSeq}`, { code: 'not_found' }), extraHeaders)
      return
    }
    sendJson(res, 200, row, extraHeaders)
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => { setTimeout(resolve, ms) })
  }

  /** 依次写出一轮的帧。`chunksSent` 供 abortMidStream 之类的故障按帧数触发。 */
  function writeStream(res: ServerResponse, id: string, model: string, turn: ResolvedTurn): number {
    let sent = 0
    const write = (frame: string): void => { res.write(frame); sent += 1 }
    write(sseFrame(roleChunk(id, model)))
    if (turn.reasoning !== '') {
      for (const piece of splitText(turn.reasoning, turn.chunkSize)) write(sseFrame(reasoningChunk(id, model, piece)))
    }
    if (turn.text !== '') {
      for (const piece of splitText(turn.text, turn.chunkSize)) write(sseFrame(textChunk(id, model, piece)))
    }
    turn.toolCalls.forEach((call, index) => {
      write(sseFrame(toolCallsChunk(id, model, toolCallDeltas(call, index))))
    })
    write(sseFrame(finishChunk(id, model, turn.finishReason)))
    if (turn.usage !== null) write(sseFrame(usageChunk(id, model, turn.usage)))
    write(SSE_DONE_FRAME)
    return sent
  }

  async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let parsed: unknown
    const raw = await readBody(req)
    try {
      parsed = JSON.parse(raw)
    } catch {
      sendJson(res, 400, errorPayload('request body is not JSON'), extraHeaders)
      return
    }

    const body = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>
    const sessionHeader = headerValue(req.headers['x-mock-session'])
    const sessionKey = sessionHeader ?? 'default'
    // 桶 key 只由 header / model / 首条 user 消息决定，与 requestIndex 无关，
    // 所以可以先用 0 算出桶，再取该桶的状态。
    const bucketHeaderName = (scenario.bucketHeader ?? 'x-mock-session').toLowerCase()
    const provisional = buildRequestView(body, 0)
    const bucketKey = resolveBucketKey(scenario, sessionHeader, provisional, headerValue(req.headers[bucketHeaderName]))
    const state = sessionState(bucketKey)
    const view = buildRequestView(body, state.requestIndex)
    state.requestIndex += 1

    let turn: ResolvedTurn
    let turnName: string
    try {
      const selected = selectTurn(scenario, view, state)
      turn = resolveTurn(selected, scenario.defaults)
      turnName = turn.name
    } catch (error) {
      if (!(error instanceof MockScenarioExhaustedError)) throw error
      record({
        method: req.method ?? 'POST',
        path: '/v1/chat/completions',
        sessionKey,
        bucketKey,
        stream: view.stream,
        headers: normalizedHeaders(req),
        body: parsed,
        turn: 'script_exhausted',
      })
      log(`mock-openai -> script_exhausted bucket=${bucketKey}`)
      sendJson(res, 500, errorPayload(String(error.message), { type: 'server_error', code: 'script_exhausted' }), extraHeaders)
      return
    }

    const row = record({
      method: req.method ?? 'POST',
      path: '/v1/chat/completions',
      sessionKey,
      bucketKey,
      stream: view.stream,
      headers: normalizedHeaders(req),
      body: parsed,
      turn: turnName,
    })
    log(`mock-openai <- #${String(row.seq)} bucket=${bucketKey} session=${sessionKey} model=${view.model} `
      + `msgs=${String(view.messageCount)} stream=${String(view.stream)} turn=${turnName}`)

    if (turn.fault !== null && turn.fault.kind === 'delay') {
      await sleep(turn.fault.delayMs ?? 0)
    }
    if (turn.fault !== null && turn.fault.kind === 'httpError') {
      sendJson(res, turn.fault.status ?? 500, errorPayload(turn.fault.message ?? 'mock httpError', { type: 'server_error' }), extraHeaders)
      return
    }

    const id = newCompletionId()
    const model = view.model === '' ? (scenario.models?.[0] ?? 'mock-model') : view.model

    if (!view.stream) {
      sendJson(res, 200, completionResponse(id, model, {
        role: 'assistant',
        content: turn.text === '' ? null : turn.text,
        ...(turn.reasoning === '' ? {} : { reasoning_content: turn.reasoning }),
        ...(turn.toolCalls.length === 0 ? {} : {
          tool_calls: turn.toolCalls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: call.arguments },
          })),
        }),
      }, turn.finishReason, turn.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }), extraHeaders)
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...extraHeaders,
    })

    if (turn.fault !== null && turn.fault.kind === 'abortMidStream') {
      const head = Math.max(0, (turn.fault.afterChunks ?? 1) - 1)
      const pieces = [roleChunk(id, model), ...splitText(turn.text, turn.chunkSize).map((piece) => textChunk(id, model, piece))]
      for (const frame of pieces.slice(0, head)) res.write(sseFrame(frame))
      res.destroy()
      return
    }
    if (turn.fault !== null && turn.fault.kind === 'errorChunk') {
      const head = Math.max(0, (turn.fault.afterChunks ?? 1) - 1)
      res.write(sseFrame(roleChunk(id, model)))
      for (let index = 1; index < head; index += 1) res.write(sseFrame(textChunk(id, model, 'x')))
      res.write(sseFrame(errorPayload(turn.fault.message ?? 'mock errorChunk', { type: 'server_error' })))
      res.write(SSE_DONE_FRAME)
      res.end()
      return
    }

    writeStream(res, id, model, turn)
    res.end()
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${options.host ?? '127.0.0.1'}`)
    const path = url.pathname

    if (path === '/__mock/requests' && req.method === 'GET') {
      handleRequestsList(res, url)
      return
    }
    const single = /^\/__mock\/requests\/(\d+)$/u.exec(path)
    if (single !== null && req.method === 'GET') {
      handleRequestBySeq(res, single[1] ?? '')
      return
    }

    if (path.endsWith('/models') && req.method === 'GET') {
      sendJson(res, 200, modelsResponse(scenario.models ?? ['mock-model']), extraHeaders)
      return
    }
    const one = /\/models\/([^/]+)$/u.exec(path)
    if (one !== null && req.method === 'GET') {
      const id = decodeURIComponent(one[1] ?? '')
      const known = (scenario.models ?? ['mock-model']).includes(id)
      if (!known) {
        sendJson(res, 404, errorPayload(`model ${id} not found`, { code: 'model_not_found' }), extraHeaders)
        return
      }
      sendJson(res, 200, modelObject(id), extraHeaders)
      return
    }

    if (path.endsWith('/chat/completions') && req.method === 'POST') {
      await handleChat(req, res)
      return
    }

    // 非法请求（错方法 / 错路径）不消耗脚本 —— 配置错不该把序列带偏。
    sendJson(res, 404, errorPayload(`mock-openai: no route for ${req.method ?? '?'} ${path}`), extraHeaders)
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      log(`mock-openai !! ${String(error)}`)
      if (!res.headersSent) sendJson(res, 500, errorPayload(String(error), { type: 'server_error' }), extraHeaders)
      else res.destroy()
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  const host = options.host ?? '127.0.0.1'

  return {
    url: `http://${host}:${String(address.port)}/v1`,
    port: address.port,
    requests,
    reset(): void {
      requests.length = 0
      sessions.clear()
      seq = 0
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => { resolve() })
      })
    },
  }
}
