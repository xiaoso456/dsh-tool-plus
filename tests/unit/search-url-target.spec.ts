/**
 * URL 目标搜索：grep 搜 http 页面。
 *
 * 这条链路依赖上游 `materializeReadUrlContent`：引擎把抓取渲染后的正文写进
 * `session.getArtifactsDir()` 再交给搜索路径。DSH 没有 host 侧 artifact 存储，
 * 由 `src/tools/shared/artifacts.ts` 用 tmpdir 顶上（与 bash spill 同法）。
 *
 * 之前这里判过「不支持」并把提示词文案收窄，是误判：机制是缺一个 seam，
 * 不是缺能力。这两条测试就是钉住「seam 接上之后真的能搜」。
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveConfig } from '../../src/config/settings.ts'
import { executeGrepTool } from '../../src/tools/grep/adapter/index.ts'
import { artifactsRoot, ensureArtifactsDir, sweepStaleArtifacts } from '../../src/tools/shared/artifacts.ts'

/** 正文够长以通过 reader 的质量门（>100 非空白字符），另含一个可搜的 needle。 */
const BODY = [
  '<!doctype html><html><head><title>Searchable</title></head><body><article>',
  '<h1>Hello URL</h1>',
  '<p>',
  'This paragraph exists so the reader quality gate accepts the page. '.repeat(6),
  '</p><p>needle_here too.</p>',
  '</article></body></html>',
].join('')

let server: http.Server | undefined
let port = 0
const tmpDirs: string[] = []

async function startServer(): Promise<number> {
  const s = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(BODY)
  })
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', () => resolve()))
  server = s
  return (s.address() as { port: number }).port
}

afterAll(() => {
  server?.close()
  server = undefined
})

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function exec(): any {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-plus-url-target-'))
  tmpDirs.push(dir)
  return { agent: { session: { header: { cwd: dir } } }, signal: undefined }
}

describe('grep 搜 URL 目标', () => {
  it('命中页面正文里的模式', async () => {
    port = port || await startServer()
    const out = await executeGrepTool(exec(), resolveConfig({}), {
      pattern: 'needle_here',
      path: `http://127.0.0.1:${port}/doc.html`,
    }, undefined as never)
    expect(out.matchCount).toBe(1)
    expect(out.text).toContain('needle_here')
  })

  it('页面里没有该模式时如实报零命中（不是抛错）', async () => {
    port = port || await startServer()
    const out = await executeGrepTool(exec(), resolveConfig({}), {
      pattern: 'definitely_not_there_xyz',
      path: `http://127.0.0.1:${port}/doc.html`,
    }, undefined as never)
    expect(out.matchCount).toBe(0)
    expect(out.text).toContain('No matches found')
  })

  /**
   * 抓取开关是「不许联网」的总闸，grep 与 ast_grep 搜 URL 走的是同一条物化路径
   * （`materializeReadUrlToFile`），所以在这里一并拦住；read 侧的同一道门控另有测试。
   */
  it('fetchEnabled 关掉后 grep 不收 URL，不许偷偷联网', async () => {
    port = port || await startServer()
    await expect(executeGrepTool(exec(), resolveConfig({ fetchEnabled: false }), {
      pattern: 'needle_here',
      path: `http://127.0.0.1:${port}/doc.html`,
    }, undefined as never)).rejects.toThrow(/URL reads are disabled/u)
  })
})

describe('artifacts seam', () => {
  it('ensureArtifactsDir 按会话建出可写目录，两个会话互不相同', () => {
    const a = ensureArtifactsDir('sess-a')
    const b = ensureArtifactsDir('sess-b')
    expect(a).toBe(path.join(artifactsRoot(), 'sess-a'))
    expect(fs.statSync(a!).isDirectory()).toBe(true)
    expect(a).not.toBe(b)
  })

  it('会话 id 里的非法路径字符被替换（Windows 不能有冒号）', () => {
    const dir = ensureArtifactsDir('a:b/c')
    expect(dir).toBe(path.join(artifactsRoot(), 'a_b_c'))
  })

  it('sweepStaleArtifacts 只删超过 24h 的文件，保留新文件', () => {
    const root = ensureArtifactsDir('sweep-spec')!
    const sub = path.join(root, 'url-search')
    fs.mkdirSync(sub, { recursive: true })
    const fresh = path.join(sub, 'fresh-spec.txt')
    const old = path.join(sub, 'old-spec.txt')
    fs.writeFileSync(fresh, 'x')
    fs.writeFileSync(old, 'x')
    const stale = Date.now() - 25 * 60 * 60 * 1000
    fs.utimesSync(old, new Date(stale), new Date(stale))
    sweepStaleArtifacts()
    expect(fs.existsSync(fresh)).toBe(true)
    expect(fs.existsSync(old)).toBe(false)
    fs.rmSync(fresh, { force: true })
  })
})
