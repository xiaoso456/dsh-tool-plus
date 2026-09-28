/**
 * 假 LLM 服务套件的自检。
 *
 * 这三层的失效方式都是「错一点也不报错」：帧上少一个 `reasoning_content`，界面上只是
 * 永远没有思考块；分桶算错，会话标题请求会静默吃掉主对话的第一轮，脚本整体错位；
 * 路由若把非法请求也算进脚本，配置里写错一个路径就能把整条时序带偏。所以分开钉：
 * protocol 钉帧形状、scenario 钉纯函数判定、server 起真服务真打 HTTP 钉端到端行为。
 *
 * @module tests/support/mock-openai
 */

import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { reasoningChunk, splitText, SSE_DONE_FRAME, toolCallsChunk, usageChunk, type MockToolCallDelta } from './protocol.ts'
import {
  buildRequestView,
  createSessionState,
  loadScenarioFile,
  MockScenarioExhaustedError,
  normalizeScenario,
  resolveBucketKey,
  selectTurn,
  type MockScenario,
} from './scenario.ts'
import { startMockOpenAI, type MockOpenAIServer } from './server.ts'

/** 同目录下的场景夹具；用 URL 拼绝对路径，避免把本机盘符写进源码。 */
const SCENARIO_FILE = fileURLToPath(new URL('./scenarios/tool-plus-all-tools.json', import.meta.url))

const servers: MockOpenAIServer[] = []
const tmpDirs: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-openai-spec-'))
  tmpDirs.push(dir)
  return dir
}

/** 每个用例自带服务，跑完必须关掉 —— 悬挂的监听端口会让同一文件重跑时互相串扰。 */
async function start(scenario: MockScenario): Promise<MockOpenAIServer> {
  const server = await startMockOpenAI({ scenario })
  servers.push(server)
  return server
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** 只声明断言真正要读的字段，避免 `any` 把字段名拼错放过去。 */
interface ErrorJson {
  error: { message: string; type: string; code: string | null }
}

interface ChatCompletionJson {
  object: string
  choices: Array<{
    finish_reason: string
    message: {
      content: string | null
      reasoning_content?: string
      tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
    }
  }>
}

interface RequestsJson {
  requests: Array<{
    seq: number
    method: string
    path: string
    sessionKey: string
    bucketKey: string
    turn?: string
    body: { model?: string }
  }>
}

function postChat(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${url}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/* -------------------------------------------------------------------------- */
/* 协议帧                                                                      */
/* -------------------------------------------------------------------------- */

describe('protocol：帧形状', () => {
  it('reasoningChunk：思考只能走 delta.reasoning_content', () => {
    const frame = reasoningChunk('cmpl-1', 'mock-model', '先确认 shell 通了', { created: 1_700_000_000 })

    expect(frame).toMatchObject({
      id: 'cmpl-1',
      object: 'chat.completion.chunk',
      created: 1_700_000_000,
      model: 'mock-model',
      choices: [{ index: 0, finish_reason: null }],
    })

    // delta 里只能有 reasoning_content：混进 content 会被客户端当正文，
    // 思考块就永远不出现（pi-ai 只在 reasoning_content 非空时产 thinking_delta）。
    const choices = frame.choices as Array<{ delta: Record<string, unknown> }>
    expect(choices).toHaveLength(1)
    expect(choices[0].delta).toEqual({ reasoning_content: '先确认 shell 通了' })
    expect(Object.keys(choices[0].delta)).toEqual(['reasoning_content'])
  })

  it('toolCallsChunk：tool_calls 分片按 index 聚合，首片带 id/type/name', () => {
    const deltas: MockToolCallDelta[] = [
      { index: 0, id: 'call_0', type: 'function', function: { name: 'bash', arguments: '{"comm' } },
      { index: 0, function: { arguments: 'and":"echo hi"}' } },
    ]
    const frame = toolCallsChunk('cmpl-2', 'mock-model', deltas, { created: 42, finishReason: 'tool_calls' })

    expect(frame).toMatchObject({
      id: 'cmpl-2',
      object: 'chat.completion.chunk',
      created: 42,
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        delta: {
          tool_calls: [
            { index: 0, id: 'call_0', type: 'function', function: { name: 'bash', arguments: '{"comm' } },
            // 后续分片只补 arguments，靠 index 认领同一个 tool_call
            { index: 0, function: { arguments: 'and":"echo hi"}' } },
          ],
        },
      }],
    })
  })

  it('usageChunk：choices 必须是空数组；终止帧逐字节等于 data: [DONE]\\n\\n', () => {
    const frame = usageChunk('cmpl-3', 'mock-model',
      { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 }, { created: 7 })

    // 非空 choices 会被当成一个内容分片，usage 反而读不到
    expect(frame).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
    })
    expect(frame.choices).toEqual([])

    expect(SSE_DONE_FRAME).toBe('data: [DONE]\n\n')
    expect(Buffer.from(SSE_DONE_FRAME, 'utf8')).toHaveLength(14)
  })

  it('splitText：按 chunkSize 切段，chunkSize<=0 时原样一段', () => {
    expect(splitText('abcdefg', 3)).toEqual(['abc', 'def', 'g'])
    // 恰好整除不能多吐一个空串（空段会在流上变成一帧空 delta）
    expect(splitText('abcdef', 3)).toEqual(['abc', 'def'])
    expect(splitText('abcdef', 0)).toEqual(['abcdef'])
    expect(splitText('abcdef', -1)).toEqual(['abcdef'])
  })
})

/* -------------------------------------------------------------------------- */
/* 场景判定（纯函数）                                                          */
/* -------------------------------------------------------------------------- */

describe('scenario：选轮与分桶', () => {
  it('selectTurn：谓词成立才命中，命中过的轮次不再被选中', () => {
    const scenario = normalizeScenario({
      name: 'ordering',
      turns: [
        { name: 'a', match: { requestIndex: 0 }, text: 'A' },
        { name: 'b', match: { requestIndex: 1 }, text: 'B' },
      ],
    })

    const state = createSessionState()
    const first = buildRequestView({ messages: [{ role: 'user', content: 'hi' }] }, 0)
    const second = buildRequestView({ messages: [{ role: 'user', content: 'hi' }] }, 1)

    // requestIndex 对不上就不能命中 —— 选轮看的是请求长什么样，不是计数器
    expect(selectTurn(scenario, second, state).name).toBe('b')
    expect(selectTurn(scenario, first, state).name).toBe('a')
    expect([...state.usedTurns].sort((left, right) => left - right)).toEqual([0, 1])
    // 两条都消耗过 → 无 fallback → 抛
    expect(() => selectTurn(scenario, first, state)).toThrow(MockScenarioExhaustedError)
  })

  it('selectTurn：都不命中时走 fallback，且 fallback 不占名额', () => {
    const scenario = normalizeScenario({
      name: 'fallback',
      turns: [{ name: 'a', match: { requestIndex: 0 }, text: 'A' }],
      fallback: { name: 'fb', text: 'F' },
    })

    const state = createSessionState()
    const unmatched = buildRequestView({ messages: [{ role: 'user', content: 'hi' }] }, 5)

    expect(selectTurn(scenario, unmatched, state).name).toBe('fb')
    expect(state.usedTurns.size).toBe(0)
    // fallback 可以无限取用：它一旦被记成「用过」，兜底请求第二次就会 500
    expect(selectTurn(scenario, unmatched, state).name).toBe('fb')
    expect(selectTurn(scenario, buildRequestView({ messages: [] }, 0), state).name).toBe('a')
  })

  it('selectTurn：都没命中且无 fallback 时抛 MockScenarioExhaustedError', () => {
    const scenario = normalizeScenario({
      name: 'exhaust',
      turns: [{ name: 'a', match: { requestIndex: 0 }, text: 'A' }],
    })

    let caught: unknown = undefined
    try {
      selectTurn(scenario, buildRequestView({ messages: [{ role: 'user', content: 'hi' }] }, 3), createSessionState())
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(MockScenarioExhaustedError)
    const exhausted = caught as MockScenarioExhaustedError
    expect(exhausted.name).toBe('MockScenarioExhaustedError')
    expect(exhausted.scenarioName).toBe('exhaust')
    expect(exhausted.view.requestIndex).toBe(3)
    // 报错里要能看出是哪个请求打崩的，否则排查只能靠猜
    expect(exhausted.message).toContain('exhaust')
    expect(exhausted.message).toContain('#3')
  })

  it('resolveBucketKey：没有 user 消息的请求与主对话分属不同桶', () => {
    const scenario = normalizeScenario({
      name: 'bucket',
      bucketBy: 'firstUserMessage',
      turns: [{ text: 'x' }],
    })

    const main = buildRequestView({ messages: [{ role: 'user', content: '帮我写个测试' }] }, 0)
    // 会话标题请求就长这样：只有 system，没有 user
    const title = buildRequestView({ messages: [{ role: 'system', content: '给这段对话起个名字' }] }, 0)
    const mainKey = resolveBucketKey(scenario, undefined, main)
    const titleKey = resolveBucketKey(scenario, undefined, title)

    expect(titleKey).not.toBe(mainKey)
    expect(titleKey).toBe('user:')
    expect(mainKey).toBe('user:帮我写个测试')

    // 没有 user 消息的请求自带一个独立 requestIndex 序列，所以标题请求
    // 即便命中了 turn0，消耗的也是自己桶里的那一份，主对话仍从 turn0 起。
    const other = normalizeScenario({ name: 'bucket', bucketBy: 'none', turns: [{ text: 'x' }] })
    expect(resolveBucketKey(other, undefined, main)).toBe('default')
    expect(resolveBucketKey(other, undefined, title)).toBe('default')

    const byModel = normalizeScenario({ name: 'bucket', bucketBy: 'model', turns: [{ text: 'x' }] })
    expect(resolveBucketKey(byModel, undefined, main)).toBe('model:')
    expect(resolveBucketKey(byModel, undefined, buildRequestView({ model: 'm2' }, 0))).toBe('model:m2')
  })

  it('resolveBucketKey：x-mock-session 头优先级最高，空串等同于没给', () => {
    const scenario = normalizeScenario({
      name: 'bucket',
      bucketBy: 'firstUserMessage',
      turns: [{ text: 'x' }],
    })
    const main = buildRequestView({ messages: [{ role: 'user', content: '帮我写个测试' }] }, 0)

    expect(resolveBucketKey(scenario, 'session-A', main)).toBe('session-A')
    // 空串若也算头，所有没带头的请求会撞进同一个空桶，隔离就白做了
    expect(resolveBucketKey(scenario, '', main)).toBe(resolveBucketKey(scenario, undefined, main))
  })

  it('resolveBucketKey：bucketBy=header 读 bucketHeader 指定的头', () => {
    // 这条是补的：bucketHeader 曾经是死配置——解析进了场景却没人读，
    // bucketBy:'header' 于是把所有会话静默挤进同一个桶、互相消耗轮次。
    const scenario = normalizeScenario({
      name: 'hdr',
      bucketBy: 'header',
      bucketHeader: 'x-conv',
      turns: [{ text: 'x' }],
    })
    const view = buildRequestView({ messages: [{ role: 'user', content: 'hi' }] }, 0)

    expect(resolveBucketKey(scenario, undefined, view)).toBe('default')
    expect(resolveBucketKey(scenario, undefined, view, 'conv-A')).toBe('header:conv-A')
    // 两个不同的头值必须分成两桶，否则隔离就是假的
    expect(resolveBucketKey(scenario, undefined, view, 'conv-A'))
      .not.toBe(resolveBucketKey(scenario, undefined, view, 'conv-B'))
    // 空串等同于没给
    expect(resolveBucketKey(scenario, undefined, view, '')).toBe('default')
    // x-mock-session 仍然最高优先
    expect(resolveBucketKey(scenario, 'session-A', view, 'conv-A')).toBe('session-A')
  })

  it('loadScenarioFile：tokens 占位符替换真的落进 toolCall 参数', () => {
    // 占位符落在 arguments 里，也就是「字符串里还是 JSON」的位置：替换是原样的、
    // 不做任何转义，所以值必须用正斜杠 —— 反斜杠会让外层 JSON 当场非法。
    const scratch = tempDir().replace(/\\/g, '/')
    const scenario = loadScenarioFile(SCENARIO_FILE, { tokens: { '<scratch>': scratch } })

    expect(scenario.name).toBe('tool-plus-all-tools')
    // 不锚定轮次表：夹具还在长（会话标题轮就是后加的），这里只钉 token 替换本身
    const args = scenario.turns.flatMap((turn) => (turn.toolCalls ?? []).map((call) => call.arguments))
    expect(args.length).toBeGreaterThan(0)

    // 替换发生在 JSON.parse 之前，所以参数里剩下的必须已经是拼好的路径
    expect(args.some((text) => text.includes('<scratch>'))).toBe(false)
    expect(args.some((text) => text.includes(scratch))).toBe(true)

    // 同一占位符出现多次必须全部命中（全文替换，不是只换第一处）；
    // write 与 read 的参数都能解析回同一条路径，说明替换没破坏参数 JSON。
    const parsed = args.map((text) => JSON.parse(text) as Record<string, unknown>)
    const fixturePaths = parsed
      .filter((value) => typeof value.path === 'string' && value.path.endsWith('/fixture.ts'))
      .map((value) => value.path)
    expect(fixturePaths.length).toBeGreaterThan(1)
    expect(new Set(fixturePaths)).toEqual(new Set([`${scratch}/fixture.ts`]))
    // ast_edit 走的是 paths 数组，同样要换到
    const plural = parsed.flatMap((value) => (Array.isArray(value.paths) ? value.paths : []))
    expect(plural).toContain(`${scratch}/fixture.ts`)
  })
})

/* -------------------------------------------------------------------------- */
/* 服务端（真起服务、真打 HTTP）                                                */
/* -------------------------------------------------------------------------- */

/** 两轮的场景：turn-0 发一个 tool_call（带 reasoning），turn-1 收尾。 */
function chatScenario(): MockScenario {
  return normalizeScenario({
    name: 'self-check',
    models: ['mock-model'],
    turns: [
      {
        name: 'turn-0',
        match: { requestIndex: 0 },
        reasoning: '先跑一条 bash 看看环境',
        toolCalls: [{ id: 'call_0', name: 'bash', arguments: '{"command":"echo MOCK_OK"}' }],
      },
      { name: 'turn-1', match: { requestIndex: 1 }, text: 'MOCK_DONE' },
    ],
  })
}

/** 同一个桶（同一条 user 消息）的一次普通请求体。 */
function chatBody(): unknown {
  return { model: 'mock-model', messages: [{ role: 'user', content: '同一个会话' }] }
}

describe('server：端到端行为', () => {
  it('流式：SSE 里同时有 reasoning_content / tool_calls / finish_reason / [DONE]', async () => {
    const server = await start(chatScenario())
    const response = await postChat(server.url, { model: 'mock-model', stream: true, messages: [{ role: 'user', content: '跑一条 bash' }] })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const text = await response.text()
    expect(text).toContain('"reasoning_content":"先跑一条 bash 看看环境"')
    expect(text).toContain('"tool_calls"')
    expect(text).toContain('"finish_reason":"tool_calls"')
    expect(text.endsWith(SSE_DONE_FRAME)).toBe(true)

    const frames = text.split('\n\n').filter((part) => part !== '')
    expect(frames.at(-1)).toBe('data: [DONE]')
    for (const frame of frames.slice(0, -1)) {
      expect(frame.startsWith('data: ')).toBe(true)
      expect(() => { JSON.parse(frame.slice(6)) }).not.toThrow()
    }
  })

  it('非流式：stream 不为 true 时回 JSON，message.tool_calls 完整', async () => {
    const server = await start(chatScenario())
    const response = await postChat(server.url, { model: 'mock-model', messages: [{ role: 'user', content: '跑一条 bash' }] })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')

    const body = await response.json() as ChatCompletionJson
    expect(body.object).toBe('chat.completion')
    expect(body.choices[0].finish_reason).toBe('tool_calls')
    // 非流式不再分片，参数必须是拼好的一整串
    expect(body.choices[0].message.tool_calls).toEqual([
      { id: 'call_0', type: 'function', function: { name: 'bash', arguments: '{"command":"echo MOCK_OK"}' } },
    ])
  })

  it('轮次推进：同桶连打两次依次命中 turn-0 / turn-1', async () => {
    const server = await start(chatScenario())

    await postChat(server.url, chatBody())
    await postChat(server.url, chatBody())

    expect(server.requests.map((row) => row.turn)).toEqual(['turn-0', 'turn-1'])
    // 同样的首条 user 消息 = 同一个桶，这是它能顺序推进的前提
    expect(server.requests[0].bucketKey).toBe(server.requests[1].bucketKey)
  })

  it('分桶隔离：无 user 消息的标题请求不吃主对话的轮次', async () => {
    const server = await start(chatScenario())

    const title = await postChat(server.url, { model: 'mock-model', messages: [{ role: 'system', content: '给会话起名' }] })
    expect(title.status).toBe(200)
    const main = await postChat(server.url, chatBody())
    expect(main.status).toBe(200)

    const [titleRow, mainRow] = server.requests
    expect(titleRow.bucketKey).not.toBe(mainRow.bucketKey)
    // 标题请求在自己桶里也能命中 turn-0，但它消耗的是另一份 usedTurns
    expect(mainRow.turn).toBe('turn-0')
    await postChat(server.url, chatBody())
    expect(server.requests[2].turn).toBe('turn-1')
  })

  it('非法请求：错方法/错路径回 404，且不消耗脚本', async () => {
    const server = await start(chatScenario())

    const wrongMethod = await fetch(`${server.url}/chat/completions`)
    expect(wrongMethod.status).toBe(404)
    const wrongPath = await fetch(`${server.url}/nope`, { method: 'POST' })
    expect(wrongPath.status).toBe(404)

    // 配置写错一个路由不该把序列带偏，所以这两次不能留痕
    expect(server.requests).toHaveLength(0)

    await postChat(server.url, chatBody())
    expect(server.requests.map((row) => row.turn)).toEqual(['turn-0'])
  })

  it('GET /models 回模型列表，未知模型 id 回 404', async () => {
    const server = await start(chatScenario())

    const list = await fetch(`${server.url}/models`)
    expect(list.status).toBe(200)
    expect(await list.json()).toMatchObject({ object: 'list', data: [{ id: 'mock-model' }] })

    const missing = await fetch(`${server.url}/models/unknown`)
    expect(missing.status).toBe(404)
    expect((await missing.json() as ErrorJson).error.code).toBe('model_not_found')
  })

  it('请求记录：/__mock/requests 列全量、按 seq 取单条、sessionKey 可过滤', async () => {
    const server = await start(chatScenario())
    const debugUrl = new URL('/__mock/requests', server.url)

    await postChat(server.url, chatBody())
    await postChat(server.url, chatBody(), { 'x-mock-session': 'sess-A' })

    const all = await fetch(debugUrl)
    expect(all.status).toBe(200)
    const listed = await all.json() as RequestsJson
    expect(listed.requests).toHaveLength(2)
    expect(listed.requests[0]).toMatchObject({
      seq: 1,
      method: 'POST',
      path: '/v1/chat/completions',
      sessionKey: 'default',
      turn: 'turn-0',
      body: { model: 'mock-model' },
    })

    const single = await fetch(new URL('/__mock/requests/2', server.url))
    expect(single.status).toBe(200)
    expect(await single.json()).toMatchObject({ seq: 2, sessionKey: 'sess-A' })
    expect((await fetch(new URL('/__mock/requests/999', server.url))).status).toBe(404)

    const filtered = await fetch(new URL('/__mock/requests?sessionKey=sess-A', server.url))
    const onlyA = await filtered.json() as RequestsJson
    expect(onlyA.requests.map((row) => row.seq)).toEqual([2])
  })

  it('reset()：清空记录并把轮次状态一起复位', async () => {
    const server = await start(chatScenario())

    await postChat(server.url, chatBody())
    await postChat(server.url, chatBody())
    expect(server.requests.map((row) => row.turn)).toEqual(['turn-0', 'turn-1'])

    server.reset()

    // 记录数组是原地清空的（句柄持有的是同一个引用），外部拿到的视图必须同步为空
    expect(server.requests).toHaveLength(0)
    // 上一轮跑完的残留状态没清掉的话，这里会直接吃到 turn-1
    await postChat(server.url, chatBody())
    expect(server.requests.map((row) => row.turn)).toEqual(['turn-0'])
  })

  it('脚本耗尽：没有轮次匹配时回结构化 500，并留下 script_exhausted 记录', async () => {
    const server = await start(normalizeScenario({
      name: 'exhaust',
      turns: [{ name: 'only', match: { requestIndex: 0 }, text: 'ok' }],
    }))

    expect((await postChat(server.url, chatBody())).status).toBe(200)

    const second = await postChat(server.url, chatBody())
    expect(second.status).toBe(500)
    expect((await second.json() as ErrorJson).error.code).toBe('script_exhausted')
    // 打崩的那次也要留痕，否则只能看到「少了一轮」而不知道是谁吃掉的
    expect(server.requests.map((row) => row.turn)).toEqual(['only', 'script_exhausted'])
  })
})
