/**
 * 回归守卫：任何工具的 `presentationMeta` 都不得返回 `undefined`。
 *
 * 为什么必须守：harness 对每个 projector 结果跑 `snapshotProjection`
 * （`@deepseek-ai/dsh-tools` → `lib/types/index.js`）：
 *
 * ```js
 * const detached = snapshotJsonValue(candidate)
 * if (detached === undefined) throw new ToolOutputError(toolName, ['output.presentationMeta returned non-lossless JSON'])
 * ```
 *
 * 也就是说，**一次本来成功的工具调用**在"画不出卡"时会被改写成 `isError`。
 * 官方 `tool-terminal` 在同语义下返回 `null`，本插件全线对齐：不产卡 = 显式 `null`。
 *
 * 覆盖范围：本插件注册的全部 8 个工具（bash / read / write / edit / grep / glob /
 * ast_grep / ast_edit），好值（产卡）与坏值（不产卡）两条路径，外加一轮脏输入穷举。
 *
 * 判定用的 `firstNonJsonPath` 是 harness `walkJsonValue` 规则的忠实镜像（见下），
 * 这样"undefined 出口"与"meta 里带 undefined 值的键"两类问题一起被守住——后者
 * 同样会让 `snapshotJsonValue` 返回 undefined。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolveConfig } from '../../src/config/settings.ts'
import { bashCardMeta } from '../../src/web/host/bash.ts'
import { registerAstEdit } from '../../src/tools/ast-edit/adapter/index.ts'
import { registerAstGrep } from '../../src/tools/ast-grep/adapter/index.ts'
import { registerEdit } from '../../src/tools/edit/adapter/index.ts'
import { registerGlob } from '../../src/tools/glob/adapter/index.ts'
import { registerGrep } from '../../src/tools/grep/adapter/index.ts'
import { registerRead } from '../../src/tools/read/adapter/index.ts'
import { registerWrite } from '../../src/tools/write/adapter/index.ts'

/** 抓取 `registerXxx` 交给宿主注册表的工具定义（defineTool 注册时就编译 schema）。 */
function captureDefinition(register: (ctx: any, getConfig: () => any) => unknown): any {
  let definition: any
  const ctx = { tools: { register: (value: any) => { definition = value; return () => {} } } }
  register(ctx, () => resolveConfig({}))
  return definition
}

const DEFINITIONS: Record<string, any> = {
  read: captureDefinition(registerRead),
  write: captureDefinition(registerWrite),
  edit: captureDefinition(registerEdit),
  grep: captureDefinition(registerGrep),
  glob: captureDefinition(registerGlob),
  ast_grep: captureDefinition(registerAstGrep),
  ast_edit: captureDefinition(registerAstEdit),
}

/**
 * First offending path of a candidate that is **not** lossless JSON, or `null`
 * when the value survives the harness's rule.
 *
 * Mirror of `snapshotJsonValue` / `walkJsonValue` in
 * `@deepseek-ai/dsh-util-values` (the function `snapshotProjection` calls):
 * `undefined` and non-plain values (functions, symbols, bigints, class
 * instances, `Date`, non-finite numbers, `-0`, cycles, `undefined`-valued keys)
 * all collapse the snapshot to `undefined`, which the host turns into
 * `ToolOutputError('… returned non-lossless JSON')`.
 */
function firstNonJsonPath(value: unknown): string | null {
  const ancestors = new Set<object>()
  const walk = (current: unknown, at: string): string | null => {
    if (current === null) return null
    const type = typeof current
    if (type === 'boolean' || type === 'string') return null
    if (type === 'number') {
      return Number.isFinite(current) && !Object.is(current, -0) ? null : at
    }
    // undefined / function / symbol / bigint：harness 一律判非 JSON。
    if (type !== 'object') return at
    const record = current as Record<string, unknown>
    if (ancestors.has(record)) return at
    ancestors.add(record)
    try {
      if (Array.isArray(record)) {
        if (Object.keys(record).length !== record.length) return at
        for (let index = 0; index < record.length; index += 1) {
          const bad = walk(record[index], `${at}[${index}]`)
          if (bad !== null) return bad
        }
        return null
      }
      const prototype = Object.getPrototypeOf(record)
      if (prototype !== Object.prototype && prototype !== null) return at
      for (const key of Object.keys(record)) {
        const bad = walk(record[key], `${at}.${key}`)
        if (bad !== null) return bad
      }
      return null
    } finally {
      ancestors.delete(record)
    }
  }
  return walk(value, '$')
}

/** 一处工具 × 其好值 / 坏值样本。 */
interface MetaProbe {
  name: string
  /** 等价于 harness 调用的 `definition.output.presentationMeta(args, value)`。 */
  presentationMeta: (args: unknown, value: unknown) => unknown
  /** 有卡样本：必须产卡且是 lossless JSON。 */
  good: Array<{ args: unknown; value: unknown }>
  /** 无卡样本：必须返回显式 `null`。 */
  noCard: Array<{ args: unknown; value: unknown }>
}

/** 引擎实跑形状的分组显示文本（grep / ast_grep 共用）。 */
const GROUPED_DISPLAY = '# src/\n## a.ts\n 1│const x = 1\n*2│const needle = 2'

const PROBES: MetaProbe[] = [
  {
    name: 'bash',
    // bash 的 presentationMeta 定义内联在 src/index.ts（`(_args, value) => bashCardMeta(value)`，
    // 插件入口无法在不启动宿主的情况下抓取定义），这里以同一函数作为等价替身；
    // 接线本身由本文件末尾的源码锁守住。
    presentationMeta: (_args, value) => bashCardMeta(value),
    good: [
      { args: {}, value: { kind: 'foreground', exitCode: 0, timedOut: false, aborted: false, timeoutMs: null, wallTimeMs: 7 } },
      { args: {}, value: { kind: 'foreground', exitCode: 1, timedOut: false, aborted: false, workingDir: '/w' } },
      { args: {}, value: { kind: 'background', jobId: 'bash-2' } },
    ],
    noCard: [
      { args: {}, value: undefined },
      { args: {}, value: null },
      { args: {}, value: {} },
      { args: {}, value: { kind: 'unknown' } },
      { args: {}, value: { kind: 'foreground', exitCode: '0', timedOut: false, aborted: false } },
      { args: {}, value: { kind: 'foreground', exitCode: 0, timedOut: false } },
      { args: {}, value: { kind: 'background', jobId: '   ' } },
    ],
  },
  {
    name: 'read',
    presentationMeta: (args, value) => DEFINITIONS.read!.output.presentationMeta(args, value),
    good: [
      {
        args: { path: '/repo/a.ts' },
        value: { text: 'x', path: '/repo/a.ts', display: { text: 'x', startLine: 1 }, textBlocks: 1 },
      },
    ],
    noCard: [
      // 图片读取（引擎以 image 标记指示，见 read-card-meta 的 targets 表）
      { args: { path: '/repo/pic.png' }, value: { text: 'x', path: '/repo/pic.png', image: { attachmentId: 'a1' }, textBlocks: 1 } },
      // sqlite 读取（非文本扩展名）
      { args: { path: 'data/app.db:users:42' }, value: { text: 'x', path: '/repo/data/app.db', display: { text: 'x', startLine: 1 }, textBlocks: 1 } },
      // 目录
      { args: { path: '/repo' }, value: { text: 'x', isDirectory: true, textBlocks: 1 } },
      // 内部 URL
      {
        args: { path: 'artifact://abc' },
        value: { text: 'x', source: { type: 'internal', value: 'artifact://abc' }, display: { text: 'x', startLine: 1 }, textBlocks: 1 },
      },
      // url
      {
        args: { path: 'https://example.com' },
        value: { text: 'x', source: { type: 'url', value: 'https://example.com' }, display: { text: 'x', startLine: 1 }, textBlocks: 1 },
      },
      // 多文本块（信封/多目标）与没有 display
      { args: { path: '/repo/a.ts' }, value: { text: 'x', path: '/repo/a.ts', display: { text: 'x', startLine: 1 }, textBlocks: 2 } },
      { args: { path: '/repo/a.ts' }, value: { text: 'x', path: '/repo/a.ts', textBlocks: 1 } },
      { args: {}, value: {} },
    ],
  },
  {
    name: 'write',
    presentationMeta: (args, value) => DEFINITIONS.write!.output.presentationMeta(args, value),
    good: [
      { args: { path: '/w/a.ts' }, value: { text: 'ok', path: '/w/a.ts' } },
      { args: { path: '/w/weird.zzz' }, value: { text: 'ok', resolvedPath: '/w/weird.zzz' } },
    ],
    noCard: [
      { args: { path: '' }, value: { text: 'hello', path: '' } },
      { args: {}, value: { text: 'hello' } },
      { args: {}, value: {} },
      { args: {}, value: undefined },
    ],
  },
  {
    name: 'edit',
    presentationMeta: (args, value) => DEFINITIONS.edit!.output.presentationMeta(args, value),
    good: [
      { args: {}, value: { text: 'ok', diffs: [{ path: '/w/a.ts', oldText: 'a', newText: 'b' }] } },
      { args: {}, value: { text: 'ok', diffs: [{ path: '/w/a.ts', oldText: null, newText: 'b' }] } },
    ],
    noCard: [
      { args: {}, value: { text: 'ok' } },
      { args: {}, value: { text: 'ok', diffs: [] } },
      { args: {}, value: {} },
      { args: {}, value: undefined },
    ],
  },
  {
    name: 'grep',
    presentationMeta: (args, value) => DEFINITIONS.grep!.output.presentationMeta(args, value),
    good: [
      {
        args: { pattern: 'needle' },
        value: { text: GROUPED_DISPLAY, displayContent: GROUPED_DISPLAY, cwd: '/repo', files: ['src/a.ts'], matchCount: 1 },
      },
    ],
    noCard: [
      { args: { pattern: 'needle' }, value: { text: 'No matches found' } },
      { args: { pattern: 'needle' }, value: { text: 'x', displayContent: '' } },
      { args: { pattern: 'needle' }, value: { text: 'x', displayContent: 'no group headers here' } },
      { args: {}, value: {} },
      { args: {}, value: undefined },
    ],
  },
  {
    name: 'glob',
    presentationMeta: (args, value) => DEFINITIONS.glob!.output.presentationMeta(args, value),
    good: [
      { args: { path: '**/*.ts' }, value: { path: '.', text: 'a.ts', fileCount: 1, paths: ['a.ts'] } },
    ],
    noCard: [
      { args: { path: '**/*.rs' }, value: { path: '.', text: 'No files found matching pattern', paths: [] } },
      { args: { path: '**/*.ts' }, value: { path: '.', text: 'No files found matching pattern' } },
      { args: {}, value: {} },
      { args: {}, value: undefined },
    ],
  },
  {
    name: 'ast_grep',
    presentationMeta: (args, value) => DEFINITIONS.ast_grep!.output.presentationMeta(args, value),
    good: [
      {
        args: { pat: 'const needle = $A' },
        value: { text: GROUPED_DISPLAY, displayContent: GROUPED_DISPLAY, cwd: '/repo', files: ['src/a.ts'], matchCount: 1 },
      },
    ],
    noCard: [
      { args: { pat: 'x' }, value: { text: 'No matches found' } },
      { args: { pat: 'x' }, value: { text: 'x', displayContent: '' } },
      { args: {}, value: {} },
      { args: {}, value: undefined },
    ],
  },
  {
    name: 'ast_edit',
    presentationMeta: (args, value) => DEFINITIONS.ast_edit!.output.presentationMeta(args, value),
    good: [
      {
        args: { ops: [], paths: ['a.ts'] },
        value: {
          text: 'Applied 2 replacements in 1 file.',
          preview: 'a.ts\n│1│ const a = 1',
          files: [{ path: 'a.ts', count: 2 }],
          replacements: 2,
          applied: true,
        },
      },
      // dry run（未落盘）也要出卡
      {
        args: { ops: [], paths: ['a.ts'] },
        value: { text: 'Preview.', preview: 'a.ts\n│1│ const a = 1', files: [{ path: 'a.ts', count: 1 }], replacements: 1, applied: false },
      },
    ],
    noCard: [
      { args: {}, value: { text: 'No replacements made.' } },
      { args: {}, value: { text: 'x', preview: '' } },
      { args: {}, value: { text: 'x' } },
      { args: {}, value: {} },
      { args: {}, value: undefined },
    ],
  },
]

/** 断言"有卡"：非 undefined、非 null、lossless JSON、且 JSON 往返不变。 */
function expectCard(tool: string, args: unknown, value: unknown): void {
  const meta = PROBES.find(probe => probe.name === tool)!.presentationMeta(args, value)
  expect(meta, `${tool}.presentationMeta 好值不得返回 undefined`).not.toBeUndefined()
  expect(meta, `${tool}.presentationMeta 好值应当产卡`).not.toBeNull()
  expect(firstNonJsonPath(meta), `${tool} 的卡片 meta 必须是 lossless JSON`).toBeNull()
  expect(JSON.parse(JSON.stringify(meta)), `${tool} 的卡片 meta 必须经得住 JSON 往返`).toEqual(meta)
}

/** 断言"不产卡"：必须是显式 `null`（`undefined` 会把成功的调用改写成 isError）。 */
function expectNoCard(tool: string, args: unknown, value: unknown): void {
  const meta = PROBES.find(probe => probe.name === tool)!.presentationMeta(args, value)
  expect(meta, `${tool}.presentationMeta 不产卡时必须返回 null，不能是 undefined`).toBeNull()
}

describe('工具卡片 meta — 注册与定义', () => {
  for (const [name, definition] of Object.entries(DEFINITIONS)) {
    it(`${name}：注册名一致且带 presentationMeta`, () => {
      expect(definition.name).toBe(name)
      expect(typeof definition.output.presentationMeta).toBe('function')
    })
  }

  it('bash：presentationMeta 是 bashCardMeta 直通（源码锁，定义内联在插件入口）', () => {
    const source = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/presentationMeta:\s*\(_args:\s*unknown,\s*value:\s*unknown\)\s*=>\s*bashCardMeta\(value\)/)
  })
})

describe('工具卡片 meta — 好值产卡（lossless JSON）', () => {
  for (const probe of PROBES) {
    it(`${probe.name}：好值产卡且 JSON 往返无损`, () => {
      for (const sample of probe.good) expectCard(probe.name, sample.args, sample.value)
    })
  }
})

describe('工具卡片 meta — 不产卡必须是显式 null', () => {
  for (const probe of PROBES) {
    it(`${probe.name}：坏值返回 null 而不是 undefined`, () => {
      for (const sample of probe.noCard) expectNoCard(probe.name, sample.args, sample.value)
    })
  }
})

describe('工具卡片 meta — 脏输入穷举', () => {
  const JUNK: unknown[] = [
    undefined, null, 0, -0, 1, Number.NaN, Number.POSITIVE_INFINITY, '', 'text',
    true, false, [], ['x'], {}, { kind: 'unknown' }, () => {}, Symbol('junk'),
    new Date(0), Object.create(null), new (class {})() ,
  ]

  it('任何工具 × 任何脏输入：不抛、不产卡、且绝不返回 undefined', () => {
    for (const probe of PROBES) {
      for (const args of JUNK) {
        for (const value of JUNK) {
          let meta: unknown
          expect(
            () => { meta = probe.presentationMeta(args, value) },
            `${probe.name}.presentationMeta 不得抛异常`,
          ).not.toThrow()
          expect(meta, `${probe.name}.presentationMeta 不得返回 undefined`).not.toBeUndefined()
          expect(meta, `${probe.name} 对脏输入不应产卡`).toBeNull()
          expect(firstNonJsonPath(meta), `${probe.name} 的返回值必须是 lossless JSON`).toBeNull()
        }
      }
    }
  })
})
