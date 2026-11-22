/**
 * Archive boundary for the verbatim OMP tool files.
 *
 * OMP 18.12.6 deleted `coding-agent/src/utils/zip.ts` and promoted the archive
 * engine into `@oh-my-pi/pi-utils` (`./ar` subpath), which the upstream tools
 * now import directly (`tools/write.ts:23`, `tools/grep.ts:15`,
 * `tools/read-archive.ts:9`). Our ported tool files are still the 17.3.5
 * generation and import the old local module, so this adapter keeps their
 * symbol names and signatures intact and only redirects the implementation.
 * That keeps the diff in each verbatim file to a single import line.
 *
 * Re-exported explicitly rather than via `export *`: the surface here is a
 * contract with files we do not own, so every name has to be deliberate.
 *
 * Node compatibility: `./ar` reaches for `Bun.file`, `Bun.write`,
 * `Bun.CryptoHasher` and `Bun.hash.crc32`, all provided by
 * `src/tools/shared/bun-shim.ts` (crc32 was added with this switch; see
 * tests/unit/archive-layer.spec.ts). `tar.zst` rides `node:zlib`'s zstd.
 */
import {
  ArchiveError,
  archiveFormatFromPath,
  encodeArchive,
  extractArchive,
  formatArchiveEntryLines,
  isWritableArchiveFormat,
  listArchiveRoot,
  openArchive,
  parseArchivePathCandidates,
  readArchiveEntries as arReadArchiveEntries,
  sniffArchiveFormat,
  writeArchive as arWriteArchive,
} from '@oh-my-pi/pi-utils/ar'
import type {
  ArchiveDirectoryEntry,
  ArchiveFormat,
  ArchiveMemberContent,
  ArchiveNode,
  ArchivePathCandidate,
  ArchiveReader,
  ArchiveSource,
  ExtractedArchiveFile,
  OpenArchiveOptions,
} from '@oh-my-pi/pi-utils/ar'

export {
  ArchiveError,
  archiveFormatFromPath,
  extractArchive,
  formatArchiveEntryLines,
  isWritableArchiveFormat,
  listArchiveRoot,
  openArchive,
  parseArchivePathCandidates,
  sniffArchiveFormat,
}
export type {
  ArchiveDirectoryEntry,
  ArchiveFormat,
  ArchiveMemberContent,
  ArchiveNode,
  ArchivePathCandidate,
  ArchiveReader,
  ArchiveSource,
  ExtractedArchiveFile,
  OpenArchiveOptions,
}

const UTF8_DECODER = new TextDecoder()

/** A fully materialized archive as `path → bytes`. */
export type Unzipped = Record<string, Uint8Array>

/**
 * Whole-archive rewrite needs every member in memory. Declared against the
 * 17.3.5 signature (`Map<string, ArchiveMemberContent>`) so callers can still
 * `set` freshly authored text; `./ar` only ever yields bytes.
 *
 * Path-backed inputs are loaded whole before indexing, which is a deliberate
 * departure from `./ar`'s lazy file source. Its `fileByteSource.read()` is
 * `Bun.file(p).slice(start, end).bytes()` per call, so materializing an archive
 * costs one file read *per member*: measured on a 36 KB / 300-member zip,
 * rewrite went 13.6 ms (17.3.5) → 190.3 ms (raw `./ar`) purely in that loop.
 * A single `readAllBytes` brings it back to the 17.3.5 profile, and the memory
 * cost is bounded by what this function already promises — it materializes every
 * member, and the 17.3.5 implementation read the container whole as well.
 * Browsing (`openArchive`) stays lazy, so large archives keep the ranged reads.
 */
export async function readArchiveEntries(
  input: ArchiveSource,
  options?: OpenArchiveOptions,
): Promise<Map<string, ArchiveMemberContent>> {
  return await arReadArchiveEntries(await materializeSource(input), options)
}

/**
 * Resolve a path-backed archive source to its bytes (see {@link readArchiveEntries}).
 *
 * Bytes-only and caller-supplied {@link ByteSource} inputs are returned
 * untouched: the former is already materialized, and the latter expresses intent
 * to stay lazy (e.g. ranged reads over HTTP).
 */
async function materializeSource(input: ArchiveSource): Promise<ArchiveSource> {
  if (typeof input === 'string') {
    const format = archiveFormatFromPath(input)
    if (!format) throw new ArchiveError(`Unsupported archive format: ${input}`)
    return { bytes: await Bun.file(input).bytes(), format }
  }
  if ('source' in input) return input
  if ('bytes' in input) return input
  return { bytes: await Bun.file(input.path).bytes(), format: input.format }
}

/**
 * Pack `entries` into `destPath`.
 *
 * The 17.3.5 module accepted only `zip`/`tar`/`tar.gz`; `./ar` writes those
 * plus `tar.zst` and `asar`. Formats the layer can only read (`rar`, `7z`,
 * `iso`, …) are rejected here with an explicit reason instead of being
 * written as a wrong container, matching the 18.12.6 prompt's
 * "ZIP/tar families and .asar writable, others read-only".
 */
export async function writeArchive(
  destPath: string,
  format: ArchiveFormat,
  entries: Iterable<readonly [string, ArchiveMemberContent]>,
): Promise<void> {
  if (!isWritableArchiveFormat(format)) {
    throw new ArchiveError(`Archive format '${format}' is read-only`)
  }
  await arWriteArchive(destPath, format, entries)
}

/**
 * Decode an in-memory ZIP into `path → bytes`.
 *
 * Kept as the 17.3.5 record shape because the markit converters index into it
 * directly (`pptx.ts` resolves relationship targets by path). `./ar` exposes
 * no synchronous container decode — its byte sources are async — so this is a
 * promise where the old shim was sync; every caller already runs inside
 * `async convert`.
 */
export async function unzip(bytes: Uint8Array): Promise<Unzipped> {
  const entries = await arReadArchiveEntries({ bytes, format: 'zip' })
  const materialized: Unzipped = {}
  for (const [memberPath, memberBytes] of entries) materialized[memberPath] = memberBytes
  return materialized
}

/** Read one materialized member as UTF-8 text, or `undefined` when absent. */
export function unzipText(entries: Unzipped, entryPath: string): string | undefined {
  const data = entries[entryPath]
  return data ? UTF8_DECODER.decode(data) : undefined
}

/**
 * Frame `entries` into an in-memory ZIP. Accepts the 17.3.5 record shape and
 * the iterable pair shape alike, since only tests have used it so far.
 */
export async function zip(
  entries: Record<string, Uint8Array> | Iterable<readonly [string, Uint8Array]>,
): Promise<Uint8Array> {
  const members = Symbol.iterator in entries
    ? (entries as Iterable<readonly [string, Uint8Array]>)
    : Object.entries(entries as Record<string, Uint8Array>)
  return await encodeArchive('zip', members)
}
