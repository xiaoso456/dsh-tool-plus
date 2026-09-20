/**
 * Web 卡片 meta 投影统一规格（宿主把引擎结果投影成官方卡片要的 meta）。
 *
 * 本文件由 8 个近乎同构的 `*-card-meta.spec.ts` 合并而来（read / grep / bash /
 * ast-edit / edit / glob / ast-grep / write）：每个用例的名字、分组意图与断言
 * 逐字保留，只把重复的临时目录、exec 上下文、工具定义抓取等公共夹具提上来共享。
 *
 * 各工具族的契约要点：
 *  - read（§4.4）：`{kind:'read', path, offset, lines, totalLines, lang?}`，path 先剥内联
 *    选择器，省略行（lineNumbers[i] === null）丢弃，totalLines 缺失用最后行号兜底，
 *    图片 / 目录 / 内部 URL / `conflict://N` / sqlite / archive / 文档转换 / URL 一律不出卡，
 *    超 256 KiB 只丢尾部行。
 *  - grep（§4.5）：`{kind:'search', shape:'matches', files, truncated, total}`，解析
 *    `# dir/` + `## file.ts` 分组头与 `*N│line` 代码帧，context 行与 `…` 不算 matches，
 *    超 64 KiB 丢尾部 group 并置 truncated。
 *  - bash：终态卡片无法推导的运行态（`timeoutMs: 0` 合法、超时无 exitCode、
 *    自动后台化不是已完成的命令）必须作为数据随行。
 *  - ast_edit（§4.3）：`{kind:'ast_edit', preview, files, replacements, applied}`。
 *  - edit（§4.2）：`{kind:'edit', diffs:[{path, oldText, newText}]}`，数据来自引擎已算好的
 *    `details.diff` / `details.perFileResults[].diff`（零额外 I/O），上限 128 KiB。
 *  - glob（§4.7）：`{kind:'search', shape:'paths', paths, truncated, total}`。
 *  - ast_grep（§4.6）：与 grep 共用 `src/web/host/search.ts` 的同一份解析器。
 *  - write（§4.1）：`{kind:'write', path, lang?}`，认不出语言时**省略 lang 键**
 *    （meta 里出现 `undefined` 会把成功调用变成 isError）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveConfig } from '../../src/config/settings.ts'
import {
  AST_EDIT_META_MAX_BYTES,
  EDIT_META_MAX_BYTES,
  READ_META_MAX_BYTES,
  SEARCH_META_MAX_BYTES,
  jsonByteLength,
  narrowAstEditCardMeta,
  narrowEditCardMeta,
  narrowReadCardMeta,
  narrowSearchCardMeta,
  narrowTerminalCardMeta,
} from '../../src/web/contract.ts'
import { readCardMeta, stripReadSelector } from '../../src/web/host/read.ts'
import { bashCardMeta } from '../../src/web/host/bash.ts'
import { projectAstEditCardMeta } from '../../src/web/host/ast-edit.ts'
import { projectEditCardMeta } from '../../src/web/host/edit.ts'
import { searchMatchesCardMeta, searchPathsCardMeta } from '../../src/web/host/search.ts'
import { projectWriteCardMeta } from '../../src/web/host/write.ts'
import { executeReadTool, registerRead, renderReadOutput } from '../../src/tools/read/adapter/index.ts'
import { executeGrepTool, registerGrep } from '../../src/tools/grep/adapter/index.ts'
import { registerAstEdit } from '../../src/tools/ast-edit/adapter/index.ts'
import { executeEditTool, registerEdit } from '../../src/tools/edit/adapter/index.ts'
import { executeGlobTool, registerGlob } from '../../src/tools/glob/adapter/index.ts'
import { registerAstGrep, toAstGrepToolResult } from '../../src/tools/ast-grep/adapter/index.ts'
import { executeWriteTool, registerWrite } from '../../src/tools/write/adapter/index.ts'
import { AstGrepTool } from '../../src/tools/omp/tools/ast-grep.ts'
import { Settings } from '../../src/tools/omp/config/settings.ts'
import { getDefault } from '../../src/tools/omp/config/settings-schema.ts'
import { canonicalSnapshotKey, getFileSnapshotStore } from '../../src/tools/omp/edit/file-snapshot-store.ts'
import { persistOmpSessionState } from '../../src/tools/shared/session-state.ts'

// ── 共享夹具 ────────────────────────────────────────────────────────────────

const tmpDirs: string[] = []
function tmpDir(label = 'web-card-meta'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`))
  tmpDirs.push(dir)
  return dir
}
/** 真实路径（ast_edit / edit 用例要求 cwd 与落盘文件同一 realpath）。 */
function realTmpDir(label: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`)))
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

/** Exec，其 session key 已带 hashline 快照。 */
function execFor(cwd: string, session?: object): any {
  return { agent: { session: session ?? { header: { cwd } } }, signal: undefined }
}

/** 抓取 registerXxx 注册进来的工具定义（defineTool 注册时就编译 schema）。 */
function captureTool(register: (ctx: any, getConfig: () => any) => unknown): any {
  let captured: any
  const ctx = { tools: { register: (def: any) => { captured = def; return () => {} } } }
  register(ctx, () => resolveConfig({}))
  return captured
}

/** Tool definition `registerAstEdit` / `registerEdit` / `registerWrite` hands to the host registry. */
function captureDefinition(
  register: (ctx: any, getConfig: () => any) => unknown,
): any {
  let definition: any
  register(
    { tools: { register: (value: any) => { definition = value; return () => {} } } } as never,
    (() => ({})) as never,
  )
  return definition
}

/** Exec whose session key already carries a hashline snapshot for `file`. */
function hashlineExec(cwd: string, file: string, seenLines: number[]): { exec: any; tag: string } {
  const sessionKey: any = { header: { cwd } }
  const seed: any = { cwd, hasEditTool: true }
  const tag = getFileSnapshotStore(seed).recordSnapshotFile(canonicalSnapshotKey(file), seenLines)
  if (!tag) throw new Error('could not mint hashline tag')
  persistOmpSessionState(sessionKey, seed)
  return { exec: execFor(cwd, sessionKey), tag }
}

function pathSet(out: { diffs?: { path: string }[] }): string[] {
  return [...new Set((out.diffs ?? []).map(hunk => path.basename(hunk.path)))].sort()
}

/** A numbered diff whose single hunk is roughly `bytes` long. */
function bigNumberedDiff(bytes: number): string {
  const rows: string[] = []
  let total = 0
  let line = 1
  while (total < bytes) {
    rows.push(`+${line}|${'x'.repeat(200)}`)
    total += 203
    line += 1
  }
  return rows.join('\n')
}

/** 会话 cwd（刻意用 posix 风格基址，断言两侧都走 path.resolve）。 */
const BASE = path.join(os.tmpdir(), 'tool-plus-grep-base')

/** ast_grep 样本用的 cwd 基址。 */
const AST_BASE = path.join(os.tmpdir(), 'tool-plus-astgrep-base')

/** 引擎实跑样本：目录作用域、普通模式（`# src/` + `## file.ts` 头）。 */
const PLAIN_GROUPED = '# src/\n## a.ts\n 1│const x = 1\n*2│const needle = 2\n 3│const z = 3\n## b.ts\n*1│let needle = 9'

/** 引擎实跑样本：hashline 模式（文件头带 `#<snapshot tag>` 后缀）。 */
const HASHLINE_GROUPED = '# src/\n## a.ts#A526\n 1│const x = 1\n*2│const needle = 2\n 3│const z = 3\n## b.ts#9643\n*1│let needle = 9'

/** 引擎实跑样本：单文件作用域（没有分组头，body 直接开始）。 */
const SINGLE_FILE = ' 1│one\n*2│needle two\n 3│three'

/** 引擎实跑样本：`# a.ts` 头 + 匹配行 + 元变量行。 */
const AST_DISPLAY = '# a.ts\n*2│const needle = 2\n  meta: A=2'

const APPLIED_DETAILS = {
  totalReplacements: 2,
  filesTouched: 1,
  applied: true,
  displayContent: 'a.ts\n│1│ const a = 1\n│2│ const b = 2',
  fileReplacements: [{ path: 'a.ts', count: 2 }],
}

/** One foreground value with the fields the bash projection reads. */
function foreground(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'foreground',
    exitCode: 0,
    timedOut: false,
    aborted: false,
    timeoutMs: 3_600_000,
    wallTimeMs: 12,
    output: { text: 'ok\n', truncated: false },
    ...overrides,
  }
}

describe('web card metadata', () => {

  // ── read ──────────────────────────────────────────────────────────────────

  describe('read', () => {
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
        const dir = tmpDir('tool-plus-readcard')
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
        const dir = tmpDir('tool-plus-readcard')
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
  })

  // ── grep ──────────────────────────────────────────────────────────────────

  describe('grep', () => {
    describe('grep card meta — grouped display parsing', () => {
      it('parses the plain grouped code-frame display into per-file matches', () => {
        const meta = searchMatchesCardMeta({
          displayContent: PLAIN_GROUPED,
          cwd: BASE,
          files: ['src/a.ts', 'src/b.ts'],
          matchCount: 2,
          truncated: false,
        })
        expect(meta).toEqual({
          kind: 'search',
          shape: 'matches',
          files: [
            { path: path.resolve(BASE, 'src/a.ts'), matches: [{ lineNumber: 2, line: 'const needle = 2' }] },
            { path: path.resolve(BASE, 'src/b.ts'), matches: [{ lineNumber: 1, line: 'let needle = 9' }] },
          ],
          truncated: false,
          total: 2,
        })
        expect(narrowSearchCardMeta(meta)).not.toBeNull()
      })

      it('parses hashline-tagged headers exactly like plain ones', () => {
        const plain = searchMatchesCardMeta({ displayContent: PLAIN_GROUPED, cwd: BASE, files: ['src/a.ts', 'src/b.ts'], matchCount: 2 })
        const hash = searchMatchesCardMeta({ displayContent: HASHLINE_GROUPED, cwd: BASE, files: ['src/a.ts', 'src/b.ts'], matchCount: 2 })
        expect(hash).toEqual(plain)
      })

      it('never counts context lines or the `…` ellipsis as matches', () => {
        const meta = searchMatchesCardMeta({
          displayContent: '# src/\n## a.ts\n*2│match\n    │…\n 9│context\n*20│later',
          cwd: BASE,
          files: ['src/a.ts'],
          matchCount: 2,
        })
        expect(meta?.files).toEqual([{
          path: path.resolve(BASE, 'src/a.ts'),
          matches: [{ lineNumber: 2, line: 'match' }, { lineNumber: 20, line: 'later' }],
        }])
        expect(meta?.files[0]?.matches.map(match => match.line)).not.toContain('context')
      })

      it('resolves a single-file scope (no group header) from files[0]', () => {
        const meta = searchMatchesCardMeta({
          displayContent: SINGLE_FILE,
          cwd: BASE,
          files: ['a.ts'],
          matchCount: 1,
          truncated: false,
        })
        expect(meta?.files).toEqual([
          { path: path.resolve(BASE, 'a.ts'), matches: [{ lineNumber: 2, line: 'needle two' }] },
        ])
        expect(meta?.total).toBe(1)
      })

      it('falls back to the parsed match count when the engine gives no total', () => {
        const meta = searchMatchesCardMeta({ displayContent: PLAIN_GROUPED, cwd: BASE, files: ['src/a.ts', 'src/b.ts'] })
        expect(meta?.total).toBe(2)
        expect(meta?.truncated).toBe(false)
      })

      it('keeps the engine-reported truncation flag', () => {
        const meta = searchMatchesCardMeta({ displayContent: PLAIN_GROUPED, cwd: BASE, files: ['src/a.ts'], matchCount: 2, truncated: true })
        expect(meta?.truncated).toBe(true)
      })

      it('draws an empty-result card when the engine reports zero matches', () => {
        // 引擎实跑的空结果形状：没有 displayContent，但 matchCount/fileCount 明确是 0。
        const empty = { text: 'No matches found', matchCount: 0, fileCount: 0, files: [], cwd: BASE, scopePath: '.' }
        expect(searchMatchesCardMeta(empty)).toEqual({
          kind: 'search',
          shape: 'matches',
          files: [],
          truncated: false,
          total: 0,
        })
        expect(narrowSearchCardMeta(searchMatchesCardMeta(empty))).not.toBeNull()

        // 引擎没报数（脏输入）时不猜，仍然不产卡。
        expect(searchMatchesCardMeta({ displayContent: 'No matches found', cwd: BASE, files: [] })).toBeNull()
        expect(searchMatchesCardMeta({ displayContent: '', cwd: BASE, files: [] })).toBeNull()
        expect(searchMatchesCardMeta({ cwd: BASE, files: [] })).toBeNull()
        // 有匹配却解析不出分组 → 不产卡，绝不能当成空结果。
        expect(searchMatchesCardMeta({ displayContent: '# skill://demo/SKILL.md\n*3│needle', cwd: BASE, files: [], matchCount: 3 })).toBeNull()
      })
    })

    describe('grep card meta — 64 KiB cap', () => {
      it('drops trailing groups, flags truncated, and keeps the pre-cap total', () => {
        const cwd = BASE
        const namespace = Array.from({ length: 300 }, (_, index) => `file-${index}-${'x'.repeat(200)}.ts`)
        const display = namespace.map((name, index) => `# ${name}\n*1│match ${index}`).join('\n\n')

        const meta = searchMatchesCardMeta({
          displayContent: display,
          cwd,
          files: namespace,
          matchCount: namespace.length,
          truncated: false,
        })

        expect(meta).not.toBeNull()
        expect(meta!.files.length).toBeGreaterThan(0)
        expect(meta!.files.length).toBeLessThan(namespace.length)
        expect(meta!.truncated).toBe(true)
        expect(meta!.total).toBe(namespace.length)
        expect(jsonByteLength(meta)).toBeLessThanOrEqual(SEARCH_META_MAX_BYTES)
        expect(narrowSearchCardMeta(meta)).not.toBeNull()

        const retained = meta!.files.map(file => path.basename(file.path).slice(0, 10))
        expect(retained[0]).toBe('file-0-xxx')
      })
    })

    describe('grep card meta — adapter wiring', () => {
      it('runs the real engine and carries the display into the value', async () => {
        const dir = tmpDir('tool-plus-grepcard')
        fs.mkdirSync(path.join(dir, 'src'))
        fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'const x = 1\nconst needle = 2\nconst z = 3\n')
        fs.writeFileSync(path.join(dir, 'src', 'b.ts'), 'let needle = 9\n')

        const out = await executeGrepTool(execIn(dir), resolveConfig({}), { pattern: 'needle' }, undefined as never)

        expect(out.text).toContain('const needle = 2')
        expect(out.displayContent).toContain('const needle = 2')
        expect(out.cwd).toBe(dir)
        expect(out.matchCount).toBe(2)
        expect(out.files).toEqual(['src/a.ts', 'src/b.ts'])

        const meta = searchMatchesCardMeta(out)
        expect(meta).toEqual({
          kind: 'search',
          shape: 'matches',
          files: [
            { path: path.resolve(dir, 'src/a.ts'), matches: [{ lineNumber: 2, line: 'const needle = 2' }] },
            { path: path.resolve(dir, 'src/b.ts'), matches: [{ lineNumber: 1, line: 'let needle = 9' }] },
          ],
          truncated: false,
          total: 2,
        })
      })

      it('projects a single-file engine run', async () => {
        const dir = tmpDir('tool-plus-grepcard')
        fs.writeFileSync(path.join(dir, 'a.ts'), 'one\nneedle two\nthree\n')

        const out = await executeGrepTool(execIn(dir), resolveConfig({}), { pattern: 'needle', path: 'a.ts' }, undefined as never)
        const meta = searchMatchesCardMeta(out)

        expect(meta?.files).toEqual([
          { path: path.resolve(dir, 'a.ts'), matches: [{ lineNumber: 2, line: 'needle two' }] },
        ])
      })

      it('produces an empty-result card for an empty engine result', async () => {
        const dir = tmpDir('tool-plus-grepcard')
        fs.writeFileSync(path.join(dir, 'a.ts'), 'nothing here\n')

        const out = await executeGrepTool(execIn(dir), resolveConfig({}), { pattern: 'needle' }, undefined as never)
        expect(out.text).toContain('No matches found')
        expect(out.matchCount).toBe(0)
        expect(searchMatchesCardMeta(out)).toEqual({
          kind: 'search',
          shape: 'matches',
          files: [],
          truncated: false,
          total: 0,
        })
      })

      it('registers a schema that accepts the display carrier and projects the same meta', () => {
        const def = captureTool(registerGrep)
        expect(def.name).toBe('grep')
        expect(def.output.schema.properties.displayContent.type).toBe('string')
        expect(def.output.schema.properties.cwd.type).toBe('string')

        const value = { text: 'x', displayContent: PLAIN_GROUPED, cwd: BASE, files: ['src/a.ts', 'src/b.ts'], matchCount: 2, truncated: false }
        expect(def.output.presentationMeta({ pattern: 'needle' }, value)).toEqual(
          searchMatchesCardMeta(value),
        )
        // 引擎实跑的空结果形状：matchCount=0 + 没有 displayContent → 出「0 处匹配」空卡。
        expect(def.output.presentationMeta({ pattern: 'needle' }, { text: 'No matches found', matchCount: 0, fileCount: 0, files: [] })).toEqual({
          kind: 'search',
          shape: 'matches',
          files: [],
          truncated: false,
          total: 0,
        })
        // 脏输入（引擎没报数）→ 还是显式 null，不是 undefined。
        expect(def.output.presentationMeta({ pattern: 'needle' }, { text: 'No matches found' })).toBeNull()
        expect(def.output.render({}, value)).toEqual([{ type: 'text', text: 'x' }])
      })
    })
  })

  // ── bash ──────────────────────────────────────────────────────────────────

  describe('bash', () => {
    describe('bash card metadata — foreground', () => {
      it('reports a clean exit', () => {
        expect(bashCardMeta(foreground())).toEqual({
          kind: 'terminal', mode: 'foreground', exitCode: 0, timedOut: false, aborted: false,
        })
      })

      it('reports a non-zero exit', () => {
        expect(bashCardMeta(foreground({ exitCode: 1 }))).toMatchObject({ exitCode: 1 })
        expect(bashCardMeta(foreground({ exitCode: 127 }))).toMatchObject({ exitCode: 127 })
      })

      it('keeps a deadline-disabled call (timeoutMs: 0) a valid card', () => {
        const meta = bashCardMeta(foreground({ timeoutMs: 0 }))
        expect(meta).not.toBeNull()
        expect(narrowTerminalCardMeta(meta)).toEqual(meta)
      })

      it('reports a timed-out run without pretending it exited', () => {
        expect(bashCardMeta(foreground({ exitCode: null, timedOut: true })))
          .toEqual({ kind: 'terminal', mode: 'foreground', exitCode: null, timedOut: true, aborted: false })
      })

      it('distinguishes an aborted run from a timeout', () => {
        expect(bashCardMeta(foreground({ exitCode: null, aborted: true })))
          .toEqual({ kind: 'terminal', mode: 'foreground', exitCode: null, timedOut: false, aborted: true })
      })

      it('carries the working directory only when the run reported one', () => {
        expect(bashCardMeta(foreground({ workingDir: '/work' }))).toMatchObject({ workingDir: '/work' })
        const without = bashCardMeta(foreground()) as Record<string, unknown>
        expect('workingDir' in without).toBe(false)
        expect(bashCardMeta(foreground({ workingDir: '' }))).not.toHaveProperty('workingDir')
      })
    })

    describe('bash card metadata — background', () => {
      it('reports a managed job hand-off from either source', () => {
        // `run_in_background: true` and the auto-background window return the same arm.
        expect(bashCardMeta({ kind: 'background', jobId: 'bash-7' }))
          .toEqual({ kind: 'terminal', mode: 'background', jobId: 'bash-7' })
      })

      it('rejects a blank or missing job id', () => {
        expect(bashCardMeta({ kind: 'background', jobId: '' })).toBeNull()
        expect(bashCardMeta({ kind: 'background' })).toBeNull()
        expect(bashCardMeta({ kind: 'background', jobId: 7 })).toBeNull()
      })
    })

    describe('bash card metadata — defensive', () => {
      it('rejects malformed values instead of throwing', () => {
        for (const value of [
          undefined, null, 0, '', 'foreground', [], {}, { kind: 'unknown' },
          { kind: 'foreground', exitCode: 0.5, timedOut: false, aborted: false },
          { kind: 'foreground', exitCode: 0, timedOut: 'no', aborted: false },
          { kind: 'foreground', exitCode: 0, timedOut: false },
          { kind: 'foreground', timedOut: false, aborted: false },
        ]) {
          expect(bashCardMeta(value)).toBeNull()
        }
      })

      it('never emits an undefined-valued key', () => {
        const metas = [
          bashCardMeta(foreground()),
          bashCardMeta(foreground({ workingDir: '/w' })),
          bashCardMeta(foreground({ exitCode: null, timedOut: true })),
          bashCardMeta({ kind: 'background', jobId: 'bash-1' }),
        ]
        for (const meta of metas) {
          expect(meta).not.toBeNull()
          for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
            expect(value, `key ${key} must not be undefined`).not.toBeUndefined()
          }
          // The wire form must survive a JSON round trip unchanged — that is what
          // `presentationMeta` requires of a lossless payload.
          expect(JSON.parse(JSON.stringify(meta))).toEqual(meta)
        }
      })

      it('emits metadata the browser half accepts', () => {
        expect(narrowTerminalCardMeta(bashCardMeta(foreground()))).not.toBeNull()
        expect(narrowTerminalCardMeta(bashCardMeta({ kind: 'background', jobId: 'bash-2' }))).not.toBeNull()
      })
    })
  })

  // ── ast_edit ──────────────────────────────────────────────────────────────

  describe('ast_edit', () => {
    describe('ast_edit 卡片投影', () => {
      it('契约形状：preview + files + replacements + applied', () => {
        const meta = projectAstEditCardMeta(APPLIED_DETAILS)
        expect(meta).toEqual({
          kind: 'ast_edit',
          preview: APPLIED_DETAILS.displayContent,
          files: [{ path: 'a.ts', count: 2 }],
          replacements: 2,
          applied: true,
        })
        expect(narrowAstEditCardMeta(meta)).not.toBeNull()
      })

      it('没有 replacement → null（No replacements made 走通用行）', () => {
        expect(projectAstEditCardMeta({ ...APPLIED_DETAILS, totalReplacements: 0, fileReplacements: [] })).toBeNull()
        expect(projectAstEditCardMeta({ ...APPLIED_DETAILS, totalReplacements: 0 })).toBeNull()
        expect(projectAstEditCardMeta({ ...APPLIED_DETAILS, totalReplacements: undefined, fileReplacements: [] })).toBeNull()
      })

      it('没有预览文本 → null', () => {
        expect(projectAstEditCardMeta({ ...APPLIED_DETAILS, displayContent: undefined })).toBeNull()
        expect(projectAstEditCardMeta({ ...APPLIED_DETAILS, displayContent: '' })).toBeNull()
      })

      it('多文件：files 按引擎顺序给出，畸形条目丢弃', () => {
        const meta = projectAstEditCardMeta({
          ...APPLIED_DETAILS,
          totalReplacements: 3,
          fileReplacements: [
            { path: 'a.ts', count: 2 },
            { path: '', count: 1 },
            { path: 'b.ts', count: 'nope' },
            { path: 'c.ts', count: 1 },
          ],
        })
        expect(meta?.files).toEqual([
          { path: 'a.ts', count: 2 },
          { path: 'c.ts', count: 1 },
        ])
        expect(meta?.replacements).toBe(3)
      })

      it('applied 非布尔 → false（dry run 语义），且 meta 里没有 undefined', () => {
        const meta = projectAstEditCardMeta({ ...APPLIED_DETAILS, applied: undefined })
        expect(meta?.applied).toBe(false)
        expect(JSON.stringify(meta)).not.toContain('undefined')
      })

      it('畸形输入不抛异常', () => {
        for (const bad of [42, 'x', [], () => {}, { fileReplacements: 'nope' }, { displayContent: 7 }]) {
          expect(() => projectAstEditCardMeta(bad as never)).not.toThrow()
        }
      })
    })

    describe('ast_edit 卡片投影：64 KiB 预览上限', () => {
      it('超长 displayContent 截断到上限内，且整体仍是合法 meta', () => {
        const meta = projectAstEditCardMeta({
          ...APPLIED_DETAILS,
          totalReplacements: 5,
          displayContent: 'x'.repeat(200_000),
          fileReplacements: [{ path: 'a.ts', count: 5 }],
        })
        expect(meta).not.toBeNull()
        expect(jsonByteLength(meta)).toBeLessThanOrEqual(AST_EDIT_META_MAX_BYTES)
        expect(meta!.preview.length).toBeGreaterThan(60_000)
        expect(meta!.preview.length).toBeLessThan(200_000)
        // 计数与文件列表保留（截断只动预览）
        expect(meta!.replacements).toBe(5)
        expect(meta!.files).toEqual([{ path: 'a.ts', count: 5 }])
        expect(narrowAstEditCardMeta(meta)).not.toBeNull()
      })

      it('文件列表本身就超限时仍不产超限 meta', () => {
        const files = Array.from({ length: 1200 }, (_, index) => ({
          path: `src/${index}/${'deep/'.repeat(6)}file-${index}-with-a-long-name.ts`,
          count: 1,
        }))
        const meta = projectAstEditCardMeta({ ...APPLIED_DETAILS, totalReplacements: files.length, fileReplacements: files })
        if (meta !== null) {
          expect(jsonByteLength(meta)).toBeLessThanOrEqual(AST_EDIT_META_MAX_BYTES)
          expect(narrowAstEditCardMeta(meta)).not.toBeNull()
        }
      })
    })

    describe('ast_edit 适配层接线', () => {
      it('output.schema 声明 preview/files/replacements/applied，render 不变', () => {
        const definition = captureDefinition(registerAstEdit)
        for (const key of ['preview', 'files', 'replacements', 'applied']) {
          expect(definition.output.schema.properties, key).toHaveProperty(key)
        }
        expect(definition.output.render({}, { text: 'ok' })).toEqual([{ type: 'text', text: 'ok' }])
      })

      it('presentationMeta 由 value 收窄成 ast_edit meta；缺预览走兜底', () => {
        const definition = captureDefinition(registerAstEdit)
        const value = {
          text: 'Applied 2 replacements in 1 file.',
          preview: 'a.ts\n│1│ const a = 1',
          files: [{ path: 'a.ts', count: 2 }],
          replacements: 2,
          applied: true,
        }
        expect(definition.output.presentationMeta({}, value)).toEqual({
          kind: 'ast_edit',
          preview: value.preview,
          files: value.files,
          replacements: 2,
          applied: true,
        })
        expect(definition.output.presentationMeta({}, { text: 'No replacements made.' })).toBeNull()
      })

      it('端到端：真实 ast_edit 调用产出预览并落盘（值形状可被投影消化）', async () => {
        const dir = realTmpDir('ast-edit-card-meta')
        const file = path.join(dir, 'a.ts')
        fs.writeFileSync(file, 'const alpha = 1\nconst beta = 2\n')

        const definition = captureDefinition(registerAstEdit)
        const out = await definition.execute(
          { ops: [{ pat: 'const alpha = $A', out: 'const alpha = 42' }], paths: [file] },
          { agent: { session: { header: { cwd: dir } } }, signal: undefined },
        )
        expect(fs.readFileSync(file, 'utf8')).toContain('const alpha = 42')
        expect(out.replacements).toBeGreaterThan(0)
        expect(typeof out.preview).toBe('string')
        expect(out.preview.length).toBeGreaterThan(0)
        expect(out.text).toMatch(/Applied 1 replacement in 1 file\./)
      })
    })
  })

  // ── edit ──────────────────────────────────────────────────────────────────

  describe('edit', () => {
    describe('edit 卡片投影：契约形状', () => {
      it('单文件：path + oldText/newText（删行+上下文 / 增行+上下文）', () => {
        const meta = projectEditCardMeta({
          path: '/w/a.ts',
          diff: ' 1|alpha\n-2|beta\n+2|BETA\n 3|gamma',
        })
        expect(meta).toEqual({
          kind: 'edit',
          diffs: [{ path: '/w/a.ts', oldText: 'alpha\nbeta\ngamma', newText: 'alpha\nBETA\ngamma' }],
        })
        expect(narrowEditCardMeta(meta)).not.toBeNull()
      })

      it('多文件：遍历 perFileResults，每个文件一条（多段则多条）', () => {
        const meta = projectEditCardMeta({
          diff: 'ignored-multi-file-join',
          perFileResults: [
            { path: '/w/a.ts', diff: ' 1|alpha\n-2|beta\n+2|BETA' },
            { path: '/w/b.ts', diff: '-1|one\n+1|ONE' },
          ],
        })
        expect(meta?.diffs.map(hunk => hunk.path)).toEqual(['/w/a.ts', '/w/b.ts'])
        expect(meta?.diffs[1]).toEqual({ path: '/w/b.ts', oldText: 'one', newText: 'ONE' })
      })

      it('纯新增：oldText 为 null', () => {
        const meta = projectEditCardMeta({ path: '/w/new.ts', diff: '+1|const a = 1\n+2|const b = 2' })
        expect(meta?.diffs[0]).toEqual({
          path: '/w/new.ts',
          oldText: null,
          newText: 'const a = 1\nconst b = 2',
        })
        expect(narrowEditCardMeta(meta)).not.toBeNull()
      })

      it('move（重命名）：只记目标为新建（oldText:null），源侧不记', () => {
        const meta = projectEditCardMeta({
          path: '/w/moved.ts',
          move: '/w/moved.ts',
          sourcePath: '/w/original.ts',
          diff: ' 1|alpha\n-2|beta\n+2|BETA',
        })
        expect(meta?.diffs).toEqual([
          { path: '/w/moved.ts', oldText: null, newText: 'alpha\nBETA' },
        ])
      })

      it('没有 diff / diff 为空 / 解不出 hunk → null', () => {
        expect(projectEditCardMeta({ path: '/w/a.ts' })).toBeNull()
        expect(projectEditCardMeta({ path: '/w/a.ts', diff: '' })).toBeNull()
        expect(projectEditCardMeta({ path: '/w/a.ts', diff: 'not a diff' })).toBeNull()
        expect(projectEditCardMeta({ diff: ' 1|alpha\n-2|beta\n+2|BETA' })).toBeNull()
        expect(projectEditCardMeta({ path: '/w/a.ts', perFileResults: [] })).toBeNull()
        expect(projectEditCardMeta({})).toBeNull()
      })

      it('畸形输入不抛异常，也不产 undefined 值', () => {
        for (const bad of [42, 'x', [], () => {}, { perFileResults: 'nope' }, { path: 1, diff: 2 }]) {
          expect(() => projectEditCardMeta(bad as never)).not.toThrow()
        }
        const meta = projectEditCardMeta({
          perFileResults: [
            { path: '/w/a.ts', diff: ' 1|alpha\n-2|beta\n+2|BETA' },
            { path: '', diff: ' 1|x' },
            { path: '/w/c.ts', diff: '' },
          ],
        })
        expect(meta?.diffs.map(hunk => hunk.path)).toEqual(['/w/a.ts'])
        expect(JSON.stringify(meta)).not.toContain('undefined')
      })
    })

    describe('edit 卡片投影：128 KiB 上限', () => {
      it('丢尾部文件：两条 70 KiB 只留第一条', () => {
        const meta = projectEditCardMeta({
          perFileResults: [
            { path: '/w/a.ts', diff: bigNumberedDiff(70 * 1024) },
            { path: '/w/b.ts', diff: bigNumberedDiff(70 * 1024) },
            { path: '/w/c.ts', diff: bigNumberedDiff(70 * 1024) },
          ],
        })
        expect(meta).not.toBeNull()
        expect(meta!.diffs.map(hunk => hunk.path)).toEqual(['/w/a.ts'])
        expect(jsonByteLength(meta)).toBeLessThanOrEqual(EDIT_META_MAX_BYTES)
        expect(narrowEditCardMeta(meta)).not.toBeNull()
      })

      it('全丢光则不产 meta（单条就超限）', () => {
        const meta = projectEditCardMeta({
          perFileResults: [{ path: '/w/a.ts', diff: bigNumberedDiff(200 * 1024) }],
        })
        expect(meta).toBeNull()
      })
    })

    describe('edit 适配层接线：四种模式', () => {
      it('replace 单段：diffs path 集合 = 目标文件，文本/内容可读', async () => {
        const dir = realTmpDir('edit-card-meta')
        const file = path.join(dir, 'a.ts')
        fs.writeFileSync(file, 'alpha\nbeta\ngamma\n')

        const out = await executeEditTool(
          execFor(dir),
          {} as never,
          { file_path: file, old_string: 'beta', new_string: 'BETA' },
          null,
        )
        expect(pathSet(out)).toEqual(['a.ts'])
        expect(out.diffs![0].oldText).toBe('alpha\nbeta\ngamma')
        expect(out.diffs![0].newText).toBe('alpha\nBETA\ngamma')
        expect(out.text).toMatch(/^Successfully replaced text in .+\.$/)
      })

      it('replace 多段：diffs path 集合 = 目标文件', async () => {
        const dir = realTmpDir('edit-card-meta')
        const file = path.join(dir, 'a.ts')
        fs.writeFileSync(file, 'alpha\nbeta\ngamma\n')

        const out = await executeEditTool(
          execFor(dir),
          {} as never,
          {
            file_path: file,
            edits: [
              { oldText: 'alpha', newText: 'ALPHA' },
              { oldText: 'gamma', newText: 'GAMMA' },
            ],
          },
          null,
        )
        expect(pathSet(out)).toEqual(['a.ts'])
        const newText = out.diffs!.map(hunk => hunk.newText).join('\n')
        expect(newText).toContain('ALPHA')
        expect(newText).toContain('GAMMA')
      })

      it('patch：diffs path 集合 = 目标文件', async () => {
        const dir = realTmpDir('edit-card-meta')
        const file = path.join(dir, 'a.ts')
        fs.writeFileSync(file, 'alpha\nbeta\ngamma\n')

        const out = await executeEditTool(
          execFor(dir),
          {} as never,
          { file_path: file, patch: '@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma' },
          null,
        )
        expect(pathSet(out)).toEqual(['a.ts'])
        expect(out.diffs!.map(hunk => hunk.oldText).join('\n')).toContain('beta')
        expect(out.diffs!.map(hunk => hunk.newText).join('\n')).toContain('BETA')
      })

      it('apply_patch 多文件：diffs path 集合 = 两个文件', async () => {
        const dir = realTmpDir('edit-card-meta')
        fs.writeFileSync(path.join(dir, 'a.ts'), 'alpha\n')
        fs.writeFileSync(path.join(dir, 'b.ts'), 'beta\n')

        const out = await executeEditTool(
          execFor(dir),
          {} as never,
          {
            input: '*** Begin Patch\n*** Update File: a.ts\n@@\n-alpha\n+ALPHA\n*** Update File: b.ts\n@@\n-beta\n+BETA\n*** End Patch',
          },
          null,
        )
        expect(pathSet(out)).toEqual(['a.ts', 'b.ts'])
      })

      it('hashline：diffs path 集合 = 目标文件', async () => {
        const dir = realTmpDir('edit-card-meta')
        const file = path.join(dir, 'a.ts')
        fs.writeFileSync(file, 'alpha\nbeta\ngamma\n')

        const { exec, tag } = hashlineExec(dir, file, [1, 2, 3])
        const out = await executeEditTool(
          exec,
          {} as never,
          { input: `[a.ts#${tag}]\nPUT 2-2:\n+const b = 2;` },
          null,
        )
        expect(pathSet(out)).toEqual(['a.ts'])
        expect(out.diffs!.map(hunk => hunk.newText).join('\n')).toContain('const b = 2;')
      })

      it('回归：失败文案一字未变（缺 file_path）', async () => {
        const dir = realTmpDir('edit-card-meta')
        await expect(
          executeEditTool(execFor(dir), {} as never, { old_string: 'a', new_string: 'b' }, null),
        ).rejects.toThrow('file_path must be a non-empty string')
      })

      it('presentationMeta：有 diffs 才产 meta，没有就走兜底（null）', () => {
        const definition = captureDefinition(registerEdit)
        expect(definition.output.schema.properties).toHaveProperty('diffs')
        expect(definition.output.render({}, { text: 'ok' })).toEqual([{ type: 'text', text: 'ok' }])

        const diffs = [{ path: '/w/a.ts', oldText: 'a', newText: 'b' }]
        expect(definition.output.presentationMeta({}, { text: 'ok', diffs })).toEqual({ kind: 'edit', diffs })
        expect(definition.output.presentationMeta({}, { text: 'ok' })).toBeNull()
        expect(definition.output.presentationMeta({}, { text: 'ok', diffs: [] })).toBeNull()
      })
    })
  })

  // ── glob ──────────────────────────────────────────────────────────────────

  describe('glob', () => {
    describe('glob card meta — paths projection', () => {
      it('projects the engine file list, in order, with the engine total', () => {
        const meta = searchPathsCardMeta({ paths: ['src/a.ts', 'src/b.ts', 'README.md'], total: 3, truncated: false })
        expect(meta).toEqual({
          kind: 'search',
          shape: 'paths',
          paths: ['src/a.ts', 'src/b.ts', 'README.md'],
          truncated: false,
          total: 3,
        })
        expect(narrowSearchCardMeta(meta)).not.toBeNull()
      })

      it('falls back to the path count for total and keeps the engine truncation flag', () => {
        expect(searchPathsCardMeta({ paths: ['a.ts'] })?.total).toBe(1)
        expect(searchPathsCardMeta({ paths: ['a.ts'], truncated: true })?.truncated).toBe(true)
      })

      it('drops non-string entries instead of failing', () => {
        expect(searchPathsCardMeta({ paths: ['a.ts', 7, null, 'b.ts'], total: 4 })).toEqual({
          kind: 'search',
          shape: 'paths',
          paths: ['a.ts', 'b.ts'],
          truncated: true,
          total: 4,
        })
      })

      it('draws an empty-result card when the engine returns no paths', () => {
        expect(searchPathsCardMeta({ paths: [], total: 0, truncated: false })).toEqual({
          kind: 'search',
          shape: 'paths',
          paths: [],
          truncated: false,
          total: 0,
        })
        expect(searchPathsCardMeta({ paths: ['a.ts', 'b.ts'], total: 0 })).toEqual({
          kind: 'search',
          shape: 'paths',
          paths: ['a.ts', 'b.ts'],
          truncated: false,
          total: 2,
        })
        // 没有 paths 键 = 不是 glob 结果（脏输入 / 别的工具的值）→ 不产卡。
        expect(searchPathsCardMeta({})).toBeNull()
        expect(searchPathsCardMeta(null)).toBeNull()
      })
    })

    describe('glob card meta — 64 KiB cap', () => {
      it('drops trailing paths, flags truncated, and keeps the pre-cap total', () => {
        const paths = Array.from({ length: 1_200 }, (_, index) => `src/${'y'.repeat(80)}-${index}.ts`)
        const meta = searchPathsCardMeta({ paths, total: 9_999, truncated: false })

        expect(meta).not.toBeNull()
        expect(meta!.paths.length).toBeGreaterThan(0)
        expect(meta!.paths.length).toBeLessThan(paths.length)
        expect(meta!.truncated).toBe(true)
        expect(meta!.total).toBe(9_999)
        expect(jsonByteLength(meta)).toBeLessThanOrEqual(SEARCH_META_MAX_BYTES)
        expect(narrowSearchCardMeta(meta)).not.toBeNull()
        expect(meta!.paths[0]).toBe(paths[0])
      })
    })

    describe('glob card meta — adapter wiring', () => {
      it('carries the engine file list into the value and leaves the text alone', async () => {
        const dir = tmpDir('tool-plus-globcard')
        fs.mkdirSync(path.join(dir, 'src'))
        fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'x\n')
        fs.writeFileSync(path.join(dir, 'src', 'b.ts'), 'x\n')
        fs.writeFileSync(path.join(dir, 'README.md'), 'x\n')

        const out = await executeGlobTool(execIn(dir), resolveConfig({}), { path: '**/*.ts' }, undefined as never)

        expect(out.text).toContain('b.ts')
        expect(out.paths?.slice().sort()).toEqual(['src/a.ts', 'src/b.ts'])
        expect(out.fileCount).toBe(2)
        expect(searchPathsCardMeta(out)).toEqual({
          kind: 'search',
          shape: 'paths',
          paths: out.paths,
          truncated: false,
          total: 2,
        })
      })

      it('produces an empty-result card for an empty engine result', async () => {
        const dir = tmpDir('tool-plus-globcard')
        fs.writeFileSync(path.join(dir, 'a.ts'), 'x\n')

        const out = await executeGlobTool(execIn(dir), resolveConfig({}), { path: '**/*.rs' }, undefined as never)
        expect(out.text).toContain('No files found')
        expect(out.paths).toEqual([])
        expect(searchPathsCardMeta(out)).toEqual({
          kind: 'search',
          shape: 'paths',
          paths: [],
          truncated: false,
          total: 0,
        })
      })

      it('registers a schema that accepts the paths carrier and projects the same meta', () => {
        const def = captureTool(registerGlob)
        expect(def.name).toBe('glob')
        expect(def.output.schema.properties.paths.type).toBe('array')

        const value = { path: '.', text: 'x', paths: ['src/a.ts'], fileCount: 1, truncated: false }
        expect(def.output.presentationMeta({ path: '*' }, value)).toEqual(
          searchPathsCardMeta(value),
        )
        // 引擎实跑的空结果形状：paths=[] → 出「0 个路径」空卡。
        expect(def.output.presentationMeta({ path: '*' }, { path: '.', text: 'No files found matching pattern', paths: [], fileCount: 0, truncated: false })).toEqual({
          kind: 'search',
          shape: 'paths',
          paths: [],
          truncated: false,
          total: 0,
        })
        expect(def.output.render({}, value)).toEqual([{ type: 'text', text: 'x' }])
      })
    })
  })

  // ── ast_grep ──────────────────────────────────────────────────────────────

  describe('ast_grep', () => {
    describe('ast_grep card meta — display parsing', () => {
      it('parses the grouped code-frame display and ignores meta-variable lines', () => {
        const meta = searchMatchesCardMeta({
          displayContent: AST_DISPLAY,
          cwd: AST_BASE,
          files: ['a.ts'],
          matchCount: 1,
          truncated: false,
        })
        expect(meta).toEqual({
          kind: 'search',
          shape: 'matches',
          files: [{ path: path.resolve(AST_BASE, 'a.ts'), matches: [{ lineNumber: 2, line: 'const needle = 2' }] }],
          truncated: false,
          total: 1,
        })
        expect(narrowSearchCardMeta(meta)).not.toBeNull()
      })

      it('keeps only the first line of a multi-line match (marker `*` lines)', () => {
        const meta = searchMatchesCardMeta({
          displayContent: '# a.ts\n*2│const x = {\n 3│  a: 1\n 4│};',
          cwd: AST_BASE,
          files: ['a.ts'],
          matchCount: 1,
        })
        expect(meta?.files[0]?.matches).toEqual([{ lineNumber: 2, line: 'const x = {' }])
      })

      it('flags truncation when the engine hit its match limit', () => {
        const meta = searchMatchesCardMeta({
          displayContent: AST_DISPLAY,
          cwd: AST_BASE,
          files: ['a.ts'],
          matchCount: 1,
          truncated: true,
        })
        expect(meta?.truncated).toBe(true)
      })

      it('draws an empty-result card when the run found nothing', () => {
        expect(searchMatchesCardMeta({ text: 'No matches found', matchCount: 0, fileCount: 0, files: [], cwd: AST_BASE })).toEqual({
          kind: 'search',
          shape: 'matches',
          files: [],
          truncated: false,
          total: 0,
        })
        // 没有计数可依（脏输入）→ 不产卡，也不许把有匹配的失败解析当空结果。
        expect(searchMatchesCardMeta({ displayContent: 'No matches found', cwd: AST_BASE, files: [] })).toBeNull()
        expect(searchMatchesCardMeta({ cwd: AST_BASE, files: [] })).toBeNull()
      })
    })

    describe('ast_grep card meta — adapter wiring', () => {
      it('puts the display, files, total and limit flag into the output value', () => {
        const result: any = {
          content: [{ type: 'text', text: 'AST body' }],
          details: {
            matchCount: 1,
            fileCount: 1,
            filesSearched: 1,
            limitReached: false,
            cwd: AST_BASE,
            files: ['a.ts'],
            displayContent: AST_DISPLAY,
          },
        }
        const value = toAstGrepToolResult(result)

        expect(value.text).toBe('AST body')
        expect(value.displayContent).toBe(AST_DISPLAY)
        expect(value.cwd).toBe(AST_BASE)
        expect(value.files).toEqual(['a.ts'])
        expect(value.matchCount).toBe(1)
        // 与 grep 同款：引擎没截断时不带这个键（投影按 `=== true` 判）。
        expect(value.truncated).toBeUndefined()
        expect(searchMatchesCardMeta(value)?.files[0]?.path).toBe(path.resolve(AST_BASE, 'a.ts'))

        const limited = toAstGrepToolResult({ ...result, details: { ...result.details, limitReached: true } })
        expect(limited.truncated).toBe(true)
      })

      it('keeps error results throwing (adapter contract unchanged)', () => {
        const result: any = { isError: true, content: [{ type: 'text', text: 'pat is invalid' }], details: {} }
        expect(() => toAstGrepToolResult(result)).toThrow('pat is invalid')
      })

      it('registers a schema that accepts the carrier and projects the same meta', () => {
        const def = captureTool(registerAstGrep)
        expect(def.name).toBe('ast_grep')
        expect(def.output.schema.properties.displayContent.type).toBe('string')
        expect(def.output.schema.properties.matchCount.type).toBe('number')

        const value = { text: 'x', displayContent: AST_DISPLAY, cwd: AST_BASE, files: ['a.ts'], matchCount: 1, truncated: false }
        expect(def.output.presentationMeta({ pat: 'const needle = $A' }, value)).toEqual(
          searchMatchesCardMeta(value),
        )
        // 引擎实跑的空结果形状：matchCount=0 → 出空卡；脏输入仍然显式 null。
        expect(def.output.presentationMeta({ pat: 'x' }, { text: 'No matches found', matchCount: 0, fileCount: 0, files: [] })).toEqual({
          kind: 'search',
          shape: 'matches',
          files: [],
          truncated: false,
          total: 0,
        })
        expect(def.output.presentationMeta({ pat: 'x' }, { text: 'No matches found' })).toBeNull()
        expect(def.output.render({}, value)).toEqual([{ type: 'text', text: 'x' }])
      })

      it('projects a real engine run', async () => {
        const dir = tmpDir('tool-plus-astgrep')
        fs.writeFileSync(path.join(dir, 'a.ts'), 'const x = 1\nconst needle = 2\n')
        const settings = new Settings(resolveConfig({}), getDefault)
        const session: any = { cwd: dir, settings, hasEditTool: true }
        const result = await new AstGrepTool(session).execute(
          'ast_grep',
          { pat: 'const needle = $A', path: '.' } as never,
          undefined,
        )
        const meta = searchMatchesCardMeta(toAstGrepToolResult(result))
        expect(meta).toEqual({
          kind: 'search',
          shape: 'matches',
          files: [{ path: path.resolve(dir, 'a.ts'), matches: [{ lineNumber: 2, line: 'const needle = 2' }] }],
          truncated: false,
          total: 1,
        })
      })
    })
  })

  // ── write ─────────────────────────────────────────────────────────────────

  describe('write', () => {
    describe('write 卡片投影：path + lang', () => {
      it('resolvedPath 优先，lang 由路径算出', () => {
        expect(projectWriteCardMeta({ resolvedPath: '/w/src/a.ts' }, { path: 'a.ts' })).toEqual({
          kind: 'write',
          path: '/w/src/a.ts',
          lang: 'typescript',
        })
      })

      it('没有 resolvedPath 时回退 args.path', () => {
        expect(projectWriteCardMeta(null, { path: '/w/notes.md' })).toEqual({
          kind: 'write',
          path: '/w/notes.md',
          lang: 'markdown',
        })
      })

      it('认不出语言时省略 lang，而不是放一个 undefined 值', () => {
        const meta = projectWriteCardMeta({ path: '/w/weird.zzz' }, null)
        expect(meta).toEqual({ kind: 'write', path: '/w/weird.zzz' })
        expect(meta).not.toBeNull()
        expect(Object.keys(meta!)).toEqual(['kind', 'path'])
        expect(JSON.stringify(meta)).not.toContain('undefined')
      })

      it('没有可用路径时不产 meta（走通用行）', () => {
        expect(projectWriteCardMeta({}, {})).toBeNull()
        expect(projectWriteCardMeta({ path: '   ' }, null)).toBeNull()
        expect(projectWriteCardMeta(undefined, undefined)).toBeNull()
        expect(projectWriteCardMeta(null, { path: 7 })).toBeNull()
      })

      it('畸形输入不抛异常', () => {
        for (const bad of [42, 'x', [], () => {}, { path: 7 }, { resolvedPath: {} }, Symbol('x')]) {
          expect(() => projectWriteCardMeta(bad as never, bad as never)).not.toThrow()
        }
      })
    })

    describe('write 适配层接线', () => {
      it('output.schema 声明可选 lang，render 仍只吐 value.text', () => {
        const definition = captureDefinition(registerWrite)
        expect(definition.output.schema.properties).toHaveProperty('lang')
        expect(definition.output.schema.properties.lang.type).toBe('string')
        expect(definition.output.render({}, { text: 'hello', path: '/w/a.ts', lang: 'typescript' })).toEqual([
          { type: 'text', text: 'hello' },
        ])
      })

      it('presentationMeta 返回契约形状（kind/path/lang）', () => {
        const definition = captureDefinition(registerWrite)
        expect(
          definition.output.presentationMeta(
            { path: 'a.ts' },
            { text: 'hello', path: '/w/b.ts', lang: 'typescript' },
          ),
        ).toEqual({ kind: 'write', path: '/w/b.ts', lang: 'typescript' })
        // 认不出语言 → 没有 lang 键（narrowWriteCardMeta 才收）
        expect(
          definition.output.presentationMeta({ path: 'a.ts' }, { text: 'hello', path: '/w/c.zzz' }),
        ).toEqual({ kind: 'write', path: '/w/c.zzz' })
        // value 没有路径（异常形态）→ 不产 meta（null，不是 undefined）
        expect(definition.output.presentationMeta({ path: '' }, { text: 'hello', path: '' })).toBeNull()
      })

      it('executeWriteTool：value 带 lang，输出文本仍是引擎原文', async () => {
        const dir = tmpDir('write-card-meta')
        const file = path.join(dir, 'a.ts')
        const out = await executeWriteTool(execFor(dir), {} as never, { path: file, content: 'const a = 1\n' })
        expect(out.lang).toBe('typescript')
        expect(out.path.endsWith('a.ts')).toBe(true)
        expect(fs.readFileSync(file, 'utf8')).toBe('const a = 1\n')
        // 模型可见文本：仍由引擎产出（本改动没有碰 toText/render）。
        expect(out.text).toMatch(/Successfully wrote 12 bytes to a\.ts$/)
      })

      it('回归：失败文案一字未变（auto-generated 守卫）', async () => {
        const dir = tmpDir('write-card-meta')
        const guard = path.join(dir, 'zz_generated.go')
        fs.writeFileSync(guard, '// original\n')
        await expect(
          executeWriteTool(execFor(dir), {} as never, { path: guard, content: '// x' }),
        ).rejects.toThrow(/auto-generated/i)
      })
    })
  })

})
