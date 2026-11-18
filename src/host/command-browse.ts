/**
 * Directory listing behind the 「路径」 picker.
 *
 * The picker only needs names, sizes and a folder flag, so this module answers
 * exactly that and nothing else: it never opens a file, never follows a path
 * the caller did not ask for, and refuses to recurse (one request, one level).
 * @module @xiaoso/dsh-tool-plus/host/command-browse
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type {
  CommandBrowseEntry,
  CommandBrowsePayload,
  CommandBrowseValue,
} from '../tools/shared/browser-rpc-channel.ts'

/**
 * Extensions the picker shows while 「全部文件」 is off.
 *
 * Only what this field actually spawns on Windows: a bare `.js` or `.py` is
 * not executable by itself, so showing it would be noise in every source
 * folder. The authoritative check stays in the apply path (`statSync` + isFile).
 */
const EXECUTABLE_EXTENSIONS = new Set(['.exe', '.cmd', '.bat', '.com'])

/**
 * Rows per reply. A folder with 20k files would otherwise ship megabytes over
 * the RPC channel for a list nobody scrolls; `truncated` tells the UI to say so.
 */
export const MAX_BROWSE_ENTRIES = 400

/** Host paths in forward slashes: the panel speaks `D:/tools/zip.exe` everywhere. */
function toSlash(value: string): string {
  return value.replace(/\\/g, '/')
}

/** Readable reason instead of a bare errno, because the dialog shows it verbatim. */
function describe(error: unknown, dir: string): string {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ENOENT') return '目录不存在：' + dir
  if (code === 'ENOTDIR') return '不是目录：' + dir
  if (code === 'EACCES' || code === 'EPERM') return '没有权限读取：' + dir
  const message = error instanceof Error ? error.message : String(error)
  return '读取失败：' + dir + '（' + message + '）'
}

/** Directory entry → row without touching the disk beyond the dirent itself. */
function classify(owner: string, dirent: fs.Dirent, showAll: boolean): CommandBrowseEntry | undefined {
  if (dirent.name.startsWith('.')) return undefined
  const full = path.join(owner, dirent.name)
  if (dirent.isDirectory()) {
    return { name: dirent.name, path: toSlash(full), kind: 'dir', size: null }
  }
  if (dirent.isSymbolicLink()) {
    // Windows junctions and symlinked folders read as links; resolve so the
    // picker can descend into them like a real folder.
    try {
      const stat = fs.statSync(full)
      return { name: dirent.name, path: toSlash(full), kind: stat.isDirectory() ? 'dir' : 'file', size: stat.isFile() ? stat.size : null }
    } catch {
      // Broken link: keep it as a file row with an unknown size.
      return { name: dirent.name, path: toSlash(full), kind: 'file', size: null }
    }
  }
  if (!showAll && !EXECUTABLE_EXTENSIONS.has(path.extname(dirent.name).toLowerCase())) return undefined
  return { name: dirent.name, path: toSlash(full), kind: 'file', size: null }
}

/**
 * Fill in sizes **after** sorting and truncation: a directory with 20k files
 * used to cost 20k `statSync` calls even though at most `cap` rows ever leave.
 */
function withSize(entry: CommandBrowseEntry): CommandBrowseEntry {
  if (entry.kind === 'dir' || entry.size !== null) return entry
  try {
    return { ...entry, size: fs.statSync(entry.path).size }
  } catch {
    return entry
  }
}

/**
 * List one directory.
 *
 * @param payload.dir - start directory; absent → the user's home directory.
 * @param payload.showAll - include non-executable files.
 * @param cap - row cap, injectable so tests do not need to create 400 files.
 * @throws Error with a readable message the dialog can show as-is.
 */
export function browseDirectory(
  payload: CommandBrowsePayload | undefined,
  cap: number = MAX_BROWSE_ENTRIES,
): CommandBrowseValue {
  const requested = payload?.dir?.trim()
  const showAll = payload?.showAll === true
  const dir = path.resolve(requested !== undefined && requested.length > 0 ? requested : os.homedir())
  let dirents: fs.Dirent[]
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    throw new Error(describe(error, toSlash(dir)))
  }

  const rows: CommandBrowseEntry[] = []
  for (const dirent of dirents) {
    let entry: CommandBrowseEntry | undefined
    try {
      entry = classify(dir, dirent, showAll)
    } catch {
      // One unreadable child must not blank the whole directory.
      entry = { name: dirent.name, path: toSlash(path.join(dir, dirent.name)), kind: 'file', size: null }
    }
    if (entry !== undefined) rows.push(entry)
  }
  rows.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'dir' ? -1 : 1
    return left.name.toLowerCase() < right.name.toLowerCase() ? -1 : left.name.toLowerCase() > right.name.toLowerCase() ? 1 : 0
  })

  const kept = rows.slice(0, cap).map(withSize)
  const parentRaw = path.dirname(dir)
  return {
    dir: toSlash(dir),
    parent: parentRaw === dir ? null : toSlash(parentRaw),
    entries: kept,
    truncated: rows.length > cap,
  }
}
