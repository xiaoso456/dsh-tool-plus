/**
 * 会话日志读取：多帧 zstd 解压、按会话目录挑版本、读头部 preset。
 *
 * 三个分析脚本（本目录的 token 统计、era 聚合、失败统计）共用这一份，别再各自
 * 复制解压逻辑——会话格式已经换过三代（无后缀 / .v3 / .v4），解压与选版规则只
 * 需要改一处。
 */
import { zstdDecompressSync } from 'node:zlib'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const SESSION_FILE = /^session(?:\.v(\d+))?\.jsonl\.zstd$/

/** 会话根目录：显式 home > $DSH_HOME > ~/.dsh。 */
export function sessionRoot(home) {
  return path.join(home ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'sessions')
}

/**
 * 多帧 zstd 解压。整包 zstdDecompressSync 只吐第一帧——v1 时代一帧装一条事件，
 * 直接整包解压会只剩头部那行。
 */
export function decompressSession(file) {
  const buf = fs.readFileSync(file)
  const starts = []
  for (let pos = 0; (pos = buf.indexOf(ZSTD_MAGIC, pos)) !== -1; pos += 4) starts.push(pos)
  starts.push(buf.length)
  let text = ''
  for (let i = 0; i < starts.length - 1; i++) {
    try { text += zstdDecompressSync(buf.subarray(starts[i], starts[i + 1])).toString() } catch { /* 压缩数据里撞见的假魔数 */ }
  }
  return text
}

/** 会话头里的 agentPreset；没有头信息时给占位串，便于分组时一眼看出。 */
export function sessionPreset(text) {
  for (const line of text.split('\n')) {
    if (!line.startsWith('{') || !line.includes('"type":"session"')) continue
    try { return JSON.parse(line).agentPreset ?? '(null)' } catch { return '(unreadable)' }
  }
  return '(no-header)'
}

/**
 * 每个会话目录挑一份会话文件：默认取版本最高的（迁移会留下 v1/v3/v4 三代），
 * `format` 传 4 / 'v4' 时只认该版本，传 'all' 或省略表示不筛。
 */
export function collectSessionFiles(home, { since = null, format = 'all' } = {}) {
  const root = sessionRoot(home)
  if (!fs.existsSync(root)) throw new Error('找不到会话目录：' + root)
  const wanted = format === 'all' ? null : Number(String(format).replace(/^v/, ''))
  const picked = []
  for (const workspace of fs.readdirSync(root)) {
    const wsDir = path.join(root, workspace)
    let wsStat
    try { wsStat = fs.statSync(wsDir) } catch { continue }
    if (!wsStat.isDirectory()) continue
    for (const session of fs.readdirSync(wsDir)) {
      const dir = path.join(wsDir, session)
      let entries
      try { entries = fs.readdirSync(dir) } catch { continue }
      let best = null
      for (const name of entries) {
        const match = SESSION_FILE.exec(name)
        if (!match) continue
        const version = match[1] === undefined ? 1 : Number(match[1])
        if (wanted !== null && version !== wanted) continue
        if (best === null || version > best.version) best = { version, file: path.join(dir, name) }
      }
      if (best === null) continue
      const stat = fs.statSync(best.file)
      if (since !== null && stat.mtimeMs < since) continue
      picked.push({ file: best.file, version: best.version, mtime: stat.mtimeMs, workspace })
    }
  }
  return picked.sort((a, b) => a.mtime - b.mtime)
}
