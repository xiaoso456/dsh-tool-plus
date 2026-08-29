/**
 * S-15a / S-15b: fs-side shim correctness.
 *
 * S-15a: BunFileSliceShim.#sliced() must positionally read the slice window
 * (fs/promises open + fh.read at [start, end)) instead of whole-file read +
 * subarray (probe audit-probes/S15/s15-slice.ts: 30MB file, slice(1000,2000)
 * spiked 29.7MB under the shim vs 0.8MB under real Bun — memory behavior is
 * probe-verified and deliberately NOT re-tested here; no big-file case).
 * Negative / out-of-range endpoints must follow Bun's Blob window semantics:
 * slice(-8) is a window of length 8, so the sliced object's `size` getter is
 * 8 (was total+8 with correct bytes).
 *
 * S-15b: fs/promises exists() swallows ALL stat errors like real Bun
 * (ENAMETOOLONG on a 60k-char path → false; probe s15-exists4.ts) — not just
 * ENOENT.
 */

import * as fs from 'node:fs'
import { exists } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

/** The slice view the shim hands back (Blob semantics: size/bytes at least). */
interface SlicedBunFile {
  readonly size: number
  bytes(): Promise<Uint8Array>
}

// Bun global installed by tests/vitest-setup.ts (installBunShim).
const bun = (globalThis as unknown as {
  Bun: { file(p: string): { slice(start?: number, end?: number): SlicedBunFile } }
}).Bun

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fs-shims-'))
const filePath = path.join(dir, 'pattern.bin')

// ~1MB deterministic pattern: byte i = i & 0xff with ASCII sentinels at the
// probed window edges so failures read clearly.
const SIZE = 1024 * 1024
const content = Buffer.alloc(SIZE)
for (let i = 0; i < SIZE; i++) content[i] = i & 0xff
content.write('HEAD-SLICE', 0)
content.write('TAIL-8BYTES', SIZE - 11)
fs.writeFileSync(filePath, content)

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('S-15a: BunFile.slice — positional read + Blob window semantics', () => {
  it('slice(1000, 2000): bytes() reads only the window; size = 1000', async () => {
    const sliced = bun.file(filePath).slice(1000, 2000)
    expect(sliced.size).toBe(1000)
    const bytes = await sliced.bytes()
    expect(bytes.byteLength).toBe(1000)
    expect(Buffer.from(bytes).equals(content.subarray(1000, 2000))).toBe(true)
  })

  it('slice(0, 16): sqlite-magic shape reads the head window; size = 16', async () => {
    const sliced = bun.file(filePath).slice(0, 16)
    expect(sliced.size).toBe(16)
    const bytes = await sliced.bytes()
    expect(bytes.byteLength).toBe(16)
    expect(Buffer.from(bytes).equals(content.subarray(0, 16))).toBe(true)
  })

  it('slice(-8): window of length 8 (last 8 bytes); size getter = 8, not total+8', async () => {
    const sliced = bun.file(filePath).slice(-8)
    expect(sliced.size).toBe(8)
    const bytes = await sliced.bytes()
    expect(bytes.byteLength).toBe(8)
    expect(Buffer.from(bytes).equals(content.subarray(SIZE - 8))).toBe(true)
  })

  it('slice(size + 5): past EOF → empty window; size = 0', async () => {
    const sliced = bun.file(filePath).slice(SIZE + 5)
    expect(sliced.size).toBe(0)
    const bytes = await sliced.bytes()
    expect(bytes.byteLength).toBe(0)
  })
})

describe('S-15b: fs/promises exists() swallows all stat errors (Bun semantics)', () => {
  it('missing path → false', async () => {
    expect(await exists(path.join(dir, 'nope.bin'))).toBe(false)
  })

  it('existing path → true', async () => {
    expect(await exists(filePath)).toBe(true)
  })

  it('60k-char path (ENAMETOOLONG) → false, does not throw', async () => {
    const longPath = path.join(dir, 'x'.repeat(60_000))
    expect(await exists(longPath)).toBe(false)
  })
})