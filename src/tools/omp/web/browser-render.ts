/**
 * Browser JS rendering for the read URL pipeline — the last reader backend
 * in `FETCH_PROVIDER_ORDER`. Where the other backends fetch the raw HTML and
 * convert it server-side, this one launches a real headless Chromium
 * (puppeteer-core), lets the page's JavaScript run, and extracts readable
 * content from the rendered DOM — which is what SPA pages need.
 *
 * Design (per the 2026-08-29 plan):
 * - Singleton browser: lazily launched on first use, reused across renders,
 *   closed after `BROWSER_IDLE_CLOSE_MS` of inactivity, best-effort killed on
 *   process exit; a memoized instance found closed (idle recycle / crash) is
 *   cleared and relaunched on the next render. A promise queue serializes
 *   renders (one page at a time).
 * - Budget: goto ≤ min(overall timeout, 20s), `domcontentloaded` + 800ms JS
 *   settle, DOM capped at `BROWSER_RENDER_MAX_BYTES` before extraction.
 * - Failure degenerates to `null` (the fetch chain then moves to the next
 *   backend or reports the raw HTML), never throws for "no browser".
 *
 * `resetBrowserForTests` is the test seam for the unit suite.
 * @module @xiaoso/dsh-tool-plus/web/browser-render
 */

import type { Browser, default as Puppeteer } from 'puppeteer-core'
import { extractReadableFromHtml } from '../browser/readable'
import { ensureChromiumExecutable } from '../browser/launch'

/** Cap on the rendered DOM handed to the readable extractor. */
export const BROWSER_RENDER_MAX_BYTES = 2 * 1024 * 1024

/** Idle time after which the singleton browser is closed (renders reuse it). */
export const BROWSER_IDLE_CLOSE_MS = 60_000

/** Extra settle time after `domcontentloaded` for JS-rendered content. */
export const RENDER_SETTLE_MS = 800

/** Per-render goto cap; the caller's timeout budget binds the whole chain. */
const RENDER_GOTO_MAX_MS = 20_000

/** Renders queue through this promise chain — one page open at a time. */
let renderQueue: Promise<unknown> = Promise.resolve()

let browserPromise: Promise<Browser | undefined> | undefined
let idleTimer: ReturnType<typeof setTimeout> | undefined

/** Load puppeteer-core lazily (it must stay external to this package). */
let puppeteerModule: typeof Puppeteer | undefined
async function loadPuppeteer(): Promise<typeof Puppeteer> {
  if (!puppeteerModule) {
    puppeteerModule = (await import('puppeteer-core')).default
  }
  return puppeteerModule
}

function scheduleIdleClose(browser: Browser): void {
  if (idleTimer !== undefined) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    void browser.close().catch(() => {})
  }, BROWSER_IDLE_CLOSE_MS)
  idleTimer.unref?.()
}

// Best-effort kill of the Chromium process tree on host exit (a stray
// headless browser must not outlive the plugin). Registered once at module
// load; the exit callback runs synchronously, so it only detaches/kills the
// process handle — no async work is possible there.
process.once('exit', () => {
  const pending = browserPromise
  if (!pending) return
  void pending.then(browser => {
    if (browser) browser.process()?.kill('SIGKILL')
  })
})

async function acquireBrowser(): Promise<Browser | undefined> {
  if (browserPromise) {
    const existing = await browserPromise
    if (existing?.connected) {
      scheduleIdleClose(existing)
      return existing
    }
    // The singleton was idled-closed (or crashed) while still memoized —
    // handing it out would fail the render; clear it and relaunch instead.
    browserPromise = undefined
  }
  browserPromise = (async () => {
    const executablePath = await ensureChromiumExecutable()
    if (!executablePath) return undefined
    const puppeteer = await loadPuppeteer()
    try {
      const browser = await puppeteer.launch({
        executablePath,
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
        ],
      })
      scheduleIdleClose(browser)
      return browser
    } catch {
      // Launch failure (missing libs, sandbox, …) — degenerate, don't retry
      // every render by clearing the promise; the probe button surfaces it.
      return undefined
    }
  })()
  const browser = await browserPromise
  if (browser) scheduleIdleClose(browser)
  return browser
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })
}

/**
 * Render a URL in a headless browser and return readable markdown, or null
 * when no browser is available / rendering fails. Serialized through the
 * singleton queue; honors `signal` cancellation between attempts.
 */
export async function renderUrlWithBrowser(
  url: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string | null> {
  const { timeoutMs = 30_000, signal } = options
  const run = async (): Promise<string | null> => {
    signal?.throwIfAborted()
    const browser = await acquireBrowser()
    if (!browser) return null
    signal?.throwIfAborted()
    const page = await browser.newPage()
    try {
      const gotoBudget = Math.max(1_000, Math.min(timeoutMs, RENDER_GOTO_MAX_MS))
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: gotoBudget })
      signal?.throwIfAborted()
      // Let client-side JS settle (SPA render) before extracting.
      await sleep(RENDER_SETTLE_MS)
      signal?.throwIfAborted()
      const html = (await page.content()) ?? ''
      const truncated = html.length > BROWSER_RENDER_MAX_BYTES ? html.slice(0, BROWSER_RENDER_MAX_BYTES) : html
      const readable = await extractReadableFromHtml(truncated, response?.url() ?? url, 'markdown')
      if (!readable?.markdown) return null
      return readable.markdown
    } catch {
      // Timeouts, aborts, navigation failures — all degenerate to null; the
      // fetch chain's next backend (or raw HTML) takes over.
      return null
    } finally {
      await page.close().catch(() => {})
    }
  }
  return renderQueue = renderQueue.then(run, run)
}

/**
 * Test seam: replicate the production idle-close state — the singleton
 * browser is closed but `browserPromise` is left pointing at the dead
 * instance (which is exactly what {@link scheduleIdleClose} does). A render
 * in this state must relaunch rather than fail.
 */
export async function simulateIdleCloseForTests(): Promise<void> {
  const pending = browserPromise
  if (!pending) return
  const browser = await pending
  if (browser) await browser.close().catch(() => {})
}

/**
 * Test seam: close the singleton browser (if any) and reset the queue so a
 * later render starts from a clean state. Also clears the launch memo so a
 * subsequent render re-resolves the executable (e.g. after the detection
 * RPC ran).
 */
export async function resetBrowserForTests(): Promise<void> {
  const pending = renderQueue
  renderQueue = Promise.resolve()
  if (idleTimer !== undefined) {
    clearTimeout(idleTimer)
    idleTimer = undefined
  }
  if (browserPromise) {
    const browser = await browserPromise
    browserPromise = undefined
    if (browser) await browser.close().catch(() => {})
  }
  await pending.catch(() => {})
}
