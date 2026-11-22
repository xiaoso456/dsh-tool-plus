/**
 * P0-1: the Bun surface `@oh-my-pi/pi-utils/ar` needs must be satisfied by
 * `src/tools/shared/bun-shim.ts`.
 *
 * OMP 18.12.6 made pi-utils the single archive boundary (`./ar` subpath) and
 * deleted `coding-agent/src/utils/zip.ts`, so our vendored 17.3.5 copy is being
 * replaced by a direct import. That layer reaches for exactly four Bun APIs:
 * `Bun.file`, `Bun.write`, `Bun.CryptoHasher` and `Bun.hash.crc32`. The first
 * three already existed; `crc32` did not, which made every archive write throw
 * "Bun.hash.crc32 is not a function" (pi-utils src/ar/checksums.ts:13).
 *
 * The checksum vectors pin the contract, but only the round-trip actually proves
 * the shim surface is complete: it exercises fileByteSource (Bun.file), the ZIP
 * encoder's CRC table, and Bun.write on the way out. asar is asserted because it
 * is the capability the vendored 17.3.5 layer never had.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  memoryByteSource,
  openArchive,
  writeArchive,
  type WritableArchiveFormat,
} from '@oh-my-pi/pi-utils/ar'
import {
  readArchiveEntries,
  type ArchiveMemberContent,
} from '../../src/tools/shared/archive/index.ts'

interface ShimBun {
  hash: { crc32(data: string | ArrayBuffer | Uint8Array, seed?: number): number }
}

// Installed by tests/vitest-setup.ts before this module loads.
const bun = (globalThis as unknown as { Bun: ShimBun }).Bun

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value)

describe('P0-1: shim Bun.hash.crc32', () => {
  it('matches the IEEE 802.3 check value', () => {
    expect(bun.hash.crc32(utf8('123456789'))).toBe(0xcbf43926)
  })

  it('chains through the seed exactly like Bun', () => {
    const head = bun.hash.crc32(utf8('12345678'))
    expect(bun.hash.crc32(utf8('9'), head)).toBe(0xcbf43926)
  })

  it('stays an unsigned 32-bit integer', () => {
    const crc = bun.hash.crc32(utf8('tool-plus'))
    expect(crc >>> 0).toBe(crc)
  })

  it('hashes an empty input to 0', () => {
    expect(bun.hash.crc32(new Uint8Array(0))).toBe(0)
  })

  it('accepts every input shape Bun.hash takes', () => {
    const expected = bun.hash.crc32(utf8('abc'))
    expect(bun.hash.crc32('abc')).toBe(expected)
    expect(bun.hash.crc32(utf8('abc').buffer as ArrayBuffer)).toBe(expected)
  })
})

describe('P0-1: archive round-trip through the upstream layer', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tool-plus-archive-'))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const roundTrip = async (format: WritableArchiveFormat, extension: string) => {
    const archive = path.join(dir, `bundle-${format.replace(/\./g, '-')}.${extension}`)
    await writeArchive(archive, format, [
      ['inner.txt', 'member content\n'],
      ['nested/deep.txt', 'nested\n'],
    ] as const)

    const reader = await openArchive(archive)
    expect(reader.format).toBe(format)
    expect(reader.listDirectory().map(entry => entry.name)).toContain('inner.txt')

    const file = await reader.readFile('inner.txt')
    expect(new TextDecoder().decode(file.bytes)).toBe('member content\n')

    const nested = await reader.readFile('nested/deep.txt')
    expect(new TextDecoder().decode(nested.bytes)).toBe('nested\n')
  }

  it('round-trips zip', async () => {
    await roundTrip('zip', 'zip')
  })

  it('round-trips tar', async () => {
    await roundTrip('tar', 'tar')
  })

  it('round-trips tar.gz', async () => {
    await roundTrip('tar.gz', 'tar.gz')
  })

  it('round-trips tar.zst', async () => {
    await roundTrip('tar.zst', 'tar.zst')
  })

  it('round-trips asar, which the vendored 17.3.5 layer never supported', async () => {
    await roundTrip('asar', 'asar')
  })
})

/**
 * The adapter's `readArchiveEntries` takes the same four-way `ArchiveSource`
 * union the upstream layer does, and resolves path-backed forms to bytes first
 * (see the comment on the function: lazy per-member file reads made a 300-member
 * rewrite 14x slower). Production only ever passes `{ path, format }`, so the
 * other three branches had no coverage at all, and that is exactly where the
 * narrowing was first written wrong.
 *
 * The O(1)-file-read property itself is measured by the one-off benchmark
 * recorded in docs/draft/omp-18.12.6-alignment.md rather than asserted here:
 * a timing guard on a 36 KB fixture is flaky, and a call-counting guard would
 * pin the shim's internals instead of our contract. What this suite pins is the
 * part that can regress silently: every accepted source form must decode to the
 * same members, and a caller-supplied ByteSource must be left lazy.
 */
describe('P0-1: adapter archive source forms', () => {
  let dir: string
  let zipPath: string
  let zipBytes: Uint8Array

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tool-plus-sources-'))
    zipPath = path.join(dir, 'fixture.zip')
    await writeArchive(zipPath, 'zip', [
      ['inner.txt', 'member content\n'],
      ['nested/deep.txt', 'nested\n'],
    ] as const)
    zipBytes = new Uint8Array(await readFile(zipPath))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const decode = (value: ArchiveMemberContent): string => {
    if (typeof value === 'string') return value
    if (!(value instanceof Uint8Array)) throw new Error('expected bytes from the archive layer')
    return new TextDecoder().decode(value)
  }

  const expectSameMembers = (entries: Map<string, ArchiveMemberContent>) => {
    expect([...entries.keys()].sort()).toEqual(['inner.txt', 'nested/deep.txt'])
    expect(decode(entries.get('inner.txt')!)).toBe('member content\n')
    expect(decode(entries.get('nested/deep.txt')!)).toBe('nested\n')
  }

  it('accepts a bare path and infers the format', async () => {
    expectSameMembers(await readArchiveEntries(zipPath))
  })

  it('accepts a format-tagged path, the form the write tool uses', async () => {
    expectSameMembers(await readArchiveEntries({ path: zipPath, format: 'zip' }))
  })

  it('accepts in-memory bytes', async () => {
    expectSameMembers(await readArchiveEntries({ bytes: zipBytes, format: 'zip' }))
  })

  it('passes a caller-supplied ByteSource through untouched', async () => {
    let reads = 0
    const source = memoryByteSource(zipBytes)
    const counting = {
      size: source.size,
      async read(start: number, end: number) {
        reads += 1
        return await source.read(start, end)
      },
    }
    expectSameMembers(await readArchiveEntries({ source: counting, format: 'zip' }))
    // Lazy on purpose: materializing here would defeat ranged reads over HTTP.
    expect(reads).toBeGreaterThan(0)
  })

  it('rejects a path whose extension names no known format', async () => {
    await expect(readArchiveEntries(path.join(dir, 'mystery.bin'))).rejects.toThrow(
      /Unsupported archive format/,
    )
  })
})

