/**
 * User overrides for shell command resolution — the data file behind the Bash
 * tab's 「命令」 sub-page.
 *
 * WHY A FILE, NOT A SETTINGS FIELD: this is not one scalar. It is a map of
 * per-command choices (use the builtin, stand aside for the system binary, or
 * forward to the user's own executable), and the settings schema is deliberately
 * flat (`src/config/settings.ts`). `bash-init.sh` set the precedent: plugin
 * data under `$DSH_HOME/tool-plus/`, written by the plugin, independent of the
 * profile patch. Profile config still owns *settings*; this owns *decisions
 * about commands*.
 *
 * The same module renders the shell snippet that makes those decisions true:
 * `enable -n <name>` lets a builtin step aside (verified both directions: the
 * lookup continues to PATH, and `enable <name>` restores it), while
 * `name() { "path" "$@"; }` forwards a name to an executable. The snippet is
 * sourced from the shell snapshot, so a new shell picks it up immediately and
 * an existing one keeps its state (the panel says so).
 * @module @xiaoso/dsh-tool-plus/bash/command-config
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** How one command should resolve. */
export type CommandMode = 'builtin' | 'system' | 'custom'

/** One override. `path`/`args` only exist for `custom`. */
export interface CommandOverride {
  mode: CommandMode
  /** Absolute path of the user's executable (`custom` only). */
  path?: string
  /** Fixed leading arguments prepended before the forwarded ones. */
  args?: string[]
}

/** The whole file: name → override. */
export interface CommandSettings {
  commands: Record<string, CommandOverride>
}

/** Empty settings; the default when the file is absent or unreadable. */
export function emptyCommandSettings(): CommandSettings {
  return { commands: {} }
}

/** Directory the plugin owns under $DSH_HOME. */
function stateDir(): string {
  const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
  return path.join(home, 'tool-plus')
}

/** Absolute path of the overrides file. */
export function commandSettingsPath(): string {
  return path.join(stateDir(), 'commands.json')
}

/** Validate one parsed override; unknown shapes are dropped, not trusted. */
function parseOverride(value: unknown): CommandOverride | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const mode = record.mode
  if (mode !== 'builtin' && mode !== 'system' && mode !== 'custom') return undefined
  const override: CommandOverride = { mode }
  if (mode === 'custom') {
    if (typeof record.path !== 'string' || record.path.length === 0) return undefined
    override.path = record.path
    if (Array.isArray(record.args)) {
      const args = record.args.filter((arg): arg is string => typeof arg === 'string')
      if (args.length > 0) override.args = args
    }
  }
  return override
}

/** Parse the file body; a broken file means "no overrides", never a crash. */
export function parseCommandSettings(text: string): CommandSettings {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return emptyCommandSettings()
  }
  if (typeof parsed !== 'object' || parsed === null) return emptyCommandSettings()
  const commands = (parsed as { commands?: unknown }).commands
  if (typeof commands !== 'object' || commands === null || Array.isArray(commands)) {
    return emptyCommandSettings()
  }
  const out: CommandSettings = { commands: {} }
  for (const [name, value] of Object.entries(commands as Record<string, unknown>)) {
    const override = parseOverride(value)
    if (override !== undefined) out.commands[name] = override
  }
  return out
}

interface Cache {
  path: string
  mtimeMs: number
  size: number
  settings: CommandSettings
}

let cache: Cache | undefined

/**
 * Read the overrides, memoized by file identity (mtime + size) so the bash hot
 * path pays one `stat`, not a read+parse per command.
 */
export function readCommandSettings(): CommandSettings {
  const file = commandSettingsPath()
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    cache = undefined
    return emptyCommandSettings()
  }
  if (cache !== undefined && cache.path === file && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return cache.settings
  }
  let settings = emptyCommandSettings()
  try {
    settings = parseCommandSettings(fs.readFileSync(file, 'utf8'))
  } catch {
    // Unreadable file: behave like "no overrides" rather than blocking bash.
  }
  cache = { path: file, mtimeMs: stat.mtimeMs, size: stat.size, settings }
  return settings
}

/**
 * Persist overrides atomically (temp file in the same directory + rename), so a
 * crash mid-write can never leave a half-parsed file that changes resolution.
 */
export function writeCommandSettings(settings: CommandSettings): void {
  const file = commandSettingsPath()
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, file)
  cache = undefined
}

/** Quote one POSIX shell word. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Names a snippet must touch, in a stable order (builtins first, then functions). */
function orderedEntries(settings: CommandSettings): Array<[string, CommandOverride]> {
  return Object.entries(settings.commands).sort(([a], [b]) => a.localeCompare(b))
}

/**
 * Render the snapshot lines that apply the overrides.
 *
 * `builtin` entries render nothing (the default is already the builtin);
 * `system` entries disable the builtin so the lookup falls through to PATH;
 * `custom` entries define a forwarding function, which wins over both.
 * @returns one line per effective override; empty when nothing is overridden.
 */
export function buildCommandScript(settings: CommandSettings): string[] {
  const lines: string[] = []
  for (const [name, override] of orderedEntries(settings)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue
    if (override.mode === 'system') {
      lines.push(`enable -n ${name} 2>/dev/null || true`)
    } else if (override.mode === 'custom' && override.path !== undefined) {
      const command = [shellQuote(override.path), ...(override.args ?? []).map(shellQuote)].join(' ')
      lines.push(`${name}() { ${command} \"$@\"; }`)
    }
  }
  return lines
}

/**
 * The snippet as one string for the snapshot, or undefined when there is
 * nothing to apply (so the snapshot cache key stays stable for the default
 * case).
 */
export function commandOverridesSnippet(): string | undefined {
  const lines = buildCommandScript(readCommandSettings())
  return lines.length === 0 ? undefined : lines.join('\n')
}

/** Test seam: forget the memoized file identity. */
export function resetCommandSettingsCache(): void {
  cache = undefined
}
