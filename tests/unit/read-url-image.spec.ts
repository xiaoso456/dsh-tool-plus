/**
 * URL 图片读取端到端回归（拍板#22）：read http://…png → fetch 图像分支 →
 * resizeImage（sharp shim 后端）→ attachments 桥 → 官方信封 + attachment 事实。
 * 无 bridge 时诚实降级 image-metadata 文本（原内联 base64 在 DSH 无处安放）。
 */
import { afterAll, describe, expect, it } from 'vitest'
import * as http from 'node:http'
import * as crypto from 'node:crypto'
import { executeReadTool } from '../../src/tools/read/adapter/index.ts'

let server: http.Server
let port = 0
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000148afa4710000000049454e44ae426082',
  'hex',
)

async function startServer(): Promise<number> {
  server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'image/png')
    res.end(PNG)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  return (server.address() as { port: number }).port
}

afterAll(() => server?.close())

function execFor(): any {
  return {
    agent: {
      session: { header: { cwd: process.cwd() }, requestHeader: () => ({ config: { provider: 'test', model: 'test-model' } }) },
      options: { provider: 'test', model: 'test-model' },
    },
    signal: undefined,
  }
}

function ctxFor(withBridge: boolean): any {
  const services: Record<string, unknown> = {}
  if (withBridge) {
    services.attachments = {
      imageLimits: {
        maxImageBytes: 20 * 1024 * 1024,
        maxMessageImageBytes: 200 * 1024 * 1024,
        maxImagePixels: 64_000_000,
        maxImageDimension: 8192,
        mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      },
      saveImage: async (input: { data: Uint8Array; mediaType: string }) => {
        // 与宿主同源：magic 权威，声明不符即 IMAGE_TYPE_MISMATCH
        const hex = Buffer.from(input.data.subarray(0, 12)).toString('hex')
        const magic = hex.startsWith('89504e47') ? 'image/png'
          : hex.startsWith('ffd8ff') ? 'image/jpeg'
          : hex.startsWith('52494646') && Buffer.from(input.data.subarray(8, 12)).toString('ascii') === 'WEBP' ? 'image/webp'
          : hex.startsWith('47494638') ? 'image/gif' : 'unknown'
        if (magic !== input.mediaType) {
          throw Object.assign(new Error(`declared ${input.mediaType}, bytes ${magic}`), { code: 'IMAGE_TYPE_MISMATCH' })
        }
        return {
          attachmentId: `sha256:${crypto.createHash('sha256').update(input.data).digest('hex')}`,
          mediaType: input.mediaType,
          bytes: input.data.byteLength,
          width: 200,
          height: 200,
        }
      },    }
    services.llm = { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }
  }
  return {
    get: (key: string) => services[key],
    fs: { resolve: async () => { throw new Error('unused') }, stat: async () => undefined, readBytes: async () => new Uint8Array() },
    emit: () => undefined,
  }
}

describe('URL 图片读取（拍板#22 端到端）', () => {
  it('image/png URL：sharp 解码缩放成功并经 bridge 提交 attachment', async () => {
    port = port || await startServer()
    const out = await executeReadTool(execFor(), {} as never, { path: `http://127.0.0.1:${port}/pixel.png` }, ctxFor(true))
    expect(out.image?.attachmentId, 'attachment committed').toMatch(/^sha256:/)
    expect(out.text).toContain('<path>http://')
    expect(out.text).toContain('<type>image</type>')
  })

  it('无 bridge：解码仍成功（说明 shim 复活），诚实降级为元数据文本且无 attachment', async () => {
    port = port || await startServer()
    const out = await executeReadTool(execFor(), {} as never, { path: `http://127.0.0.1:${port}/pixel.png` }, ctxFor(false))
    expect(out.image).toBeUndefined()
    expect(out.text).toContain('Fetched image content (image/png)')
    expect(out.text).toContain('Method: image-metadata')
  })
})
