/**
 * P0-1 format matrix: every archive container `@oh-my-pi/pi-utils/ar` can decode
 * must actually decode under our Node runtime.
 *
 * This is where the Bun-compatibility risk lives. The upstream layer reaches for
 * `Bun.file`/`Bun.write`/`Bun.CryptoHasher`/`Bun.hash.crc32`, and those calls
 * sit inside per-format decoders (crc32 in zip + cab, sha256 in asar, file
 * sources everywhere). A shim gap that only shows up on an exotic container
 * would surface as a model-facing "not found" instead of a decode error, so the
 * coverage here is deliberately one real fixture per container family rather
 * than one synthetic zip.
 *
 * Fixtures are the upstream ones from `packages/utils/test/ar/` (OMP v18.12.6,
 * shipped inside `test/fixtures/ar.tar.gz`), copied one by one so the repo only
 * carries the ~5.7 KB this table needs. Expected listings were captured from a
 * probe run against these exact bytes, never guessed.
 *
 * The vendored 17.3.5 module could read only zip/tar/tar.gz, so every case below
 * except the zip family is new capability.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  type ArchiveFormat,
  openArchive,
  sniffArchiveFormat,
  unzip,
  unzipText,
  writeArchive,
} from '../../src/tools/shared/archive/index.ts'

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/archive/${name}`, import.meta.url))))

const tmpDirs: string[] = []
const tmpDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tool-plus-matrix-'))
  tmpDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Case {
  file: string
  format: ArchiveFormat
  /** `listDirectory('')` names, exactly as the decoder reports them. */
  topLevel: readonly string[]
}

// One fixture per container family the layer claims to read.
const READABLE: readonly Case[] = [
  { file: 'asar-valid.asar', format: 'asar', topLevel: ['docs', 'empty.bin'] },
  { file: 'rar4-default.rar', format: 'rar', topLevel: ['input'] },
  { file: 'rar5-default.rar', format: 'rar', topLevel: ['input'] },
  { file: 'sevenzip-default.7z', format: '7z', topLevel: ['empty.txt', 'nested'] },
  { file: 'cab-mszip.cab', format: 'cab', topLevel: ['nested', 'root.txt'] },
  { file: 'cpio-newc.cpio', format: 'cpio', topLevel: ['dir', 'hard.txt', 'root.txt'] },
  { file: 'lzh-level2-lh7.lzh', format: 'lzh', topLevel: ['hello.txt', 'nested'] },
  { file: 'arj-method1.arj', format: 'arj', topLevel: ['hello.txt', 'nested'] },
  { file: 'minimal-gzip.rpm', format: 'rpm', topLevel: ['dir', 'hard.txt', 'root.txt'] },
  { file: 'tiny.deb', format: 'deb', topLevel: ['control', 'debian-binary', 'usr'] },
  { file: 'unix-gnu.a', format: 'ar', topLevel: ['nested', 'short.txt'] },
  { file: 'zip-zip64.zip', format: 'zip', topLevel: ['zip64.txt'] },
  { file: 'zip-zstd.zip', format: 'zip', topLevel: ['nested'] },
]

describe('P0-1: every readable container decodes under the Node shim', () => {
  for (const testCase of READABLE) {
    it(`${testCase.file} (${testCase.format})`, async () => {
      const bytes = fixture(testCase.file)
      expect(sniffArchiveFormat(bytes)).toBe(testCase.format)

      const reader = await openArchive({ bytes, format: testCase.format })
      expect(reader.format).toBe(testCase.format)
      expect(reader.listDirectory('').map(entry => entry.name)).toEqual([...testCase.topLevel])
    })
  }

  it('reads member payloads, not just the index', async () => {
    const reader = await openArchive({ bytes: fixture('asar-valid.asar'), format: 'asar' })
    const hello = await reader.readFile('docs/hello.txt')
    // Size is what the index reported; the payload must decode to the same span.
    expect(hello.bytes.byteLength).toBe(11)
    expect(hello.isDirectory).toBe(false)
  })
})

describe('P0-1: hostile archives are refused, not silently half-read', () => {
  it('reports encrypted members with a reason', async () => {
    const bytes = fixture('zip-encrypted.zip')
    await expect(openArchive({ bytes, format: 'zip' })).rejects.toThrow(/Encrypted ZIP member/)
  })

  it('exposes nothing that escapes the archive root', async () => {
    // zip-traversal.zip carries '..' members; the reader normalizes them away
    // rather than handing callers a path outside the container.
    const reader = await openArchive({ bytes: fixture('zip-traversal.zip'), format: 'zip' })
    expect(reader.listDirectory('')).toEqual([])
  })
})

describe('P0-1: in-memory ZIP helpers keep the 17.3.5 shape', () => {
  it('unzip returns a record the converters can index', async () => {
    const entries = await unzip(fixture('zip-zip64.zip'))
    // pptx.ts resolves relationship targets with entries[path], so this shape is load bearing.
    expect(entries['zip64.txt']).toBeInstanceOf(Uint8Array)
    expect(unzipText(entries, 'zip64.txt')).toBeTruthy()
  })

  it('unzipText returns undefined for an absent member', async () => {
    const entries = await unzip(fixture('zip-zip64.zip'))
    expect(unzipText(entries, 'nope.txt')).toBeUndefined()
  })
})

describe('P0-1: write contract matches the 18.12.6 prompt', () => {
  it('rejects archive formats the layer can only read', async () => {
    const target = path.join(tmpDir(), 'out.rar')
    await expect(writeArchive(target, 'rar', [['a.txt', 'a']])).rejects.toThrow(/read-only/)
  })

  it('writes the tar.zst container the 17.3.5 module never knew', async () => {
    const target = path.join(tmpDir(), 'out.tar.zst')
    await writeArchive(target, 'tar.zst', [['a.txt', 'a']])
    const reader = await openArchive(target)
    expect(reader.format).toBe('tar.zst')
    expect(reader.listDirectory('').map(entry => entry.name)).toEqual(['a.txt'])
  })
})
