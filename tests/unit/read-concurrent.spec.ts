/**
 * read 并发安全（2026-08-28）：read_image 官方 `isConcurrencySafe: true` 接过来。
 * 1) 注册面：isConcurrencySafe 分类器存在，默认 true，readConcurrentSafe=false 可关；
 * 2) 引擎面：并发执行多个 read（文本/图片/冲突文件）结果正确无串扰、共享
 *    ConflictHistory（attachOmpSessionState 同一引用）并发不炸。
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { executeReadTool, registerRead } from '../../src/tools/read/adapter/index.ts'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-plus-read-conc-'))
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
