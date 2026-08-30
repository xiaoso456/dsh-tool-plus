/**
 * Unit tests for the browser-detection shell (`src/tools/shared/browser-detect.ts`):
 * candidate-table ordering per platform, PUPPETEER_EXECUTABLE_PATH priority,
 * Chrome-for-Testing cache scanning, and the probe/detect memoization split.
 * Everything is injected — no real filesystem or browser is touched.
 * @module tests
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  detectBrowser,
  probeBrowsers,
  resetBrowserDetectionForTest,
  type BrowserDetectEnv,
} from '../../src/tools/shared/browser-detect.ts'

/** Injectable env over a fake filesystem. */
function envFor(overrides: Partial<BrowserDetectEnv> = {}, existing: string[] = []): BrowserDetectEnv {
  const exists = (p: string): boolean => existing.includes(p)
  return {
    platform: 'linux',
    home: '/home/user',
    which: () => undefined,
    exists,
    ...overrides,
  }
}

afterEach(() => {
  resetBrowserDetectionForTest()
})

describe('probeBrowsers', () => {
  it('honors PUPPETEER_EXECUTABLE_PATH first (env kind)', () => {
    const env = envFor({ envPath: 'C:\\custom\\chrome.exe' })
    const found = probeBrowsers(env)
    expect(found[0]).toEqual({ kind: 'env', name: 'PUPPETEER_EXECUTABLE_PATH', path: 'C:\\custom\\chrome.exe' })
  })

  it('walks the system table with family labels (linux which + fixed paths)', () => {
    // which(chromium) hits /usr/bin/real-chromium; exists() accepts it.
    const env = envFor({ platform: 'linux', which: () => '/usr/bin/real-chromium' }, ['/usr/bin/real-chromium'])
    const found = probeBrowsers(env)
    expect(found.length).toBeGreaterThan(0)
    const chromium = found.find(b => b.path === '/usr/bin/real-chromium')
    expect(chromium?.kind).toBe('chromium')
    expect(chromium?.name).toBe('Chromium')
  })

  it('labels Edge vs Chrome on win32', () => {
    const originalProgramFiles = process.env.ProgramFiles
    process.env.ProgramFiles = 'C:\\Program Files'
    try {
      const existing = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
      const env = envFor({ platform: 'win32', home: 'C:\\Users\\test' }, existing)
      const found = probeBrowsers(env)
      const chrome = found.find(b => b.path.endsWith('chrome.exe'))
      const edge = found.find(b => b.path.endsWith('msedge.exe'))
      expect(chrome?.kind).toBe('chrome')
      expect(edge?.kind).toBe('edge')
      // Chrome precedes Edge in the OMP win32 table (chrome.exe candidates
      // are listed before msedge.exe).
      expect(found.indexOf(chrome!)).toBeLessThan(found.indexOf(edge!))
    } finally {
      if (originalProgramFiles === undefined) delete process.env.ProgramFiles
      else process.env.ProgramFiles = originalProgramFiles
    }
  })

  it('scans Chrome-for-Testing caches after the system table', () => {
    const cacheRoot = '/home/user/.omp/puppeteer'
    const cfrExe = '/home/user/.omp/puppeteer/chrome/linux-x64-130.0.6723.91/chrome'
    const env = envFor(
      {
        platform: 'linux',
        cacheDirs: [cacheRoot],
        readdir: () => ['linux-x64-130.0.6723.91', 'linux-x64-131.0.0.1'],
      },
      ['/home/user/.omp/puppeteer/chrome', cfrExe],
    )
    const found = probeBrowsers(env)
    const cfr = found.find(b => b.path === cfrExe)
    expect(cfr).toBeDefined()
    expect(cfr?.kind).toBe('cfr')
    expect(cfr?.name).toBe('Chrome for Testing')
  })

  it('deduplicates and returns best-first: env, system table, then cfr', () => {
    const cacheRoot = '/home/user/.omp/puppeteer'
    const cfrExe = '/home/user/.omp/puppeteer/chrome/linux-x64-130.0.6723.91/chrome'
    const env = envFor(
      {
        which: () => '/usr/bin/real-chromium',
        envPath: cfrExe,
        cacheDirs: [cacheRoot],
        readdir: () => ['linux-x64-130.0.6723.91'],
      },
      ['/usr/bin/real-chromium', '/home/user/.omp/puppeteer/chrome', cfrExe],
    )
    const found = probeBrowsers(env)
    const paths = found.map(b => b.path)
    expect(new Set(paths).size).toBe(paths.length)
    expect(paths[0]).toBe(cfrExe) // env wins
    expect(paths).toContain('/usr/bin/real-chromium')
    // The cfr scan of the same path is deduped against the env entry.
    expect(paths.filter(p => p === cfrExe)).toHaveLength(1)
  })

  it('returns an empty list when nothing exists', () => {
    expect(probeBrowsers(envFor({}, []))).toEqual([])
  })
})

describe('detectBrowser memoization', () => {
  it('returns the first usable browser (same priority as the probe button)', () => {
    const env = envFor({ which: () => '/usr/bin/real-chromium' }, ['/usr/bin/real-chromium'])
    expect(detectBrowser(env)).toEqual({ kind: 'chromium', name: 'Chromium', path: '/usr/bin/real-chromium' })
  })

  it('caches the result across calls (no re-probe)', () => {
    let calls = 0
    const env: BrowserDetectEnv = {
      platform: 'linux',
      home: '/home/user',
      which: () => undefined,
      exists: () => {
        calls += 1
        return true
      },
    }
    const first = detectBrowser(env)
    const second = detectBrowser(env)
    expect(first).toEqual(second)
    expect(calls).toBeGreaterThan(0)
    // Second call reuses the memo: the exists walker (multiple candidate
    // probes per detection) must not run again.
    const callsAfterFirst = calls
    detectBrowser(env)
    expect(calls).toBe(callsAfterFirst)
  })

  it('resetBrowserDetectionForTest clears the memo', () => {
    const env = envFor({ which: () => '/usr/bin/real-chromium' }, ['/usr/bin/real-chromium'])
    expect(detectBrowser(env)).toBeDefined()
    resetBrowserDetectionForTest()
    let ran = false
    const env2: BrowserDetectEnv = {
      platform: 'linux',
      home: '/home/user',
      which: () => undefined,
      exists: () => {
        ran = true
        return false
      },
    }
    expect(detectBrowser(env2)).toBeUndefined()
    expect(ran).toBe(true)
  })
})
