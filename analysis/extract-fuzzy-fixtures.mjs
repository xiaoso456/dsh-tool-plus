#!/usr/bin/env node
/**
 * 历史模糊匹配失败 -> 可回放语料。
 *
 * 会话日志里每次「Could not find a close enough match」都带着请求的文本（edit 参数或
 * run_code 源码里的 oldText）、当时最接近的原文行、相似度。把它和当时的文件内容配起来，
 * 就是一条能直接喂给匹配器做回归的样本。
 *
 * 文件内容按可信度取，优先会话内快照：同一路径在失败之前最后一次 write（带全文）或
 * read（原文返回），其次失败之后最近一次 read，最后才退回磁盘现文件。无论哪一路，
 * 都用报错里那行「最接近原文」再校验一遍——对不上说明拿到的不是当时的内容
 * （read 返回结构摘要、文件后来被改过），标 verified=false。
 *
 * 产物两份：
 *   fuzzy-failures-index.jsonl   全部可解析的失败（含无可信内容者），只留元信息与请求文本
 *   fuzzy-replay-cases.jsonl     校验通过的子集，带内容窗口，可直接回放
 *
 * 只读会话日志，不修改仓库里任何现有文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectSessionFiles, decompressSession, sessionPreset } from './session-store.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MARKER = 'Could not find a close enough match'
const DEFAULTS = {
  outDir: path.join(HERE, 'fixtures'),
  format: 4,
  windowLines: 150,
  dryRun: false,
  quiet: false,
}

function parseArgs(argv) {
  const opts = { ...DEFAULTS }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--home') opts.home = argv[++i]
    else if (arg === '--out-dir') opts.outDir = argv[++i]
    else if (arg === '--format') opts.format = argv[++i]
    else if (arg === '--window-lines') opts.windowLines = Number(argv[++i])
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--quiet') opts.quiet = true
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0) }
    else throw new Error('未知参数：' + arg)
  }
  return opts
}

function printHelp() {
  console.log([
    '用法：node analysis/extract-fuzzy-fixtures.mjs [选项]',
    '',
    '  --home <dir>           会话根目录（默认 $DSH_HOME 或 ~/.dsh）',
    '  --out-dir <dir>        产物目录（默认 analysis/fixtures）',
    '  --format <4|v4|all>    会话格式版本（默认 4）',
    '  --window-lines <n>     回放样本保留报错行前后多少行（默认 150）',
    '  --dry-run              只统计不写文件',
    '  --quiet                不打印统计',
  ].join('\n'))
}

const tryJson = (s) => { try { return JSON.parse(s) } catch { return null } }
const squash = (s) => s.replace(/\s+/g, '')
const normalizeText = (s) => s.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim()

/** 从 start 处的 JS 字符串字面量读出值（模板串、单双引号都认）。 */
function readStringLiteral(src, start) {
  const quote = src[start]
  if (quote !== '`' && quote !== '"' && quote !== "'") return null
  let i = start + 1
  let value = ''
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') {
      const next = src[i + 1]
      value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next === undefined ? '' : next
      i += 2
      continue
    }
    if (ch === quote) return { value, end: i + 1 }
    value += ch
    i++
  }
  return null
}

/** run_code 源码里每个 oldText/newText 对，顺序同 edits 数组。 */
function extractRunCodeEntries(code) {
  const pairs = []
  const re = /\bold(?:Text|_string)\s*:\s*/g
  let match
  while ((match = re.exec(code))) {
    const oldLit = readStringLiteral(code, match.index + match[0].length)
    if (!oldLit) continue
    re.lastIndex = oldLit.end
    let newText = null
    const rest = code.slice(oldLit.end)
    const newMatch = /\bnew(?:Text|_string)\s*:\s*/.exec(rest)
    if (newMatch && newMatch.index < 400) {
      const newLit = readStringLiteral(rest, newMatch.index + newMatch[0].length)
      if (newLit) newText = newLit.value
    }
    pairs.push({ oldText: oldLit.value, newText })
  }
  return pairs
}

function parseFailure(body) {
  const closest = /Closest match \((\d+)% similar\) at line (\d+):\n([\s\S]*?)\nClosest match was below/.exec(body)
  const entry = /\(entry (\d+) of (\d+)\)/.exec(body)
  const pathMatch = /Could not find a close enough match in ([^\n]+?)\.(?:\n|$)/.exec(body)
  const lines = closest ? closest[3].split('\n') : []
  return {
    similarity: closest ? Number(closest[1]) : null,
    line: closest ? Number(closest[2]) : null,
    plus: lines.filter((l) => l.startsWith('  + ')).map((l) => l.slice(4)),
    minus: lines.filter((l) => l.startsWith('  - ')).map((l) => l.slice(4)),
    entryIndex: entry ? Number(entry[1]) - 1 : 0,
    entryCount: entry ? Number(entry[2]) : 1,
    pathFromMessage: pathMatch ? pathMatch[1] : null,
  }
}

function verifyContent(content, minus) {
  const needle = minus.map((l) => l.trim()).filter((l) => l.length >= 8)[0]
  if (!needle) return null
  return content.includes(needle)
}

function windowContent(content, line, windowLines) {
  const lines = content.split('\n')
  if (lines.length <= windowLines * 2 + 1) return { content, windowed: false, startLine: 1 }
  const center = Math.max(0, Math.min(lines.length - 1, (line ?? 1) - 1))
  const start = Math.max(0, center - windowLines)
  const end = Math.min(lines.length, center + windowLines + 1)
  return { content: lines.slice(start, end).join('\n'), windowed: true, startLine: start + 1 }
}

/** 同一路径的会话内快照，按事件序号排。 */
function pickSnapshot(list, failureSeq) {
  if (!list || list.length === 0) return null
  const before = list.filter((s) => s.seq < failureSeq)
  const after = list.filter((s) => s.seq > failureSeq)
  if (before.length) {
    const writes = before.filter((s) => s.kind === 'write')
    return writes.length ? writes[writes.length - 1] : before[before.length - 1]
  }
  if (after.length) return after[0]
  return null
}

function scanSession(file, workspace, opts, out) {
  let text
  try { text = decompressSession(file) } catch { return }
  if (!text.includes(MARKER)) return
  out.scanned++
  const preset = sessionPreset(text)
  const sessionName = path.join(workspace, path.basename(path.dirname(file)))

  const events = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    const event = tryJson(line)
    if (event) events.push(event)
  }

  const calls = new Map()
  const snapshots = new Map()
  const addSnapshot = (filePath, seq, kind, content) => {
    if (typeof filePath !== 'string' || !filePath || typeof content !== 'string') return
    const key = path.normalize(filePath)
    if (!snapshots.has(key)) snapshots.set(key, [])
    snapshots.get(key).push({ seq, kind, content })
  }

  for (let seq = 0; seq < events.length; seq++) {
    const event = events[seq]
    if (event.type === 'tool/call') {
      const data = event.data ?? {}
      const args = tryJson(data.arguments) ?? {}
      calls.set(data.callId, { name: data.name, args, seq })
      if (data.name === 'write') addSnapshot(args.file_path ?? args.path, seq, 'write', args.content)
      continue
    }
    if (event.type !== 'tool/result') continue
    const message = event.data?.message ?? {}
    const body = (message.content ?? []).map((block) => block.text ?? '').join('')
    const call = calls.get(message.toolCallId ?? message.source?.callId)
    if (!call) continue
    const isError = message.isError === true || message.content?.[0]?.isError === true

    if (call.name === 'read' && !isError) {
      addSnapshot(call.args.file_path ?? call.args.path, seq, 'read', body)
      continue
    }
    if (!isError && !body.includes(MARKER)) continue
    if (!body.includes(MARKER)) continue
    if (call.name !== 'edit' && call.name !== 'run_code') continue

    const failure = parseFailure(body)
    let filePath = null
    let oldText = null
    let newText = null
    let entries = 1
    let ambiguous = false
    let oldTextSource = 'args'

    if (call.name === 'edit') {
      filePath = typeof call.args.file_path === 'string' ? call.args.file_path : failure.pathFromMessage
      const list = Array.isArray(call.args.edits)
        ? call.args.edits
        : call.args.old_string != null ? [{ oldText: call.args.old_string, newText: call.args.new_string }] : []
      entries = list.length
      const picked = list[failure.entryIndex] ?? list[0]
      oldText = picked?.oldText ?? picked?.old_string ?? null
      newText = picked?.newText ?? picked?.new_string ?? null
    } else {
      filePath = failure.pathFromMessage
      const code = typeof call.args.code === 'string' ? call.args.code : ''
      const pairs = extractRunCodeEntries(code)
      const editCalls = (code.match(/tools\.edit\s*\(/g) ?? []).length
      entries = pairs.length
      ambiguous = editCalls !== 1
      oldTextSource = 'run_code-source'
      const picked = pairs[failure.entryIndex] ?? (editCalls === 1 ? pairs[0] : null)
      oldText = picked?.oldText ?? null
      newText = picked?.newText ?? null
    }

    const base = {
      session: sessionName,
      preset,
      time: event.time ?? null,
      tool: call.name,
      path: filePath,
      entry: failure.entryIndex + 1,
      entries,
      ambiguous,
      reported: { similarity: failure.similarity, line: failure.line, minus: failure.minus, plus: failure.plus },
      oldText: typeof oldText === 'string' && oldText ? oldText : null,
      newText,
      oldTextSource,
    }

    if (!base.oldText) { out.skippedNoOldText++; out.index.push(base); continue }

    const key = filePath ? path.normalize(filePath) : null
    const snapshot = key ? pickSnapshot(snapshots.get(key), seq) : null
    let content = snapshot?.content ?? null
    let contentSource = snapshot ? 'session-' + snapshot.kind : null
    if (content == null && key) {
      try {
        if (fs.existsSync(key) && fs.statSync(key).isFile()) {
          content = fs.readFileSync(key, 'utf8')
          contentSource = 'disk'
        }
      } catch { /* 无权限或已删除 */ }
    }

    if (content == null) { out.skippedNoContent++; out.index.push({ ...base, contentSource: null, verified: null }); continue }

    const verified = verifyContent(content, failure.minus)
    const enriched = {
      ...base,
      contentSource,
      verified,
      exactHit: content.includes(base.oldText),
      squashedHit: squash(content).includes(squash(base.oldText)),
      normalizedHit: normalizeText(content).includes(normalizeText(base.oldText)),
    }
    out.index.push(enriched)
    if (verified === true) {
      const w = windowContent(content, failure.line, opts.windowLines)
      out.replay.push({ ...enriched, windowed: w.windowed, contentStartLine: w.startLine, content: w.content })
    }
  }
}

const opts = parseArgs(process.argv.slice(2))
const files = collectSessionFiles(opts.home, { format: opts.format })
const out = { scanned: 0, index: [], replay: [], skippedNoOldText: 0, skippedNoContent: 0 }
for (const entry of files) scanSession(entry.file, entry.workspace, opts, out)

out.index.forEach((c, i) => { c.id = 'fuzzy-' + String(i + 1).padStart(3, '0') })
out.replay.forEach((c, i) => { c.id = 'replay-' + String(i + 1).padStart(3, '0') })

const count = (list, pred) => list.filter(pred).length
const by = (list, key) => {
  const map = {}
  for (const c of list) map[key(c)] = (map[key(c)] ?? 0) + 1
  return map
}
const stats = {
  scanned: out.scanned,
  index: out.index.length,
  replay: out.replay.length,
  skippedNoOldText: out.skippedNoOldText,
  skippedNoContent: out.skippedNoContent,
  preset: by(out.index, (c) => c.preset),
  tool: by(out.index, (c) => c.tool),
  contentSource: by(out.replay, (c) => c.contentSource),
  replaySquashedHit: count(out.replay, (c) => c.squashedHit),
  replayExactHit: count(out.replay, (c) => c.exactHit),
  uniquePairs: new Set(out.replay.map((c) => c.path + '\n' + c.oldText)).size,
  similarity: by(out.index, (c) => {
    const s = c.reported.similarity
    if (s == null) return '未知'
    return s >= 90 ? '90-94' : s >= 80 ? '80-89' : s >= 70 ? '70-79' : s >= 50 ? '50-69' : '0-49'
  }),
}

if (!opts.quiet) console.log(JSON.stringify(stats, null, 1))

if (opts.dryRun) {
  if (!opts.quiet) console.log('dry-run：不写文件')
  process.exit(0)
}

fs.mkdirSync(opts.outDir, { recursive: true })
const writeJsonl = (name, list) => {
  const target = path.join(opts.outDir, name)
  fs.writeFileSync(target, list.map((c) => JSON.stringify(c)).join('\n') + (list.length ? '\n' : ''))
  return target + '（' + (fs.statSync(target).size / 1024).toFixed(0) + ' KB）'
}
if (!opts.quiet) {
  console.log('写出：' + writeJsonl('fuzzy-failures-index.jsonl', out.index))
  console.log('写出：' + writeJsonl('fuzzy-replay-cases.jsonl', out.replay))
}
