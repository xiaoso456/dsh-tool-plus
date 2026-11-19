#!/usr/bin/env node
/**
 * Render the README hero banner (assets/hero/hero.html) to
 * assets/hero.zh.png and assets/hero.en.png at 2× (2560×1280, transparent corners).
 *
 * Uses a locally installed Chromium-family browser in headless mode; set
 * HERO_BROWSER to override the executable. The page uses locally installed
 * fonts (Noto Sans SC, Cascadia Mono), so output can differ between machines.
 *
 *   node scripts/render-hero.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const page = join(root, 'assets', 'hero', 'hero.html')
const outputs = [
  { lang: 'zh', file: join(root, 'assets', 'hero.zh.png') },
  { lang: 'en', file: join(root, 'assets', 'hero.en.png') },
]

const CANDIDATES = [
  process.env.HERO_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/microsoft-edge',
]
const browser = CANDIDATES.find((p) => p && existsSync(p))
if (!browser) {
  console.error('render-hero: no Chromium-family browser found; set HERO_BROWSER')
  process.exit(1)
}

/** Headless screenshots are flushed after the process exits on some builds; poll briefly. */
function waitForFile(file, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (existsSync(file) && statSync(file).size > 0) return true
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
  }
  return false
}

for (const { lang, file } of outputs) {
  const profile = mkdtempSync(join(tmpdir(), 'hero-render-'))
  rmSync(file, { force: true })
  const url = `${pathToFileURL(page).href}?lang=${lang}`
  spawnSync(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    `--user-data-dir=${profile}`,
    '--default-background-color=00000000',
    '--force-device-scale-factor=2', '--window-size=1280,640',
    '--virtual-time-budget=4000',
    `--screenshot=${file}`, url,
  ], { stdio: 'ignore' })
  const ok = waitForFile(file)
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  } catch {
    // The browser's helper processes can hold the profile for a moment after exit;
    // a leftover temp profile is harmless, so cleanup stays best-effort.
  }
  if (!ok) {
    console.error(`render-hero: ${lang} screenshot was not written`)
    process.exit(1)
  }
  console.log(`render-hero: ${file}`)
}
