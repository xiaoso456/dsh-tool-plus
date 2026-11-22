/**
 * URL 选择器：与本地文件共用同一套 OMP 18.12.6 语义。
 *
 * 上游 `fetch.ts::parseReadUrlTarget` 返回 `{path, sel: ParsedSelector}`，read 对
 * `lines`/`tail` 走同一条 `buildInMemorySelectorResult`。我们原先自己手写了一套
 * `{raw, offset, limit}`，于是漏了两件事：裸数字在 `:raw` 旁没有 pin 成单行、
 * `:-N` 尾巴根本没被识别成选择器（整页返回）。
 *
 * 一个容易误会的地方：URL 的 `lines` 是套在**带 6 行头部**的输出上
 * （`URL:` / `Content-Type:` / `Method:` / 空行 / `---` / 空行），所以 `:17` 落在
 * 正文第 11 行。这是上游行为（上游把 `entry.output` 直接喂给选择器），不是偏差，
 * 用例里用「正文第 11 行」断言正是为了钉住它。
 */
import { afterAll, describe, expect, it } from 'vitest'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveConfig } from '../../src/config/settings.ts'
import { executeReadTool } from '../../src/tools/read/adapter/index.ts'

/** 30 行纯文本：line1..line30。 */
const BODY = Array.from({ length: 30 }, (_, i) => 'line' + (i + 1)).join('\n') + '\n'

let server: http.Server | undefined
let port = 0
const dirs: string[] = []

async function startTextServer(): Promise<number> {
  const s = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(BODY)
  })
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', () => resolve()))
  server = s
  return (s.address() as { port: number }).port
}

afterAll(() => {
  server?.close()
  longServer?.close()
  server = undefined
  longServer = undefined
})

const readUrl = async (sel: string): Promise<string> => {
  port = port || await startTextServer()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-plus-url-sel-'))
  dirs.push(dir)
  const exec: any = { agent: { session: { header: { cwd: dir } } }, signal: undefined }
  const out: any = await executeReadTool(exec, resolveConfig({}), { path: `http://127.0.0.1:${port}/n.txt${sel}` }, undefined as never)
  return String(out.text ?? '')
}

const lines = (text: string): number[] => [...text.matchAll(/line(\d+)/g)].map(m => Number(m[1]))

describe('URL 行选择器', () => {
  it(':-N 取正文最后 N 行（非 raw 带 1 行前置补齐）', async () => {
    const nums = lines(await readUrl(':-5'))
    expect(nums.at(-1)).toBe(30)
    expect(nums).toContain(26)
    // 6 行 = 正文 26..30 + 1 行补齐；raw 才是精确 5 行
    expect(nums.length).toBe(6)
  })

  it(':-N:raw 精确取最后 N 行，不带补齐', async () => {
    const nums = lines(await readUrl(':-5:raw'))
    expect(nums).toEqual([26, 27, 28, 29, 30])
  })

  it(':raw 旁的裸数字只取一行（落在正文第 11 行，头部占 6 行）', async () => {
    const nums = lines(await readUrl(':17:raw'))
    expect(nums).toEqual([11])
  })

  it('逗号列表里的裸数字各取一行', async () => {
    const nums = lines(await readUrl(':17,20'))
    expect(nums).toEqual([11, 14])
  })

  it('显式范围与头部偏移一致（:17-20 → 正文 11-14）', async () => {
    const nums = lines(await readUrl(':17-20:raw'))
    expect(nums).toEqual([11, 12, 13, 14])
  })

  it(':raw 不带范围时返回全文', async () => {
    const nums = lines(await readUrl(':raw'))
    expect(nums.length).toBe(30)
  })
})

/** 长页面：line1..line400，用来验行数上限到底跟哪个设置键走。 */
let longServer: http.Server | undefined
let longPort = 0
const LONG_BODY = Array.from({ length: 400 }, (_, i) => 'line' + (i + 1)).join('\n') + '\n'

async function startLongServer(): Promise<number> {
  const s = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(LONG_BODY)
  })
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', () => resolve()))
  longServer = s
  return (s.address() as { port: number }).port
}

/** 用指定配置读一个 URL，返回正文。 */
const readUrlWith = async (cfg: ReturnType<typeof resolveConfig>, sel: string): Promise<string> => {
  longPort = longPort || await startLongServer()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-plus-url-limit-'))
  dirs.push(dir)
  const exec: any = { agent: { session: { header: { cwd: dir } } }, signal: undefined }
  const out: any = await executeReadTool(exec, cfg, { path: `http://127.0.0.1:${longPort}/long.txt${sel}` }, undefined as never)
  return String(out.text ?? '')
}

describe('URL 读取的门控与行数上限', () => {
  it('fetchEnabled 关掉后拒读 URL，普通读取与选择器读取都不放行', async () => {
    longPort = longPort || await startLongServer()
    const cfg = resolveConfig({ fetchEnabled: false })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-plus-url-off-'))
    dirs.push(dir)
    const exec: any = { agent: { session: { header: { cwd: dir } } }, signal: undefined }
    const url = `http://127.0.0.1:${longPort}/long.txt`
    await expect(executeReadTool(exec, cfg, { path: url }, undefined as never)).rejects.toThrow(/URL reads are disabled/u)
    await expect(executeReadTool(exec, cfg, { path: url + ':5' }, undefined as never)).rejects.toThrow(/URL reads are disabled/u)
  })

  it('行数上限跟 readDefaultLimit 走，不是写死的 300', async () => {
    // 默认 300：header 6 行 + 294 行正文，line100 在内、line400 被截掉
    const dflt = await readUrlWith(resolveConfig({}), '')
    expect(dflt).toContain('line100')
    expect(dflt).not.toContain('line400')
    // 调到 50：line100 就不该再出现（同一个键对本地读与 URL 读给出同一套行为）
    const tight = await readUrlWith(resolveConfig({ readDefaultLimit: 50 }), '')
    expect(tight).toContain('line1')
    expect(tight).not.toContain('line100')
  })
})
