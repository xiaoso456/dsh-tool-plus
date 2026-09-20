/**
 * preset 安装 fs 层：启动补缺、升级（只改冲突行）、重置（整份覆盖）。
 *
 * 三条纪律：
 * - **启动唯一自动动作**是"目录不存在才整份写入"；目录已存在则一个字节都不碰
 *   （不检查、不补文件、不更新），失败绝不抛出、绝不阻塞启动。
 * - **内容相同就不写盘**：preset 代际以 `agent.cordis.yml` 的 mtime 为键，
 *   白写一次就白造一代 + 白起 watcher。判定一律用"写前先读回比较字节"。
 * - **写盘一律原子**：同目录临时文件 + `rename`；替换前若同名备份不存在，
 *   先落一份 `agent.cordis.yml.bak-<插件版本>`（改写前的内容，同名不覆盖）。
 * @module @xiaoso/dsh-tool-plus/presets/install
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  COMPOSITION_FILE_NAME,
  DEFAULT_PRESET_IDS,
  type PresetDeps,
  packageRootDir,
  templateDir,
  userPresetDir,
} from './paths.ts'
import { type PresetChange, analyzePresetComposition, rewritePresetComposition } from './rewrite.ts'

/** 一次预设动作的结果：`changed: false` 表示一个字节都没写（含幂等与失败）。 */
export interface PresetInstallResult {
  ok: boolean
  changed: boolean
  /** 失败/无变化的原因（给人看的一句话）。 */
  reason?: string
  /** 本次落下的备份文件绝对路径（内容变化且有改写前内容时才有）。 */
  backupPath?: string
  /** 实际改动清单（升级 = 冲突行改动；重置 = 整份覆盖，故为空）。 */
  changes: PresetChange[]
}

/** 包内模板的一份文件（Buffer 保留原始字节，避免任何编码往返）。 */
interface TemplateFile {
  name: string
  content: Buffer
}

/**
 * 读取包内模板目录的全部常规文件（"整份写入"的来源）。
 * 模板目录不存在、或里面没有 `agent.cordis.yml` → 抛错，由调用方收进 reason。
 */
function readTemplateFiles(id: string, deps: PresetDeps): TemplateFile[] {
  const dir = templateDir(id, deps)
  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
  if (!names.includes(COMPOSITION_FILE_NAME)) {
    throw new Error(`preset template is incomplete: ${path.join(dir, COMPOSITION_FILE_NAME)} not found`)
  }
  return names.map((name) => ({ name, content: fs.readFileSync(path.join(dir, name)) }))
}

/** 把异常收成一句人话（启动路径永不抛）。 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 只读文本文件；读不到返回 undefined（不抛）。 */
function readTextFile(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/** 只读原始字节；读不到返回 undefined（不抛）。 */
function readFile(file: string): Buffer | undefined {
  try {
    return fs.readFileSync(file)
  } catch {
    return undefined
  }
}

/**
 * 启动补缺：`<dshHome>/.agent-presets/<id>` 目录不存在时，从包内模板整份写入
 * （`mkdir -p` + 模板目录里的每个文件）。
 *
 * 目录已存在 → 一律不碰（含"目录存在但缺文件"的情形，那种只在设置页状态里
 * 显示）。整个流程每个 id 单独 try/catch，**永不抛**。
 * @param deps - 路径注入（fs 层测试用）。
 * @returns 新建成功的 id 列表与失败原因列表（顺序均为 {@link DEFAULT_PRESET_IDS}）。
 */
export function ensureDefaultPresets(deps: PresetDeps = {}): {
  created: string[]
  failed: Array<{ id: string; reason: string }>
} {
  const created: string[] = []
  const failed: Array<{ id: string; reason: string }> = []
  for (const id of DEFAULT_PRESET_IDS) {
    try {
      const dir = userPresetDir(id, deps)
      if (fs.existsSync(dir)) continue // 已存在 → 不检查、不改写、不更新
      const files = readTemplateFiles(id, deps)
      fs.mkdirSync(dir, { recursive: true })
      for (const file of files) fs.writeFileSync(path.join(dir, file.name), file.content)
      created.push(id)
    } catch (error) {
      failed.push({ id, reason: reasonOf(error) })
    }
  }
  return { created, failed }
}

/** 本插件的版本号（备份名后缀）：读包根 package.json，读不到就退化成 `unknown`。 */
function pluginVersion(deps: PresetDeps): string {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(packageRootDir(deps), 'package.json'), 'utf8')) as {
      version?: unknown
    }
    if (typeof raw.version === 'string' && raw.version.length > 0) return raw.version
  } catch {
    // 包根没有可读 package.json（测试注入的假包根）→ 退化
  }
  return 'unknown'
}

/** 备份路径：与被替换的文件同目录，`<文件>.bak-<插件版本>`。 */
function backupFileFor(file: string, deps: PresetDeps): string {
  return `${file}.bak-${pluginVersion(deps)}`
}

/**
 * 替换前落一份"改写前内容"的备份；同名备份已存在则不覆盖（返回既有路径）。
 * 备份是纯新增文件，不参与写入链的原子性。
 */
function writeBackup(file: string, content: string | Buffer, deps: PresetDeps): string {
  const backup = backupFileFor(file, deps)
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, content)
  return backup
}

/** 同目录临时文件 + `rename` 的原子替换；失败时清掉临时文件再把错抛出去。 */
function writeFileAtomic(file: string, content: string | Buffer): void {
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`,
  )
  fs.writeFileSync(temp, content)
  try {
    fs.renameSync(temp, file)
  } catch (error) {
    try {
      fs.unlinkSync(temp)
    } catch {
      // 临时文件已经不在（或删不掉）：原错误才是要看的那一个。
    }
    throw error
  }
}

/**
 * 升级：只改冲突行（追加 `disabled: true` 或把既有值翻成 `true`）。
 * 形状无法识别 → 不写；内容逐字节相同 → 不写盘、不备份。
 */
function upgrade(id: string, deps: PresetDeps): PresetInstallResult {
  const file = path.join(userPresetDir(id, deps), COMPOSITION_FILE_NAME)
  const original = readTextFile(file)
  if (original === undefined) {
    return { ok: false, changed: false, reason: `preset is not installed: ${file} cannot be read`, changes: [] }
  }
  if (analyzePresetComposition(original).shape === 'unrecognized') {
    return {
      ok: false,
      changed: false,
      reason: `composition shape is unrecognized, nothing was written: ${file}`,
      changes: [],
    }
  }

  const { text, changes } = rewritePresetComposition(original)
  if (text === original) return { ok: true, changed: false, changes: [] } // 幂等：一个字节都不写

  const backupPath = writeBackup(file, original, deps)
  writeFileAtomic(file, text)
  return { ok: true, changed: true, backupPath, changes }
}

/**
 * 重置：用**指定的**模板整份覆盖该预设目录（组合文件 + 元数据等每个模板文件）。
 *
 * 模板来源按用户所选：`templateId` 给了就用它（可以把 A 预设对齐到 B 模板），
 * 没给才退回"同名模板"（历史行为）。内容相同则一个字节都不写；组合文件被改写
 * 前先落备份。`changes` 恒为空：重置不是"逐行改写"，行级摘要不在它的契约里。
 */
function reset(id: string, deps: PresetDeps, templateId?: string): PresetInstallResult {
  const source = templateId ?? id
  const sourceComposition = path.join(templateDir(source, deps), COMPOSITION_FILE_NAME)
  if (!fs.existsSync(sourceComposition)) {
    return { ok: false, changed: false, reason: `template is missing: ${sourceComposition}`, changes: [] }
  }
  const dir = userPresetDir(id, deps)
  const files = readTemplateFiles(source, deps)
  const composition = path.join(dir, COMPOSITION_FILE_NAME)
  let changed = false
  let backupPath: string | undefined

  for (const file of files) {
    const target = path.join(dir, file.name)
    const current = readFile(target)
    if (current !== undefined && current.equals(file.content)) continue
    // 有旧内容且被改的是组合文件 → 先备份改写前内容；新增文件无需备份。
    if (current !== undefined && file.name === COMPOSITION_FILE_NAME) {
      backupPath = writeBackup(target, current, deps)
    }
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    writeFileAtomic(target, file.content)
    changed = true
  }

  return { ok: true, changed, backupPath, changes: [] }
}

/**
 * 用户在设置页对某个预设执行的动作。
 *
 * - `upgrade`：只改官方冲突行（面板上叫「最小更新」）；
 * - `reset`：用**所选模板**整份覆盖该预设（先备份）。模板由 `templateId` 指定，
 *   缺省才是同名模板 —— 面板总是把用户挑的那份模板传进来。
 *
 * 永不抛：任何异常收进 `ok: false` + `reason`。
 * @param id - 预设 id（目录名）。
 * @param action - `upgrade` 或 `reset`。
 * @param deps - 路径注入（fs 层测试用）。
 * @param templateId - `reset` 的模板来源（默认同名模板）。
 * @returns 结果（`changed: false` = 一个字节都没写）。
 */
export function applyPresetAction(
  id: string,
  action: 'upgrade' | 'reset',
  deps: PresetDeps = {},
  templateId?: string,
): PresetInstallResult {
  try {
    return action === 'reset' ? reset(id, deps, templateId) : upgrade(id, deps)
  } catch (error) {
    return { ok: false, changed: false, reason: reasonOf(error), changes: [] }
  }
}
