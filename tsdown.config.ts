import { defineConfig } from 'tsdown'
import { fileURLToPath } from 'node:url'

const SHIM = (p: string): string => fileURLToPath(new URL(`./${p}`, import.meta.url))

/**
 * Browser-bundle externals the web module loader can answer from its frozen
 * table: the platform seed plus this package's injected client deps. The card
 * imports only React (value) plus slot/scope types (erased), so everything
 * else is inlined.
 */
const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-settings',
]

const PLUGIN_ID = '@xiaoso/dsh-tool-plus'

export default defineConfig([
  {
    // Node half: the tool runtime. Workspace and npm dependencies stay
    // external — the Loader resolves `@deepseek-ai/dsh-*` and
    // `@oh-my-pi/pi-natives` through node_modules (workspace links / profile
    // install), so only this package's own sources are bundled.
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: false,
    // OMP/bundled packages read `Bun.env` at module top-level, so the shim
    // must be installed before ANY module body in this chunk graph runs.
    outputOptions: {
      banner: `import { installBunShim as __installBunShim } from './bun-shim.mjs'; __installBunShim();`,
    },
    define: {
      // Bun has import.meta.dir; Node 22 only has import.meta.dirname.
      'import.meta.dir': 'import.meta.dirname',
    },
    // OMP imports prompt/lark/html files as text (`with { type: "text" }`).
    loader: {
      '.md': 'text',
      '.lark': 'text',
      '.html': 'text',
    },
    // Redirect Bun-only modules to Node shims so the OMP tool code bundled
    // into the Node half runs unchanged under Node (absolute paths — rolldown
    // resolves alias replacements against the importer, not the cwd).
    alias: {
      'bun:sqlite': SHIM('src/tools/shared/bun-sqlite-shim.ts'),
      'node:fs/promises': SHIM('src/tools/shared/fs-promises-shim.ts'),
      'bun': SHIM('src/tools/shared/bun-named-shim.ts'),
      'bun:ffi': SHIM('src/tools/shared/bun-ffi-shim.ts'),
      // Fused in-repo OMP hashline sources (no package.json / link: anymore).
      '@oh-my-pi/hashline': SHIM('src/tools/hashline/engine/index.ts'),
    },
    deps: {
      // @deepseek-ai/* and pi-natives resolve through node_modules (workspace
      // links / profile install). @oh-my-pi/* source packages (main →
      // src/*.ts) are pure-TS — Node cannot strip types under node_modules,
      // so they MUST be bundled in (deps.alwaysBundle).
      neverBundle: [/^@deepseek-ai\//, /^@oh-my-pi\/pi-natives/],
      alwaysBundle: [
        /^@oh-my-pi\/pi-utils/,
        /^@oh-my-pi\/pi-tui/,
        /^@oh-my-pi\/pi-agent-core/,
        /^@oh-my-pi\/pi-ai/,
        /^@oh-my-pi\/pi-catalog/,
        /^@oh-my-pi\/pi-wire/,
        /^@oh-my-pi\/hashline/,
      ],
    },
  },
  {
    // Standalone Bun-shim entry (no banner): the main bundle imports this via
    // its banner to install the Bun global before any module body runs.
    entry: { 'bun-shim': 'src/tools/shared/bun-shim.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: false,
    deps: {
      // json5 is CJS; keep it external so Node's ESM default-interop applies.
      neverBundle: [/^json5/],
    },
  },
  {
    // Browser half: the settings card, emitted as the closure-factory bundle
    // the module loader expects (`window.__ModuleLoader__.load({id, factory})`).
    // It lands next to the node half as exactly lib/client.js.
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    dts: false,
    clean: false,
    deps: {
      neverBundle: CLIENT_EXTERNALS,
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
