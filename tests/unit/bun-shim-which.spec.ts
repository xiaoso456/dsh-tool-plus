/**
 * `$which` through the bun-shim (T4 regression suite).
 *
 * Upstream OMP's `packages/utils/test/which.test.ts` skips itself on win32 —
 * which is this plugin's primary platform — so the port below drops the skip
 * (`.CMD` + PATHEXT on Windows) and adds the missing-command / cache-policy /
 * `PATH`+`cwd` option coverage the upstream file never had.
 *
 * The chain under test is the real one: bun-shim's `Bun.which` ← pi-utils
 * `$which` (which looks `Bun.which` up on every call, so the shim installed by
 * vitest-setup is honoured without re-importing anything).
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { $which, WhichCachePolicy } from '@oh-my-pi/pi-utils'
import { installBunShim } from '../../src/tools/shared/bun-shim.ts'

const WIN32 = process.platform === 'win32'

/** Windows resolves through PATHEXT, POSIX through the executable bit. */
const EXEC_SUFFIX = WIN32 ? '.CMD' : ''

let seq = 0
/** `$which` caches per command+PATH in-module, so every case needs its own name. */
function uniqueCommand(): string {
  return `dsh-which-${process.pid}-${seq++}`
}

const tempDirs: string[] = []
const originalPath = process.env.PATH
const originalPathext = process.env.PATHEXT

function restoreEnv(key: 'PATH' | 'PATHEXT', value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** Create `command` in `dir`; returns the exact path a PATH walk must produce. */
function writeExecutable(dir: string, command: string): string {
  const full = path.join(dir, `${command}${EXEC_SUFFIX}`)
  fs.writeFileSync(full, WIN32 ? '@echo off\r\n' : '#!/bin/sh\n')
  if (!WIN32) fs.chmodSync(full, 0o755)
  return full
}

/** Pin PATHEXT so the temp `.CMD` fixture resolves regardless of host settings. */
function pinPathext(): void {
  if (WIN32) process.env.PATHEXT = '.CMD;.EXE'
}

afterEach(() => {
  restoreEnv('PATH', originalPath)
  restoreEnv('PATHEXT', originalPathext)
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('$which via the bun-shim', () => {
  it('installs Bun.which as a function (regression: it used to be missing)', () => {
    installBunShim()
    const shimmed = globalThis as unknown as { Bun?: { which?: unknown } }
    expect(typeof shimmed.Bun?.which).toBe('function')
  })

  it('resolves a real executable and returns null — not a throw — for a missing one', () => {
    installBunShim()

    const found = $which(WIN32 ? 'node.exe' : 'node', { cache: WhichCachePolicy.Fresh })
    expect(found).toBeTypeOf('string')
    expect(fs.existsSync(found as string)).toBe(true)
    expect(path.basename(found as string).toLowerCase()).toMatch(/^node(\.exe)?$/)

    expect(() => $which('dsh-which-definitely-missing-9f3a', { cache: WhichCachePolicy.Fresh })).not.toThrow()
    expect($which('dsh-which-definitely-missing-9f3a', { cache: WhichCachePolicy.Fresh })).toBeNull()
  })

  // Ported from refs/oh-my-pi/packages/utils/test/which.test.ts; its
  // `it.skipIf(process.platform === "win32")` is deliberately dropped.
  it('uses the current process PATH for each cached lookup', () => {
    installBunShim()
    pinPathext()

    const firstDir = makeTempDir('omp-which-first-')
    const secondDir = makeTempDir('omp-which-second-')
    const command = uniqueCommand()
    const firstExecutable = writeExecutable(firstDir, command)
    const secondExecutable = writeExecutable(secondDir, command)

    process.env.PATH = firstDir
    expect($which(command)).toBe(firstExecutable)

    process.env.PATH = secondDir
    expect($which(command)).toBe(secondExecutable)
  })

  it('honours options.PATH over process.env.PATH', () => {
    installBunShim()
    pinPathext()

    const envDir = makeTempDir('omp-which-env-')
    const optionDir = makeTempDir('omp-which-option-')
    const command = uniqueCommand()
    const fromEnv = writeExecutable(envDir, command)
    const fromOptions = writeExecutable(optionDir, command)

    process.env.PATH = envDir
    expect($which(command, { PATH: optionDir, cache: WhichCachePolicy.Bypass })).toBe(fromOptions)
    expect($which(command, { cache: WhichCachePolicy.Bypass })).toBe(fromEnv)
  })

  it('honours options.cwd for commands carrying a path separator', () => {
    installBunShim()
    pinPathext()

    const dir = makeTempDir('omp-which-cwd-')
    const full = writeExecutable(dir, uniqueCommand())
    const relative = `.${path.sep}${path.basename(full)}`

    expect($which(relative, { cwd: dir, cache: WhichCachePolicy.Bypass })).toBe(full)
    // Without cwd the same relative command resolves against the process cwd.
    expect($which(relative, { cache: WhichCachePolicy.Bypass })).toBeNull()
  })

  it('seeds Bun.hash, so $which cache keys stay per-command instead of per-PATH', () => {
    installBunShim()
    const shim = globalThis as unknown as { Bun: { hash: (value: string, seed?: number) => number } }

    // Unseeded values stay the documented FNV-1a 32-bit ones ("" → offset basis).
    expect(shim.Bun.hash('')).toBe(0x811c9dc5)
    expect(shim.Bun.hash('a')).toBe(0xe40c292c)
    // pi-utils' cacheKey re-seeds per field (command → cwd → PATH) over the SAME
    // data, so the seed itself must change the result; dropping it collapses
    // every command sharing one PATH onto a single cache slot.
    expect(shim.Bun.hash('dsh-which-seed', 1)).not.toBe(shim.Bun.hash('dsh-which-seed', 2))
    expect(shim.Bun.hash('dsh-which-seed', 12345)).not.toBe(shim.Bun.hash('dsh-which-seed'))
  })

  it('keeps the three cache policies distinct (cached is PATH-keyed)', () => {
    installBunShim()
    pinPathext()

    const dirA = makeTempDir('omp-which-cache-a-')
    const dirB = makeTempDir('omp-which-cache-b-')

    // default (Cached): PATH is part of the cache key, so switching PATH re-looks-up
    const pathKeyed = uniqueCommand()
    const inA = writeExecutable(dirA, pathKeyed)
    const inB = writeExecutable(dirB, pathKeyed)
    process.env.PATH = dirA
    expect($which(pathKeyed)).toBe(inA)
    process.env.PATH = dirB
    expect($which(pathKeyed)).toBe(inB)

    // default: a cached hit outlives the file; fresh re-scans and rewrites the entry
    const freshCmd = uniqueCommand()
    const onlyFile = writeExecutable(dirB, freshCmd)
    process.env.PATH = dirB
    expect($which(freshCmd)).toBe(onlyFile)
    fs.rmSync(onlyFile, { force: true })
    expect($which(freshCmd)).toBe(onlyFile)
    expect($which(freshCmd, { cache: WhichCachePolicy.Fresh })).toBeNull()
    expect($which(freshCmd)).toBeNull()

    // bypass: neither reads nor writes, so a bypass hit leaves no cached entry
    const bypassCmd = uniqueCommand()
    const bypassFile = writeExecutable(dirB, bypassCmd)
    process.env.PATH = dirB
    expect($which(bypassCmd, { cache: WhichCachePolicy.Bypass })).toBe(bypassFile)
    fs.rmSync(bypassFile, { force: true })
    expect($which(bypassCmd, { cache: WhichCachePolicy.Bypass })).toBeNull()
    expect($which(bypassCmd)).toBeNull()
  })
})
