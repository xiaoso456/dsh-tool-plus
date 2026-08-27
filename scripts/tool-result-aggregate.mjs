/**
 * Aggregate per-tool result stats across many sessions, split by era
 * (pre-tool-plus deploy vs post). Usage: node scripts/tool-result-aggregate.mjs
 */
import { zstdDecompressSync } from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = 'C:/Users/xiaoso456/.dsh/sessions'
const DEPLOY_AT = new Date('2026-08-26T16:00:00Z').getTime() // tool-plus 真实部署完成（用户批准）

function decompress(file) {
  const buf = fs.readFileSync(file)
  const magic = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])
  const frames = []
  for (let p = 0; (p = buf.indexOf(magic, p)) !== -1; p += 4) frames.push(p)
  frames.push(buf.length)
  let all = ''
  for (let i = 0; i < frames.length - 1; i++) {
    try { all += zstdDecompressSync(buf.subarray(frames[i], frames[i + 1])).toString() } catch {}
  }
  return all
}

// eras: official tools (before), tool-plus (after)
const agg = {
  before: {}, after: {},
}
const sessionMeta = []

for (const ws of fs.readdirSync(ROOT)) {
  const wsd = path.join(ROOT, ws)
  if (!fs.statSync(wsd).isDirectory()) continue
  for (const s of fs.readdirSync(wsd)) {
    const file = path.join(wsd, s, 'session.jsonl.zstd')
    let st; try { st = fs.statSync(file) } catch { continue }
    if (st.size < 80 * 1024) continue // skip trivial sessions
    const era = st.mtimeMs < DEPLOY_AT ? 'before' : 'after'
    const lines = decompress(file).split('\n').filter(l => l.startsWith('{'))
    const callName = {}
    const perTool = {}
    let resultTotal = 0, calls = 0, asstText = 0, userChars = 0, firstT = 0, lastT = 0
    for (const l of lines) {
      let o; try { o = JSON.parse(l) } catch { continue }
      if (o.time) { if (!firstT) firstT = o.time; lastT = o.time }
      const d = o.data ?? {}
      if (o.type === 'tool/call') { callName[d.callId] = d.name; calls++ }
      else if (o.type === 'tool/result') {
        const tid = d.message?.content?.[0]?.toolCallId
        const name = callName[tid] || '?'
        let chars = 0
        for (const b of d.message?.content || []) {
          if (b.type === 'tool-result') for (const c of b.content || []) if (c.type === 'text') chars += (c.text || '').length
        }
        resultTotal += chars
        const t = perTool[name] || (perTool[name] = { calls: 0, chars: 0 })
        t.calls++; t.chars += chars
      } else if (o.type === 'assistant/message') {
        for (const b of d.message?.content || []) if (b.type === 'text') asstText += (b.text || '').length
      } else if (o.type === 'user/message') {
        for (const b of d.content || []) if (b.type === 'text') userChars += (b.text || '').length
      }
    }
    if (calls < 10) continue // skip near-empty sessions without meaningful tool use
    const target = agg[era]
    sessionMeta.push({ era, calls, resultTotal, asstText, userChars, mins: Math.round((lastT - firstT) / 60000), ws: ws.slice(3, 40) })
    for (const [name, t] of Object.entries(perTool)) {
      const g = target[name] || (target[name] = { sessions: 0, calls: 0, chars: 0 })
      g.sessions++; g.calls += t.calls; g.chars += t.chars
    }
  }
}

function fmt(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'K' : String(n) }

console.log('## 会话池：前(官方工具) vs 后(tool-plus)  部署分界', new Date(DEPLOY_AT).toISOString().slice(0, 10))
console.log()
console.log('### 汇总')
for (const era of ['before', 'after']) {
  const ss = sessionMeta.filter(s => s.era === era)
  const tc = ss.reduce((a, s) => a + s.calls, 0)
  const tr = ss.reduce((a, s) => a + s.resultTotal, 0)
  console.log(`${era === 'before' ? '官方' : 'tool-plus'}: ${ss.length}会话, ${fmt(tc)}次调用, 结果 ${fmt(tr)}c, 平均 ${Math.round(tr / Math.max(1, tc))}c/次`)
}
console.log()
console.log('### 各工具（跨会话聚合）')
const names = [...new Set([...Object.keys(agg.before), ...Object.keys(agg.after)])]
  .filter(n => !['?'].includes(n))
console.log(['工具'.padEnd(16), '| 官方调用', '官方均Kc/次', '| tp调用', 'tp均Kc/次'].join(' '))
for (const n of names.sort()) {
  const b = agg.before[n], a = agg.after[n]
  if (!b && !a) continue
  const bc = b ? Math.round(b.chars / Math.max(1, b.calls) / 100) / 10 : '-'
  const ac = a ? Math.round(a.chars / Math.max(1, a.calls) / 100) / 10 : '-'
  console.log([
    n.padEnd(16),
    String(b ? fmt(b.calls) : '-').padStart(8),
    String(bc).padStart(7),
    String(a ? fmt(a.calls) : '-').padStart(8),
    String(ac).padStart(7),
  ].join(' '))
}
