import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ensurePiNativesPatched } from '../../scripts/patch-pi-natives.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BUGGY = 'const nativeDir = overrides.nativeDir ?? path.join(import.meta.dir, "..", "native");\n'
const PATCHED = BUGGY.replace('import.meta.dir,', 'import.meta.dirname,')

interface Fixture {
  root: string
  store: string
  target: string
  cleanup: () => void
}

function makeFixture(content: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'tool-plus-pi-natives-'))
  const store = join(root, 'store', 'loader-state.js')
  mkdirSync(join(root, 'store'), { recursive: true })
  writeFileSync(store, content)

  const native = join(root, 'node_modules', '@oh-my-pi', 'pi-natives', 'native')
  mkdirSync(native, { recursive: true })
  const target = join(native, 'loader-state.js')
  linkSync(store, target)

  return {
    root,
    store,
    target,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

describe('pi-natives bootstrap compat', () => {
  it('patches a hardlinked loader-state without touching the store copy', () => {
    const f = makeFixture(BUGGY)
    try {
      const result = ensurePiNativesPatched({ target: f.target })
      expect(result.error).toBeUndefined()
      expect(result.patched).toBe(1)
      expect(readFileSync(f.store, 'utf8')).toContain('import.meta.dir,')
      expect(readFileSync(f.target, 'utf8')).toContain('import.meta.dirname')
      expect(statSync(f.target).nlink).toBe(1)
      expect(statSync(f.store).nlink).toBe(1)

      const again = ensurePiNativesPatched({ target: f.target })
      expect(again.patched).toBe(0)
      expect(again.detached).toBe(0)
    } finally {
      f.cleanup()
    }
  })

  it('detaches an already patched file that is still hardlinked', () => {
    const f = makeFixture(PATCHED)
    try {
      const result = ensurePiNativesPatched({ target: f.target })
      expect(result.error).toBeUndefined()
      expect(result.patched).toBe(0)
      expect(result.detached).toBe(1)
      expect(readFileSync(f.store, 'utf8')).toContain('import.meta.dirname')
      expect(statSync(f.target).nlink).toBe(1)
    } finally {
      f.cleanup()
    }
  })

  it('returns an error for a missing target instead of throwing', () => {
    const result = ensurePiNativesPatched({ target: join(tmpdir(), 'tool-plus-missing', 'loader-state.js') })
    expect(result.inspected).toBe(0)
    expect(result.error).toBeTruthy()
  })

  it('routes the package entry through the compat bootstrap', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      main?: string
      exports?: Record<string, { default?: string }>
    }
    expect(pkg.main).toBe('lib/pi-natives-bootstrap.mjs')
    expect(pkg.exports?.['.']?.default).toBe('./lib/pi-natives-bootstrap.mjs')
  })

  it.skipIf(!existsSync(join(ROOT, 'lib/pi-natives-bootstrap.mjs')))('patches before importing the plugin entry', () => {
    const source = readFileSync(join(ROOT, 'lib/pi-natives-bootstrap.mjs'), 'utf8')
    const ensureAt = source.indexOf('ensurePiNativesPatched')
    const importAt = source.indexOf('./index.mjs')
    expect(ensureAt).toBeGreaterThanOrEqual(0)
    expect(importAt).toBeGreaterThan(ensureAt)
    expect(source).not.toMatch(/from\s+['"]@oh-my-pi\/pi-natives['"]/)
  })
})
