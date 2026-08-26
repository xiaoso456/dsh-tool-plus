/**
 * Windows 路径语义修正（适配层，非 verbatim）。
 *
 * OMP 的 `probeLiteralPathExists` 用 `lstat` 判定"字面路径是否存在"，用于
 * `splitPathAndSelPreferringLiteral` 的"字面优先于选择器"决策。Windows 上
 * NTFS 把 `file:stream` 当作数据流（ADS）路径：`lstat('file:conflicts')`
 * 可能落到基文件而成功，但该数据流实际不存在（`open` 失败）——probe 误判
 * "exists"，导致 `path:conflicts` 等选择器不被拆分、整串当字面路径打开报
 * ENOENT（T11-1）。
 *
 * 修正：lstat 成功后，对含冒号的 Windows 路径再 `open` 验证——open 失败
 * 按 "missing" 处理，让选择器拆分生效。POSIX 与普通 Windows 路径零开销。
 *
 * read.ts / grep.ts 的 `probeLiteralPathExists` / `splitPathAndSelPreferringLiteral`
 * import 指向本模块（import 路径调整，verbatim 引擎代码不动）。
 */
import * as fs from 'node:fs/promises'
import { hasFsCode, isEnoent, isEnotdir } from '@oh-my-pi/pi-utils'
import { resolveReadPath, splitPathAndSel } from './omp/tools/path-utils.ts'

export type ProbeResult = 'exists' | 'missing' | 'unknown'

/**
 * probe 判定纯函数（供单测直接覆盖修正分支）。
 *
 * @param lstatOk lstat 是否成功
 * @param openOk  open 验证是否成功（仅 needsOpenVerify 时有意义）
 * @param needsOpenVerify 是否需要对含冒号的 Windows 路径做 open 验证
 */
export function resolveProbeResult(
  lstatOk: boolean,
  openOk: boolean,
  needsOpenVerify: boolean,
): ProbeResult {
  if (!lstatOk) return 'missing'
  if (needsOpenVerify && !openOk) return 'missing'
  return 'exists'
}

/** Windows NTFS ADS 感知的 probe：lstat 成功但 open 失败 → "missing"。 */
export async function probeLiteralPathExists(filePath: string, cwd: string): Promise<ProbeResult> {
  const resolved = resolveReadPath(filePath, cwd)
  let lstatOk = false
  try {
    await fs.lstat(resolved)
    lstatOk = true
  } catch (err) {
    if (isEnoent(err) || isEnotdir(err) || hasFsCode(err, 'ENAMETOOLONG')) return 'missing'
    return 'unknown'
  }
  const needsOpenVerify = process.platform === 'win32' && resolved.includes(':')
  if (!needsOpenVerify) return resolveProbeResult(true, true, false)
  try {
    const handle = await fs.open(resolved, 'r')
    await handle.close()
    return resolveProbeResult(true, true, true)
  } catch (err) {
    if (isEnoent(err) || isEnotdir(err)) return resolveProbeResult(true, false, true)
    return 'unknown'
  }
}

/** 字面优先于选择器拆分（修正版 probe）。 */
export async function splitPathAndSelPreferringLiteral(
  rawPath: string,
  cwd: string,
): Promise<{ path: string; sel?: string }> {
  const strict = splitPathAndSel(rawPath)
  if (strict.sel === undefined) return strict
  const probe = await probeLiteralPathExists(rawPath, cwd)
  return probe === 'missing' ? strict : { path: rawPath }
}
