/**
 * POSIX single-quote escaping shared by every seam that hands a path or command
 * fragment to a shell (snapshot source line, 试运行, user-shell command).
 * @module @xiaoso/dsh-tool-plus/bash/shell-quote
 */

export function quoteShellArg(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}
