/**
 * preset 安装路径解析：`<dshHome>`、用户根预设目录、包内模板目录。
 *
 * 三处路径各有唯一来源：
 * - `<dshHome>`：`PresetDeps.homeDir`（测试注入）→ `$DSH_HOME`（trim 后非空）
 *   → `~/.dsh`。规则与官方 `@deepseek-ai/dsh-home-paths` 的
 *   `defaultDshHome()` / `DSH_HOME_ENV`（`'DSH_HOME'`）/ 目录名 `.dsh`
 *   完全一致；这里就地实现而不 import 该包——它在插件安装树里解析不到，
 *   静态 import 一个解析不到的模块会让整个插件加载失败。
 * - 用户根：`<dshHome>/.agent-presets`（与 `dsh-agent-presets` 的
 *   `USER_PRESET_DIR` 同值，所有 profile 共享）。
 * - 模板：插件包内 `presets/<id>/`，用 `import.meta.url` 相对解析（与
 *   `rmSafeCliPath()` 同一手法，见 src/tools/bash/rm-safe.ts）。构建后入口
 *   是单文件 `lib/index.mjs`，源码期是 `src/presets/paths.ts`，两者到包根的
 *   相对深度不同，所以向上探两个候选、取同时含 `package.json` 与 `presets/`
 *   的那个。
 * @module @xiaoso/dsh-tool-plus/presets/paths
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUNDLED_PRESET_IDS } from '../tools/shared/browser-rpc-channel.ts'

/** 用户根预设目录名（`dsh-agent-presets` 的 `USER_PRESET_DIR` 同值）。 */
export const PRESET_DIR_NAME = '.agent-presets'

/** 让一个目录成为 preset 的组合文件名。 */
export const COMPOSITION_FILE_NAME = 'agent.cordis.yml'

/** 组合文件旁的可选展示元数据文件名。 */
export const METADATA_FILE_NAME = 'preset.yml'

/**
 * 本插件随包的两个预设 id（启动补缺只认它们）。名单的单一来源是共享契约
 * 模块 {@link BUNDLED_PRESET_IDS}，这里只做本模块语义下的别名。
 */
export const DEFAULT_PRESET_IDS: readonly string[] = BUNDLED_PRESET_IDS

/** 覆盖 `DSH_HOME` 的环境变量名（与官方 `DSH_HOME_ENV` 同值）。 */
const DSH_HOME_ENV = 'DSH_HOME'

/** 默认 harness home 的目录名（与官方 `DSH_HOME_DIR_NAME` 同值）。 */
const DSH_HOME_DIR_NAME = '.dsh'

/**
 * 路径解析的注入点：宿主半的每个公开函数都收它，fs 层测试据此把
 * `<dshHome>` 与包根指到临时目录，避免任何写死路径。
 */
export interface PresetDeps {
  /** 覆盖 `<dshHome>`；缺省走 `$DSH_HOME` → `~/.dsh`。 */
  homeDir?: string
  /** 覆盖插件包根（模板目录的父目录）；缺省按 `import.meta.url` 向上探。 */
  packageRoot?: string
}

/**
 * 解析 `<dshHome>`。优先级：注入的 `homeDir` → `$DSH_HOME`（trim 后非空）
 * → `~/.dsh`，与官方 `@deepseek-ai/dsh-home-paths` 的 `defaultDshHome()` 同规则。
 * @param deps - 可选的注入覆盖。
 * @returns 绝对路径的 harness home。
 */
export function dshHomeDir(deps: PresetDeps = {}): string {
  if (deps.homeDir !== undefined && deps.homeDir.trim().length > 0) return path.resolve(deps.homeDir)
  const env = process.env[DSH_HOME_ENV]
  return env !== undefined && env.trim().length > 0
    ? path.resolve(env)
    : path.join(os.homedir(), DSH_HOME_DIR_NAME)
}

/** 用户根预设目录：`<dshHome>/.agent-presets`（所有 profile 共享的写入根）。 */
export function userPresetRoot(deps: PresetDeps = {}): string {
  return path.join(dshHomeDir(deps), PRESET_DIR_NAME)
}

/** 某个预设的用户根目录：`<dshHome>/.agent-presets/<id>`。 */
export function userPresetDir(id: string, deps: PresetDeps = {}): string {
  return path.join(userPresetRoot(deps), id)
}

/**
 * 插件包根：注入的 `packageRoot` 优先，否则按 `import.meta.url` 向上探。
 * 构建后入口是 `lib/index.mjs`（`..` 即包根），源码期是
 * `src/presets/paths.ts`（`../..` 即包根），两个候选都试、取同时含
 * `package.json` 与 `presets/` 的那个；都不命中时返回 `../..` 候选。
 */
export function packageRootDir(deps: PresetDeps = {}): string {
  if (deps.packageRoot !== undefined && deps.packageRoot.trim().length > 0) {
    return path.resolve(deps.packageRoot)
  }
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [path.resolve(here, '..', '..'), path.resolve(here, '..')]
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'package.json')) && fs.existsSync(path.join(candidate, 'presets'))) {
      return candidate
    }
  }
  return candidates[0]
}

/** 包内模板目录：`<包根>/presets/<id>`。 */
export function templateDir(id: string, deps: PresetDeps = {}): string {
  return path.join(packageRootDir(deps), 'presets', id)
}
