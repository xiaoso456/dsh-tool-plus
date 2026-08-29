/**
 * S-8: bun-shim stripANSI must match real Bun.stripANSI byte-for-byte.
 *
 * Golden baseline: tests/fixtures/baseline-bun.json — 24 corpus
 * cases with expected outputs captured from REAL Bun (Bun.stripANSI + pi-utils
 * sanitizeText). The old hand-written regex lost data on OSC8 hyperlinks
 * (greedy OSC branch ate text between terminators) and left private-CSI / DCS /
 * unterminated-OSC / ESC+intermediate / double-ESC residue behind (13/24
 * diffs); the shim now runs a full ECMA-48 state machine (see
 * src/tools/shared/bun-shim.ts) and src/tools/bash/sanitize-text.ts re-exports
 * that single implementation on top of native String.prototype.toWellFormed.
 *
 * Baseline provenance: originally captured under tool-plus-lab/audit-probes/S8
 * (S-8 probe); that directory went away with the lab cleanup on 2026-08-29, so
 * the fixture was regenerated from a rebuilt 24-case corpus covering the same
 * escape classes, captured from REAL Bun 1.4.0 (bun tmp-regen-baseline.mjs →
 * tests/fixtures/baseline-bun.json).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sanitizeText } from '../../src/tools/bash/sanitize-text.ts'

interface BaselineCase {
  name: string
  input: string
  sanitized: string
  stripped: string
}

const baseline = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../fixtures/baseline-bun.json', import.meta.url)),
    'utf8',
  ),
) as BaselineCase[]

// Installed by tests/vitest-setup.ts before any module loads — this is the
// exact install surface (installBunShim → globalThis.Bun.stripANSI) that
// pi-utils sanitizeText calls on every bash output chunk.
const bun = (globalThis as unknown as { Bun: { stripANSI(text: string): string } }).Bun

describe('S-8: shim Bun.stripANSI === real Bun (baseline-bun.json)', () => {
  for (const c of baseline) {
    it(`stripANSI: ${c.name}`, () => {
      expect(bun.stripANSI(c.input)).toBe(c.stripped)
    })
  }
})

describe('S-8: sanitizeText normalization (sanitize-text.ts re-exports the shim state machine)', () => {
  for (const c of baseline) {
    it(`sanitizeText: ${c.name}`, () => {
      expect(sanitizeText(c.input)).toBe(c.sanitized)
    })
  }
})