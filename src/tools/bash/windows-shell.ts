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

import { spawnSync } from 'node:child_process'
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
  // Windows ships a WSL relay stub at System32\\bash.exe (and a WindowsApps
  // shim). It is on PATH before any portable Git install and fails with
  // `execvpe(/bin/bash)` when no WSL distro is installed — never treat it as
  // the host shell (issue #5).
  if (bashOnPath && !isWslBashStub(bashOnPath)) return bashOnPath

  const shOnPath = findOnPath('sh.exe', env)
  if (shOnPath) {
    const siblingBash = path.join(path.dirname(shOnPath), 'bash.exe')
    if (fs.existsSync(siblingBash) && !isWslBashStub(siblingBash)) return siblingBash
    return shOnPath
  }

  return env.ComSpec || env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe'
}

/**
 * True for Windows' WSL relay stub and the Microsoft Store shim — both are
 * named `bash.exe` but cannot run POSIX commands (issue #5).
 */
export function isWslBashStub(bashPath: string): boolean {
  const normalized = bashPath.replace(/[\\/]+/g, '/').toLowerCase()
  if (!normalized.endsWith('/bash.exe')) return false
  return normalized.endsWith('/windows/system32/bash.exe') || normalized.includes('/windowsapps/')
}

/** One Git for Windows install, as the directories a shell needs. */
export interface GitBashDirs {
  root: string
  bin: string
  /** `usr/bin` (the MSYS toolset); absent when the install has none. */
  usrBin?: string
}

/** Env-derived Git install candidates, most specific first. */
function candidateGitRoots(env: NodeJS.ProcessEnv): string[] {
  return [
    env.GIT_INSTALL_ROOT,
    env.ProgramFiles && path.join(env.ProgramFiles, 'Git'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Git'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Git'),
    env.SCOOP && path.join(env.SCOOP, 'apps', 'git', 'current'),
    env.USERPROFILE && path.join(env.USERPROFILE, 'scoop', 'apps', 'git', 'current'),
  ].filter((root): root is string => Boolean(root))
}

/** Derive the install root from a `git.exe` path (ported from pi-shell windows.rs). */
export function gitRootFromBinary(gitPath: string): string | undefined {
  const parent = path.dirname(gitPath)
  const parentName = path.basename(parent).toLowerCase()
  if (parentName === 'cmd') return path.dirname(parent)
  if (parentName === 'bin') {
    const grandparent = path.dirname(parent)
    const grandparentName = path.basename(grandparent).toLowerCase()
    if (grandparentName === 'usr' || grandparentName === 'mingw64' || grandparentName === 'mingw32') {
      return path.dirname(grandparent)
    }
    return grandparent
  }
  return path.dirname(parent)
}

/** `where git` on Windows; a portable install has no registry key (issue #5). */
function defaultWhereGit(): string | undefined {
  if (process.platform !== 'win32') return undefined
  try {
    const out = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true, timeout: 2_000 })
    if (out.status !== 0 || !out.stdout) return undefined
    const first = out.stdout.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0)
    return first || undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the directories of a real Git Bash install.
 *
 * Discovery order mirrors pi-shell's `discover_git`: env-derived roots, then
 * `where git` (the only signal a portable install leaves). `whereGit` is
 * injectable so specs pin the derivation without spawning.
 */
export function resolveGitBashDirs(
  env: NodeJS.ProcessEnv = process.env,
  whereGit: (() => string | undefined) | undefined = defaultWhereGit,
): GitBashDirs | undefined {
  const roots = candidateGitRoots(env)
  const fromWhere = whereGit?.()
  if (fromWhere) {
    const root = gitRootFromBinary(fromWhere)
    if (root) roots.push(root)
  }
  for (const root of roots) {
    const bin = path.join(root, 'bin')
    if (!fs.existsSync(path.join(bin, 'bash.exe'))) continue
    const usrBin = path.join(root, 'usr', 'bin')
    return { root, bin, usrBin: fs.existsSync(path.join(usrBin, 'bash.exe')) ? usrBin : undefined }
  }
  return undefined
}
