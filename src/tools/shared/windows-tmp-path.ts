/**
 * Windows /tmp alias translation (adapter layer, not verbatim).
 *
 * A bare /tmp under Win32 is drive-relative (<cwd-drive>:\tmp), not a
 * scratch root. The shell already maps it onto the Windows temp directory
 * (brush-core translate_unix_tmp_path), but the TS tool layer used to
 * resolve it as the current drive's \tmp, so write /tmp/x and read /tmp/x
 * could disagree with bash's /tmp/x. This module makes the tool layer follow
 * the same rule.
 *
 * Scope is intentionally narrow: only a single leading slash followed by the
 * literal, lowercase tmp root. Native C:\tmp, C:/tmp, current-drive \tmp,
 * UNC //server/share/tmp, /tmpfoo and /TMP are untouched. "."/".." are folded
 * against the logical POSIX path before the check, so /tmp/../tmp/x maps to
 * <temp>\x while /tmp/.. does not map.
 */
import * as os from 'node:os'
import * as path from 'node:path'

export interface WindowsUnixTmpPathOptions {
  /** Override for tests; production uses process.platform. */
  platform?: NodeJS.Platform
  /** Override for tests; production resolves the host temp directory. */
  tempDir?: string
}

/**
 * Resolve the Windows temp directory the same way Rust's env::temp_dir()
 * does on Windows: TMP first, then TEMP, then the OS default. The order
 * matters because the shell's /tmp uses it; using TEMP first would split the
 * two when the variables disagree.
 *
 * The result is a concrete absolute path. Node's fs does not expand
 * %TMP%/%TEMP% literals, so a non-absolute value is skipped.
 */
export function resolveWindowsTempDir(env: NodeJS.ProcessEnv = process.env): string {
  const tmp = env.TMP?.trim()
  if (tmp !== undefined && tmp.length > 0 && path.win32.isAbsolute(tmp)) {
    return path.win32.normalize(tmp)
  }
  const temp = env.TEMP?.trim()
  if (temp !== undefined && temp.length > 0 && path.win32.isAbsolute(temp)) {
    return path.win32.normalize(temp)
  }
  return path.win32.normalize(os.tmpdir())
}

/**
 * Map the logical POSIX /tmp tree onto the Windows temp directory.
 * Returns filePath unchanged when the platform is not Windows or the path is
 * outside the /tmp root.
 */
export function normalizeWindowsUnixTmpPath(
  filePath: string,
  options: WindowsUnixTmpPathOptions = {},
): string {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return filePath
  // Only a single leading slash: //... is UNC or a doubled root, and the
  // Rust implementation leaves it alone too.
  if (!filePath.startsWith('/') || filePath.startsWith('//')) return filePath

  const logical: string[] = []
  for (const part of filePath.slice(1).split(/[\\/]+/)) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      logical.pop()
      continue
    }
    logical.push(part)
  }
  if (logical[0] !== 'tmp') return filePath

  const tempDir = options.tempDir ?? resolveWindowsTempDir()
  const tail = logical.slice(1)
  return tail.length === 0 ? tempDir : path.win32.join(tempDir, ...tail)
}
