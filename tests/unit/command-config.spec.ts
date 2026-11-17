import { describe, expect, it } from 'vitest'
import {
  buildCommandScript,
  emptyCommandSettings,
  parseCommandSettings,
  shellQuote,
  type CommandSettings,
} from '../../src/tools/bash/command-config.ts'

describe('parseCommandSettings', () => {
  it('treats broken JSON as no overrides', () => {
    expect(parseCommandSettings('{')).toEqual(emptyCommandSettings())
    expect(parseCommandSettings('null')).toEqual(emptyCommandSettings())
    expect(parseCommandSettings('{"commands":[]}')).toEqual(emptyCommandSettings())
  })

  it('keeps valid entries and drops malformed ones', () => {
    const parsed = parseCommandSettings(JSON.stringify({
      commands: {
        zip: { mode: 'system' },
        z7: { mode: 'custom', path: 'D:/tools/7z.exe', args: ['-mx=9', 3] },
        bad: { mode: 'sometimes' },
        nopath: { mode: 'custom' },
        plain: { mode: 'builtin', path: 'ignored' },
      },
    }))
    expect(parsed.commands.zip).toEqual({ mode: 'system' })
    expect(parsed.commands.z7).toEqual({ mode: 'custom', path: 'D:/tools/7z.exe', args: ['-mx=9'] })
    expect(parsed.commands.bad).toBeUndefined()
    expect(parsed.commands.nopath).toBeUndefined()
    expect(parsed.commands.plain).toEqual({ mode: 'builtin' })
  })
})

describe('buildCommandScript', () => {
  it('renders enable -n for system and a function for custom', () => {
    const settings: CommandSettings = {
      commands: {
        bc: { mode: 'system' },
        zip: { mode: 'custom', path: 'D:/tools/zip.exe' },
        z7: { mode: 'custom', path: 'D:/Program Files/7z.exe', args: ['-mx=9'] },
        tree: { mode: 'builtin' },
      },
    }
    expect(buildCommandScript(settings)).toEqual([
      'enable -n bc 2>/dev/null || true',
      'z7() { \'D:/Program Files/7z.exe\' -mx=9 "$@"; }',
      'zip() { D:/tools/zip.exe "$@"; }',
    ])
  })

  it('ignores names that are not valid shell identifiers', () => {
    expect(buildCommandScript({ commands: { 'a b': { mode: 'system' } } })).toEqual([])
  })

  it('quotes words the shell would otherwise split', () => {
    expect(shellQuote('plain')).toBe('plain')
    expect(shellQuote('C:/Program Files/x.exe')).toBe("'C:/Program Files/x.exe'")
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })
})
