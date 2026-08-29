/**
 * Windows shell discovery, ported from oh-my-pi procmgr's `resolveWindowsShell`
 * (refs/oh-my-pi/packages/utils/src/procmgr.ts:148-173) — adapted verbatim:
 * `Bun.env` → injectable Node env (default `process.env`), and pi-utils
 * `$which` → `findOnPath` (src/tools/bash/which.ts).
 *
 * Deliberately NOT ported from procmgr: buildSpawnEnv, shell prefix handling,
 * direnv integration, and PI_SHELL_PREFIX — DSH has no shell-prefix seam;
 * commands run inside the embedded brush shell or the resolved user shell.
 * @module @xiaoso/dsh-tool-plus/bash/windows-shell
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { findOnPath } from './which.ts'

/**
 * Resolve the external shell to advertise on Windows.
 *
 * A host bash is OPTIONAL: bash tool commands always execute in the embedded
 * brush-core shell. The resolved binary only serves the spawn-a-shell paths,
 * so this prefers a real Git Bash when one exists and otherwise falls back to
 * cmd.exe — it never fails.
 *
 * Search order:
 * 1. Git for Windows install roots (machine + per-user installers)
 * 2. scoop installs — scoop's git manifest sets GIT_INSTALL_ROOT and shims
 *    sh.exe/git.exe but never bash.exe, so PATH lookup alone misses it
 * 3. bash.exe on PATH (Cygwin, MSYS2, ...)
 * 4. sh.exe on PATH (Git for Windows' sh.exe is bash; prefer a sibling
 *    bash.exe when present)
 * 5. cmd.exe from ComSpec
 *
 * Exported for tests; `env` overrides process.env-based discovery.
 */
export function resolveWindowsShell(env: NodeJS.ProcessEnv = process.env): string {
  const gitRoots = [
    env.ProgramFiles && path.join(env.ProgramFiles, 'Git'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Git'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Git'),
    env.GIT_INSTALL_ROOT,
    env.SCOOP && path.join(env.SCOOP, 'apps', 'git', 'current'),
    env.USERPROFILE && path.join(env.USERPROFILE, 'scoop', 'apps', 'git', 'current'),
  ]
  for (const root of gitRoots) {
    if (!root) continue
    const candidate = path.join(root, 'bin', 'bash.exe')
    if (fs.existsSync(candidate)) return candidate
  }

  const bashOnPath = findOnPath('bash.exe', env)
  if (bashOnPath) return bashOnPath

  const shOnPath = findOnPath('sh.exe', env)
  if (shOnPath) {
    const siblingBash = path.join(path.dirname(shOnPath), 'bash.exe')
    return fs.existsSync(siblingBash) ? siblingBash : shOnPath
  }

  return env.ComSpec || env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe'
}