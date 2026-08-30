/**
 * Browser JS-rendering coverage for the read URL pipeline:
 * - the browser provider sits at the tail of FETCH_PROVIDER_ORDER;
 * - the `browser.readerEnabled` switch gates it (off → the chain never
 *   reports a browser method);
 * - with a usable browser on the host, a real headless render of a local
 *   JS-gated page yields the dynamically injected text (otherwise skipped).
 * The unit suite never downloads a browser; renders only run when
 * `ensureChromiumExecutable` finds one on this machine.
 * @module tests
 */

import { afterAll, describe, expect, it } from 'vitest'
import * as http from 'node:http'
import {
  FETCH_PROVIDER_ORDER,
  isCsrHtmlShell,
  renderHtmlToText,
} from '../../src/tools/omp/tools/fetch.ts'
import { renderUrlWithBrowser, resetBrowserForTests, simulateIdleCloseForTests } from '../../src/tools/omp/web/browser-render.ts'
import { ensureChromiumExecutable } from '../../src/tools/omp/browser/launch.ts'

/** Static HTML long enough for the native converter to pass the quality gate. */
const STATIC_HTML = `<!doctype html><html><head><title>Static Page</title></head><body>
<main><h1>Static Heading</h1><p>This paragraph carries enough words to clear the
hundred-character quality gate when the native backend converts it to markdown.
It really does, because the gate looks at the trimmed output length.</p></main>
</body></html>`

/** JS-gated page: the visible text only exists after the script runs. */
const JS_GATED_HTML = `<!doctype html><html><head><title>SPA Page</title></head><body>
<div id="app">loading…</div>
<script>document.getElementById('app').textContent = 'rendered-by-js-12345. This dynamically injected paragraph is deliberately long so the rendered markdown clears the reader-chain quality gate (more than one hundred non-whitespace characters) and proves the browser backend executed the page script.'</script>
</body></html>`

/** CSR app shell: script-dense, text-light — isCsrHtmlShell must flag it. */
const CSR_SHELL_HTML = `<!doctype html><html><head><title>CSR Shell Page</title>
<meta name="description" content="The whole body of this page is rendered by client-side JavaScript after hydration, so the static markup only carries a mount point."></head><body>
<div id="root"></div>
<noscript>JavaScript is required to run this application. Please enable JavaScript or upgrade to a browser that supports modern web standards so the collaborative canvas can initialize its document model before any drawing tools become available at all.</noscript>
<script>document.getElementById('root').textContent = 'csr-shell-rendered-6789. The browser render injects this long paragraph at runtime so the markdown produced from it clears the reader-chain quality gate and proves the shell reached the browser backend through the automatic provider order.'</script>
<script>void 0;</script>
<script>void 0;</script>
</body></html>`

let server: http.Server | undefined
let port = 0

/** Whether this host has a usable browser (checked once at module load). */
const hasBrowser = await ensureChromiumExecutable() !== undefined

async function startServer(kind: 'static' | 'js' | 'shell'): Promise<void> {
  server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(kind === 'static' ? STATIC_HTML : kind === 'js' ? JS_GATED_HTML : CSR_SHELL_HTML)
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()))
  port = (server!.address() as { port: number }).port
}

afterAll(async () => {
  server?.close()
  server = undefined
  await resetBrowserForTests()
})

/** Minimal Settings-shaped object for renderHtmlToText (only get is used). */
function settingsLike(values: Record<string, unknown>): any {
  return { get: (path: string) => values[path] }
}

describe('fetch provider order', () => {
  it('places the browser backend at the tail of FETCH_PROVIDER_ORDER', () => {
    expect(FETCH_PROVIDER_ORDER[FETCH_PROVIDER_ORDER.length - 1]).toBe('browser')
    expect(FETCH_PROVIDER_ORDER).toContain('browser')
  })

  it('never reports a browser method when browser.readerEnabled is off', async () => {
    // fetchReader explicitly prefers the browser — with the switch off the
    // chain must skip it entirely and fall back to a local backend.
    await startServer('static')
    const url = `http://127.0.0.1:${port}/`
    const result = await renderHtmlToText(
      url,
      STATIC_HTML,
      20,
      settingsLike({ 'providers.fetch': 'browser', 'browser.readerEnabled': false }),
      undefined,
      null,
    )
    expect(result.method).not.toBe('browser')
    // The native backend clears the gate on static HTML.
    expect(result.ok).toBe(true)
    expect(result.method).toBe('native')
    expect(result.content).toContain('Static Heading')
  })
})

describe('real browser rendering (skipped when no browser exists)', () => {
  it.skipIf(!hasBrowser)('renders a JS-gated page and extracts the injected text', async () => {
    await startServer('js')
    const url = `http://127.0.0.1:${port}/`
    const markdown = await renderUrlWithBrowser(url, { timeoutMs: 20_000 })
    expect(markdown).not.toBeNull()
    expect(markdown).toContain('rendered-by-js-12345')
  })

  it.skipIf(!hasBrowser)('reaches the browser backend through the fetch chain on JS-gated pages', async () => {
    await startServer('js')
    const url = `http://127.0.0.1:${port}/`
    const result = await renderHtmlToText(
      url,
      JS_GATED_HTML,
      20,
      settingsLike({ 'providers.fetch': 'browser', 'browser.readerEnabled': true }),
      undefined,
      null,
    )
    // The static HTML alone is under the quality gate; only the browser
    // render produces the injected text.
    expect(result.ok).toBe(true)
    expect(result.method).toBe('browser')
    expect(result.content).toContain('rendered-by-js-12345')
  })

  it.skipIf(!hasBrowser)('relaunches the singleton after an idle close instead of failing', async () => {
    await startServer('js')
    const url = `http://127.0.0.1:${port}/`
    const first = await renderUrlWithBrowser(url, { timeoutMs: 20_000 })
    expect(first).toContain('rendered-by-js-12345')
    // The production idle path closes the browser but keeps browserPromise
    // pointing at the dead instance; a subsequent render must relaunch.
    await simulateIdleCloseForTests()
    const second = await renderUrlWithBrowser(url, { timeoutMs: 20_000 })
    expect(second).toContain('rendered-by-js-12345')
  })
})

describe('CSR shell routing (auto order, browser sits last)', () => {
  /** Offline stub for the remote readers (jina) so the suite never leaves localhost. */
  const offlineFetch = (async () => {
    throw new Error('offline test stub')
  }) as unknown as typeof fetch

  it('flags script-heavy text-light HTML as a CSR shell', () => {
    expect(isCsrHtmlShell(CSR_SHELL_HTML)).toBe(true)
    expect(isCsrHtmlShell(STATIC_HTML)).toBe(false)
    expect(isCsrHtmlShell(JS_GATED_HTML)).toBe(false)
  })

  it.skipIf(!hasBrowser)('auto order holds JS-unaware backends and hands the shell to the browser', async () => {
    await startServer('shell')
    const url = `http://127.0.0.1:${port}/`
    const result = await renderHtmlToText(
      url,
      CSR_SHELL_HTML,
      20,
      settingsLike({ 'providers.fetch': 'auto', 'browser.readerEnabled': true }),
      undefined,
      null,
      offlineFetch,
    )
    // Without the hold, the native remnant clears the gate first and the
    // browser (tail of the order) is never reached; with it the chain makes
    // it to the browser and gets the JS-injected body.
    expect(result.ok).toBe(true)
    expect(result.method).toBe('browser')
    expect(result.content).toContain('csr-shell-rendered-6789')
  })

  it('returns the parked shell when the browser is disabled (no regression)', async () => {
    await startServer('shell')
    const url = `http://127.0.0.1:${port}/`
    const result = await renderHtmlToText(
      url,
      CSR_SHELL_HTML,
      20,
      settingsLike({ 'providers.fetch': 'auto', 'browser.readerEnabled': false }),
      undefined,
      null,
      offlineFetch,
    )
    // Browser out of the chain: the parked native remnant is surfaced, which
    // is exactly the pre-hold behaviour for degraded environments.
    expect(result.ok).toBe(true)
    expect(result.method).toBe('native')
    expect(result.content).toContain('meta-description: The whole body')
  })
})
