/**
 * read 图片路径（拍板#22 融合回读）：omp loadImageInput 管线 + DSH attachment
 * 提交出口。无 bridge → 软降级 metadata 文本（不抛错）；非 vision 路由 → 同样
 * 软降级；正常路由 → saveImage 提交 + 官方信封 + attachment 块。
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { executeReadTool } from '../../src/tools/read/adapter/index.ts'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-plus-read-img-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** 模拟 DSH exec 上下文：agent.session 是同一对象（跨调用稳定）。 */
function execFor(cwd: string, provider = 'test', model = 'test-model'): any {
  return {
    agent: {
      session: { header: { cwd }, requestHeader: () => ({ config: { provider, model } }) },
      options: { provider, model },
    },
    signal: undefined,
  }
}

function mockAttachments(saveImpl?: (input: { data: Uint8Array; mediaType: string }) => Promise<unknown>) {
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
      saveImage: saveImpl
        ?? (async (input: { data: Uint8Array; mediaType: string; name?: string }) => {
          // 模拟宿主 detectImage：magic bytes 是权威，声明与字节不符 → IMAGE_TYPE_MISMATCH
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
        }),
    },
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

const visionLlm = {
  resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
}
const textLlm = {
  resolveModelInfo: async () => ({ inputModalities: ['text'] }),
}

describe('read 图片融合（拍板#22）', () => {
  it('有 attachments + vision 路由：saveImage 提交，输出含 attachment 与官方信封', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'pic.png')
    fs.writeFileSync(file, PNG_BYTES)
    const attachments = mockAttachments()

    const out = await executeReadTool(execFor(dir), {} as never, { path: file }, ctxFor({ attachments: attachments.service, llm: visionLlm }))
    expect(out.image, 'image facts present').toBeTruthy()
    expect(out.image!.attachmentId).toMatch(/^sha256:/)
    expect(out.text).toContain('<path>')
    expect(out.text).toContain('<type>image</type>')
    expect(out.text).toContain('image/png image,')
    expect(attachments.saved).toHaveLength(1)
    // autoResize 默认开 → 1x1 被抬到 200px 下限（sharp 真解码，非头嗅探）
    expect(attachments.saved[0]!.data.length).toBeGreaterThan(0)
    expect(attachments.saved[0]!.mediaType).toBe('image/png')
  })

  it('无 attachments 服务：软降级 metadata 文本，不抛程序错', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'pic.png')
    fs.writeFileSync(file, PNG_BYTES)

    const out = await executeReadTool(execFor(dir), {} as never, { path: file }, ctxFor({}))
    expect(out.image).toBeUndefined()
    expect(out.text).toMatch(/no attachment store mounted/)
    expect(out.text).toMatch(/image \(/)
    expect(out.text).not.toContain('read_image tool')
  })

  it('非 vision 路由：软降级 metadata 文本（模型可见说明，不抛错）', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'pic.png')
    fs.writeFileSync(file, PNG_BYTES)
    const attachments = mockAttachments()

    const out = await executeReadTool(execFor(dir), {} as never, { path: file }, ctxFor({ attachments: attachments.service, llm: textLlm }))
    expect(out.image).toBeUndefined()
    expect(attachments.saved).toHaveLength(0)
    expect(out.text).toMatch(/does not accept image input/)
  })

  it('PNG 字节伪装 .txt：内容嗅探命中，仍走图片路径', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'innocent.txt')
    fs.writeFileSync(file, PNG_BYTES)
    const attachments = mockAttachments()

    const out = await executeReadTool(execFor(dir), {} as never, { path: file }, ctxFor({ attachments: attachments.service, llm: visionLlm }))
    expect(out.image?.attachmentId).toMatch(/^sha256:/)
  })

  it('saveImage 报 IMAGE_DIMENSION_TOO_LARGE：映射为官方可恢复文案', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'big.png')
    fs.writeFileSync(file, PNG_BYTES)
    const err = Object.assign(new Error('side too large'), { code: 'IMAGE_DIMENSION_TOO_LARGE' })
    const attachments = mockAttachments(async () => { throw err })

    await expect(
      executeReadTool(execFor(dir), {} as never, { path: file }, ctxFor({ attachments: attachments.service, llm: visionLlm })),
    ).rejects.toThrow(/exceeds the 8192px limit; downscale/)
  })
})
