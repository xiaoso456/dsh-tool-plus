/**
 * Real-environment smoke mock: OpenAI-compatible SSE LLM that drives a fixed
 * tool-call sequence (grep → glob → ast_edit → read), then emits a final text.
 * Used with `dsh --profile tool-plus --patch mock-patch.yml "task"` to prove
 * the ported tools execute inside a real dsh process (no real API consumed).
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.MOCK_PORT ?? 30199)
const MODEL = process.env.MOCK_MODEL ?? 'mock/flash'

/** One scripted tool call per request index; last entry is the final text. */
const SEQUENCE = [
  { type: 'tool', name: 'ast_grep', args: { pat: 'oldName', path: 'code.ts' } },
  { type: 'tool', name: 'ast_edit', args: { ops: [{ pat: 'oldName', out: 'newName' }], paths: ['code.ts'] } },
  { type: 'tool', name: 'read', args: { path: 'code.ts' } },
  { type: 'text', text: 'MOCK_DONE ast_grep/ast_edit(read) 全部工具链执行完毕' },
]

let reqCount = 0
let mainSeqCount = 0
const seenToolResults = new Set()

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`)
}

function sendToolCall(res, index, name, args) {
  const id = `call_${index + 1}`
  sse(res, { id: `chatcmpl-${reqCount}`, object: 'chat.completion.chunk', created: Date.now(), model: MODEL, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] }, finish_reason: null }] })
  const argStr = JSON.stringify(args)
  const half = Math.max(1, Math.floor(argStr.length / 2))
  for (const part of [argStr.slice(0, half), argStr.slice(half)]) {
    sse(res, { id: `chatcmpl-${reqCount}`, object: 'chat.completion.chunk', created: Date.now(), model: MODEL, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: part } }] }, finish_reason: null }] })
  }
  sse(res, { id: `chatcmpl-${reqCount}`, object: 'chat.completion.chunk', created: Date.now(), model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
  res.write('data: [DONE]\n\n')
  res.end()
}

function sendText(res, text) {
  const half = Math.max(1, Math.floor(text.length / 2))
  for (const part of [text.slice(0, half), text.slice(half)]) {
    sse(res, { id: `chatcmpl-${reqCount}`, object: 'chat.completion.chunk', created: Date.now(), model: MODEL, choices: [{ index: 0, delta: { role: 'assistant', content: part }, finish_reason: null }] })
  }
  sse(res, { id: `chatcmpl-${reqCount}`, object: 'chat.completion.chunk', created: Date.now(), model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  res.write('data: [DONE]\n\n')
  res.end()
}

const server = createServer((req, res) => {
  console.log(`[mock-llm] ${req.method} ${req.url}`)
  if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
    res.writeHead(404).end()
    return
  }
  let body = ''
  req.on('data', c => (body += c))
  req.on('end', () => {
    reqCount += 1
    console.log(`[mock-llm] === req${reqCount} body(first 1500) ===`)
    console.log(body.slice(0, 60000))
    // The harness also fires an async session-title request (developer prompt
    // mentions "Create a concise title"). Answer it with a plain short title
    // and do NOT consume the main tool sequence.
    try {
      const payload = JSON.parse(body)
      const first = payload.messages?.[0]
      if (first?.role === 'developer' && String(first.content).includes('Create a concise title')) {
        console.log('[mock-llm] title request -> short title')
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        sendText(res, '工具冒烟测试')
        return
      }
    } catch {}
    const roles = (() => { try { return (JSON.parse(body).messages ?? []).map(m => m.role).join(',') } catch { return '?' } })()
    console.log(`[mock-llm] roles: ${roles}`)
      try { const pl=JSON.parse(body); console.log('[mock-llm] TOOLS:', JSON.stringify((pl.tools??[]).map(t=>t.function?.name ?? t.name))) } catch {}
    // Record tool results from the previous round for verification.
    try {
      const payload = JSON.parse(body)
      for (const msg of payload.messages ?? []) {
        if (msg.role === 'tool') {
          const id = msg.tool_call_id ?? msg.name ?? '?'
          seenToolResults.add(id)
          const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
          console.log(`[mock-llm] tool-result ${id}: ${text.slice(0, 120).replace(/\n/g, '\\n')}`)
        }
      }
    } catch (e) { console.log(`[mock-llm] parse fail: ${e.message}`) }
    const step = SEQUENCE[Math.min(mainSeqCount, SEQUENCE.length - 1)]
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    if (step.type === 'tool') {
      sendToolChunked(res, step.name, step.args)
    } else {
      const done = `MOCK_DONE tools=${[...seenToolResults].join(',')} (期望 call_1=ast_grep call_2=ast_edit call_3=read)`
      sendText(res, done)
    }
    mainSeqCount += 1
  })
})

function sendToolChunked(res, name, args) {
  const id = `call_${mainSeqCount + 1}`
  console.log(`[mock-llm] RESPOND tool=${name} id=${id}`)
  sse(res, { id: `chatcmpl-${reqCount}`, object: 'chat.completion.chunk', created: Date.now(), model: MODEL, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] }, finish_reason: null }] })
  const argStr = JSON.stringify(args)
  const half = Math.max(1, Math.floor(argStr.length / 2))
  for (const part of [argStr.slice(0, half), argStr.slice(half)]) {
    sse(res, { id: `chatcmpl-${reqCount}`, object: 'chat.completion.chunk', created: Date.now(), model: MODEL, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: part } }] }, finish_reason: null }] })
  }
  sse(res, { id: `chatcmpl-${reqCount}`, object: 'chat.completion.chunk', created: Date.now(), model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
  res.write('data: [DONE]\n\n')
  res.end()
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-llm listening on http://127.0.0.1:${PORT}/v1`)
})
