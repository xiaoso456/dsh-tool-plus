import { defineConfig } from 'tsdown'

/**
 * Package-local runtime bundle. Workspace and npm dependencies stay external:
 * the Loader resolves `@deepseek-ai/dsh-*` and `@oh-my-pi/pi-natives` through
 * node_modules (workspace links / profile install), so only this package's own
 * sources are bundled into `lib/index.mjs`.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: false,
  deps: {
    neverBundle: [/^@deepseek-ai\//, /^@oh-my-pi\//],
  },
})
