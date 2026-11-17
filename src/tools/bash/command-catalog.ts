/**
 * Runtime command catalog: what `bash` can actually run right now, and where
 * each name comes from.
 *
 * Everything here is measured, never assumed: the list comes from the same
 * brush-based shell the bash tool runs (`createWarmShell`), so disabled
 * builtins and snapshot overrides are reflected exactly as the tool sees them.
 * Only the *attribution* (bash / OMP / plugin-added) is static — those tables
 * ship with the package, in `builtin-commands.ts`.
 *
 * Cost, measured (Windows, 2026-11-17): `compgen -c` ~0.7s, `compgen -b` ~0ms,
 * `declare -F`/`alias` ~0ms; the per-name `type -t` route would be ~9s for
 * 1337 names, so classification only ever does set arithmetic. Results are
 * cached; the panel's 「重新探测」 and every write invalidate the cache.
 * @module @xiaoso/dsh-tool-plus/bash/command-catalog
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { createWarmShell } from './bash-executor.ts'
import { builtinOrigin } from './builtin-commands.ts'
import { readCommandSettings, shellQuote, type CommandOverride } from './command-config.ts'

/** Where one row's code lives, as the panel labels it. */
export type CommandOrigin = 'new' | 'omp' | 'bash' | 'sys' | 'fn' | 'custom'

/** What actually wins for this name right now. */
export type CommandActive = 'builtin' | 'system' | 'function' | 'custom' | 'path'

/** One row of the panel. */
export interface CommandEntry {
  name: string
  origin: CommandOrigin
  active: CommandActive
  /** System executable of the same name, when one exists. */
  systemPath?: string
  /** Absolute path of the user's executable for a `custom` choice. */
  customPath?: string
}

/** One full scan. */
export interface CommandCatalog {
  entries: CommandEntry[]
  counts: { builtin: number; system: number; function: number; custom: number; total: number }
  /** Milliseconds the scan itself took. */
  scanMs: number
  scannedAt: number
}

const SECTION = {
  builtins: '__TP_B__',
  commands: '__TP_C__',
  functions: '__TP_F__',
  aliases: '__TP_A__',
  end: '__TP_END__',
} as const

const SCAN_SCRIPT = [
  `printf '%s\\n' '${SECTION.builtins}'`,
  'compgen -b',
  `printf '%s\\n' '${SECTION.commands}'`,
  'compgen -c | sort -u',
  `printf '%s\\n' '${SECTION.functions}'`,
  "declare -F 2>/dev/null | cut -d' ' -f3",
  `printf '%s\\n' '${SECTION.aliases}'`,
  'alias 2>/dev/null',
  `printf '%s\\n' '${SECTION.end}'`,
].join('\n')

/** Split the marker-delimited output into its four lists. */
export function parseScanOutput(output: string): {
  builtins: string[]
  commands: string[]
  functions: string[]
  aliases: string[]
} {
  const sections: Record<string, string[]> = {
    [SECTION.builtins]: [],
    [SECTION.commands]: [],
    [SECTION.functions]: [],
    [SECTION.aliases]: [],
  }
  let current: string[] | undefined
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === SECTION.end) break
    if (line in sections) {
      current = sections[line]
      continue
    }
    if (current !== undefined && line.length > 0) current.push(line)
  }
  const aliases = sections[SECTION.aliases]
    .map(line => line.replace(/^alias\s+/, '').split('=', 1)[0] ?? '')
    .filter(name => name.length > 0)
  return {
    builtins: sections[SECTION.builtins] ?? [],
    commands: sections[SECTION.commands] ?? [],
    functions: [...new Set([...(sections[SECTION.functions] ?? []), ...aliases])],
    aliases,
  }
}

/** Executable names visible on PATH, for the "system has the same name" badge. */
function pathNames(): Set<string> {
  const names = new Set<string>()
  const raw = process.env.PATH ?? process.env.Path ?? ''
  const separator = process.platform === 'win32' ? ';' : ':'
  for (const dir of raw.split(separator)) {
    if (dir.length === 0) continue
    let entries: string[]
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const lower = entry.toLowerCase()
      names.add(lower)
      const dot = lower.lastIndexOf('.')
      if (dot > 0) names.add(lower.slice(0, dot))
    }
  }
  return names
}

/** Whether PATH carries a binary with this name (Windows extensions included). */
export function systemPathOf(name: string): string | undefined {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.com', ''] : ['']
  const raw = process.env.PATH ?? process.env.Path ?? ''
  const separator = process.platform === 'win32' ? ';' : ':'
  for (const dir of raw.split(separator)) {
    if (dir.length === 0) continue
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        // not here
      }
    }
  }
  return undefined
}

/** Turn one raw scan plus the user's overrides into panel rows. */
export function buildCatalog(
  raw: ReturnType<typeof parseScanOutput>,
  overrides: Record<string, CommandOverride>,
  system: (name: string) => string | undefined = systemPathOf,
): Omit<CommandCatalog, 'scanMs' | 'scannedAt'> {
  const builtins = new Set(raw.builtins)
  const functions = new Set(raw.functions)
  const byName = new Map<string, CommandEntry>()

  for (const name of builtins) {
    const override = overrides[name]
    const sys = system(name)
    if (override?.mode === 'custom' && override.path !== undefined) {
      byName.set(name, { name, origin: 'custom', active: 'custom', customPath: override.path, ...(sys === undefined ? {} : { systemPath: sys }) })
    } else if (override?.mode === 'system') {
      byName.set(name, { name, origin: 'sys', active: 'system', ...(sys === undefined ? {} : { systemPath: sys }) })
    } else {
      byName.set(name, { name, origin: builtinOrigin(name), active: 'builtin', ...(sys === undefined ? {} : { systemPath: sys }) })
    }
  }

  for (const name of raw.commands) {
    if (byName.has(name) || functions.has(name)) continue
    byName.set(name, { name, origin: 'sys', active: 'path' })
  }

  for (const name of functions) {
    if (byName.has(name)) continue
    const override = overrides[name]
    if (override?.mode === 'custom' && override.path !== undefined) {
      byName.set(name, { name, origin: 'custom', active: 'custom', customPath: override.path })
    } else {
      byName.set(name, { name, origin: 'fn', active: 'function' })
    }
  }

  // Overrides for names the shell did not report (e.g. a custom name whose
  // function failed to load) still deserve a row: that is the state the user
  // must be able to fix.
  for (const [name, override] of Object.entries(overrides)) {
    if (byName.has(name)) continue
    if (override.mode === 'custom' && override.path !== undefined) {
      byName.set(name, { name, origin: 'custom', active: 'custom', customPath: override.path })
    } else if (override.mode === 'system') {
      byName.set(name, { name, origin: 'sys', active: 'system' })
    }
  }

  const entries = [...byName.values()].sort((a, b) => {
    const order: CommandOrigin[] = ['custom', 'new', 'omp', 'bash', 'fn', 'sys']
    const delta = order.indexOf(a.origin) - order.indexOf(b.origin)
    return delta !== 0 ? delta : a.name.localeCompare(b.name)
  })
  const counts = {
    builtin: entries.filter(entry => entry.origin === 'new' || entry.origin === 'omp' || entry.origin === 'bash').length,
    system: entries.filter(entry => entry.origin === 'sys').length,
    function: entries.filter(entry => entry.origin === 'fn').length,
    custom: entries.filter(entry => entry.origin === 'custom').length,
    total: entries.length,
  }
  return { entries, counts }
}

/** Cached scan; invalidated by every write and by the panel's refresh button. */
let cached: CommandCatalog | undefined
const CACHE_TTL_MS = 60_000

/** Drop the cached scan (called after a write and by `command/rescan`). */
export function invalidateCommandCatalog(): void {
  cached = undefined
}

/**
 * Collect one shell's worth of output, then drop the shell. A fresh shell
 * (rather than the tool's session shells) keeps the scan read-only and
 * independent of whatever a session has done to its own shell.
 */
async function runScript(command: string, timeoutMs: number): Promise<string> {
  const shell = await createWarmShell({ snapshotEnabled: true, initScriptEnabled: true, initScriptPath: undefined })
  if (shell === null) throw new Error('无法创建用于探测的 shell（初始化失败）')
  let output = ''
  try {
    const result = await shell.run(
      { command, cwd: process.cwd(), env: {}, timeoutMs },
      (_error: unknown, chunk: string) => { output += chunk },
    )
    if (result.timedOut) throw new Error('探测超时')
    if (result.exitCode !== 0 && output.trim().length === 0) throw new Error('探测脚本没有输出（exit ' + String(result.exitCode) + '）')
  } finally {
    void shell.abort().catch(() => undefined)
  }
  return output
}

/**
 * Scan the current shell state.
 * @param force - ignore the 60s cache (the panel's 「重新探测」).
 */
export async function scanCommands(force = false): Promise<CommandCatalog> {
  if (!force && cached !== undefined && Date.now() - cached.scannedAt < CACHE_TTL_MS) return cached
  const started = Date.now()
  const output = await runScript(SCAN_SCRIPT, 30_000)
  const parsed = parseScanOutput(output)
  const settings = readCommandSettings()
  const catalog = { ...buildCatalog(parsed, settings.commands), scanMs: Date.now() - started, scannedAt: Date.now() }
  cached = catalog
  return catalog
}

/** The probe script for one name; `--version` is best-effort and capped. */
export function probeScript(name: string): string {
  const quoted = shellQuote(name)
  return [
    "printf '%s\\n' '__TP_T__'",
    'type -a ' + quoted + ' 2>&1 || true',
    "printf '%s\\n' '__TP_V__'",
    'command -v ' + quoted + ' 2>&1 || true',
    "printf '%s\\n' '__TP_X__'",
    quoted + ' --version 2>&1 | head -3 || true',
    "printf '%s\\n' '__TP_END__'",
  ].join('\n')
}

/** Run the probe for one name and return its raw output lines. */
export async function probeCommand(name: string): Promise<string[]> {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) throw new Error('命令名不合法')
  const output = await runScript(probeScript(name), 15_000)
  return output.split(/\r?\n/).filter(line => line.length > 0 && !line.startsWith('__TP_'))
}
