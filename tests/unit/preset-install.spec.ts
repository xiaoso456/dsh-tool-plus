/**
 * preset 安装 fs 层（src/presets/install.ts / status.ts）单测。
 *
 * 覆盖设计文档 §4（启动补缺、升级、重置）、§8（写盘策略：原子写 + 备份 +
 * 内容相同不写）与 §10 的 fs 层验收 9–10：全程用 `fs.mkdtempSync` 造临时
 * `<dshHome>` 与临时包根，通过 `deps` 注入，测试里不出现写死路径。
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ensureDefaultPresets, applyPresetAction } from '../../src/presets/install.ts'
import {
  COMPOSITION_FILE_NAME,
  DEFAULT_PRESET_IDS,
  METADATA_FILE_NAME,
  templateDir,
  userPresetDir,
  userPresetRoot,
} from '../../src/presets/paths.ts'
import { listPresetStatuses } from '../../src/presets/status.ts'

const COMPOSITION = `- id: persona
  name: '@deepseek-ai/dsh-persona'

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
`

const METADATA = `name: 测试预设
description: 单测用模板
order: 9
`

/** 需要清理的临时目录。 */
const temps: string[] = []

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-preset-${label}-`))
  temps.push(dir)
  return dir
}

/** 造一个假的插件包根：`<pkg>/presets/<id>/{agent.cordis.yml,preset.yml}`。 */
function fixturePackage(ids: readonly string[] = DEFAULT_PRESET_IDS): {
  packageRoot: string
  homeDir: string
} {
  const packageRoot = tempDir('pkg')
  const homeDir = tempDir('home')
  // 假包根也带 package.json：备份名里的插件版本从它读，测试可断言确定的名字。
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify({ name: 'fake-tool-plus', version: '9.9.9' }, null, 2)}\n`,
  )
  for (const id of ids) {
    const dir = path.join(packageRoot, 'presets', id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, COMPOSITION_FILE_NAME), `${COMPOSITION}# ${id}\n`)
    fs.writeFileSync(path.join(dir, METADATA_FILE_NAME), `name: ${id}\n${METADATA}`)
  }
  return { packageRoot, homeDir }
}

afterEach(() => {
  while (temps.length > 0) fs.rmSync(temps.pop() as string, { recursive: true, force: true })
})

describe('ensureDefaultPresets', () => {
  it('用户根目录不存在 → 整份写入两个默认预设（两文件逐字节等于模板）', () => {
    const deps = fixturePackage()

    const result = ensureDefaultPresets(deps)

    expect(result.created).toEqual([...DEFAULT_PRESET_IDS])
    expect(result.failed).toEqual([])
    for (const id of DEFAULT_PRESET_IDS) {
      const dir = userPresetDir(id, deps)
      expect(fs.readFileSync(path.join(dir, COMPOSITION_FILE_NAME), 'utf8')).toBe(`${COMPOSITION}# ${id}\n`)
      expect(fs.readFileSync(path.join(dir, METADATA_FILE_NAME), 'utf8')).toBe(`name: ${id}\n${METADATA}`)
    }
  })

  it('用户根目录已存在 → 一个字节都不碰（created 为空、mtime 不变、多余文件保留）', () => {
    const deps = fixturePackage()
    const id = DEFAULT_PRESET_IDS[0]
    const dir = userPresetDir(id, deps)
    fs.mkdirSync(dir, { recursive: true })
    const composition = path.join(dir, COMPOSITION_FILE_NAME)
    fs.writeFileSync(composition, '# 用户自己的版本\n- id: persona\n  name: x\n')
    fs.writeFileSync(path.join(dir, 'user-note.txt'), 'keep me\n')
    const oldTime = new Date('2020-01-02T03:04:05Z')
    fs.utimesSync(composition, oldTime, oldTime)
    const before = fs.readFileSync(composition, 'utf8')
    // 第二个默认预设也存在（否则它会被补缺，不是本用例要断言的情形）。
    fs.mkdirSync(userPresetDir(DEFAULT_PRESET_IDS[1], deps), { recursive: true })

    const result = ensureDefaultPresets(deps)

    expect(result.created).toEqual([])
    expect(result.failed).toEqual([])
    expect(fs.readFileSync(composition, 'utf8')).toBe(before)
    expect(fs.statSync(composition).mtimeMs).toBe(oldTime.getTime())
    expect(fs.readFileSync(path.join(dir, 'user-note.txt'), 'utf8')).toBe('keep me\n')
    expect(fs.existsSync(path.join(userPresetDir(DEFAULT_PRESET_IDS[1], deps), COMPOSITION_FILE_NAME))).toBe(false)
  })

  it('目录存在但缺 preset.yml → 不补（缺文件只在设置页状态里显示）', () => {
    const deps = fixturePackage()
    // 两个默认预设目录都已存在，其中一个只有组合文件。
    fs.mkdirSync(userPresetDir(DEFAULT_PRESET_IDS[0], deps), { recursive: true })
    const id = DEFAULT_PRESET_IDS[1]
    const dir = userPresetDir(id, deps)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, COMPOSITION_FILE_NAME), '# partial\n')

    const result = ensureDefaultPresets(deps)

    expect(result.created).toEqual([])
    expect(result.failed).toEqual([])
    expect(fs.existsSync(path.join(dir, METADATA_FILE_NAME))).toBe(false)
  })

  it('模板缺失 → 收进 failed，永不抛，另一个预设照常创建', () => {
    const deps = fixturePackage([DEFAULT_PRESET_IDS[0]])

    const result = ensureDefaultPresets(deps)

    expect(result.created).toEqual([DEFAULT_PRESET_IDS[0]])
    expect(result.failed.map((entry) => entry.id)).toEqual([DEFAULT_PRESET_IDS[1]])
    expect(result.failed[0].reason.length).toBeGreaterThan(0)
    expect(fs.existsSync(userPresetRoot(deps))).toBe(true)
  })
})

/** 造一个"已安装但被本地改过"的预设：用户根目录 + 给定组合内容。 */
function seedInstalled(deps: { packageRoot: string; homeDir: string }, id: string, composition: string): string {
  const dir = userPresetDir(id, deps)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, COMPOSITION_FILE_NAME)
  fs.writeFileSync(file, composition)
  return file
}

/** 一份"官方行还挂着"的用户本地组合（升级要改的就是它）。 */
const DIRTY = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    thresholdRatio: 0.4

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'

- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: false
`

/** DIRTY 的升级结果（tool-bash 补禁用键，tool-pwsh 翻转）。 */
const DIRTY_FIXED = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    thresholdRatio: 0.4

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: true

- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: true
`

/** 本插件版本（假包根 package.json 里写死的 9.9.9）。 */
const VERSION = '9.9.9'

describe('applyPresetAction(upgrade)', () => {
  it('只改冲突行：先备份改写前内容（bak-<插件版本>），再原子写回', () => {
    const deps = fixturePackage()
    const id = DEFAULT_PRESET_IDS[0]
    const file = seedInstalled(deps, id, DIRTY)

    const result = applyPresetAction(id, 'upgrade', deps)

    expect(result.ok).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.changes).toEqual([
      { id: 'tool-bash', action: 'disabled' },
      { id: 'tool-pwsh', action: 'flipped' },
    ])
    expect(result.backupPath).toBe(`${file}.bak-${VERSION}`)
    expect(fs.readFileSync(`${file}.bak-${VERSION}`, 'utf8')).toBe(DIRTY)
    expect(fs.readFileSync(file, 'utf8')).toBe(DIRTY_FIXED)
    // 原子写的临时文件不能留在目录里。
    expect(fs.readdirSync(userPresetDir(id, deps)).filter((name) => name.includes('.tmp'))).toEqual([])
  })

  it('内容无变化 → 不写盘、不产生备份、mtime 不变', () => {
    const deps = fixturePackage()
    const id = DEFAULT_PRESET_IDS[0]
    const file = seedInstalled(deps, id, DIRTY_FIXED)
    const oldTime = new Date('2021-05-06T07:08:09Z')
    fs.utimesSync(file, oldTime, oldTime)

    const result = applyPresetAction(id, 'upgrade', deps)

    expect(result.ok).toBe(true)
    expect(result.changed).toBe(false)
    expect(result.backupPath).toBeUndefined()
    expect(result.changes).toEqual([])
    expect(fs.statSync(file).mtimeMs).toBe(oldTime.getTime())
    expect(fs.existsSync(`${file}.bak-${VERSION}`)).toBe(false)
  })

  it('同名备份已存在 → 不覆盖（保留用户手上那份改写前快照）', () => {
    const deps = fixturePackage()
    const id = DEFAULT_PRESET_IDS[0]
    const file = seedInstalled(deps, id, DIRTY)
    fs.writeFileSync(`${file}.bak-${VERSION}`, 'PRE-EXISTING\n')

    const result = applyPresetAction(id, 'upgrade', deps)

    expect(result.changed).toBe(true)
    expect(result.backupPath).toBe(`${file}.bak-${VERSION}`)
    expect(fs.readFileSync(`${file}.bak-${VERSION}`, 'utf8')).toBe('PRE-EXISTING\n')
  })

  it('形状无法识别 → ok=false 且一个字节都不写（不备份）', () => {
    const deps = fixturePackage()
    const id = DEFAULT_PRESET_IDS[1]
    const broken = 'foo: bar\n'
    const file = seedInstalled(deps, id, broken)
    const oldTime = new Date('2022-01-01T00:00:00Z')
    fs.utimesSync(file, oldTime, oldTime)

    const result = applyPresetAction(id, 'upgrade', deps)

    expect(result.ok).toBe(false)
    expect(result.changed).toBe(false)
    expect(result.reason).toContain('unrecognized')
    expect(fs.readFileSync(file, 'utf8')).toBe(broken)
    expect(fs.statSync(file).mtimeMs).toBe(oldTime.getTime())
    expect(fs.existsSync(`${file}.bak-${VERSION}`)).toBe(false)
  })

  it('预设未安装（组合文件不存在）→ ok=false 带原因，不抛', () => {
    const deps = fixturePackage()

    const result = applyPresetAction(DEFAULT_PRESET_IDS[0], 'upgrade', deps)

    expect(result.ok).toBe(false)
    expect(result.changed).toBe(false)
    expect(result.reason && result.reason.length > 0).toBe(true)
    expect(result.changes).toEqual([])
  })
})

describe('applyPresetAction(reset)', () => {
  it('整份对齐模板（含 preset.yml）：先备份改写前内容，再跑一次不写盘', () => {
    const deps = fixturePackage()
    const id = DEFAULT_PRESET_IDS[0]
    const file = seedInstalled(deps, id, DIRTY)
    fs.writeFileSync(path.join(userPresetDir(id, deps), METADATA_FILE_NAME), 'name: 用户改过的名字\n')

    const first = applyPresetAction(id, 'reset', deps)

    expect(first.ok).toBe(true)
    expect(first.changed).toBe(true)
    expect(first.changes).toEqual([])
    expect(first.backupPath).toBe(`${file}.bak-${VERSION}`)
    expect(fs.readFileSync(`${file}.bak-${VERSION}`, 'utf8')).toBe(DIRTY)
    expect(fs.readFileSync(file, 'utf8')).toBe(
      fs.readFileSync(path.join(templateDir(id, deps), COMPOSITION_FILE_NAME), 'utf8'),
    )
    expect(fs.readFileSync(path.join(userPresetDir(id, deps), METADATA_FILE_NAME), 'utf8')).toBe(
      fs.readFileSync(path.join(templateDir(id, deps), METADATA_FILE_NAME), 'utf8'),
    )

    const oldTime = new Date('2023-03-04T05:06:07Z')
    fs.utimesSync(file, oldTime, oldTime)
    const second = applyPresetAction(id, 'reset', deps)

    expect(second.ok).toBe(true)
    expect(second.changed).toBe(false)
    expect(fs.statSync(file).mtimeMs).toBe(oldTime.getTime())
  })

  it('未安装 → 建立目录并整份写入模板（无备份）', () => {
    const deps = fixturePackage()
    const id = DEFAULT_PRESET_IDS[1]

    const result = applyPresetAction(id, 'reset', deps)

    expect(result.ok).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.backupPath).toBeUndefined()
    expect(fs.readFileSync(path.join(userPresetDir(id, deps), COMPOSITION_FILE_NAME), 'utf8')).toBe(
      `${COMPOSITION}# ${id}\n`,
    )
  })

  it('模板缺失 → ok=false 带原因，不抛', () => {
    const deps = fixturePackage([DEFAULT_PRESET_IDS[0]])

    const result = applyPresetAction(DEFAULT_PRESET_IDS[1], 'reset', deps)

    expect(result.ok).toBe(false)
    expect(result.reason && result.reason.length > 0).toBe(true)
  })

  it('templateId 指定模板 → 对齐到**那份**模板，不是同名模板', () => {
    // 用户语义（2026-09-19）：重置 = 把所选预设对齐到所选的模板，允许跨 id。
    const deps = fixturePackage()
    const target = DEFAULT_PRESET_IDS[0]
    const source = DEFAULT_PRESET_IDS[1]
    const file = seedInstalled(deps, target, DIRTY)

    const result = applyPresetAction(target, 'reset', deps, source)

    expect(result.ok).toBe(true)
    expect(result.changed).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe(
      fs.readFileSync(path.join(templateDir(source, deps), COMPOSITION_FILE_NAME), 'utf8'),
    )
    // 同名模板的正文与所选模板不同，才能证明用的确实是 templateId 指定的那份。
    expect(fs.readFileSync(file, 'utf8')).not.toBe(
      fs.readFileSync(path.join(templateDir(target, deps), COMPOSITION_FILE_NAME), 'utf8'),
    )
    // 预设目录的 id 不变（对齐的是内容，不是改名）。
    expect(fs.existsSync(path.join(userPresetDir(target, deps), METADATA_FILE_NAME))).toBe(true)
  })

  it('templateId 指向不存在的模板 → ok=false 带原因，且不写盘', () => {
    const deps = fixturePackage()
    const id = DEFAULT_PRESET_IDS[0]
    const file = seedInstalled(deps, id, DIRTY)

    const result = applyPresetAction(id, 'reset', deps, 'no-such-template')

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('template is missing')
    expect(fs.readFileSync(file, 'utf8')).toBe(DIRTY)
  })
})

describe('listPresetStatuses', () => {
  it('我们随包的两份：source=ours，本地与模板不同 → templateDiffers，冲突行列得出', () => {
    const deps = fixturePackage()
    const file = seedInstalled(deps, DEFAULT_PRESET_IDS[0], DIRTY)

    const [status] = listPresetStatuses(
      [{ id: DEFAULT_PRESET_IDS[0], trust: 'user', path: file, name: 'Tool Plus 标准增强版' }],
      deps,
    )

    expect(status).toMatchObject({
      id: DEFAULT_PRESET_IDS[0],
      name: 'Tool Plus 标准增强版',
      source: 'ours',
      installed: true,
      templatePresent: true,
      templateDiffers: true,
      conflicts: ['tool-bash', 'tool-pwsh'],
      clean: false,
      unrecognized: false,
    })
    expect(status.path).toBe(file)
  })

  it('本地与模板逐字节一致 → templateDiffers=false 且 clean=true', () => {
    const deps = fixturePackage()
    const id = DEFAULT_PRESET_IDS[0]
    const templateFile = path.join(templateDir(id, deps), COMPOSITION_FILE_NAME)
    // 把模板换成一份干净组合：本用例只关心"本地 == 模板"，不掺入冲突行。
    const cleanTemplate = '- id: persona\n  name: x\n'
    fs.writeFileSync(templateFile, cleanTemplate)
    const file = seedInstalled(deps, id, cleanTemplate)

    const [status] = listPresetStatuses([{ id, trust: 'user', path: file }], deps)

    expect(status.templateDiffers).toBe(false)
    expect(status.clean).toBe(true)
    expect(status.conflicts).toEqual([])
  })

  it('官方随附（trust=system）→ shipped、不在用户根、无模板、冲突照实报', () => {
    const deps = fixturePackage()
    const systemFile = path.join(tempDir('shipped'), COMPOSITION_FILE_NAME)
    fs.writeFileSync(systemFile, DIRTY)

    const [status] = listPresetStatuses([{ id: 'standard', trust: 'system', path: systemFile }], deps)

    expect(status).toMatchObject({
      id: 'standard',
      source: 'shipped',
      installed: false,
      templatePresent: false,
      templateDiffers: false,
      conflicts: ['tool-bash', 'tool-pwsh'],
      clean: false,
      unrecognized: false,
    })
  })

  it('用户自建预设（trust=user）→ source=user，不报模板差异', () => {
    const deps = fixturePackage()
    const file = path.join(tempDir('mine'), COMPOSITION_FILE_NAME)
    fs.writeFileSync(file, '- id: persona\n  name: x\n')

    const [status] = listPresetStatuses(
      [{ id: 'my-preset', trust: 'user', path: file, description: '自建' }],
      deps,
    )

    expect(status).toMatchObject({
      id: 'my-preset',
      source: 'user',
      installed: false,
      templatePresent: false,
      templateDiffers: false,
      clean: true,
      unrecognized: false,
      description: '自建',
    })
  })

  it('组合文件不存在（未安装）→ 不算 unrecognized，installed=false，broken 原样带出', () => {
    const deps = fixturePackage()
    const missing = path.join(tempDir('gone'), COMPOSITION_FILE_NAME)

    const [status] = listPresetStatuses(
      [{ id: 'broken-one', trust: 'user', path: missing, broken: 'composition file is unreadable' }],
      deps,
    )

    // 不存在是存在性问题，不是内容问题：设置页据此走「未安装 / 未应用」而不是
    // 「无法识别」。
    expect(status.unrecognized).toBe(false)
    expect(status.clean).toBe(false)
    expect(status.conflicts).toEqual([])
    expect(status.installed).toBe(false)
    expect(status.broken).toBe('composition file is unreadable')
  })

  it('我们随包的两份未安装（roster 行 path 指向不存在的用户根文件）→ 状态位可显示「未安装」', () => {
    const deps = fixturePackage()
    const file = path.join(userPresetDir(DEFAULT_PRESET_IDS[0], deps), COMPOSITION_FILE_NAME)

    const [status] = listPresetStatuses([{ id: DEFAULT_PRESET_IDS[0], trust: 'user', path: file }], deps)

    expect(status.source).toBe('ours')
    expect(status.installed).toBe(false)
    // 不拦 unrecognized：UI 的「未安装」判定在 unrecognized 之后。
    expect(status.unrecognized).toBe(false)
    expect(status.templatePresent).toBe(true)
    expect(status.templateDiffers).toBe(false)
  })

  it('组合文件可读但不成顶层行列表 → unrecognized=true、clean=false', () => {
    const deps = fixturePackage()
    const file = path.join(tempDir('junk'), COMPOSITION_FILE_NAME)
    fs.writeFileSync(file, 'foo: bar\n')

    const [status] = listPresetStatuses([{ id: 'junk', trust: 'user', path: file }], deps)

    expect(status.unrecognized).toBe(true)
    expect(status.clean).toBe(false)
    expect(status.conflicts).toEqual([])
  })
})
