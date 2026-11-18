import { describe, expect, it } from 'vitest'
import { crumbsOf, dirOfPath, firstMatchIndex, formatSize, parentOfPath } from '../../src/client/path-text.ts'

describe('dirOfPath', () => {
  it('takes the folder of a full file path', () => {
    expect(dirOfPath('D:/tools/zip.exe')).toBe('D:/tools')
    expect(dirOfPath('D:\\tools\\zip.exe')).toBe('D:/tools')
    expect(dirOfPath('  D:/tools/zip.exe  ')).toBe('D:/tools')
  })

  it('keeps a folder that was typed with its separator', () => {
    expect(dirOfPath('D:/tools/')).toBe('D:/tools/')
    expect(dirOfPath('D:/')).toBe('D:/')
  })

  it('gives up when there is no folder to start from', () => {
    expect(dirOfPath('')).toBeUndefined()
    expect(dirOfPath('   ')).toBeUndefined()
    expect(dirOfPath('zip.exe')).toBeUndefined()
  })

  it('puts the separator back on a bare drive letter', () => {
    expect(dirOfPath('D:\\zip.exe')).toBe('D:/')
  })

  it('treats a typed folder without a trailing slash as the folder itself', () => {
    expect(dirOfPath('D:/tools')).toBe('D:/tools/')
    expect(dirOfPath('D:/Program Files/Git')).toBe('D:/Program Files/Git/')
  })

  it('still treats a dotted last segment as a file', () => {
    expect(dirOfPath('D:/tools/v1.2.exe')).toBe('D:/tools')
    expect(dirOfPath('D:/tools/archive.tar.gz')).toBe('D:/tools')
  })
})

describe('crumbsOf', () => {
  it('splits a windows path and keeps each prefix usable', () => {
    expect(crumbsOf('D:/tools/bin')).toEqual([
      { label: 'D:', path: 'D:/' },
      { label: 'tools', path: 'D:/tools' },
      { label: 'bin', path: 'D:/tools/bin' },
    ])
  })

  it('splits a posix path without losing the leading slash', () => {
    expect(crumbsOf('/usr/local')).toEqual([
      { label: 'usr', path: '/usr' },
      { label: 'local', path: '/usr/local' },
    ])
  })

  it('has nothing to show for an empty string', () => {
    expect(crumbsOf('')).toEqual([])
  })
})

describe('parentOfPath', () => {
  it('steps up one level and stops at a root', () => {
    expect(parentOfPath('D:/tools/bin')).toBe('D:/tools')
    expect(parentOfPath('D:/tools/bin/')).toBe('D:/tools')
    expect(parentOfPath('D:/tools')).toBe('D:/')
    expect(parentOfPath('D:/')).toBeNull()
    expect(parentOfPath('/usr/local')).toBe('/usr')
    expect(parentOfPath('/')).toBeNull()
  })
})

describe('firstMatchIndex', () => {
  const names = ['alpha.exe', 'Zip.exe', 'zstd.exe', 'Zulu.exe']

  it('jumps to the first prefix match, case-insensitively', () => {
    expect(firstMatchIndex(names, 'z', -1)).toBe(1)
    expect(firstMatchIndex(names, 'zs', -1)).toBe(2)
  })

  it('continues after the current row so repeated keys cycle', () => {
    expect(firstMatchIndex(names, 'z', 1)).toBe(2)
    expect(firstMatchIndex(names, 'z', 3)).toBe(1)
  })

  it('returns -1 when nothing matches', () => {
    expect(firstMatchIndex(names, 'q', -1)).toBe(-1)
    expect(firstMatchIndex(names, '', -1)).toBe(-1)
    expect(firstMatchIndex([], 'z', -1)).toBe(-1)
  })
})

describe('formatSize', () => {
  it('says nothing for a folder', () => {
    expect(formatSize(null)).toBe('')
  })

  it('picks a readable unit', () => {
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(1023)).toBe('1023 B')
    expect(formatSize(2048)).toBe('2 KB')
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB')
  })

  it('never prints 1024 of a smaller unit', () => {
    expect(formatSize(1024 * 1024 - 1)).toBe('1.0 MB')
    expect(formatSize(1024 * 1024 * 1024 - 1)).toBe('1.0 GB')
    expect(formatSize(3 * 1024 * 1024 * 1024)).toBe('3.0 GB')
  })
})
