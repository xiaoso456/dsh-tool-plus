import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_BROWSE_ENTRIES, browseDirectory } from '../../src/host/command-browse.ts'

/** Fixture tree: two folders, two executables, one text file, one dotfile. */
function buildTree(root: string): void {
  fs.mkdirSync(path.join(root, 'bin'))
  fs.mkdirSync(path.join(root, 'docs'))
  fs.writeFileSync(path.join(root, 'zip.exe'), 'MZ')
  fs.writeFileSync(path.join(root, 'zstd.cmd'), '@echo off')
  fs.writeFileSync(path.join(root, 'notes.txt'), 'x')
  fs.writeFileSync(path.join(root, '.hidden.exe'), 'x')
}

describe('browseDirectory', () => {
  let root = ''

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-browse-'))
    buildTree(root)
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('lists folders first, then executables only', () => {
    const value = browseDirectory({ dir: root })
    expect(value.entries.map(entry => entry.name)).toEqual(['bin', 'docs', 'zip.exe', 'zstd.cmd'])
    expect(value.entries[0].kind).toBe('dir')
    expect(value.entries[2]).toMatchObject({ kind: 'file', size: 2 })
    expect(value.entries[0].size).toBeNull()
  })

  it('includes everything once all files are shown', () => {
    const value = browseDirectory({ dir: root, showAll: true })
    expect(value.entries.map(entry => entry.name)).toContain('notes.txt')
  })

  it('always hides dotfiles, even with all files shown', () => {
    const value = browseDirectory({ dir: root, showAll: true })
    expect(value.entries.map(entry => entry.name)).not.toContain('.hidden.exe')
  })

  it('answers the parent folder and stops at a volume root', () => {
    const value = browseDirectory({ dir: path.join(root, 'bin') })
    expect(value.dir.endsWith('/bin')).toBe(true)
    expect(value.parent).toBe(root.replace(/\\/g, '/'))

    const volumeRoot = path.parse(root).root
    expect(browseDirectory({ dir: volumeRoot }).parent).toBeNull()
  })

  it('hands back forward slashes so the panel shows one shape', () => {
    const value = browseDirectory({ dir: root })
    expect(value.dir.includes('\\')).toBe(false)
    expect(value.entries.every(entry => !entry.path.includes('\\'))).toBe(true)
  })

  it('caps the reply and says it truncated', () => {
    const value = browseDirectory({ dir: root }, 2)
    expect(value.entries).toHaveLength(2)
    expect(value.truncated).toBe(true)
    expect(browseDirectory({ dir: root }).truncated).toBe(false)
    expect(MAX_BROWSE_ENTRIES).toBeGreaterThan(2)
  })

  it('falls back to the home folder when no directory is given', () => {
    const value = browseDirectory(undefined)
    expect(value.dir).toBe(os.homedir().replace(/\\/g, '/'))
  })

  it('names the reason instead of leaking errno', () => {
    expect(() => browseDirectory({ dir: path.join(root, 'missing') })).toThrow(/目录不存在/)
    expect(() => browseDirectory({ dir: path.join(root, 'zip.exe') })).toThrow(/不是目录/)
  })
})
