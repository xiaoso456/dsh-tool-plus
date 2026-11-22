/**
 * P0-3/P0-4: `utils/grammars.ts` is the on-demand tree-sitter grammar layer
 * behind the `lang` override and the "grammar was not available" note.
 *
 * Ported from OMP v18.12.6 `utils/grammars.ts` with two documented boundary
 * adaptations (`Bun.zstdDecompressSync` → `node:zlib`, and our 17.3.5
 * `downloadFile` signature). Everything below is deliberately network-free:
 * the languages used here are either linked into the addon (`wasmGrammarFor`
 * returns `null`) or unknown (`null`), and only the downloadable ones such as
 * `verilog`/`csharp` resolve to an install record. Pinning that contract is what
 * makes the rest of this suite safe to run offline.
 */
import { describe, expect, it } from 'vitest'
import { wasmGrammarFor } from '@oh-my-pi/pi-natives'
import {
  ensureGrammar,
  ensureGrammars,
  missingGrammarsNote,
  rerunWithGrammars,
} from '../../src/tools/omp/utils/grammars.ts'

describe('P0-3: built-in and unknown languages resolve to no install record', () => {
  // This is the invariant that keeps every ensure*/rerun* call below offline.
  for (const lang of ['cpp', 'typescript', 'python', 'rust']) {
    it(`${lang} is linked into the addon`, () => {
      expect(wasmGrammarFor({ lang })).toBeNull()
    })
  }

  it('an unknown language resolves to null rather than a bogus record', () => {
    expect(wasmGrammarFor({ lang: 'definitely-not-a-lang' })).toBeNull()
  })
})

describe('P0-3: ensureGrammar short-circuits without network', () => {
  it('returns true for a built-in grammar', async () => {
    await expect(ensureGrammar({ lang: 'cpp' })).resolves.toBe(true)
  })

  it('returns true when the language is unknown', async () => {
    await expect(ensureGrammar({ lang: 'definitely-not-a-lang' })).resolves.toBe(true)
  })

  it('reports nothing installed when no language has a downloadable record', async () => {
    await expect(ensureGrammars(['definitely-not-a-lang'])).resolves.toBe(false)
  })
})

describe('P0-3: rerunWithGrammars only re-runs when an install actually happened', () => {
  it('runs once when the first pass reports no missing grammars', async () => {
    let calls = 0
    const result = await rerunWithGrammars(async () => {
      calls++
      return { matches: 3 }
    })
    expect(calls).toBe(1)
    expect(result).toEqual({ matches: 3 })
  })

  it('runs once when the missing grammars cannot be installed', async () => {
    // Not installable ⇒ cfgEscape: re-running would produce the identical
    // result, so the helper must not loop.
    let calls = 0
    const result = await rerunWithGrammars(async () => {
      calls++
      return { missingGrammars: ['definitely-not-a-lang'], matches: 0 }
    })
    expect(calls).toBe(1)
    expect(result.missingGrammars).toEqual(['definitely-not-a-lang'])
  })

  it('hands back the first pass untouched when no install happened', async () => {
    // A re-run only exists to re-query after a grammar landed. With nothing
    // installable the caller must get the original object, byte for byte: any
    // merging or re-shaping here would hide a download that never occurred.
    const first = { missingGrammars: ['definitely-not-a-lang'], matches: 7 }
    let calls = 0
    const result = await rerunWithGrammars(async () => {
      calls++
      return first
    })
    expect(calls).toBe(1)
    expect(result).toBe(first)
  })
})

describe('P0-3: the model-facing note names the skipped languages', () => {
  it('formats a single language', () => {
    expect(missingGrammarsNote(['verilog'])).toBe(
      'Skipped verilog files: grammar could not be downloaded (offline?); results exclude them.',
    )
  })

  it('joins several languages in one sentence', () => {
    expect(missingGrammarsNote(['verilog', 'csharp'])).toBe(
      'Skipped verilog, csharp files: grammar could not be downloaded (offline?); results exclude them.',
    )
  })
})
