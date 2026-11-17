/**
 * Host half of the 「命令」 sub-page: enumerate, probe and write the
 * per-command overrides. Pure adaptation — the catalog logic lives in
 * `tools/bash/command-catalog.ts`, the file format in `command-config.ts`, and
 * this module only validates the wire payload and answers in the shared
 * envelope shape.
 * @module @xiaoso/dsh-tool-plus/host/commands-rpc
 */

import * as fs from 'node:fs'
import {
  COMMAND_APPLY_ENDPOINT,
  COMMAND_LIST_ENDPOINT,
  COMMAND_PROBE_ENDPOINT,
  type CommandApplyPayload,
  type CommandApplyValue,
  type CommandListValue,
  type CommandProbeValue,
} from '../tools/shared/browser-rpc-channel.ts'
import { invalidateCommandCatalog, probeCommand, scanCommands } from '../tools/bash/command-catalog.ts'
import { readCommandSettings, writeCommandSettings, type CommandSettings } from '../tools/bash/command-config.ts'
import { cleanupSnapshots } from '../tools/bash/shell-snapshot.ts'

/** Envelope shape the RPC route expects; kept structural to avoid a cycle. */
type Envelope = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

/** One wire payload as `unknown`; narrowed here. */
function applyPayload(payload: unknown): CommandApplyPayload | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  const name = record.name
  const mode = record.mode
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) return undefined
  if (mode !== 'builtin' && mode !== 'system' && mode !== 'custom') return undefined
  const path = typeof record.path === 'string' ? record.path : undefined
  if (mode === 'custom' && (path === undefined || path.trim().length === 0)) return undefined
  const args = Array.isArray(record.args)
    ? record.args.filter((arg): arg is string => typeof arg === 'string' && arg.length > 0)
    : undefined
  return { name, mode, ...(path === undefined ? {} : { path: path.trim() }), ...(args === undefined ? {} : { args }) }
}

/**
 * Apply one choice, persist it, and make the next shell pick it up.
 *
 * The write is a whole-file rewrite of the plugin's own data file (the
 * `bash-init.sh` precedent), not a profile patch: this is plugin state, not a
 * host setting. Snapshots are dropped so the very next shell sources the new
 * snippet instead of replaying a cached one.
 */
function applyChoice(payload: CommandApplyPayload): CommandApplyValue {
  const settings: CommandSettings = readCommandSettings()
  const next: CommandSettings = { commands: { ...settings.commands } }
  const previous = settings.commands[payload.name]
  if (payload.mode === 'builtin') {
    // Nothing to restore: the command never had an override. Answering "no
    // change" keeps the panel from rewriting the file and rescanning 1337
    // commands for a click that does nothing.
    if (previous === undefined) return { ok: true, changed: false }
    delete next.commands[payload.name]
  } else if (payload.mode === 'system') {
    if (previous !== undefined && previous.mode === 'system') return { ok: true, changed: false }
    next.commands[payload.name] = { mode: 'system' }
  } else {
    const target = payload.path as string
    let stat: fs.Stats
    try {
      stat = fs.statSync(target)
    } catch {
      return { ok: false, message: '文件不存在：' + target }
    }
    if (!stat.isFile()) return { ok: false, message: '不是文件：' + target }
    if (previous !== undefined && previous.mode === 'custom' && previous.path === target
      && JSON.stringify(previous.args ?? []) === JSON.stringify(payload.args ?? [])) {
      return { ok: true, changed: false }
    }
    next.commands[payload.name] = {
      mode: 'custom',
      path: target,
      ...(payload.args === undefined ? {} : { args: payload.args }),
    }
  }
  writeCommandSettings(next)
  invalidateCommandCatalog()
  cleanupSnapshots()
  return { ok: true, changed: true }
}

/**
 * Serve one command endpoint, or return undefined when it is not ours (the
 * route dispatches several endpoint families).
 */
export async function handleCommandEndpoint(endpoint: string, payload: unknown): Promise<Envelope | undefined> {
  try {
    if (endpoint === COMMAND_LIST_ENDPOINT) {
      const catalog = await scanCommands((payload as { refresh?: unknown } | undefined)?.refresh === true)
      const value: CommandListValue = {
        entries: catalog.entries,
        counts: catalog.counts,
        scanMs: catalog.scanMs,
      }
      return { ok: true, value }
    }
    if (endpoint === COMMAND_PROBE_ENDPOINT) {
      const name = (payload as { name?: unknown } | undefined)?.name
      if (typeof name !== 'string') throw new Error('缺少命令名')
      const lines = await probeCommand(name)
      const value: CommandProbeValue = { lines }
      return { ok: true, value }
    }
    if (endpoint === COMMAND_APPLY_ENDPOINT) {
      const parsed = applyPayload(payload)
      if (parsed === undefined) throw new Error('参数不完整')
      const value = applyChoice(parsed)
      return { ok: true, value }
    }
    return undefined
  } catch (error) {
    return {
      ok: false,
      error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} },
    }
  }
}
