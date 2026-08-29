/**
 * S-10 (fish interactive arg handling) + S-6 (Windows shell discovery).
 *
 * - `needsInteractiveShellArg` / `ensureInteractiveShellArgs`: fish needs the
 *   interactive arg but must NOT keep `-l`/`--login` (fish sources the same
 *   config for login and interactive shells — refs exec/bash-executor.ts:290-298).
 *   DSH shape for fish: `['-i', '-c']` with no login flag.
 * - `resolveWindowsShell`: verbatim port of refs utils/procmgr.ts:148-173
 *   (Bun.env → injectable env, $which → findOnPath), covering git roots,
 *   PATH bash/sh with sibling preference, and the ComSpec fallback.
 * @module tests
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ensureInteractiveShellArgs,
  getShellConfig,
  needsInteractiveShellArg,
} from '../../src/tools/bash/bash-executor.ts'
import { resolveWindowsShell } from '../../src/tools/bash/windows-shell.ts'

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shell-discovery-'))
}

describe('needsInteractiveShellArg', () => {
  it('flags zsh and fish, not bash', () => {
    expect(needsInteractiveShellArg('/bin/bash')).toBe(false)
    expect(needsInteractiveShellArg('/usr/bin/zsh')).toBe(true)
    expect(needsInteractiveShellArg('/usr/bin/fish')).toBe(true)
  })
})

describe('ensureInteractiveShellArgs', () => {
  it('fish: adds -i and strips login flags — DSH shape is ["-i","-c"] with no -l', () => {
    const result = ensureInteractiveShellArgs('/usr/bin/fish', ['-c'])
    expect(result).toEqual(['-i', '-c'])
    expect(result).not.toContain('-l')
    expect(result).not.toContain('--login')
  })

  it('fish: inherited -l / --login are removed before the interactive arg is added', () => {
    expect(ensureInteractiveShellArgs('/usr/bin/fish', ['-l', '-c'])).toEqual(['-i', '-c'])
    expect(ensureInteractiveShellArgs('/usr/bin/fish', ['--login', '-c'])).toEqual(['-i', '-c'])
  })

  it('fish: an existing interactive arg short-circuits without adding a second one', () => {
    expect(ensureInteractiveShellArgs('/usr/bin/fish', ['-i', '-c'])).toEqual(['-i', '-c'])
    expect(ensureInteractiveShellArgs('/usr/bin/fish', ['-li', '-c'])).toEqual(['-li', '-c'])
  })

  it('zsh keeps -l (login-only .zprofile) and still gets -i', () => {
    expect(ensureInteractiveShellArgs('/usr/bin/zsh', ['-l', '-c'])).toEqual(['-l', '-i', '-c'])
    expect(ensureInteractiveShellArgs('/usr/bin/zsh', ['-c'])).toEqual(['-i', '-c'])
  })

  it('bash args pass through untouched', () => {
    expect(ensureInteractiveShellArgs('/bin/bash', ['-c'])).toEqual(['-c'])
    expect(ensureInteractiveShellArgs('C:\\Program Files\\Git\\bin\\bash.exe', ['--login', '-c'])).toEqual([
      '--login',
      '-c',
    ])
  })
})

describe('resolveWindowsShell', () => {
  it('prefers <ProgramFiles>/Git/bin/bash.exe over a bash.exe found on PATH', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-winshell-git-'))
    const pathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-winshell-path-'))
    fs.mkdirSync(path.join(root, 'Git', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(root, 'Git', 'bin', 'bash.exe'), '')
    fs.writeFileSync(path.join(pathDir, 'bash.exe'), '')
    try {
      expect(resolveWindowsShell({ ProgramFiles: root, PATH: pathDir })).toBe(
        path.join(root, 'Git', 'bin', 'bash.exe'),
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(pathDir, { recursive: true, force: true })
    }
  })

  it('resolves GIT_INSTALL_ROOT as a git root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-winshell-env-'))
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(root, 'bin', 'bash.exe'), '')
    try {
      expect(resolveWindowsShell({ GIT_INSTALL_ROOT: root, PATH: '' })).toBe(
        path.join(root, 'bin', 'bash.exe'),
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves LOCALAPPDATA per-user installs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-winshell-local-'))
    fs.mkdirSync(path.join(root, 'Programs', 'Git', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(root, 'Programs', 'Git', 'bin', 'bash.exe'), '')
    try {
      expect(resolveWindowsShell({ LOCALAPPDATA: root, PATH: '' })).toBe(
        path.join(root, 'Programs', 'Git', 'bin', 'bash.exe'),
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to bash.exe on PATH', () => {
    const pathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-winshell-path-'))
    fs.writeFileSync(path.join(pathDir, 'bash.exe'), '')
    try {
      expect(resolveWindowsShell({ PATH: pathDir })).toBe(path.join(pathDir, 'bash.exe'))
    } finally {
      fs.rmSync(pathDir, { recursive: true, force: true })
    }
  })

  it('uses sh.exe from PATH and prefers a sibling bash.exe when one exists', () => {
    const withoutSibling = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-winshell-sh1-'))
    fs.writeFileSync(path.join(withoutSibling, 'sh.exe'), '')
    const withSibling = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-winshell-sh2-'))
    fs.writeFileSync(path.join(withSibling, 'sh.exe'), '')
    fs.writeFileSync(path.join(withSibling, 'bash.exe'), '')
    try {
      expect(resolveWindowsShell({ PATH: withoutSibling })).toBe(path.join(withoutSibling, 'sh.exe'))
      expect(resolveWindowsShell({ PATH: withSibling })).toBe(path.join(withSibling, 'bash.exe'))
    } finally {
      fs.rmSync(withoutSibling, { recursive: true, force: true })
      fs.rmSync(withSibling, { recursive: true, force: true })
    }
  })

  it('never fails: falls back to ComSpec/COMSPEC then the System32 cmd.exe constant', () => {
    expect(resolveWindowsShell({ PATH: '' })).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(resolveWindowsShell({ PATH: '', ComSpec: 'X:\\custom\\cmd.exe' })).toBe('X:\\custom\\cmd.exe')
    expect(resolveWindowsShell({ PATH: '', COMSPEC: 'Y:\\custom\\cmd.exe' })).toBe('Y:\\custom\\cmd.exe')
  })

  it('real-env regression: returns a non-empty shell, consistent with getShellConfig on win32', () => {
    const shell = resolveWindowsShell()
    expect(typeof shell).toBe('string')
    expect(shell.length).toBeGreaterThan(0)
    if (process.platform === 'win32') {
      expect(getShellConfig().shell).toBe(shell)
    }
  })
})