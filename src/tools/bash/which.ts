/**
 * Minimal PATH (+ PATHEXT on Windows) executable lookup, standing in for
 * `Bun.which` / pi-utils `$which` on the Node runtime.
 *
 * Why this exists: pi-utils' `$which` calls `Bun.which` at module top level
 * (node_modules @oh-my-pi/pi-utils src/which.ts:196), which the bun-shim does
 * not provide — so DSH code that must resolve executables the way OMP does
 * (procmgr `resolveWindowsShell` for shell discovery, `REJECT_PROMPT_COMMAND`
 * in non-interactive-env) uses this scanner instead. Single implementation —
 * any new caller resolves executables through here, never hand-rolls a PATH
 * walk.
 * @module @xiaoso/dsh-tool-plus/bash/which
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

/** Windows default extension order when PATHEXT is unset. */
const WIN32_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/** True when `command` carries its own directory component. */
function hasPathSeparator(command: string): boolean {
  return command.includes('/') || command.includes('\\')
}

/**
 * Resolve `command` against PATH the way `Bun.which` would: absolute/relative
 * candidates are returned as-is when they name an existing file; bare names
 * are looked up in each PATH dir (appending PATHEXT extensions on win32, in
 * order). Returns the first existing regular file, or `undefined`.
 */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (command.length === 0) return undefined

  if (hasPathSeparator(command)) {
    try {
      return fs.statSync(command).isFile() ? path.resolve(command) : undefined
    } catch {
      return undefined
    }
  }

  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT && env.PATHEXT.length > 0 ? env.PATHEXT : WIN32_DEFAULT_PATHEXT).split(';').filter(Boolean)
    : []
  // Try the bare name first so an already-extensioned command ("bash.exe")
  // resolves without waiting for "bash.exe.COM"/"bash.exe.EXE" misses.
  const candidates = process.platform === 'win32'
    ? [command, ...extensions.map(ext => command + ext)]
    : [command]

  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate)
      try {
        if (fs.statSync(full).isFile()) return full
      } catch {
        // keep scanning
      }
    }
  }
  return undefined
}