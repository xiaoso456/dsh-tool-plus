/**
 * 会话分析聚合，两种模式：
 *
 * - 默认（era）：按部署分界对比工具结果体积（官方工具 vs tool-plus）。
 * - `--failures`：按 agentPreset 统计工具失败率、失败簇与高频失败特征。
 *
 * 解压、选版、preset 读取统一走 session-store.mjs。
 *
 * Usage:
 *   node analysis/tool-result-aggregate.mjs
 *   node analysis/tool-result-aggregate.mjs --failures --format v4 --preset tool-plus-standard --top 8
 *   node analysis/tool-result-aggregate.mjs --failures --since 2026-09-25 --json
 */
import fs from 'node:fs'
import path from 'node:path'
import { collectSessionFiles, decompressSession, sessionPreset, sessionRoot } from './session-store.mjs'

/** 会话目录：`$TOOL_RESULT_SESSIONS` > `$DSH_HOME/sessions` > `~/.dsh/sessions`。 */
const ROOT = process.env.TOOL_RESULT_SESSIONS ?? sessionRoot()
const DEPLOY_AT = new Date('2026-08-26T16:00:00Z').getTime() // tool-plus 真实部署完成（用户批准）

/** 规则拦截：模型先试 shell 写法，被插件 interceptor 挡回专用工具。 */
const INTERCEPTOR = /Blocked: Use the .(grep|read|glob|edit|write)./
/** 工作目录在 shell 里已经不存在（被删/改名）。 */
const CWD_MISSING = /Working directory does not exist|Failed to set cwd/
/** Windows 替换文件偶发 EIO（已知抖动，重试通常成功）。 */
const REPLACE_EIO = /ReplaceFileW EIO/
/** 多段编辑中途失败：报错里带 entry k of n，或首行是成功文案。 */
const PARTIAL_EDIT = /entry \d+ of \d+|Successfully replaced[\s\S]{0,60}Error editing/
/** edit 模糊匹配没到阈值。 */
const FUZZY_MISS = /Could not find a close enough match/
/** 状态守卫：没读就改 / 读之后文件又变了。 */
const NEEDS_READ = /file has not been read|requires reading .* first/
const CHANGED_SINCE_READ = /file changed since it was read/

const BUCKETS = [
  ['interceptor 拦截（改用专用工具）', INTERCEPTOR],
  ['cwd 已不存在', CWD_MISSING],
  ['Windows ReplaceFileW EIO', REPLACE_EIO],
  ['多段编辑半途失败', PARTIAL_EDIT],
  ['edit 模糊匹配未达阈值', FUZZY_MISS],
  ['没读就改', NEEDS_READ],
  ['读之后文件又变了', CHANGED_SINCE_READ],
]

function parseArgs(argv) {
  const opts = { failures: false, home: undefined, since: null, format: 'all', preset: null, top: 8, json: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--failures') opts.failures = true
    else if (arg === '--home') opts.home = argv[++i]
    else if (arg === '--since') opts.since = Date.parse(argv[++i] + 'T00:00:00Z')
    else if (arg === '--format') opts.format = argv[++i]
    else if (arg === '--preset') opts.preset = argv[++i]
    else if (arg === '--top') opts.top = Number(argv[++i]) || 8
    else if (arg === '--json') opts.json = true
  }
  return opts
}

/** 把首行错误归一化：路径与数字抹掉，否则同类错误会被拆成几百条。 */
function signature(body) {
  const first = body.split('\n').find(line => line.trim().length > 0) ?? '(empty)'
  return first
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
    .replace(/\/[^\s"']{3,}/g, '<path>')
    .replace(/'[^']{0,60}'/g, "'<x>'")
    .replace(/\d+/g, '#')
    .trim()
    .slice(0, 92)
}

function bump(map, key) { map.set(key, (map.get(key) ?? 0) + 1) }

function failuresMode(opts) {
  const files = collectSessionFiles(opts.home, { since: opts.since, format: opts.format })
  const groups = new Map()
  for (const entry of files) {
    let text
    try { text = decompressSession(entry.file) } catch { continue }
    if (!text.includes('"tool/call"')) continue
    const preset = sessionPreset(text)
    if (opts.preset !== null && preset !== opts.preset) continue
    let group = groups.get(preset)
    if (group === undefined) {
      group = { sessions: 0, calls: 0, errors: 0, tools: new Map(), buckets: new Map(), signatures: new Map() }
      groups.set(preset, group)
    }
    group.sessions++
    const callsById = new Map()
    for (const line of text.split('\n')) {
      if (!line.startsWith('{') || !line.includes('"type":"tool/')) continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (event.type === 'tool/call') {
        const name = event.data?.name ?? '?'
        callsById.set(event.data?.callId, name)
        group.calls++
        const tool = group.tools.get(name) ?? { calls: 0, errors: 0 }
        tool.calls++
        group.tools.set(name, tool)
        continue
      }
      const message = event.data?.message ?? {}
      const nested = message.content?.[0]
      const isError = message.isError === true || nested?.isError === true
      if (!isError) continue
      const name = callsById.get(message.toolCallId ?? message.source?.callId) ?? '?'
      group.errors++
      const tool = group.tools.get(name) ?? { calls: 0, errors: 0 }
      tool.errors++
      group.tools.set(name, tool)
      const blocks = nested?.type === 'tool-result' ? nested.content : message.content
      const body = (blocks ?? []).map(block => block?.text ?? '').join('')
      bump(group.signatures, name + ' | ' + signature(body))
      for (const [label, pattern] of BUCKETS) if (pattern.test(body)) bump(group.buckets, label)
    }
  }
  if (opts.json) {
    const rows = [...groups.entries()].map(([preset, group]) => ({
      preset,
      sessions: group.sessions,
      calls: group.calls,
      errors: group.errors,
      tools: [...group.tools.entries()].filter(([, t]) => t.errors > 0).sort((a, b) => b[1].errors - a[1].errors),
      buckets: [...group.buckets.entries()].sort((a, b) => b[1] - a[1]),
      signatures: [...group.signatures.entries()].sort((a, b) => b[1] - a[1]).slice(0, opts.top),
    }))
    console.log(JSON.stringify({ files: files.length, rows }, null, 2))
    return
  }
  console.log('会话文件 ' + files.length + ' 个（format=' + opts.format + (opts.since === null ? '' : '，since=' + new Date(opts.since).toISOString().slice(0, 10)) + '）')
  for (const [preset, group] of [...groups.entries()].sort((a, b) => b[1].calls - a[1].calls)) {
    const rate = group.calls === 0 ? 0 : (group.errors / group.calls) * 100
    console.log('\n=== ' + preset + '：会话 ' + group.sessions + '，调用 ' + group.calls + '，失败 ' + group.errors + ' (' + rate.toFixed(1) + '%) ===')
    console.log('  工具            调用     失败    失败率')
    for (const [name, tool] of [...group.tools.entries()].filter(([, t]) => t.errors > 0).sort((a, b) => b[1].errors - a[1].errors).slice(0, opts.top)) {
      console.log('  ' + name.padEnd(16) + String(tool.calls).padStart(6) + String(tool.errors).padStart(8) + (tool.errors / tool.calls * 100).toFixed(1).padStart(7) + '%')
    }
    if (group.buckets.size > 0) {
      console.log('  失败簇：')
      for (const [label, count] of [...group.buckets.entries()].sort((a, b) => b[1] - a[1])) console.log('  ' + String(count).padStart(5) + '  ' + label)
    }
    if (group.signatures.size > 0) {
      console.log('  Top 失败特征：')
      for (const [sig, count] of [...group.signatures.entries()].sort((a, b) => b[1] - a[1]).slice(0, opts.top)) console.log('  ' + String(count).padStart(5) + '  ' + sig)
    }
  }
}

function fmt(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'K' : String(n) }

function eraMode() {
  // eras: official tools (before), tool-plus (after)
  const agg = { before: {}, after: {} }
  const sessionMeta = []

  for (const ws of fs.readdirSync(ROOT)) {
    const wsd = path.join(ROOT, ws)
    if (!fs.statSync(wsd).isDirectory()) continue
    for (const s of fs.readdirSync(wsd)) {
      const file = path.join(wsd, s, 'session.jsonl.zstd')
      let st; try { st = fs.statSync(file) } catch { continue }
      if (st.size < 80 * 1024) continue
      const era = st.mtimeMs < DEPLOY_AT ? 'before' : 'after'
      const lines = decompressSession(file).split('\n').filter(l => l.startsWith('{'))
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
      if (calls < 10) continue
      const target = agg[era]
      sessionMeta.push({ era, calls, resultTotal, asstText, userChars, mins: Math.round((lastT - firstT) / 60000), ws: ws.slice(3, 40) })
      for (const [name, t] of Object.entries(perTool)) {
        const g = target[name] || (target[name] = { sessions: 0, calls: 0, chars: 0 })
        g.sessions++; g.calls += t.calls; g.chars += t.chars
      }
    }
  }

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
}

const opts = parseArgs(process.argv.slice(2))
if (opts.failures) failuresMode(opts)
else eraMode()
