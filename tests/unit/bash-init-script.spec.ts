/**
 * Shell init script (issue #5): default content, path resolution, PATH prefix
 * and the snapshot source line.
 * @module tests
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildInitSourceLine,
  computePathPrefix,
  DEFAULT_INIT_SCRIPT,
  defaultInitScriptPath,
  INIT_PATH_PREFIX_ENV,
  readInitScript,
} from '../../src/tools/bash/init-script.ts'

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-init-script-'))
}

describe('defaultInitScriptPath', () => {
  it('uses $DSH_HOME when set', () => {
    expect(defaultInitScriptPath({ DSH_HOME: 'C:/dsh-home' })).toBe(
      path.join('C:/dsh-home', 'tool-plus', 'bash-init.sh'),
    )
  })

})

describe('readInitScript', () => {
  it('falls back to the built-in default when the user copy is missing', () => {
    const dir = tempDir()
    const info = readInitScript({ DSH_HOME: dir })
    try {
      expect(info.source).toBe('default')
      expect(info.exists).toBe(false)
      expect(info.content).toBe(DEFAULT_INIT_SCRIPT)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads the user copy when it exists', () => {
    const dir = tempDir()
    const script = path.join(dir, 'tool-plus', 'bash-init.sh')
    fs.mkdirSync(path.dirname(script), { recursive: true })
    fs.writeFileSync(script, 'export MY_FLAG=1\n')
    try {
      const info = readInitScript({ DSH_HOME: dir })
      expect(info).toMatchObject({ source: 'user', exists: true, content: 'export MY_FLAG=1\n' })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('DEFAULT_INIT_SCRIPT', () => {
  it('is platform-neutral: the Windows fix is driven by the injected prefix', () => {
    expect(DEFAULT_INIT_SCRIPT).toContain('${' + INIT_PATH_PREFIX_ENV + ':-}')
    const active = DEFAULT_INIT_SCRIPT.split('\n').filter(line => !line.trimStart().startsWith('#'))
    expect(active.join('\n')).not.toMatch(/[A-Za-z]:[\\/]/)
  })
})

describe('computePathPrefix', () => {
  it('is empty off Windows', () => {
    expect(computePathPrefix({}, 'linux')).toBe('')
    expect(computePathPrefix({ GIT_INSTALL_ROOT: 'C:/Git' }, 'darwin')).toBe('')
  })

  it('prepends the real Git dirs on Windows, POSIX separators', () => {
    const root = tempDir()
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(root, 'bin', 'bash.exe'), '')
    fs.mkdirSync(path.join(root, 'usr', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(root, 'usr', 'bin', 'bash.exe'), '')
    try {
      const prefix = computePathPrefix({ GIT_INSTALL_ROOT: root }, 'win32', () => undefined)
      const bin = path.join(root, 'bin').replace(/\\/g, '/')
      const usrBin = path.join(root, 'usr', 'bin').replace(/\\/g, '/')
      expect(prefix).toBe(bin + ';' + usrBin + ';')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('stays empty when no Git install is found', () => {
    expect(computePathPrefix({}, 'win32', () => undefined)).toBe('')
  })
})

describe('buildInitSourceLine', () => {
  it('sources the script, logs errors and never aborts the session', () => {
    const line = buildInitSourceLine("C:/Users/o'neil/bash-init.sh", 'C:/tmp/init.log')
    expect(line).toContain("'C:/Users/o'\\''neil/bash-init.sh'")
    expect(line).toContain("2>>'C:/tmp/init.log'")
    expect(line.trimEnd()).toMatch(/\|\| true$/)
  })
})
