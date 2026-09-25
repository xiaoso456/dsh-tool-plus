/**
 * preset patch 文件（`presets/<id>.patch.yml`）的锁。
 *
 * 这三个文件是**生成物**：由 `scripts/build-preset-patches.mjs` 从
 * `presets/baseline/<官方预设>.patch.yml`（对应 dsh 版本的官方随附预设快照）
 * 加上一小段显式 delta 得出。之所以要有这份锁，是因为手抄副本已经害过我们一次：
 * 两个预设的 `delegation` group 里一直挂着
 * `@deepseek-ai/dsh-workflow-worker-thread`，而 dsh 0.1.7 把它改名成了
 * `dsh-workflow-ptc` —— 于是整份预设激活失败，而且没有任何测试能发现。
 *
 * 四条不变量：
 * 1. 生成器现在重算的结果与仓库里的文件逐字节一致；
 * 2. 声明形状正确（行 id、模块名、完整 config 字段）；
 * 3. delta **恰好**只有声明的那几项，其余每个路径与基线深相等；
 * 4. 行名集合 = 基线的行名集合 − 去掉的三行 + 文档行 —— 也就是说，任何"官方把某个
 *    包改名/删掉"的漂移都会随基线一起继承，而不会留在我们这份里。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** 解析 entry-list 方言里的 `!!js`（值取出来只用于比较，不求值）。 */
const JS_TAG = { tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ __jsExpr: value }) }

/** 我们随包声明的两个预设与它们的基线。 */
const CASES = [
  { id: 'tool-plus-standard', baseline: 'standard', order: 20 },
  { id: 'tool-plus-ptc', baseline: 'ptc', order: 21 },
] as const

/** 宿主面已接管、agent 面必须缺席的三行。 */
const REMOVED = ['tool-bash', 'tool-fs', 'tool-fs-search']

/** 故意关掉而非删除的一行（产品决定：两档增强版都不启用 pwsh）。 */
const FORCE_DISABLED = 'tool-pwsh'

/** 插在原来 shell/fs 那一段位置上的文档行，故意 disabled。 */
const DOC_ROW = { id: 'tool-plus', name: '@xiaoso/dsh-tool-plus' }

/** 一行 Cordis 配置项的最小子集。 */
interface Row {
  id?: string
  name?: string
  group?: boolean
  disabled?: unknown
  config?: unknown
  [key: string]: unknown
}

/** 读一个 patch 文件里的声明行 → `config.plugins`。 */
function pluginsOf(file: string): Row[] {
  const document = parse(readFileSync(file, 'utf8'), { schema: 'core', customTags: [JS_TAG] }) as
    | Array<{ insert?: Array<{ id?: string; name?: string; config?: { id?: string; order?: number; plugins?: Row[] } }> }>
    | null
  expect(Array.isArray(document), `${file} must be a top-level YAML sequence`).toBe(true)
  const inserted = document?.[0]?.insert
  expect(inserted, `${file} must carry exactly one \`- insert:\` declaration`).toHaveLength(1)
  const plugins = inserted?.[0]?.config?.plugins
  expect(Array.isArray(plugins), `${file} must carry config.plugins`).toBe(true)
  return plugins as Row[]
}

/** 声明行本身（校验行 id / 模块名 / 元数据用）。 */
function declarationOf(file: string): { id?: string; name?: string; config?: { id?: string; order?: number } } {
  const document = parse(readFileSync(file, 'utf8'), { schema: 'core', customTags: [JS_TAG] }) as Array<{
    insert?: Array<{ id?: string; name?: string; config?: { id?: string; order?: number } }>
  }>
  return document[0]?.insert?.[0] ?? {}
}

/** 展平成 `路径 → 行`（含 group 内子行）。 */
function flatten(rows: readonly Row[], prefix = ''): Map<string, Row> {
  const out = new Map<string, Row>()
  for (const row of rows) {
    if (typeof row.id !== 'string') continue
    const path = prefix.length > 0 ? `${prefix}/${row.id}` : row.id
    out.set(path, row)
    if (row.group === true && Array.isArray(row.config)) {
      for (const [nested, nestedRow] of flatten(row.config as Row[], path)) out.set(nested, nestedRow)
    }
  }
  return out
}

/** 一棵行树里所有模块名（含 group 内子行），排序后便于做多重集比较。 */
function moduleNames(rows: readonly Row[]): string[] {
  const names: string[] = []
  const walk = (list: readonly Row[]): void => {
    for (const row of list) {
      if (typeof row.name === 'string') names.push(row.name)
      if (row.group === true && Array.isArray(row.config)) walk(row.config as Row[])
    }
  }
  walk(rows)
  return names.sort()
}

const generated = (id: string): string => join(ROOT, 'presets', `${id}.patch.yml`)
const baseline = (name: string): string => join(ROOT, 'presets', 'baseline', `${name}.patch.yml`)

describe('preset patches', () => {
  it('are exactly what the generator recomputes', () => {
    // 生成器 `--check` 会重算并逐字节比对；任何手改都会在这里失败。
    expect(() => execFileSync(process.execPath, ['scripts/build-preset-patches.mjs', '--check'], {
      cwd: ROOT,
      stdio: 'pipe',
    })).not.toThrow()
  })

  for (const spec of CASES) {
    describe(spec.id, () => {
      it('declares one preset with the documented identity', () => {
        const declaration = declarationOf(generated(spec.id))
        expect(declaration.id).toBe(`preset-${spec.id}`)
        expect(declaration.name).toBe('@deepseek-ai/dsh-agent-preset')
        expect(declaration.config?.id).toBe(spec.id)
        expect(declaration.config?.order).toBe(spec.order)
      })

      it('carries nothing but the declared delta over the baseline', () => {
        const mine = flatten(pluginsOf(generated(spec.id)))
        const theirs = flatten(pluginsOf(baseline(spec.baseline)))

        for (const id of REMOVED) expect(mine.has(id), `${id} must not be mounted in the agent plane`).toBe(false)
        for (const id of REMOVED) expect(theirs.has(id), `baseline is expected to carry ${id}`).toBe(true)

        // 文档行在场且故意关掉。
        expect(mine.get(DOC_ROW.id)?.name).toBe(DOC_ROW.name)
        expect(mine.get(DOC_ROW.id)?.disabled).toBe(true)

        // 其余每个路径都必须与基线深相等，唯一例外是那一个被强制关掉的行。
        for (const [path, row] of mine) {
          if (path === DOC_ROW.id) continue
          const counterpart = theirs.get(path)
          expect(counterpart, `${path} is not in the baseline — the delta is not declared`).toBeDefined()
          if (path === FORCE_DISABLED) {
            expect(row.disabled).toBe(true)
            expect(counterpart?.disabled).not.toBe(true)
            const { disabled: _mine, ...rest } = row
            const { disabled: _theirs, ...baselineRest } = counterpart as Row
            expect(rest).toEqual(baselineRest)
            continue
          }
          expect(row, `${path} drifted from the baseline`).toEqual(counterpart)
        }
        for (const path of theirs.keys()) {
          if (REMOVED.includes(path)) continue
          expect(mine.has(path), `${path} is missing from the generated preset`).toBe(true)
        }
      })

      it('takes every module name from the pinned baseline', () => {
        const expected = moduleNames(pluginsOf(baseline(spec.baseline)))
        const removedNames = new Set(REMOVED.map(id => flatten(pluginsOf(baseline(spec.baseline))).get(id)?.name))
        const want = expected.filter(name => !removedNames.has(name)).concat(DOC_ROW.name).sort()
        expect(moduleNames(pluginsOf(generated(spec.id)))).toEqual(want)
      })

      it('cannot regress to the renamed workflow engine', () => {
        const mine = flatten(pluginsOf(generated(spec.id)))
        expect([...mine.keys()]).toContain('delegation/workflow-ptc')
        for (const [path, row] of mine) {
          expect(path).not.toContain('workflow-worker-thread')
          expect(row.name).not.toContain('workflow-worker-thread')
        }
      })

      it('leaves no !!js marker behind (they would serialize as a plain map)', () => {
        expect(JSON.stringify(pluginsOf(generated(spec.id)))).not.toContain('__jsExpr')
      })
    })
  }
})
