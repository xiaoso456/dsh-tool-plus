/**
 * read 工具单元覆盖（合并自 read-concurrent / read-conflicts-selector /
 * read-notice / read-url-image 四个 spec，加上 read-browser-render 里不启动
 * 浏览器的三条）：
 * - 并发安全（isConcurrencySafe 接过来，2026-08-28）；
 * - `:conflicts` 选择器 + win-path-fixes probe 判定（T11-1）；
 * - 截断提示（T02，会话层 formatOutputNotice 语义）；
 * - URL 图片读取端到端（拍板#22）；
 * - fetch 链的浏览器路由：provider 顺序、readerEnabled 开关、CSR shell 判定与
 *   停泊 shell 回退（真正起浏览器的用例留在 read-browser-render.spec.ts）。
 * read 图片本地路径融合见 read-image-fusion.spec.ts。
 * @module tests
 */

import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { gzipSync } from 'node:zlib'
import { execFileSync, spawnSync } from 'node:child_process'
import { executeReadTool, registerRead, renderReadOutput } from '../../src/tools/read/adapter/index.ts'
import { resolveProbeResult } from '../../src/tools/shared/win-path-fixes.ts'
import { FETCH_PROVIDER_ORDER, isCsrHtmlShell, renderHtmlToText } from '../../src/tools/omp/tools/fetch.ts'

/* -------------------------------------------------------------------------- */
/* 通用夹具                                                                    */
/* -------------------------------------------------------------------------- */

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-plus-read-unit-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** 模拟 DSH exec 上下文：agent.session 是同一对象（同一会话的并发调用）。 */
function execFor(cwd: string, provider = 'test', model = 'test-model'): any {
  return {
    agent: {
      session: { header: { cwd }, requestHeader: () => ({ config: { provider, model } }) },
      options: { provider, model },
    },
    signal: undefined,
  }
}

/** 只有 cwd 的轻量 exec（T02 截断提示 / :conflicts 选择器同款）。 */
function execForCwd(cwd: string): any {
  return { agent: { session: { header: { cwd } } }, signal: undefined }
}

function ctxFor(opts: { attachments?: unknown; llm?: unknown }): any {
  const services: Record<string, unknown> = {}
  if (opts.attachments !== undefined) services.attachments = opts.attachments
  if (opts.llm !== undefined) services.llm = opts.llm
  return {
    get: (key: string) => services[key],
    fs: { resolve: async () => { throw new Error('unused') }, stat: async () => undefined, readBytes: async () => new Uint8Array() },
    emit: () => undefined,
  }
}

// 1x1 红色 PNG（合法文件头，内容嗅探可命中）
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000148afa4710000000049454e44ae426082',
  'hex',
)

const visionLlm = { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }

/** 与宿主 detectImage 同源的字节权威判定（magic 是权威）。 */
function detectMagic(data: Uint8Array): string {
  const hex = Buffer.from(data.subarray(0, 12)).toString('hex')
  if (hex.startsWith('89504e47')) return 'image/png'
  if (hex.startsWith('ffd8ff')) return 'image/jpeg'
  if (hex.startsWith('52494646') && Buffer.from(data.subarray(8, 12)).toString('ascii') === 'WEBP') return 'image/webp'
  if (hex.startsWith('47494638')) return 'image/gif'
  return 'unknown'
}

function mockAttachments() {
  const saved: Array<{ data: Uint8Array; mediaType: string; name?: string }> = []
  return {
    saved,
    service: {
      imageLimits: {
        maxImageBytes: 20 * 1024 * 1024,
        maxMessageImageBytes: 200 * 1024 * 1024,
        maxImagePixels: 64_000_000,
        maxImageDimension: 8192,
        mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      },
      saveImage: async (input: { data: Uint8Array; mediaType: string; name?: string }) => {
        if (detectMagic(input.data) !== input.mediaType) {
          throw Object.assign(new Error(`declared ${input.mediaType}, bytes are different`), { code: 'IMAGE_TYPE_MISMATCH' })
        }
        saved.push(input)
        return {
          attachmentId: `sha256:${crypto.createHash('sha256').update(input.data).digest('hex')}`,
          mediaType: input.mediaType,
          bytes: input.data.byteLength,
          width: 200,
          height: 200,
        }
      },
    },
  }
}

/* -------------------------------------------------------------------------- */
/* read 并发安全（isConcurrencySafe 接过来）                                     */
/* -------------------------------------------------------------------------- */

describe('read 并发安全（isConcurrencySafe 接过来）', () => {
  it('注册面：isConcurrencySafe 分类器存在，默认 true，readConcurrentSafe=false 关闭', () => {
    // 注意：defineTool 包装了分类器——先 validate(args) 再调用户函数，
    // 所以必须传符合 read 参数 schema 的调用参数（{ path }）。
    let def: any
    const ctx = { tools: { register: (d: any) => { def = d; return () => undefined } } } as any
    registerRead(ctx, () => ({}) as never)
    expect(typeof def.isConcurrencySafe).toBe('function')
    expect(def.isConcurrencySafe({ path: 'x' })).toBe(true)

    let defOff: any
    const ctxOff = { tools: { register: (d: any) => { defOff = d; return () => undefined } } } as any
    registerRead(ctxOff, () => ({ readConcurrentSafe: false }) as never)
    expect(defOff.isConcurrencySafe({ path: 'x' })).toBe(false)
  })

  it('并发文本读取：结果各自正确无串扰', async () => {
    const dir = tmpDir()
    const files = ['a.txt', 'b.txt', 'c.txt'].map((n) => {
      const p = path.join(dir, n)
      fs.writeFileSync(p, `content of ${n}\nline2\nline3\n`)
      return p
    })
    const results = await Promise.all(
      files.map((f) => executeReadTool(execFor(dir), {} as never, { path: f }, ctxFor({}))),
    )
    results.forEach((r, i) => {
      expect(r.text).toContain(`content of ${path.basename(files[i])}`)
      expect(r.text).not.toContain(`content of ${path.basename(files[(i + 1) % files.length])}`)
    })
  })

  it('并发图片读取：attachment 各自提交成功', async () => {
    const dir = tmpDir()
    const files = ['a.png', 'b.png', 'c.png'].map((n) => {
      const p = path.join(dir, n)
      fs.writeFileSync(p, PNG_BYTES)
      return p
    })
    const attachments = mockAttachments()
    const results = await Promise.all(
      files.map((f) =>
        executeReadTool(execFor(dir), {} as never, { path: f }, ctxFor({ attachments: attachments.service, llm: visionLlm })),
      ),
    )
    results.forEach((r) => {
      expect(r.image).toBeTruthy()
      expect(r.image!.attachmentId).toMatch(/^sha256:/)
    })
    expect(attachments.saved).toHaveLength(3)
  })

  it('并发读含冲突块文件：共享 ConflictHistory 并发不炸，各自检测到冲突', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'conflict.txt')
    fs.writeFileSync(file, 'a\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> branch\nb\n')
    const exec = execFor(dir)
    const [r1, r2] = await Promise.all([
      executeReadTool(exec, {} as never, { path: file }, ctxFor({})),
      executeReadTool(exec, {} as never, { path: file }, ctxFor({})),
    ])
    expect(r1.text).toContain('unresolved conflict')
    expect(r2.text).toContain('unresolved conflict')
  })
})

/* -------------------------------------------------------------------------- */
/* read :conflicts 选择器（T11-1）                                              */
/* -------------------------------------------------------------------------- */

const CONFLICTED = [
  'def choose():',
  '<<<<<<< HEAD',
  '    print("ours")',
  '=======',
  '    print("theirs")',
  '>>>>>>> feature',
  '    return None',
  '',
].join('\n')

describe('read :conflicts 选择器（T11-1）', () => {
  it('`path:conflicts` 输出冲突块列表（#1 L2-6）', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'conflicted.py')
    fs.writeFileSync(file, CONFLICTED)

    const out = await executeReadTool(execForCwd(dir), {} as never, { path: `${file}:conflicts` }, null as never)

    expect(out.text).toContain('1 unresolved conflict')
    expect(out.text).toContain('#1')
    expect(out.text).toContain('L2-6')
  })
})

describe('win-path-fixes probe 判定（T11-1 单元）', () => {
  it('lstat 成功 + open 失败（Windows ADS 假阳性）→ missing，选择器拆分生效', () => {
    expect(resolveProbeResult(true, false, true)).toBe('missing')
  })

  it('lstat 成功 + open 成功（真实文件/真实 ADS）→ exists', () => {
    expect(resolveProbeResult(true, true, true)).toBe('exists')
  })

  it('非冒号路径不做 open 验证：lstat 成功 → exists', () => {
    expect(resolveProbeResult(true, false, false)).toBe('exists')
  })

  it('lstat 失败 → missing（原版语义）', () => {
    expect(resolveProbeResult(false, false, true)).toBe('missing')
  })
})

/* -------------------------------------------------------------------------- */
/* read 截断提示（T02）                                                         */
/* -------------------------------------------------------------------------- */

describe('read 截断提示（T02）', () => {
  it('长行文件：输出含 "Some lines truncated to N chars" 提示', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'longline.txt')
    fs.writeFileSync(file, 'A'.repeat(2000))

    const out = await executeReadTool(execForCwd(dir), {} as never, { path: file }, null as never)

    expect(out.text).toContain('…')
    // 提示在 notice 字段，render 拼接后模型可见
    expect(out.notice).toMatch(/Some lines truncated to \d+ chars/)
    expect(renderReadOutput(out)).toContain('Some lines truncated to')
  })

  it('大文件（超 summarize 上限）：输出含 "Showing lines X-Y of Z" 提示', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'huge.log')
    // 20001 行 > MAX_SUMMARY_LINES(20000)，且 > read.defaultLimit(300) → 走普通截断路径
    fs.writeFileSync(file, Array.from({ length: 20_001 }, (_, i) => `line-${i}`).join('\n'))

    const out = await executeReadTool(execForCwd(dir), {} as never, { path: file }, null as never)

    expect(out.notice).toMatch(/Showing lines \d+-\d+ of 20001/)
    expect(renderReadOutput(out)).toContain('Showing lines')
  })

  it('普通小文件：无提示，render 输出 = 文本', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'small.txt')
    fs.writeFileSync(file, 'hello\nworld\n')

    const out = await executeReadTool(execForCwd(dir), {} as never, { path: file }, null as never)

    expect(out.notice).toBeUndefined()
    expect(renderReadOutput(out)).toBe(out.text)
  })
})

/* -------------------------------------------------------------------------- */
/* URL 图片读取（拍板#22 端到端）                                                */
/* -------------------------------------------------------------------------- */

/** URL 图片夹具：本地 HTTP 服务，只在 bytes 被真正请求时才 listen（惰性）。 */
let urlServer: http.Server | undefined
let urlPort = 0

async function startUrlServer(): Promise<number> {
  urlServer = http.createServer((_req, res) => {
    res.setHeader('content-type', 'image/png')
    res.end(PNG_BYTES)
  })
  await new Promise<void>(resolve => urlServer!.listen(0, '127.0.0.1', () => resolve()))
  return (urlServer.address() as { port: number }).port
}

afterAll(() => {
  urlServer?.close()
  urlServer = undefined
  htmlServer?.close()
  htmlServer = undefined
})

/** 只有 bridge 开关的 ctx（URL 图片路径用）。 */
function ctxForBridge(withBridge: boolean): any {
  const services: Record<string, unknown> = {}
  if (withBridge) {
    services.attachments = mockAttachments().service
    services.llm = visionLlm
  }
  return {
    get: (key: string) => services[key],
    fs: { resolve: async () => { throw new Error('unused') }, stat: async () => undefined, readBytes: async () => new Uint8Array() },
    emit: () => undefined,
  }
}

describe('URL 图片读取（拍板#22 端到端）', () => {
  it('image/png URL：sharp 解码缩放成功并经 bridge 提交 attachment', async () => {
    urlPort = urlPort || await startUrlServer()
    const out = await executeReadTool(execFor(process.cwd()), {} as never, { path: `http://127.0.0.1:${urlPort}/pixel.png` }, ctxForBridge(true))
    expect(out.image?.attachmentId, 'attachment committed').toMatch(/^sha256:/)
    expect(out.text).toContain('<path>http://')
    expect(out.text).toContain('<type>image</type>')
  })

  it('无 bridge：解码仍成功（说明 shim 复活），诚实降级为元数据文本且无 attachment', async () => {
    urlPort = urlPort || await startUrlServer()
    const out = await executeReadTool(execFor(process.cwd()), {} as never, { path: `http://127.0.0.1:${urlPort}/pixel.png` }, ctxForBridge(false))
    expect(out.image).toBeUndefined()
    expect(out.text).toContain('Fetched image content (image/png)')
    expect(out.text).toContain('Method: image-metadata')
  })

  it('HTML 页面：native 后端转 markdown（正文 + frontmatter title）', async () => {
    htmlPort = htmlPort || await startHtmlServer()
    const out = await executeReadTool(execFor(process.cwd()), {} as never, { path: `http://127.0.0.1:${htmlPort}/doc.html` }, ctxForBridge(true))
    expect(out.text).toContain('Method: native')
    expect(out.text).toContain('# Hello URL')
    expect(out.text).toContain('reader quality gate')
  })

  it('HTML 页面 `:raw`：返回原 HTML 而非 markdown', async () => {
    htmlPort = htmlPort || await startHtmlServer()
    const out = await executeReadTool(execFor(process.cwd()), {} as never, { path: `http://127.0.0.1:${htmlPort}/doc.html:raw` }, ctxForBridge(true))
    expect(out.text).toContain('Method: raw')
    expect(out.text).toContain('<article>')
    expect(out.text).not.toContain('# Hello URL')
  })
})

/** HTML 页面夹具：正文够长以通过 reader 的质量门（>100 非空白字符）。 */
let htmlServer: http.Server | undefined
let htmlPort = 0
const HTML_PAGE = [
  '<!doctype html><html><head><title>Doc</title></head><body><article>',
  '<h1>Hello URL</h1>',
  '<p>' + 'This paragraph exists so the reader quality gate accepts the page. '.repeat(6) + '</p>',
  '<p>Second para with more words to pass the gate.</p>',
  '</article></body></html>',
].join('')

async function startHtmlServer(): Promise<number> {
  htmlServer = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(HTML_PAGE)
  })
  await new Promise<void>(resolve => htmlServer!.listen(0, '127.0.0.1', () => resolve()))
  return (htmlServer.address() as { port: number }).port
}

/* -------------------------------------------------------------------------- */
/* fetch 链的浏览器路由（不启动浏览器的部分）                                     */
/* -------------------------------------------------------------------------- */

/** Static HTML long enough for the native converter to pass the quality gate. */
const STATIC_HTML = `<!doctype html><html><head><title>Static Page</title></head><body>
<main><h1>Static Heading</h1><p>This paragraph carries enough words to clear the
hundred-character quality gate when the native backend converts it to markdown.
It really does, because the gate looks at the trimmed output length.</p></main>
</body></html>`

/** JS-gated page: the visible text only exists after the script runs. */
const JS_GATED_HTML = `<!doctype html><html><head><title>SPA Page</title></head><body>
<div id="app">loading…</div>
<script>document.getElementById('app').textContent = 'rendered-by-js-12345. This dynamically injected paragraph is deliberately long so the rendered markdown clears the reader-chain quality gate (more than one hundred non-whitespace characters) and proves the browser backend executed the page script.'</script>
</body></html>`

/** CSR app shell: script-dense, text-light — isCsrHtmlShell must flag it. */
const CSR_SHELL_HTML = `<!doctype html><html><head><title>CSR Shell Page</title>
<meta name="description" content="The whole body of this page is rendered by client-side JavaScript after hydration, so the static markup only carries a mount point."></head><body>
<div id="root"></div>
<noscript>JavaScript is required to run this application. Please enable JavaScript or upgrade to a browser that supports modern web standards so the collaborative canvas can initialize its document model before any drawing tools become available at all.</noscript>
<script>document.getElementById('root').textContent = 'csr-shell-rendered-6789. The browser render injects this long paragraph at runtime so the markdown produced from it clears the reader-chain quality gate and proves the shell reached the browser backend through the automatic provider order.'</script>
<script>void 0;</script>
<script>void 0;</script>
</body></html>`

let routeServer: http.Server | undefined
let routePort = 0

async function startRouteServer(kind: 'static' | 'shell'): Promise<void> {
  routeServer = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(kind === 'static' ? STATIC_HTML : CSR_SHELL_HTML)
  })
  await new Promise<void>(resolve => routeServer!.listen(0, '127.0.0.1', () => resolve()))
  routePort = (routeServer!.address() as { port: number }).port
}

afterAll(() => {
  routeServer?.close()
  routeServer = undefined
})

/** Minimal Settings-shaped object for renderHtmlToText (only get is used). */
function settingsLike(values: Record<string, unknown>): any {
  return { get: (path: string) => values[path] }
}

describe('fetch provider order', () => {
  it('places the browser backend at the tail of FETCH_PROVIDER_ORDER', () => {
    expect(FETCH_PROVIDER_ORDER[FETCH_PROVIDER_ORDER.length - 1]).toBe('browser')
    expect(FETCH_PROVIDER_ORDER).toContain('browser')
  })

  it('never reports a browser method when browser.readerEnabled is off', async () => {
    // fetchReader explicitly prefers the browser — with the switch off the
    // chain must skip it entirely and fall back to a local backend.
    await startRouteServer('static')
    const url = `http://127.0.0.1:${routePort}/`
    const result = await renderHtmlToText(
      url,
      STATIC_HTML,
      20,
      settingsLike({ 'providers.fetch': 'browser', 'browser.readerEnabled': false }),
      undefined,
      null,
    )
    expect(result.method).not.toBe('browser')
    // The native backend clears the gate on static HTML.
    expect(result.ok).toBe(true)
    expect(result.method).toBe('native')
    expect(result.content).toContain('Static Heading')
  })
})

describe('CSR shell routing (auto order, browser sits last)', () => {
  /** Offline stub for the remote readers (jina) so the suite never leaves localhost. */
  const offlineFetch = (async () => {
    throw new Error('offline test stub')
  }) as unknown as typeof fetch

  it('flags script-heavy text-light HTML as a CSR shell', () => {
    expect(isCsrHtmlShell(CSR_SHELL_HTML)).toBe(true)
    expect(isCsrHtmlShell(STATIC_HTML)).toBe(false)
    expect(isCsrHtmlShell(JS_GATED_HTML)).toBe(false)
  })

  it('returns the parked shell when the browser is disabled (no regression)', async () => {
    await startRouteServer('shell')
    const url = `http://127.0.0.1:${routePort}/`
    const result = await renderHtmlToText(
      url,
      CSR_SHELL_HTML,
      20,
      settingsLike({ 'providers.fetch': 'auto', 'browser.readerEnabled': false }),
      undefined,
      null,
      offlineFetch,
    )
    // Browser out of the chain: the parked native remnant is surfaced, which
    // is exactly the pre-hold behaviour for degraded environments.
    expect(result.ok).toBe(true)
    expect(result.method).toBe('native')
    expect(result.content).toContain('meta-description: The whole body')
  })
})

/* -------------------------------------------------------------------------- */
/* read JSON/JSONL 查询（P1：OMP 18.12.6 read-json 移植）                        */
/* -------------------------------------------------------------------------- */

/**
 * jq 来自 vendored brush 的 Rust 内置（`pi-builtins/src/jq.rs`，jaq 3.1.1），
 * 随插件自己的 shell 一起提供，不是外部可执行文件——所以这里不做可用性探测：
 * 谁把这个内置拆了，read 的 JSON 能力就真的坏了，测试应当直接红。
 */

describe('read JSON/JSONL 查询', () => {
  const readJson = async (dir: string, p: string) =>
    executeReadTool(execForCwd(dir), {} as never, { path: p }, null as never)

  it('q 投影出字符串时按 jq 默认加引号', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify([{ name: 'a' }, { name: 'b' }]))
    const out = await readJson(dir, 'data.json?q=.[].name')
    expect(out.text).toBe('"a"\n"b"')
  })

  it('raw=true 输出不带引号的原始字符串', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify([{ name: 'a' }, { name: 'b' }]))
    const out = await readJson(dir, 'data.json?q=.[].name&raw=true')
    expect(out.text).toBe('a\nb')
  })

  it('compact=true 每个值压成一行', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify([{ name: 'a' }, { name: 'b' }]))
    const out = await readJson(dir, 'data.json?q=.[]&compact=true')
    expect(out.text).toBe('{"name":"a"}\n{"name":"b"}')
  })

  it('不带 compact 时按 jaq 缩进排版', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify([{ name: 'a' }]))
    const out = await readJson(dir, 'data.json?q=.[]')
    expect(out.text).toBe('{\n  "name": "a"\n}')
  })

  it('limit 截断并给出可续读的下一页提示', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify([1, 2, 3, 4, 5]))
    const out = await readJson(dir, 'data.json?q=.[]&limit=2')
    expect(out.text).toContain('1')
    expect(out.text).toContain('2')
    expect(out.text).toContain('offset=2')
    expect(out.text).toContain('to continue')
  })

  it('过滤器里的 & 需转义成 %26，转义后仍原样传给 jq', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify([{ tag: 'a&b' }, { tag: 'plain' }]))
    const out = await readJson(dir, 'data.json?q=.[]%7Cselect(.tag%3D%3D%22a%26b%22)')
    expect(out.text).toContain('a&b')
    expect(out.text).not.toContain('plain')
  })

  it('过滤器里的 + 不被当空格解码', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify([{ tag: 'a+b' }, { tag: 'a b' }]))
    const out = await readJson(dir, 'data.json?q=.[]|select(.tag=="a+b")')
    expect(out.text).toContain('a+b')
    expect(out.text).not.toContain('a b')
  })

  it('JSONL 逐行 select', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'rows.jsonl'), '{"n":1}\n{"n":2}\n{"n":3}\n')
    const out = await readJson(dir, 'rows.jsonl?q=select(.n>1)')
    expect(out.text).toContain('"n": 2')
    expect(out.text).toContain('"n": 3')
    expect(out.text).not.toContain('"n": 1')
  })

  it('ndjson 同样被识别为 JSON 源', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'rows.ndjson'), '{"n":7}\n')
    const out = await readJson(dir, 'rows.ndjson?q=.n')
    expect(out.text).toContain('7')
  })

  it('过滤器语法错误时抛错并带出 jq 的 stderr', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'data.json'), '[]')
    await expect(readJson(dir, 'data.json?q=.[|')).rejects.toThrow(/jq|JSON/i)
  })

  // 关键回归守卫：没有 ?q= 的普通 .json 必须还是原样文本读，不能被 JSON 分派抢走。
  it('不带 ?q= 的 .json 仍按普通文本读取', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'plain.json'), '{\n  "a": 1\n}\n')
    const out = await readJson(dir, 'plain.json')
    expect(out.text).toContain('"a": 1')
    expect(out.text).toMatch(/\d+[:|]/)
  })
})

/* -------------------------------------------------------------------------- */
/* read tail 选择器 `:-N`（OMP 18.12.6 新增能力）                              */
/* -------------------------------------------------------------------------- */

/**
 * 尾巴读是 18.12.6 才有的能力：v17.3.5 的 ParsedSelector 里没有 tail，
 * 老代码把 `:-10` 当畸形选择器，实测报 `Path 'n.txt:-5' not found`。
 * 这里的判据是「末尾 N 行、且不能漏出更早的行」，用零填充行名避免
 * `row-1` 命中 `row-10` 这种子串假阳性。
 */
describe('read tail 选择器', () => {
  const writeRows = (dir: string, n = 100): string => {
    const p = path.join(dir, 'n.txt')
    fs.writeFileSync(p, Array.from({ length: n }, (_, i) => `row-${String(i + 1).padStart(3, '0')}`).join('\n') + '\n')
    return p
  }

  it(':-N 读文件末尾 N 行，且不含更早的行', async () => {
    const dir = tmpDir()
    writeRows(dir)
    const out = await executeReadTool(execForCwd(dir), {} as never, { path: 'n.txt:-5' }, null as never)
    for (const n of [96, 97, 98, 99, 100]) expect(out.text).toContain(`row-${String(n).padStart(3, '0')}`)
    // 非 raw 的单范围读固定带 1 行前置上下文（4.6 节），所以 row-095 应当出现，
    // 更早的 row-094 不能出现。逐字边界由下面的 :raw 用例钉住。
    expect(out.text).toContain('row-095')
    expect(out.text).not.toContain('row-094')
  })

  it(':-N 不会再被当成字面路径（旧行为是 Path not found）', async () => {
    const dir = tmpDir()
    writeRows(dir)
    const out = await executeReadTool(execForCwd(dir), {} as never, { path: 'n.txt:-5' }, null as never)
    expect(out.text).not.toContain('not found')
    expect(out.text).toContain('row-100')
  })

  it(':-N 与 :raw 组合时返回逐字内容，不带行号前缀', async () => {
    const dir = tmpDir()
    writeRows(dir)
    const out = await executeReadTool(execForCwd(dir), {} as never, { path: 'n.txt:-5:raw' }, null as never)
    expect(out.text).toContain('row-100')
    expect(out.text).not.toContain('row-095')
    // raw 输出不该带 `96|` 这类行号前缀
    expect(out.text).not.toMatch(/^\d+\|row-/m)
  })

  it(':-N 的 N 大于文件行数时退化为整文件', async () => {
    const dir = tmpDir()
    writeRows(dir, 3)
    const out = await executeReadTool(execForCwd(dir), {} as never, { path: 'n.txt:-100' }, null as never)
    expect(out.text).toContain('row-001')
    expect(out.text).toContain('row-003')
  })

  it('普通行范围选择器不受影响', async () => {
    const dir = tmpDir()
    writeRows(dir)
    const out = await executeReadTool(execForCwd(dir), {} as never, { path: 'n.txt:1-2' }, null as never)
    expect(out.text).toContain('row-001')
    expect(out.text).toContain('row-002')
    expect(out.text).not.toContain('row-050')
  })

  it('字面文件名叫 n.txt:-5 时仍然优先读真文件', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'n.txt:-5'), 'literal file wins\n')
    const out = await executeReadTool(execForCwd(dir), {} as never, { path: 'n.txt:-5' }, null as never)
    expect(out.text).toContain('literal file wins')
  })
})


/* -------------------------------------------------------------------------- */
/* 裸数字与逗号列表的语义（18.12.6 read.md 逐条写明）                            */
/* -------------------------------------------------------------------------- */

/**
 * read.md 第 5 行把四种语义写得很细，此前只验了部分：
 * - `:50` 或 `:50-` 从 50 行起到文件尾（单独出现的裸数字是「往后」）；
 * - 逗号列表里的裸数字是「那一行」（`:19,59` 只取两行）；
 * - `:raw` 旁边的裸数字是「那一行」（`:17:raw`），而 `:17-:raw` 仍是往后。
 *
 * 这四条原先有两条是错的（`:19,59` 塌成 19 到文件尾、`:17:raw` 塌成 17 到文件尾），
 * 根因是本地 parseLineRanges 丢掉了上游的 BareLineMode（`pinBare`）。
 */
describe('行选择器：裸数字与逗号列表语义', () => {
  /** 100 行、row-001..row-100 的夹具（本地定义，不依赖别的 describe 里的闭包）。 */
  const rows = (dir: string): string => {
    const p = path.join(dir, 'n.txt')
    fs.writeFileSync(p, Array.from({ length: 100 }, (_, i) => `row-${String(i + 1).padStart(3, '0')}`).join('\n') + '\n')
    return p
  }
  it('单独裸数字从该行到文件尾', async () => {
    const dir = tmpDir()
    rows(dir)
    const out = await executeReadTool(execForCwd(dir), {} as never, { path: 'n.txt:95' }, null as never)
    expect(out.text).toContain('row-095')
    expect(out.text).toContain('row-100')
    expect(out.text).not.toContain('row-050')
  })

  it('逗号列表里的裸数字各取一行（:19,59 只取两行）', async () => {
    const dir = tmpDir()
    rows(dir)
    const out = await executeReadTool(execForCwd(dir), {} as never, { path: 'n.txt:19,59' }, null as never)
    expect(out.text).toContain('row-019')
    expect(out.text).toContain('row-059')
    expect(out.text).not.toContain('row-020')
    expect(out.text).not.toContain('row-060')
  })

  it(':raw 旁边的裸数字只取那一行（:17:raw）', async () => {
    const dir = tmpDir()
    rows(dir)
    const out = await executeReadTool(execForCwd(dir), {} as never, { path: 'n.txt:17:raw' }, null as never)
    expect(out.text.trim()).toBe('row-017')
  })

  it(':17-:raw 仍是往后到文件尾', async () => {
    const dir = tmpDir()
    rows(dir)
    const out = await executeReadTool(execForCwd(dir), {} as never, { path: 'n.txt:97-:raw' }, null as never)
    expect(out.text).toContain('row-097')
    expect(out.text).toContain('row-100')
    expect(out.text).not.toContain('row-095')
  })
})


/* -------------------------------------------------------------------------- */
/* read 的 :img 选择器（OMP 18.12.6：把 SVG/SVGZ 栅格化成图片）                  */
/* -------------------------------------------------------------------------- */

/**
 * 18.12.6 的 read.md 里写明：SVG/SVGZ 默认按文本返回，`:img` 才栅格化成图片，
 * `:raw` 取原件；而栅格图片（PNG/JPEG）不需要 `:img`，带了要报错。
 *
 * 硬判据是 attachment mock 里的 magic 校验：它按声明的 mediaType 反查字节头，
 * 不一致就抛 IMAGE_TYPE_MISMATCH。所以「`:img` 能提交成功」等价于
 * 「rasterizeSvg 真的产出了合法 PNG」，不是「返回了点什么」。
 */
describe('read :img 选择器', () => {
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>'

  it('SVG 默认按文本读（不栅格化）', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'pic.svg'), SVG)
    const out = await executeReadTool(execFor(dir), {} as never, { path: 'pic.svg' }, ctxFor({}))
    expect(out.text).toContain('<svg')
    expect(out.image).toBeFalsy()
  })

  it(':img 把 SVG 栅格化成 PNG 并提交', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'pic.svg'), SVG)
    const attachments = mockAttachments()
    const out = await executeReadTool(
      execFor(dir),
      {} as never,
      { path: 'pic.svg:img' },
      ctxFor({ attachments: attachments.service, llm: visionLlm }),
    )
    expect(out.image).toBeTruthy()
    expect(attachments.saved).toHaveLength(1)
    // mock 只在字节头与声明一致时才接受，所以「提交成功」本身就是硬证据：
    // rasterizeSvg 产出了合法 PNG 字节。mediaType 不写死，因为 autoResize 会把
    // 这张 16x16 的小图重编码成体积更小的 WebP（既有的 resize 策略，不是 bug）。
    expect(['image/png', 'image/webp']).toContain(attachments.saved[0]!.mediaType)
  })

  it(':img 支持 .svgz（gzip 压缩的 SVG）', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'pic.svgz'), gzipSync(Buffer.from(SVG)))
    const attachments = mockAttachments()
    const out = await executeReadTool(
      execFor(dir),
      {} as never,
      { path: 'pic.svgz:img' },
      ctxFor({ attachments: attachments.service, llm: visionLlm }),
    )
    expect(out.image).toBeTruthy()
    expect(['image/png', 'image/webp']).toContain(attachments.saved[0]!.mediaType)
  })

  it('对栅格图片用 :img 会明确报错', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'pic.png'), PNG_BYTES)
    await expect(
      executeReadTool(execFor(dir), {} as never, { path: 'pic.png:img' }, ctxFor({})),
    ).rejects.toThrow(/only rasterizes \.svg and \.svgz/)
  })
})


/* -------------------------------------------------------------------------- */
/* read 视频（OMP 18.12.6）：裸读预览网格，选择器取单帧                          */
/* -------------------------------------------------------------------------- */

/**
 * 18.12.6 的 read.md 写明：视频需要 ffmpeg/ffprobe，裸路径给预览网格，
 * 选择器取单帧。这里用真 ffmpeg 生成一段 2 秒 64x48 的测试视频再读，
 * 不做 mock：真正的风险在参数拼装与进程交互上，mock 掉就测不到。
 *
 * ffmpeg/ffprobe 是**外部二进制**（不像 jq 是我们 shell 的内置），
 * 所以没装的机器上跳过，红绿反映真实环境。
 */
describe('read 视频', () => {
  const hasMediaTools = (() => {
    try {
      return (
        spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 &&
        spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0
      )
    } catch {
      return false
    }
  })()

  const makeClip = (dir: string): string => {
    const out = path.join(dir, 'clip.mp4')
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=10:duration=2',
      '-pix_fmt', 'yuv420p', out,
    ])
    return out
  }

  it.skipIf(!hasMediaTools)('裸读返回预览网格并提交图片', async () => {
    const dir = tmpDir()
    makeClip(dir)
    const attachments = mockAttachments()
    const out = await executeReadTool(
      execFor(dir),
      {} as never,
      { path: 'clip.mp4' },
      ctxFor({ attachments: attachments.service, llm: visionLlm }),
    )
    expect(out.text).toContain('Video preview grid: clip.mp4')
    expect(out.image).toBeTruthy()
    expect(attachments.saved).toHaveLength(1)
  })

  it.skipIf(!hasMediaTools)('帧号选择器取单帧', async () => {
    const dir = tmpDir()
    makeClip(dir)
    const attachments = mockAttachments()
    const out = await executeReadTool(
      execFor(dir),
      {} as never,
      { path: 'clip.mp4:5' },
      ctxFor({ attachments: attachments.service, llm: visionLlm }),
    )
    expect(out.text).toContain('Video frame: clip.mp4 (frame 5)')
    expect(out.text).toContain('Duration')
    expect(out.image).toBeTruthy()
  })

  it.skipIf(!hasMediaTools)('时间戳选择器取单帧', async () => {
    const dir = tmpDir()
    makeClip(dir)
    const attachments = mockAttachments()
    const out = await executeReadTool(
      execFor(dir),
      {} as never,
      { path: 'clip.mp4:1s' },
      ctxFor({ attachments: attachments.service, llm: visionLlm }),
    )
    expect(out.text).toContain('Video frame: clip.mp4 @ 1s')
    expect(out.image).toBeTruthy()
  })

  it.skipIf(!hasMediaTools)('纯文本模型拿到不支持说明，不提交图片', async () => {
    const dir = tmpDir()
    makeClip(dir)
    const attachments = mockAttachments()
    const textOnly = { resolveModelInfo: async () => ({ inputModalities: ['text'] }) }
    const out = await executeReadTool(
      execFor(dir),
      {} as never,
      { path: 'clip.mp4' },
      {
        get: (k: string) => (k === 'attachments' ? attachments.service : k === 'llm' ? textOnly : undefined),
        fs: {},
        emit: () => undefined,
      } as never,
    )
    // DSH 只有一条「模型能不能看图」的判据（attachment bridge 的 routeImageSupport），
    // 所以纯文本模型读视频与读 PNG 得到同一种说明：不提交图片，也不假装给了预览。
    expect(out.text).toContain('does not accept image input')
    expect(out.image).toBeFalsy()
    expect(attachments.saved).toHaveLength(0)
  })
})
