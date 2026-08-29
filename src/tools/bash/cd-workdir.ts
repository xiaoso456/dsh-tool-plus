/**
 * Leading `cd <path> && …` workdir extraction and `~` expansion for the bash
 * tool.
 *
 * Extraction delegates to `extractLeadingCdTarget` (shell-tokenize.ts, verbatim
 * port of upstream tools/shell-tokenize.ts), so redirect prefixes, extra
 * arguments, command substitution, and unterminated quotes all bail and leave
 * the whole command with the shell. `~`/`~/…` prefixes expand against
 * `os.homedir()` with upstream `expandTilde` semantics
 * (refs packages/coding-agent/src/tools/path-utils.ts).
 * @module @xiaoso/dsh-tool-plus/bash/cd-workdir
 */

import * as os from 'node:os'
import * as path from 'node:path'
import { extractLeadingCdTarget } from './shell-tokenize.ts'

/**
 * Expand a leading `~`/`~/…`/`~\…` prefix to the home directory, matching
 * upstream `expandTilde` (refs tools/path-utils.ts). A bare `~name` is joined
 * under the home directory like upstream (user-home approximation).
 */
export function expandTilde(filePath: string, home: string = os.homedir()): string {
  if (filePath === '~') return home
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return home + filePath.slice(1)
  }
  if (filePath.startsWith('~')) {
    return path.join(home, filePath.slice(1))
  }
  return filePath
}

/** A leading `cd <path> && …` split into its (tilde-expanded) workdir and the remainder. */
export interface CdWorkdir {
  /** Tilde-expanded working directory for the leading `cd`. */
  workdir: string
  /** Command remainder after the top-level `&&`. */
  command: string
}

/**
 * Extract a leading `cd <path> && …` prefix, expanding `~` in the target.
 *
 * Returns `null` when the command does not start with exactly `cd`, one path
 * token, and a top-level `&&` — redirects (`cd /tmp 2>/dev/null && …`), extra
 * arguments, command substitution (`$`, backticks, `(`), and unterminated
 * quotes all leave the whole command for the shell instead of absorbing shell
 * syntax into the structured workdir seam.
 */
export function extractCdWorkdir(command: string, home?: string): CdWorkdir | null {
  const extracted = extractLeadingCdTarget(command)
  if (extracted === null) return null
  return { workdir: expandTilde(extracted.path, home), command: extracted.rest }
}