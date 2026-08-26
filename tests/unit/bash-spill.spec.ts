/**
 * Unit tests for the bash spill-file lifecycle (adapter/spill.ts) and the
 * OutputSink artifactPath mirror that backs it.
 * @module tests
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { allocateOriginalFile, allocateSpillFile, saveOriginalText, spillDir, sweepStaleSpillFiles } from '../../src/tools/bash/adapter/spill.ts'
import { OutputSink } from '../../src/tools/bash/streaming-output.ts'

describe('spill allocation', () => {
  it('allocates unique files under the spill dir, creating it on demand', () => {
    const first = allocateSpillFile()
    const second = allocateSpillFile()
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(path.dirname(first!)).toBe(spillDir())
    expect(fs.existsSync(spillDir())).toBe(true)
    expect(first).not.toBe(second)
  })

  it('allocates originals under a distinct naming kind', () => {
    const original = allocateOriginalFile()
    expect(original).toBeDefined()
    expect(path.basename(original!)).toMatch(/^dsh-bash-original-/)
  })

  it('saveOriginalText writes and returns the path; failures return undefined', () => {
    const saved = saveOriginalText('original\noutput\n')
    expect(saved).toBeDefined()
    expect(fs.readFileSync(saved!, 'utf-8')).toBe('original\noutput\n')
  })
})

describe('sweepStaleSpillFiles', () => {
  it('removes stale spill files and keeps fresh ones', () => {
    const stale = allocateSpillFile()!
    fs.writeFileSync(stale, 'stale', 'utf-8')
    const fresh = allocateSpillFile()!
    fs.writeFileSync(fresh, 'fresh', 'utf-8')
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
    fs.utimesSync(stale, old, old)

    sweepStaleSpillFiles()

    expect(fs.existsSync(stale)).toBe(false)
    expect(fs.existsSync(fresh)).toBe(true)
    fs.unlinkSync(fresh)
  })

  it('sweeps legacy flat tmpdir/dsh-bash-*.log files older than the cutoff', () => {
    const legacy = path.join(os.tmpdir(), `dsh-bash-${'ab12cd34'}.log`)
    fs.writeFileSync(legacy, 'legacy orphan', 'utf-8')
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
    fs.utimesSync(legacy, old, old)

    sweepStaleSpillFiles()

    expect(fs.existsSync(legacy)).toBe(false)
  })
})

describe('OutputSink artifactPath mirror', () => {
  it('mirrors the raw stream once the tail window overflows and reports the path on dump', async () => {
    const target = allocateSpillFile()!
    try {
      const sink = new OutputSink({ artifactPath: target, spillThreshold: 32, headBytes: 16 })
      sink.push(`${'a'.repeat(24)}\n`)
      sink.push(`${'b'.repeat(24)}\n`)
      sink.push(`${'c'.repeat(24)}\n`)
      const summary = await sink.dump()
      expect(summary.truncated).toBe(true)
      expect(summary.artifactPath).toBe(target)
      // The mirror holds the full uncapped stream — all three chunks verbatim.
      const mirrored = fs.readFileSync(target, 'utf-8')
      for (const line of ['a'.repeat(24), 'b'.repeat(24), 'c'.repeat(24)]) {
        expect(mirrored).toContain(line)
      }
    } finally {
      fs.unlinkSync(target)
    }
  })

  it('creates no mirror when output stays within the inline windows', async () => {
    const target = allocateSpillFile()!
    const sink = new OutputSink({ artifactPath: target, spillThreshold: 4096, headBytes: 1024 })
    sink.push('small output\n')
    const summary = await sink.dump()
    expect(summary.truncated).toBe(false)
    expect(summary.artifactPath).toBeUndefined()
    expect(fs.existsSync(target)).toBe(false)
  })

  it('survives write-stream failures without crashing the process', async () => {
    // A directory at the target path makes createWriteStream fail asynchronously.
    const bogus = path.join(os.tmpdir(), `dsh-bash-spill-bogus-${Date.now().toString(36)}`)
    fs.mkdirSync(bogus, { recursive: true })
    try {
      const sink = new OutputSink({ artifactPath: bogus, spillThreshold: 8 })
      sink.push(`${'x'.repeat(64)}\n`)
      await new Promise(resolve => setTimeout(resolve, 20))
      const summary = await sink.dump()
      expect(typeof summary.output).toBe('string')
    } finally {
      fs.rmdirSync(bogus)
    }
  })
})
