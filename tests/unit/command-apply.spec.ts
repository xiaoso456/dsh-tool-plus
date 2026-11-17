import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { COMMAND_APPLY_ENDPOINT, type CommandApplyValue } from '../../src/tools/shared/browser-rpc-channel.ts'
import { handleCommandEndpoint } from '../../src/host/commands-rpc.ts'
import { commandSettingsPath, resetCommandSettingsCache } from '../../src/tools/bash/command-config.ts'

/**
 * A click that changes nothing must write nothing.
 *
 * 「恢复默认」 on a command with no override used to rewrite the file, drop the
 * snapshot cache and re-probe all 1337 commands — the panel visibly reloaded for
 * a no-op. These cases pin the host half of that fix: the answer carries
 * `changed: false` and the data file is left untouched.
 */
describe('command apply no-ops', () => {
  let home: string
  const originalHome = process.env.DSH_HOME

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-plus-apply-'))
    process.env.DSH_HOME = home
    resetCommandSettingsCache()
  })

  afterEach(() => {
    process.env.DSH_HOME = originalHome
    resetCommandSettingsCache()
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 })
  })

  const apply = async (payload: unknown): Promise<CommandApplyValue> => {
    const envelope = await handleCommandEndpoint(COMMAND_APPLY_ENDPOINT, payload)
    expect(envelope?.ok).toBe(true)
    return (envelope as { value: CommandApplyValue }).value
  }

  it('restoring the default of a command without an override writes nothing', async () => {
    const value = await apply({ name: 'bc', mode: 'builtin' })
    expect(value).toEqual({ ok: true, changed: false })
    expect(fs.existsSync(commandSettingsPath())).toBe(false)
  })

  it('re-picking the active source of an override writes nothing', async () => {
    expect(await apply({ name: 'gunzip', mode: 'system' })).toEqual({ ok: true, changed: true })
    const before = fs.readFileSync(commandSettingsPath(), 'utf8')
    const mtime = fs.statSync(commandSettingsPath()).mtimeMs

    expect(await apply({ name: 'gunzip', mode: 'system' })).toEqual({ ok: true, changed: false })
    expect(fs.readFileSync(commandSettingsPath(), 'utf8')).toBe(before)
    expect(fs.statSync(commandSettingsPath()).mtimeMs).toBe(mtime)
  })

  it('an actual change still reports changed and rewrites the file', async () => {
    expect(await apply({ name: 'bc', mode: 'system' })).toEqual({ ok: true, changed: true })
    expect(JSON.parse(fs.readFileSync(commandSettingsPath(), 'utf8')).commands.bc).toEqual({ mode: 'system' })

    expect(await apply({ name: 'bc', mode: 'builtin' })).toEqual({ ok: true, changed: true })
    expect(JSON.parse(fs.readFileSync(commandSettingsPath(), 'utf8')).commands.bc).toBeUndefined()
  })

  it('a custom path pointed at a missing file is still refused before any write', async () => {
    const value = await apply({ name: 'z9', mode: 'custom', path: path.join(home, 'no-such-binary.exe') })
    expect(value.ok).toBe(false)
    expect(fs.existsSync(commandSettingsPath())).toBe(false)
  })
})
