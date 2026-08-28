/**
 * 图像配置旋钮（2026-08-28 配置扩充）：blockImages 全局熄图、inputMaxBytes 准入
 * 硬顶、resizeMaxSide 阶梯目标边、excludeWebp 手动禁 WebP，以及 URL 侧 blockImages。
 * 全部默认值 = 上游硬编码常量，本测试只验证"接通后可调"，默认零行为变化由
 * read-image-fusion / read-url-image 两件套回归覆盖。
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import sharp from 'sharp'
import { executeReadTool } from '../../src/tools/read/adapter/index.ts'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-plus-img-knobs-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** 1x1 红 PNG（真文件头，可被 magic 嗅探）。 */
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000148afa4710000000049454e44ae426082',
  'hex',
)

async function solidPng(w: number, h: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 30, b: 90 } } }).png().toBuffer()
}

function execFor(cwd: string): any {
  return {
    agent: {
      session: { header: { cwd }, requestHeader: () => ({ config: { provider: 'test', model: 'test-model' } }) },
      options: { provider: 'test', model: 'test-model' },
    },
    signal: undefined,
  }
}

/** PNG/JPEG/WebP/GIF magic → media type（与宿主准入同源的字节权威判定）。 */
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
  const service = {
    imageLimits: {
      maxImageBytes: 20 * 1024 * 1024,
      maxMessageImageBytes: 200 * 1024 * 1024,
      maxImagePixels: 64_000_000,
      maxImageDimension: 8192,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    },
    saveImage: async (input: { data: Uint8Array; mediaType: string; name?: string }) => {
      // 模拟宿主 detectImage：magic 权威，声明与字节不符 → IMAGE_TYPE_MISMATCH
      if (detectMagic(input.data) !== input.mediaType) {
        throw Object.assign(new Error(`declared ${input.mediaType}, bytes differ`), { code: 'IMAGE_TYPE_MISMATCH' })
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
  }
  return { saved, service }
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

const visionLlm = { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }

describe('图像配置旋钮（2026-08-28 扩充）', () => {
  it('imagesBlockImages：熄图短路——回 omp 原文、零缩放零提交', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'pic.png')
    fs.writeFileSync(file, await solidPng(300, 300))
    const attachments = mockAttachments()

    const out = await executeReadTool(
      execFor(dir),
      { imagesBlockImages: true } as never,
      { path: file },
      ctxFor({ attachments: attachments.service, llm: visionLlm }),
    )
    expect(out.text).toContain('Image reading is disabled.')
    expect(out.image).toBeUndefined()
    expect(attachments.saved).toHaveLength(0)
  })

  it('imagesInputMaxBytes：调小准入硬顶后大图直接拒读', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'pic.png')
    fs.writeFileSync(file, await solidPng(300, 300)) // 远大于 1KB
    const attachments = mockAttachments()

    await expect(
      executeReadTool(
        execFor(dir),
        { imagesInputMaxBytes: 1024 } as never,
        { path: file },
        ctxFor({ attachments: attachments.service, llm: visionLlm }),
      ),
    ).rejects.toThrow(/Image file too large/)
    expect(attachments.saved).toHaveLength(0)
  })

  it('imagesResizeMaxSide：阶梯目标边接通——300px 图按 100 缩放提交', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'pic.png')
    fs.writeFileSync(file, await solidPng(300, 300))
    const attachments = mockAttachments()

    await executeReadTool(
      execFor(dir),
      { imagesResizeMaxSide: 100, imagesResizeMinSide: 50 } as never,
      { path: file },
      ctxFor({ attachments: attachments.service, llm: visionLlm }),
    )
    expect(attachments.saved).toHaveLength(1)
    // 提交格式随编码阶梯比小面定（纯色 100px 方图 webp 可胜 png），尺寸断言用真解码
    const meta = await sharp(Buffer.from(attachments.saved[0]!.data)).metadata()
    expect([meta.width, meta.height]).toEqual([100, 100])
  })

  it('imagesExcludeWebp：强制禁 WebP——提交字节不再是 webp 且 magic 与声明一致', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'noisy.png')
    // 确定性伪噪声图：有损编码下 webp 常取最小，正是需要手动禁的形态
    const size = 256
    const raw = Buffer.alloc(size * size * 3)
    for (let i = 0; i < raw.length; i++) raw[i] = ((i * 2654435761) >>> 0) % 256
    fs.writeFileSync(file, await sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer())
    const attachments = mockAttachments()

    const out = await executeReadTool(
      execFor(dir),
      { imagesExcludeWebp: true } as never,
      { path: file },
      ctxFor({ attachments: attachments.service, llm: visionLlm }),
    )
    expect(out.image).toBeTruthy()
    expect(attachments.saved).toHaveLength(1)
    expect(detectMagic(attachments.saved[0]!.data)).not.toBe('image/webp')
    expect(attachments.saved[0]!.mediaType).toBe(detectMagic(attachments.saved[0]!.data))
  })

  // URL 侧：blockImages 在 fetch 图像分支头部短路
  let server: http.Server | undefined
  let port = 0
  afterAll(() => server?.close())
  async function startServer(): Promise<number> {
    if (port) return port
    const solid = await solidPng(300, 300)
    server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'image/png')
      res.end(solid)
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as { port: number }).port
    return port
  }

  it('imagesBlockImages（URL）：抓取到 image/png 也只回文本，不提交附件', async () => {
    const p = await startServer()
    const out = await executeReadTool(
      execFor(process.cwd()),
      { imagesBlockImages: true } as never,
      { path: `http://127.0.0.1:${p}/solid.png` },
      ctxFor({ llm: visionLlm }),
    )
    expect(out.text).toContain('Image reading is disabled.')
    expect(out.image).toBeUndefined()
  })
})
