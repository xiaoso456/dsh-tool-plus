#!/usr/bin/env node
/**
 * 阈值分档分析：用历史报错里引擎自己算的相似度，估算把阈值往下调会接受哪些失败样本，
 * 并检查这些样本「首个不同行」到底差在哪（同型 / 近似 / 实质）。
 *
 * 为什么不用回放语料重算：会话里能抢救出来的内容大多不是失败时刻的那份（模型先 write
 * 再多次 edit，快照会落后），重算出来的置信度和当时报的对不上。历史报错里的
 * 「Closest match (N% similar)」就是引擎在真实内容上打的分，直接用它做反事实更可靠。
 *
 * 行配对的方向（容易搞反）：报错里
 *   - 请求的文本（模型以为文件里是这样）
 *   + 文件里实际的文本
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CASES = path.join(HERE, 'fixtures', 'fuzzy-failures-index.jsonl')

/**
 * 复刻 2026-11-21 修复前的 normalizeForFuzzy：去首尾空白、折叠空白、统一部分引号与破折号。
 * 它**不含** U+201C/U+201D/U+2018/U+2019（最常见的弯双引号、弯单引号），历史分档要按
 * 失败发生时的真实行为算，所以这里保留旧口径，不跟着源码一起改。
 */
function normalizeForFuzzy(line) {
  return line
    .trim()
    .replace(/[""„‟«»]/g, '"')
    .replace(/[''‚‛BT´]/g, "'")
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/[ \t]+/g, ' ')
}

function levenshtein(a, b) {
  const m = a.length
  const n = b.length
  if (!m || !n) return Math.max(m, n)
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[n]
}

function similarity(a, b) {
  const len = Math.max(a.length, b.length)
  return len === 0 ? 1 : 1 - levenshtein(a, b) / len
}

const cases = fs.readFileSync(CASES, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
const withText = cases.filter((c) => c.oldText)
const bands = [[95, 101], [90, 95], [85, 90], [80, 85], [70, 80], [0, 70]]

console.log('有 oldText 的失败：' + withText.length + ' / ' + cases.length)
console.log('')
console.log('相似度档 | 条数 | 首个不同行：同型 / 近似 / 实质 | 多行 oldText | 多 entry | 短文本<60字 | 累计可达')
let cumulative = 0
for (const [lo, hi] of bands) {
  const sel = withText.filter((c) => c.reported.similarity != null && c.reported.similarity >= lo && c.reported.similarity < hi)
  let cosmetic = 0
  let near = 0
  for (const item of sel) {
    const requested = item.reported.minus[0] ?? ''
    const actual = item.reported.plus[0] ?? ''
    if (!requested || !actual) continue
    if (normalizeForFuzzy(requested) === normalizeForFuzzy(actual)) cosmetic += 1
    else if (similarity(normalizeForFuzzy(requested), normalizeForFuzzy(actual)) >= 0.7) near += 1
  }
  const risky = sel.length - cosmetic - near
  cumulative += sel.length
  const label = '[' + lo + ',' + hi + ')'
  console.log(
    label.padEnd(10) + ' | ' + String(sel.length).padStart(3) +
    ' | ' + cosmetic + ' / ' + near + ' / ' + risky +
    ' | ' + sel.filter((c) => c.oldText.split('\n').length > 1).length +
    ' | ' + sel.filter((c) => c.entries > 1).length +
    ' | ' + sel.filter((c) => c.oldText.length < 60).length +
    ' | ' + cumulative,
  )
}

console.log('')
console.log('阈值 0.90 会新接受（90-94 档）的逐条明细：')
for (const item of withText.filter((c) => c.reported.similarity >= 90 && c.reported.similarity < 95)) {
  const requested = item.reported.minus[0] ?? ''
  const actual = item.reported.plus[0] ?? ''
  const same = normalizeForFuzzy(requested) === normalizeForFuzzy(actual)
  const score = similarity(normalizeForFuzzy(requested), normalizeForFuzzy(actual))
  console.log('--- ' + item.id + '  ' + item.reported.similarity + '%  entries=' + item.entries + '  lines=' + item.oldText.split('\n').length + '  ' + (same ? '同型' : score >= 0.7 ? '近似' : '实质'))
  console.log('    请求: ' + JSON.stringify(requested.slice(0, 100)))
  console.log('    实际: ' + JSON.stringify(actual.slice(0, 100)))
}
