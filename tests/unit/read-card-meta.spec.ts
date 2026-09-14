/**
 * §4.4 read 卡片 meta 投影：宿主把 OMP read 引擎的 `displayContent`
 * （`{text, startLine, lineNumbers?}`）投影成官方 read 卡要的
 * `{kind:'read', path, offset, lines, totalLines, lang?}`。
 *
 * 覆盖：
 *  - 窗口 / `:raw` / 多区间 三种真实 displayContent 形状（样本抄自引擎实跑输出）；
 *  - path 必须剥掉内联选择器（`:5-16,40-80` / `:raw`），并按
 *    `meta.source.value` → `resolvedPath` → `args.path` 的顺序取；
 *  - 省略行（lineNumbers[i] === null，正文是 `…`）必须丢掉；
 *  - totalLines 缺失时用最后一个行号兜底；
 *  - 图片 / 目录 / 内部 URL / `conflict://N` / sqlite / archive / 文档转换 / URL
 *    一律不出卡；
 *  - 超 256 KiB 只丢尾部行，totalLines 保持原值；
 *  - 适配层把 display 带出来，但模型可见文本一点没变。
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveConfig } from '../../src/config/settings.ts'
import { READ_META_MAX_BYTES, jsonByteLength, narrowReadCardMeta } from '../../src/web/contract.ts'
import { readCardMeta, stripReadSelector } from '../../src/web/host/read.ts'
import { executeReadTool, registerRead, renderReadOutput } from '../../src/tools/read/adapter/index.ts'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-plus-readcard-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** 适配层可识别的 exec 上下文（cwd 指向临时目录）。 */
function execIn(dir: string): any {
  return { agent: { session: { header: { cwd: dir } } }, signal: undefined }
}

/** 抓取 registerXxx 注册进来的工具定义（defineTool 注册时就编译 schema）。 */
function captureTool(register: (ctx: any, getConfig: () => any) => unknown): any {
  let captured: any
  const ctx = { tools: { register: (def: any) => { captured = def; return () => {} } } }
  register(ctx, () => resolveConfig({}))
  return captured
}

describe('read card meta — path', () => {
  it('strips inline selectors from the fallback path', () => {
    expect(stripReadSelector('src/foo.ts:5-16,40-80')).toBe('src/foo.ts')
    expect(stripReadSelector('README.md:raw')).toBe('README.md')
    expect(stripReadSelector('src/foo.ts:50+150')).toBe('src/foo.ts')
    expect(stripReadSelector('src/foo.ts')).toBe('src/foo.ts')
    expect(stripReadSelector('C:\\repo\\src\\foo.ts:5-16')).toBe('C:\\repo\\src\\foo.ts')
    expect(stripReadSelector('file:///C:/repo/src/foo.ts:5')).toBe('C:/repo/src/foo.ts')
  })

  it('prefers meta.source.value, then the resolved path, then args.path', () => {
    const display = { text: 'const a = 1', startLine: 1 }
    const withSource = {
      path: '/repo/resolved.ts',
      source: { type: 'path', value: '/repo/source.ts' },
      display,
      textBlocks: 1,
    }
    expect(readCardMeta({ path: '/repo/args.ts' }, withSource)?.path).toBe('/repo/source.ts')
    expect(readCardMeta({ path: '/repo/args.ts' }, { path: '/repo/resolved.ts', display, textBlocks: 1 })?.path)
      .toBe('/repo/resolved.ts')
    expect(readCardMeta({ path: '/repo/args.ts:5-16,40-80' }, { display, textBlocks: 1 })?.path).toBe('/repo/args.ts')
  })
})

describe('read card meta — lines', () => {
  it('builds the shipped read-card shape from a window display', () => {
    const meta = readCardMeta({ path: '/repo/src/foo.ts:5-16' }, {
      path: '/repo/src/foo.ts',
      source: { type: 'path', value: '/repo/src/foo.ts' },
      display: { text: 'const a = 1\nconst b = 2', startLine: 5, lineNumbers: [5, 6] },
      totalLines: 40,
      textBlocks: 1,
    })
    expect(meta).toEqual({
      kind: 'read',
      path: '/repo/src/foo.ts',
      offset: 5,
      lines: [
        { number: 5, text: 'const a = 1' },
        { number: 6, text: 'const b = 2' },
      ],
      totalLines: 40,
      lang: 'typescript',
    })
    expect(narrowReadCardMeta(meta)).not.toBeNull()
  })

  it('drops elided lines (null line number) and falls back to the last line for totalLines', () => {
    const meta = readCardMeta({}, {
      path: '/repo/a.ts',
      display: {
        text: 'line 3\nline 4\nline 5\nline 6\n…\nline 10\nline 11\nline 12',
        startLine: 3,
        lineNumbers: [3, 4, 5, 6, null, 10, 11, 12],
      },
      textBlocks: 1,
    })
    expect(meta?.lines.map(line => line.number)).toEqual([3, 4, 5, 6, 10, 11, 12])
    expect(meta?.lines.map(line => line.text)).not.toContain('…')
    expect(meta?.offset).toBe(3)
    expect(meta?.totalLines).toBe(12)
    expect(narrowReadCardMeta(meta)).not.toBeNull()
  })

  it('numbers lines from startLine when the engine gives no lineNumbers', () => {
    const meta = readCardMeta({}, {
      path: '/repo/notes.md',
      display: { text: 'a\nb\nc', startLine: 10 },
      textBlocks: 1,
    })
    expect(meta?.lines.map(line => line.number)).toEqual([10, 11, 12])
    expect(meta?.totalLines).toBe(12)
    expect(meta?.lang).toBe('markdown')
  })

  it('keeps an engine-provided totalLines and omits lang when the path names no language', () => {
    expect(readCardMeta({}, {
      path: '/repo/a.ts',
      display: { text: 'x', startLine: 1 },
      totalLines: 500,
      textBlocks: 1,
    })?.totalLines).toBe(500)
    expect(readCardMeta({}, { path: '/repo/LICENSE', display: { text: 'x', startLine: 1 }, textBlocks: 1 }))
      .toEqual({ kind: 'read', path: '/repo/LICENSE', offset: 1, lines: [{ number: 1, text: 'x' }], totalLines: 1 })
  })

  it('produces no card when the window has no numbered line at all', () => {
    expect(readCardMeta({}, { path: '/repo/a.ts', display: { text: '', startLine: 1 }, textBlocks: 1 })).toBeNull()
    expect(readCardMeta({}, {
      path: '/repo/a.ts',
      display: { text: '…', startLine: 1, lineNumbers: [null] },
      textBlocks: 1,
    })).toBeNull()
  })
})

describe('read card meta — targets that never take the card', () => {
  const display = { text: 'hello', startLine: 1 }

  it.each([
    ['an image read', { path: '/repo/pic.png' }, { path: '/repo/pic.png', image: { attachmentId: 'a1' } }],
    ['a directory listing', { path: '/repo/src' }, { path: '/repo/src', isDirectory: true }],
    ['a conflict://N block', { path: 'conflict://1' }, { path: '/repo/src/a.ts', source: { type: 'path', value: '/repo/src/a.ts' } }],
    ['a skill:// internal URL', { path: 'skill://demo/SKILL.md' }, { path: '/repo/SKILL.md', source: { type: 'internal', value: 'skill://demo/SKILL.md' } }],
    ['a web URL read', { path: 'https://example.test/a' }, { path: '/repo/a.txt', source: { type: 'url', value: 'https://example.test/a' } }],
    ['a SQLite read', { path: 'data/app.db:users:42' }, { path: '/repo/data/app.db' }],
    ['an archive member read', { path: 'bundle.zip:src/foo.ts' }, { path: '/repo/bundle.zip' }],
    ['a converted document read', { path: 'report.pdf' }, { path: '/repo/report.pdf' }],
  ])('produces no card for %s', (_name, args, value) => {
    expect(readCardMeta(args, { ...value, display, textBlocks: 1 })).toBeNull()
  })

  it('produces no card without a display, with several text blocks, or for a multi-range :raw read', () => {
    expect(readCardMeta({ path: '/repo/a.ts' }, { path: '/repo/a.ts', textBlocks: 1 })).toBeNull()
    expect(readCardMeta({ path: '/repo/a.ts' }, { path: '/repo/a.ts', display, textBlocks: 2 })).toBeNull()
    // 多区间叠加 :raw 时引擎根本不产 displayContent（read.ts 的 buildInMemoryMultiRangeResult 分支）
    expect(readCardMeta({ path: '/repo/a.ts:3-6,10-12:raw' }, { path: '/repo/a.ts:3-6,10-12:raw' })).toBeNull()
  })
})

describe('read card meta — 256 KiB cap', () => {
  it('drops trailing lines, flags nothing extra, and keeps the pre-cap totalLines', () => {
    // Few, long lines: the cap keeps the test quick while still forcing the tail
    // to be dropped (300 × 4 KiB ≈ 1.2 MiB against a 256 KiB budget).
    const count = 300
    const text = Array.from({ length: count }, () => 'x'.repeat(4_096)).join('\n')
    const meta = readCardMeta({}, {
      path: '/repo/big.ts',
      display: { text, startLine: 1 },
      totalLines: 900_000,
      textBlocks: 1,
    })
    expect(meta).not.toBeNull()
    expect(meta!.lines.length).toBeGreaterThan(0)
    expect(meta!.lines.length).toBeLessThan(count)
    expect(meta!.offset).toBe(1)
    expect(meta!.totalLines).toBe(900_000)
    expect(jsonByteLength(meta)).toBeLessThanOrEqual(READ_META_MAX_BYTES)
    expect(narrowReadCardMeta(meta)).not.toBeNull()
  })
})

describe('read card meta — adapter wiring', () => {
  it('carries the engine display into the value and leaves the model-visible text alone', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'sample.ts')
    fs.writeFileSync(file, 'const a = 1\nconst b = 2\nconst c = 3\n')

    const out = await executeReadTool(execIn(dir), resolveConfig({}), { path: file }, null as never)

    // 输出文本零变化：render 仍严格等于 text + notice。
    expect(renderReadOutput(out)).toBe(out.text + (out.notice ?? ''))
    expect(out.text).toContain('const b = 2')
    expect(out.path).toBe(file)
    // 引擎的 displayContent 被带进 value（供 presentationMeta 取数）。
    expect(out.display).toEqual({ text: 'const a = 1\nconst b = 2\nconst c = 3', startLine: 1, lineNumbers: [1, 2, 3] })
    expect(out.textBlocks).toBe(1)

    const meta = readCardMeta({ path: file }, out)
    expect(meta).toEqual({
      kind: 'read',
      path: file,
      offset: 1,
      lines: [
        { number: 1, text: 'const a = 1' },
        { number: 2, text: 'const b = 2' },
        { number: 3, text: 'const c = 3' },
      ],
      totalLines: 3,
      lang: 'typescript',
    })
  })

  it('strips the inline selector from the card path of a real window read', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'sample.ts')
    fs.writeFileSync(file, 'one\ntwo\nthree\nfour\nfive\n')

    const out = await executeReadTool(execIn(dir), resolveConfig({}), { path: `${file}:2-4` }, null as never)
    const meta = readCardMeta({ path: `${file}:2-4` }, out)

    expect(meta?.path).toBe(file)
    expect(meta?.path).not.toContain(':2-4')
    expect(meta?.lines.map(line => line.number)).toContain(2)
    expect(narrowReadCardMeta(meta)).not.toBeNull()
  })

  it('registers the read tool with a value schema that accepts the projection carrier', () => {
    const def = captureTool(registerRead)
    // defineTool 注册时已编译 schema；能注册成功就说明 display/source/isDirectory/textBlocks 合法。
    expect(def.name).toBe('read')
    expect(def.output.schema.properties.display.properties.startLine.type).toBe('integer')
    expect(def.output.schema.properties.display.properties.lineNumbers.items.oneOf).toHaveLength(2)
    expect(def.output.schema.properties.textBlocks.type).toBe('integer')

    const value = { text: 'x', path: '/repo/a.ts', display: { text: 'x', startLine: 1 }, textBlocks: 1 }
    expect(def.output.presentationMeta({ path: '/repo/a.ts' }, value)).toEqual({
      kind: 'read',
      path: '/repo/a.ts',
      offset: 1,
      lines: [{ number: 1, text: 'x' }],
      totalLines: 1,
      lang: 'typescript',
    })
    expect(def.output.render({}, value)).toEqual([{ type: 'text', text: 'x' }])
    // 不产卡的情形必须是显式 null：返回 undefined 会被宿主判成 non-lossless JSON，
    // 把一次成功的调用改写成 isError。
    expect(def.output.presentationMeta(
      { path: '/repo/pic.png' },
      { text: 'x', path: '/repo/pic.png', image: { attachmentId: 'a1' }, textBlocks: 1 },
    )).toBeNull()
    expect(def.output.presentationMeta(
      { path: 'artifact://abc' },
      { text: 'x', source: { type: 'internal', value: 'artifact://abc' }, display: { text: 'x', startLine: 1 }, textBlocks: 1 },
    )).toBeNull()
  })
})
