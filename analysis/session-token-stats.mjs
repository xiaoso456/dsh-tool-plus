/**
 * Session token-efficiency probe: decompress DSH session.jsonl.zstd (multi-frame)
 * and tally user/assistant/tool volumes + tool-call mix.
 * Usage: node analysis/session-token-stats.mjs <session-dir> [<session-dir> ...]
 *
 * 解压与选版统一走 session-store.mjs，别再在脚本里复制一份。
 */
import fs from 'node:fs'
import path from 'node:path'
import { decompressSession } from './session-store.mjs'

export function analyzeSessionFile(file) {
  const lines = decompressSession(file).split('\n').filter(l => l.startsWith('{'))
  const out = {
    file: path.basename(path.dirname(file)), userMsgs: 0, userChars: 0, asstTextChars: 0,
    toolCalls: 0, toolArgChars: 0, toolResultChars: 0, tools: {}, compactions: 0,
    turns: 0, firstTime: 0, lastTime: 0,
  }
  for (const l of lines) {
    let o; try { o = JSON.parse(l) } catch { continue }
    if (o.time) {
      if (!out.firstTime) out.firstTime = o.time
      out.lastTime = o.time
    }
    const d = o.data ?? {}
    if (o.type === 'user/message') {
      out.userMsgs++
      for (const b of d.content || []) if (b.type === 'text') out.userChars += (b.text || '').length
    } else if (o.type === 'assistant/message') {
      for (const b of d.message?.content || []) if (b.type === 'text') out.asstTextChars += (b.text || '').length
    } else if (o.type === 'tool/call') {
      out.toolCalls++
      out.tools[d.name] = (out.tools[d.name] || 0) + 1
      out.toolArgChars += (d.arguments || '').length
    } else if (o.type === 'tool/result') {
      for (const b of d.message?.content || []) {
        if (b.type === 'tool-result') {
          for (const c of b.content || []) if (c.type === 'text') out.toolResultChars += (c.text || '').length
        }
      }
    } else if (o.type === 'compaction/start') out.compactions++
    else if (o.type === 'turn/start') out.turns++
  }
  return out
}

if (process.argv.length > 2 && process.argv[1] && process.argv[1].endsWith('session-token-stats.mjs')) {
  for (const dir of process.argv.slice(2)) {
    const r = analyzeSessionFile(path.join(dir, 'session.jsonl.zstd'))
    console.log('=== ' + r.file)
    console.log(`turns=${r.turns} userMsgs=${r.userMsgs} userIn=${r.userChars}c asstOut=${r.asstTextChars}c`)
    console.log(`toolCalls=${r.toolCalls} args=${r.toolArgChars}c results=${r.toolResultChars}c compactions=${r.compactions} spanMin=${Math.round((r.lastTime - r.firstTime) / 60000)}`)
    console.log('tools:', JSON.stringify(r.tools))
  }
}
