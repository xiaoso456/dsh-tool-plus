import { describe, expect, it } from 'vitest'
import { KNOWN_BUILTIN_COUNT, OMP_PROCESS_COMMANDS, OMP_UTILITY_COMMANDS, PLUGIN_ADDED_COMMANDS, builtinOrigin } from '../../src/tools/bash/builtin-commands.ts'
import { buildCatalog, parseScanOutput } from '../../src/tools/bash/command-catalog.ts'

describe('builtin origin tables', () => {
  it('account for every builtin the panel expects', () => {
    const names = new Set([...PLUGIN_ADDED_COMMANDS, ...OMP_UTILITY_COMMANDS, ...OMP_PROCESS_COMMANDS])
    expect(names.size).toBe(PLUGIN_ADDED_COMMANDS.length + OMP_UTILITY_COMMANDS.length + OMP_PROCESS_COMMANDS.length)
    expect(KNOWN_BUILTIN_COUNT - names.size).toBe(57)
  })

  it('classifies by layer', () => {
    expect(builtinOrigin('zip')).toBe('new')
    expect(builtinOrigin('cat')).toBe('omp')
    expect(builtinOrigin('nohup')).toBe('omp')
    expect(builtinOrigin('cd')).toBe('bash')
    expect(builtinOrigin('compgen')).toBe('bash')
  })
})

describe('parseScanOutput', () => {
  it('splits marker sections and strips alias bodies', () => {
    const output = [
      '__TP_B__', 'cd', 'zip',
      '__TP_C__', 'cd', 'zip', 'ls.exe',
      '__TP_F__', 'conda',
      '__TP_A__', "alias ll='ls -l'", "alias g='git'",
      '__TP_END__',
    ].join('\n')
    const parsed = parseScanOutput(output)
    expect(parsed.builtins).toEqual(['cd', 'zip'])
    expect(parsed.commands).toEqual(['cd', 'zip', 'ls.exe'])
    expect(parsed.functions).toEqual(['conda', 'll', 'g'])
  })
})

describe('buildCatalog', () => {
  const raw = { builtins: ['zip', 'cd', 'cat'], commands: ['zip', 'cd', 'cat', 'rg', 'git'], functions: ['conda'], aliases: [] }
  const system = (name: string) => (name === 'zip' || name === 'cd' || name === 'git' ? 'C:/bin/' + name + '.exe' : undefined)

  it('merges builtins, functions and PATH names into one sorted list', () => {
    const catalog = buildCatalog(raw, {}, system)
    expect(catalog.entries.map(entry => entry.name)).toEqual(['zip', 'cat', 'cd', 'conda', 'git', 'rg'])
    expect(catalog.counts).toEqual({ builtin: 3, system: 2, function: 1, custom: 0, total: 6 })
  })

  it('applies the three overrides and keeps the shadow path', () => {
    const catalog = buildCatalog(raw, { zip: { mode: 'custom', path: 'D:/tools/zip.exe' }, cd: { mode: 'system' } }, system)
    const zip = catalog.entries.find(entry => entry.name === 'zip')
    expect(zip).toMatchObject({ origin: 'custom', active: 'custom', customPath: 'D:/tools/zip.exe', systemPath: 'C:/bin/zip.exe' })
    const cd = catalog.entries.find(entry => entry.name === 'cd')
    expect(cd).toMatchObject({ origin: 'sys', active: 'system' })
    expect(catalog.counts.builtin).toBe(1)
  })

  it('lists an override for a name the shell does not report', () => {
    const catalog = buildCatalog(raw, { ghost: { mode: 'custom', path: 'D:/tools/ghost.exe' } }, system)
    expect(catalog.entries.find(entry => entry.name === 'ghost')).toMatchObject({ origin: 'custom', active: 'custom' })
  })
})
