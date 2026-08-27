/**
 * Vitest shim for `bun:test` — lets OMP's bun:test test files
 * (src/tools/hashline/test/*.test.ts, copied verbatim)
 * run unmodified under vitest.
 *
 * Only the surface the OMP tests actually use is mapped (describe/it/expect);
 * add more exports here if future copied tests need them.
 */
export { describe, expect, it } from 'vitest'
