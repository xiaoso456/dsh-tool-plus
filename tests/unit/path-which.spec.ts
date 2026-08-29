import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { findOnPath } from '../../src/tools/bash/which.ts'

describe('findOnPath', () => {
  it('returns absolute/relative candidates that name an existing file, undefined otherwise', () => {
    const existing = path.join(os.tmpdir(), 'dsh-which-probe.txt')
    fs.writeFileSync(existing, 'x', 'utf-8')
    try {
      expect(findOnPath(existing)).toBe(path.resolve(existing))
      expect(findOnPath(path.join(os.tmpdir(), 'dsh-which-definitely-missing-9f3a.txt'))).toBeUndefined()
    } finally {
      fs.unlinkSync(existing)
    }
  })

  it('resolves a well-known executable from PATH', () => {
    const found = findOnPath(process.platform === 'win32' ? 'node.exe' : 'node')
    expect(found).toBeDefined()
    expect(fs.existsSync(found!)).toBe(true)
  })

  it('appends PATHEXT candidates on win32 and resolves bare extensionless names', () => {
    if (process.platform !== 'win32') return
    const found = findOnPath('cmd')
    expect(found).toBeDefined()
    expect(found!.toLowerCase()).toMatch(/cmd(\.com|\.exe)$/)
  })

  it('returns undefined for garbage names and honors an injected env', () => {
    expect(findOnPath('definitely-not-a-real-binary-4e7f21')).toBeUndefined()
    expect(findOnPath('node', { PATH: '' })).toBeUndefined()
  })
})