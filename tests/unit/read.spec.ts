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

    // 截断本身发生（尾部省略号）
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
})

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
