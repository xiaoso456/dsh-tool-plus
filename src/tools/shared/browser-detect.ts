/**
 * Browser executable detection for the read browser renderer — a thin,
 * fully-injectable shell over the OMP probe family (`src/tools/omp/browser/launch.ts`).
 *
 * Two entry points share one candidate pipeline:
 * - {@link probeBrowsers} — no caching; every call walks the candidate table.
 *   Backs the settings-panel "探测浏览器" button via the host RPC, so a user
 *   can re-probe after installing a browser.
 * - {@link detectBrowser} — memoizes the first success as the renderer's
 *   executable choice, so repeated reads do not re-stat the filesystem.
 *
 * Candidate kinds are annotated for display (`edge` / `chrome` / `chromium` /
 * `cfr` / `env`); the renderer itself only needs the resolved path, so the
 * detection result and the launch path never drift.
 *
 * Host-side only: this module imports node:fs, so it must never be reached
 * from the browser client half (it isn't — the client imports the channel
 * constants module, not this one).
 * @module @xiaoso/dsh-tool-plus/browser-detect
 */

import * as fs from "node:fs"
import { $which, getPuppeteerDir } from "@oh-my-pi/pi-utils"
import { systemChromiumCandidatesForTest } from "../omp/browser/launch"

/** Browser family labels surfaced by the detection button. */
export type BrowserKind = "edge" | "chrome" | "chromium" | "cfr" | "env"

/** One detected browser executable. */
export interface DetectedBrowser {
  kind: BrowserKind
  name: string
  path: string
}

/** Injectable environment; everything the probe touches comes through here. */
export interface BrowserDetectEnv {
  platform: NodeJS.Platform
  home: string
  which: (name: string) => string | null | undefined
  exists: (p: string) => boolean
  /** Directory listing for Chrome-for-Testing cache roots. */
  readdir?: (p: string) => string[]
  /** PUPPETEER_EXECUTABLE_PATH override (wins over the table). */
  envPath?: string
  /** Chrome-for-Testing cache roots to scan (defaults to getPuppeteerDir()). */
  cacheDirs?: readonly string[]
}

/** Default environment: the real platform/homedir/which/filesystem. */
export function defaultBrowserDetectEnv(): BrowserDetectEnv {
  return {
    platform: process.platform,
    home: process.env.HOME ?? process.env.USERPROFILE ?? "",
    which: $which,
    exists: (p: string) => {
      try {
        return fs.existsSync(p)
      } catch {
        return false
      }
    },
    readdir: (p: string) => fs.readdirSync(p),
    envPath: process.env.PUPPETEER_EXECUTABLE_PATH,
    cacheDirs: [getPuppeteerDir()],
  }
}

const FAMILY_NAMES: Record<BrowserKind, string> = {
  edge: "Microsoft Edge",
  chrome: "Google Chrome",
  chromium: "Chromium",
  cfr: "Chrome for Testing",
  env: "PUPPETEER_EXECUTABLE_PATH",
}

/** Label a candidate path with its browser family (by filename). */
function kindOf(executablePath: string): BrowserKind {
  const name = executablePath.replaceAll("\\", "/").split("/").pop() ?? executablePath
  const lower = name.toLowerCase()
  if (lower.includes("msedge")) return "edge"
  if (lower.includes("chromium")) return "chromium"
  return "chrome"
}

/**
 * Candidate paths for the given platform with family labels, in the OMP
 * system table order (see `systemChromiumCandidates`). `env` paths are
 * injected separately by the caller.
 */
function tableCandidates(env: BrowserDetectEnv): Array<{ kind: BrowserKind; path: string }> {
  const out: Array<{ kind: BrowserKind; path: string }> = []
  for (const p of systemChromiumCandidatesForTest(env.platform, env.home, env.which)) {
    if (!p) continue
    out.push({ kind: kindOf(p), path: p })
  }
  return out
}

/**
 * Scan a Chrome-for-Testing cache root for installed browsers
 * (`<root>/chrome/<platform>-<build>/chrome(.exe)` layout used by
 * @puppeteer/browsers and OMP's getPuppeteerDir cache).
 */
function cfrCandidates(env: BrowserDetectEnv): Array<{ kind: BrowserKind; path: string }> {
  const out: Array<{ kind: BrowserKind; path: string }> = []
  const execName = env.platform === "win32" ? "chrome.exe" : "chrome"
  const sep = env.platform === "win32" ? "\\" : "/"
  for (const root of env.cacheDirs ?? []) {
    try {
      const chromeDir = `${root}${root.endsWith("/") || root.endsWith("\\") ? "" : sep}chrome`
      if (!env.exists(chromeDir)) continue
      const list = env.readdir?.(chromeDir) ?? []
      for (const build of list) {
        if (build === "." || build === "..") continue
        const exe = `${chromeDir}${sep}${build}${sep}${execName}`
        if (env.exists(exe)) out.push({ kind: "cfr", path: exe })
      }
    } catch {
      /* unreadable cache root — skip */
    }
  }
  return out
}

/** Walk candidates in priority order, keeping the first executable file. */
function findFirst(
  env: BrowserDetectEnv,
  candidates: Array<{ kind: BrowserKind; path: string }>,
): DetectedBrowser | undefined {
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (!candidate.path || seen.has(candidate.path)) continue
    seen.add(candidate.path)
    if (!env.exists(candidate.path)) continue
    return { kind: candidate.kind, name: FAMILY_NAMES[candidate.kind], path: candidate.path }
  }
  return undefined
}

/** Detect every usable browser on the machine, best first. No caching. */
export function probeBrowsers(env: BrowserDetectEnv = defaultBrowserDetectEnv()): DetectedBrowser[] {
  const found: DetectedBrowser[] = []
  const seen = new Set<string>()
  const push = (browser: DetectedBrowser | undefined): void => {
    if (browser === undefined || seen.has(browser.path)) return
    seen.add(browser.path)
    found.push(browser)
  }

  if (env.envPath) push({ kind: "env", name: FAMILY_NAMES.env, path: env.envPath })
  // System table (OMP order), then Chrome-for-Testing caches. The renderer's
  // own choice (detectBrowser) uses the same priority, so the button previews
  // exactly what read will use.
  for (const candidate of [...tableCandidates(env), ...cfrCandidates(env)]) {
    if (!env.exists(candidate.path)) continue
    push({ kind: candidate.kind, name: FAMILY_NAMES[candidate.kind], path: candidate.path })
  }
  return found
}

let cachedDetection: DetectedBrowser | undefined

/**
 * Resolve the browser the renderer will launch (memoized). Mirrors
 * {@link ensureChromiumExecutable} priority (PUPPETEER_EXECUTABLE_PATH →
 * system table → Chrome-for-Testing cache) but keeps its own display
 * metadata; returns undefined when no browser exists.
 */
export function detectBrowser(env: BrowserDetectEnv = defaultBrowserDetectEnv()): DetectedBrowser | undefined {
  if (cachedDetection !== undefined) return cachedDetection
  cachedDetection = findFirst(env, [
    ...(env.envPath ? [{ kind: "env" as const, path: env.envPath }] : []),
    ...tableCandidates(env),
    ...cfrCandidates(env),
  ])
  return cachedDetection
}

/** Clear the memoized detection (re-probe on next call; test seam). */
export function resetBrowserDetectionForTest(): void {
  cachedDetection = undefined
}
