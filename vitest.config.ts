import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const SHIM = (p: string): string => fileURLToPath(new URL(`./${p}`, import.meta.url))

/**
 * Unit + keyless composition-boot tests. All @deepseek-ai/* imports resolve
 * through the installed npm packages (exports → lib), so no tsconfig paths
 * plugin is needed.
 */
export default defineConfig({
  resolve: {
    // Mirror tsdown's Bun→Node shim aliases for the test runner.
    alias: {
      'bun': SHIM('src/tools/shared/bun-named-shim.ts'),
      'bun:ffi': SHIM('src/tools/shared/bun-ffi-shim.ts'),
      'bun:sqlite': SHIM('src/tools/shared/bun-sqlite-shim.ts'),
      // OMP tests import { describe, expect, it } from "bun:test" (verbatim
      // copies); map them onto vitest so the originals run unmodified.
      'bun:test': SHIM('tests/bun-test-shim.ts'),
      'node:fs/promises': SHIM('src/tools/shared/fs-promises-shim.ts'),
    },
  },
  plugins: [
    {
      name: 'text-imports',
      transform(code, id) {
        if (id.endsWith('.md') || id.endsWith('.lark') || id.endsWith('.html')) {
          return { code: `export default ${JSON.stringify(code)}` }
        }
      },
    },
  ],
  define: {
    // Bun/vitest: pi-ai reads import.meta.dir at module load (Node supports
    // it natively; vite rewrites import.meta in transformed modules).
    'import.meta.dir': JSON.stringify(process.cwd()),
  },
  test: {
    include: [
      'tests/unit/**/*.spec.ts',
      'tests/boot/**/*.spec.ts',
      // OMP's own hashline test suite (verbatim, run unmodified via bun:test shim).
      'src/tools/hashline/omp-hashline/test/*.test.ts',
    ],
    testTimeout: 60_000,
    // OMP tool code (Bun-origin) needs the Bun global before any module
    // imports run (pi-utils reads Bun.env at load time).
    setupFiles: ['tests/vitest-setup.ts'],
  },
})
