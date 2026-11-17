/**
 * Which shell builtins come from where — the static half of the command panel.
 *
 * Every name here ships **inside this plugin**, so the panel calls all of them
 * 插件内置; the split below only tells the user which layer added the name:
 *
 *  - `PLUGIN_ADDED_COMMANDS`: our own overlay (`vendor/oh-my-pi/overlay/crates/
 *    pi-builtins/src/shellcmds.rs`, 19 names over 12 implementations).
 *  - `OMP_UTILITY_COMMANDS` / `OMP_PROCESS_COMMANDS`: upstream oh-my-pi's
 *    `pi-builtins` factory (`utility_builtins` / `process_builtins`).
 *  - everything else that `compgen -b` reports: brush's bash-compatible set
 *    (`default_builtins(BuiltinSet::BashMode)`).
 *
 * The measured total is 152 (57 + 76 + 19); `tests/unit/command-catalog.spec.ts`
 * pins the arithmetic so a list edit cannot silently skew the panel.
 * @module @xiaoso/dsh-tool-plus/bash/builtin-commands
 */

/** Where one builtin's implementation lives. */
export type BuiltinOrigin = 'new' | 'omp' | 'bash'

/** Our overlay's registered names (12 modules, 19 names). */
export const PLUGIN_ADDED_COMMANDS: readonly string[] = [
  'zip', 'tree',
  'gzip', 'gunzip', 'zcat',
  'envsubst',
  'zstd', 'unzstd', 'zstdcat',
  'xz', 'unxz', 'xzcat',
  'bc', 'uuidgen', 'strings', 'hexdump', 'hd', 'rev', 'free',
]

/** Upstream in-process utilities (`pi_builtins::utility_builtins`). */
export const OMP_UTILITY_COMMANDS: readonly string[] = [
  'b2sum', 'base32', 'base64', 'basename', 'cat', 'cksum', 'cmp', 'comm', 'cp',
  'combine', 'cut', 'date', 'dd', 'df', 'diff', 'dirname', 'du', 'env', 'fd',
  'find', 'fold', 'grep', 'rg', 'head', 'hostname', 'ifne', 'isutf8', 'jq',
  'ln', 'ls', 'md5sum', 'mkdir', 'mktemp', 'mv', 'nl', 'nproc', 'od', 'paste',
  'printenv', 'readlink', 'realpath', 'rm', 'rmdir', 'sed', 'seq', 'sha1sum',
  'sha224sum', 'sha256sum', 'sha384sum', 'sha512sum', 'sort', 'sponge', 'stat',
  'tac', 'tail', 'tee', 'touch', 'tr', 'truncate', 'ts', 'uname', 'uniq',
  'uptime', 'wc', 'which', 'whoami', 'xargs', 'yes',
]

/** Upstream process builtins (`pi_builtins::process_builtins`). */
export const OMP_PROCESS_COMMANDS: readonly string[] = [
  'nohup', 'pgrep', 'pidwait', 'pkill', 'ps', 'sleep', 'timeout', 'top',
]

const NEW = new Set(PLUGIN_ADDED_COMMANDS)
const OMP = new Set([...OMP_UTILITY_COMMANDS, ...OMP_PROCESS_COMMANDS])

/**
 * Classify one name reported by `compgen -b`.
 * @param name - the command name as the shell spells it.
 * @returns which layer registered it.
 */
export function builtinOrigin(name: string): BuiltinOrigin {
  if (NEW.has(name)) return 'new'
  if (OMP.has(name)) return 'omp'
  return 'bash'
}

/** Every name the panel should attribute before the shell answers. */
export const KNOWN_BUILTIN_COUNT = 152
