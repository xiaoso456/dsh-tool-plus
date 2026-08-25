/**
 * DSH adapter shim for OMP `markit/` — the in-house document → markdown engine
 * (pdf/docx/pptx/xlsx/epub converters).
 *
 * The write adapter's `utils/markit.ts` references `../markit` only for the
 * pure types (`ConversionResult`, `StreamInfo`) and the lazy-loaded `Markit`
 * class. The real engine is Bun/native-heavy (PDF via `@oh-my-pi/pi-natives`,
 * docx via `@oh-my-pi/pi-utils/docx`, all converters via `Bun.file`) — a Bun /
 * external dependency chain, left for the unified Bun compatibility pass
 * (step.md "Bun 兼容").
 *
 * This shim re-exports the verbatim pure types (`./types`) and provides a
 * structural `Markit` class type whose runtime methods throw (never driven in
 * DSH; document conversion requires the native layer).
 */
export * from "./types"

import type { ConversionResult, StreamInfo } from "./types"

/**
 * Document → markdown engine (verbatim OMP method surface). Bun/native-backed
 * in OMP; in DSH the class is never instantiated.
 */
export class Markit {
  constructor() {
    throw new Error(
      'Markit is Bun/native-backed and not available in DSH (Bun compatibility pass pending)',
    )
  }

  async convertFile(filePath: string, extra?: { imageDir?: string }): Promise<ConversionResult> {
    throw new Error('Markit is Bun/native-backed and not available in DSH')
  }

  async convert(_input: Buffer, _streamInfo: StreamInfo): Promise<ConversionResult> {
    throw new Error('Markit is Bun/native-backed and not available in DSH')
  }
}
