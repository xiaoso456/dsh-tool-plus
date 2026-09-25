/**
 * Generate `presets/<id>.patch.yml` from the vendored official baseline.
 *
 * WHY A GENERATOR: our two agent presets are the shipped `standard` / `ptc`
 * compositions with a small, explicit delta. Hand-maintaining the copy is what
 * made us ship a preset whose `delegation` group still named
 * `@deepseek-ai/dsh-workflow-worker-thread` — a package dsh 0.1.7 renamed to
 * `dsh-workflow-ptc`, so the whole preset failed to activate. Deriving the file
 * from a pinned baseline turns that class of drift into a build failure.
 *
 * HOW TO REFRESH: when the plugin's dsh pin moves, re-copy
 * `packages/bundle/web-app/presets/{standard,ptc}.patch.yml` from that dsh
 * release into `presets/baseline/`, run this script, and review the diff.
 * `--check` recomputes without writing and exits non-zero on drift (used by
 * `tests/unit/preset-patches.spec.ts`).
 *
 * The delta is deliberately tiny and each item is a documented product
 * decision; everything else must stay byte-equivalent to the baseline.
 * @module dsh-tool-plus/scripts/build-preset-patches
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const YAML = require('yaml')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const baselineDir = join(root, 'presets', 'baseline')
const outputDir = join(root, 'presets')

/**
 * The `!!js` dialect of the entry-list YAML. `@deepseek-ai/dsh-agent-preset`
 * rows carry `disabled: !!js <expr>` platform gates, so the baseline cannot be
 * parsed with a plain schema. Resolved values become markers that would NOT
 * survive a re-serialize as `!!js` — {@link assertNoJsExpressions} turns that
 * into a loud failure instead of a silently corrupted preset.
 */
const jsExpressionTag = {
  tag: 'tag:yaml.org,2002:js',
  resolve: (value) => ({ __jsExpr: value }),
}

/**
 * Rows this plugin serves from the HOST plane, so the agent plane must not
 * mount them again. `cordis.patch.yml` disables these four rows and inserts
 * one global `tool-plus` row; a preset that still names them would register a
 * second, per-session shadow instance whose settings injection never fires
 * (the 2026-08-25 hashline root cause). `tool-pwsh` is handled by
 * {@link FORCE_DISABLED} rather than removal because we want the row visible
 * and off, not absent.
 */
const REMOVE_ROWS = ['tool-bash', 'tool-fs', 'tool-fs-search']

/** Product decision: neither Tool Plus preset enables pwsh; OMP bash covers the shell. */
const FORCE_DISABLED = ['tool-pwsh']

/**
 * Inserted where the first removed row stood, so the shell/filesystem block
 * keeps its position. Disabled on purpose: it documents where an agent-plane
 * `tool-plus` row would go for a deployment that loads the package nowhere
 * else, while the healthy host-plane instance serves every session.
 */
const DOC_ROW = { id: 'tool-plus', name: '@xiaoso/dsh-tool-plus', disabled: true }

/** The two presets this package ships, in panel order. */
const PRESETS = [
  {
    id: 'tool-plus-standard',
    baseline: 'standard',
    order: 20,
    label: 'Tool Plus 标准增强版',
    description:
      '标准模式全部能力 + tool-plus 增强：文件/Shell 工具集替换为 @xiaoso/dsh-tool-plus（移植 oh-my-pi：read 单参数 file_path 内联行选择器、edit 三模式、bash/grep/glob）；pwsh 默认禁用。',
  },
  {
    id: 'tool-plus-ptc',
    baseline: 'ptc',
    order: 21,
    label: 'Tool Plus PTC 增强版',
    description:
      'PTC 模式全部能力 + tool-plus 增强：文件/Shell 工具集替换为 @xiaoso/dsh-tool-plus（移植 oh-my-pi：read 单参数 file_path 内联行选择器、edit 三模式、bash/grep/glob），经 Code Mode SDK 以 run_code 组合多步操作；pwsh 默认禁用。',
  },
]

/** Module specifier of the declaration plugin every preset row names. */
const DECLARATION_MODULE = '@deepseek-ai/dsh-agent-preset'

/** Refuse to emit a `!!js` value we cannot round-trip. */
function assertNoJsExpressions(rows) {
  const walk = (value, path) => {
    if (Array.isArray(value)) return value.forEach((item, index) => walk(item, `${path}[${index}]`))
    if (value === null || typeof value !== 'object') return
    if (typeof value.__jsExpr === 'string' && Object.keys(value).length === 1) {
      throw new Error(
        `preset rows carry a !!js expression at ${path} that this generator cannot re-emit as !!js.\n`
        + 'Teach serializePatch() the represent side (mirror vendor/include/src/index.ts JsExpr) '
        + 'or fold the row into REMOVE_ROWS / FORCE_DISABLED.',
      )
    }
    for (const [key, nested] of Object.entries(value)) walk(nested, `${path}.${key}`)
  }
  walk(rows, 'plugins')
}

/**
 * Apply the delta to one baseline declaration.
 * @param spec - one entry of {@link PRESETS}.
 * @returns the declaration row to serialize.
 */
function buildDeclaration(spec) {
  const baselinePath = join(baselineDir, `${spec.baseline}.patch.yml`)
  const document = YAML.parse(readFileSync(baselinePath, 'utf8'), { schema: 'core', customTags: [jsExpressionTag] })
  const baselineRow = document?.[0]?.insert?.[0]
  if (baselineRow === undefined) throw new Error(`${baselinePath}: expected one \`- insert:\` declaration row`)

  const plugins = baselineRow.config?.plugins
  if (!Array.isArray(plugins)) throw new Error(`${baselinePath}: declaration carries no config.plugins list`)

  const at = plugins.findIndex((row) => REMOVE_ROWS.includes(row?.id))
  if (at < 0) {
    throw new Error(
      `${baselinePath}: none of the host-plane rows ${REMOVE_ROWS.join(', ')} are present at top level. `
      + 'The official composition changed shape — re-derive the delta before shipping.',
    )
  }
  const missing = REMOVE_ROWS.filter((id) => !plugins.some((row) => row?.id === id))
  if (missing.length > 0) throw new Error(`${baselinePath}: expected to remove ${missing.join(', ')} but found no such top-level row`)

  const kept = plugins.filter((row) => !REMOVE_ROWS.includes(row?.id))
  const next = []
  for (const row of kept) {
    if (FORCE_DISABLED.includes(row?.id)) next.push({ ...row, disabled: true })
    else next.push(row)
  }
  // The doc row takes the position the removed block occupied: `at` counts
  // rows in the ORIGINAL list, so subtract how many removed rows preceded it.
  const removedBefore = plugins.slice(0, at).filter((row) => REMOVE_ROWS.includes(row?.id)).length
  next.splice(at - removedBefore, 0, { ...DOC_ROW })

  // A patch file is a top-level YAML SEQUENCE of patch entries; `insert` (with
  // no `id`) appends rows to the profile's root entry list.
  return [{
    insert: [{
      id: `preset-${spec.id}`,
      name: DECLARATION_MODULE,
      config: {
        id: spec.id,
        name: spec.label,
        description: spec.description,
        order: spec.order,
        plugins: next,
      },
    }],
  }]
}

/** Header comment: why this file is generated and what our delta is. */
function header(spec) {
  return [
    `# Agent preset \`${spec.id}\` — declared as one \`${DECLARATION_MODULE}\` row.`,
    '#',
    `# GENERATED by scripts/build-preset-patches.mjs from`,
    `# presets/baseline/${spec.baseline}.patch.yml (the shipped \`${spec.baseline}\` composition of the dsh`,
    '# release this plugin pins). Do not edit by hand: the generator is what keeps',
    '# our delta honest across dsh upgrades, and tests/unit/preset-patches.spec.ts',
    '# fails when this file and the generator disagree.',
    '#',
    '# Delta over the baseline:',
    `#   - ${REMOVE_ROWS.join(', ')} are removed — the host plane already serves them`,
    '#     through this plugin\'s `cordis.patch.yml`, and mounting them again in the',
    '#     agent plane would create a per-session shadow instance',
    `#   - ${FORCE_DISABLED.join(', ')} is forced \`disabled: true\` (neither Tool Plus preset enables pwsh)`,
    `#   - an inert \`${DOC_ROW.id}\` row documents where an agent-plane plugin row would go`,
    '#   - everything else is the baseline, byte-equivalent',
    '#',
    '# A profile patch overriding this row BY THE ROW ID BELOW replaces the whole',
    '# `config`, so an override must restate `id`, `name`, `description`, `order` and',
    '# `plugins`. That is what `@xiaoso/dsh-tool-plus`\'s settings panel writes.',
    '',
  ].join('\n')
}

/** Render one declaration file exactly as it should land on disk. */
function serializePatch(spec) {
  const declaration = buildDeclaration(spec)
  assertNoJsExpressions(declaration[0].insert[0].config.plugins)
  const body = YAML.stringify(declaration, { lineWidth: 0, aliasDuplicateObjects: false, singleQuote: true })
  if (body.includes('__jsExpr')) {
    throw new Error(`${spec.id}: serialized patch still contains a __jsExpr marker — refusing to write`)
  }
  return header(spec) + body
}

const check = process.argv.includes('--check')
let drifted = 0
for (const spec of PRESETS) {
  const target = join(outputDir, `${spec.id}.patch.yml`)
  const rendered = serializePatch(spec)
  if (check) {
    let onDisk
    try {
      onDisk = readFileSync(target, 'utf8')
    } catch {
      console.error(`DRIFT ${spec.id}: ${target} is missing`)
      drifted += 1
      continue
    }
    if (onDisk.replace(/\r\n/g, '\n') !== rendered) {
      console.error(`DRIFT ${spec.id}: ${target} does not match the generator output`)
      drifted += 1
    }
    continue
  }
  writeFileSync(target, rendered)
  console.log(`wrote ${target} (${Buffer.byteLength(rendered)} bytes)`)
}
if (check) {
  if (drifted > 0) {
    console.error(`\n${drifted} preset patch file(s) drifted. Run: node scripts/build-preset-patches.mjs`)
    process.exit(1)
  }
  console.log('preset patches match the generator')
}
