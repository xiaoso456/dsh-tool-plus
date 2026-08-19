import { defineConfig } from 'tsdown'

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

const PLUGIN_ID = '@xiaoso/dsh-bash-plus'

export default defineConfig([
  {
    // Node half: the tool runtime. Workspace and npm dependencies stay
    // external — the Loader resolves `@deepseek-ai/dsh-*` and
    // `@oh-my-pi/pi-natives` through node_modules (workspace links / profile
    // install), so only this package's own sources are bundled.
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
