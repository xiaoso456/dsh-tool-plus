/**
 * Which native addon this install is actually running.
 *
 * tool-plus ships its own pi-natives build (upstream + the in-process shell
 * builtins) as a per-platform package. The vendored loader (src/vendor/
 * pi-natives, patch 0006) prefers it and silently falls back to the upstream
 * package when it is absent — which is correct behaviour, but it means the
 * extra shell commands can be missing with no visible reason. This module
 * answers "which one am I on, and if not ours, why" for the settings panel and
 * the startup log.
 * @module @xiaoso/dsh-tool-plus/native-status
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { nativeAddonStatus } from '../../vendor/pi-natives/loader-state.js'
import type { NativeStatusValue } from './browser-rpc-channel.ts'

/** Platform tags we publish a package for (also the loader's `platformTag`). */
export const NATIVE_PACKAGE_TAGS = [
  'linux-x64',
  'linux-arm64',
  'darwin-arm64',
  'darwin-x64',
  'win32-x64',
  'win32-arm64',
] as const

/** Scoped package name of the addon package for one platform tag. */
export function nativePackageName(tag: string): string {
  return `@xiaoso/dsh-tool-plus-natives-${tag}`
}

/** `18.12.6-plus.1` → `18.12.6`: the pi-natives release a build was made for. */
export function pinBaseOf(version: string): string {
  const dash = version.indexOf('-')
  return dash === -1 ? version : version.slice(0, dash)
}

function readManifest(dir: string): { version?: string } {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: string }
}

/** Version of the installed `@oh-my-pi/pi-natives`, or null when absent. */
export function installedPinVersion(): string | null {
  try {
    const entry = createRequire(import.meta.url).resolve('@oh-my-pi/pi-natives')
    return readManifest(path.join(path.dirname(entry), '..')).version ?? null
  } catch {
    return null
  }
}

/**
 * Resolve our addon package and the pin it was built for.
 *
 * `require.resolve` on the manifest — not on the package entry — because the
 * loader addresses platform packages by directory; the package therefore has
 * no `exports` map (see scripts/build-native-packages.mjs).
 */
export function resolveOwnNativePackage(tag: string): { dir: string; version: string } | null {
  try {
    const dir = path.dirname(createRequire(import.meta.url).resolve(`${nativePackageName(tag)}/package.json`))
    const version = readManifest(dir).version
    return version === undefined ? null : { dir, version }
  } catch {
    return null
  }
}

/** What this process actually loaded, as the loader reports it. */
export interface LoadedAddonFacts {
  /** Absolute path of the `.node` that was required. */
  path: string
  /** The addon carries a different release than the installed pi-natives. */
  stale: boolean
  /** The file is our platform package's build (see {@link loadedAddonIsOurs}). */
  ours: boolean
}

/**
 * Does `loadedPath` carry the build our platform package ships?
 *
 * The path alone cannot answer that: on Windows the loader stages the binary into
 * `~/.omp/natives/<version>/` before loading it, and that directory is shared by
 * every distribution that ever shipped the same upstream version — the hole that
 * let a stale copy shadow the package. A staged file is a byte-for-byte copy, so
 * a size match against one of the package's `.node` files identifies it, which is
 * the same rule the loader uses to decide which copy to trust.
 */
export function loadedAddonIsOurs(loadedPath: string, packageDir: string): boolean {
  const normalize = (value: string): string => path.resolve(value).toLowerCase()
  try {
    const loaded = normalize(loadedPath)
    const dir = normalize(packageDir)
    if (loaded.startsWith(`${dir}${path.sep}`)) return true
    const size = fs.statSync(loadedPath).size
    return fs
      .readdirSync(packageDir)
      .filter((name) => name.endsWith('.node'))
      .some((name) => {
        try {
          return fs.statSync(path.join(packageDir, name)).size === size
        } catch {
          return false
        }
      })
  } catch {
    return false
  }
}

/**
 * Decide the state from four facts: the host platform, whether our package is
 * installed, whether it matches the installed pi-natives release, and — the one
 * that actually matters — which binary the loader required.
 *
 * The first three are package-level and cannot see a stale cache copy that won
 * the load order; `loaded` is runtime-level. The settings row reports the
 * runtime answer for that reason. Pure enough to unit-test by injection.
 */
export function nativeStatusFromFacts(facts: {
  tag: string
  pinVersion: string | null
  own: { version: string } | null
  loaded: LoadedAddonFacts | null
  supported?: readonly string[]
}): NativeStatusValue {
  const supported = facts.supported ?? NATIVE_PACKAGE_TAGS
  if (!supported.includes(facts.tag)) {
    return { status: 'fallback', reason: 'platform-unsupported', platformTag: facts.tag }
  }
  if (facts.own === null) {
    return { status: 'fallback', reason: 'package-missing', platformTag: facts.tag }
  }
  if (facts.pinVersion === null || pinBaseOf(facts.own.version) !== facts.pinVersion) {
    return { status: 'fallback', reason: 'version-mismatch', platformTag: facts.tag }
  }
  if (facts.loaded === null) {
    return { status: 'fallback', reason: 'addon-not-loaded', platformTag: facts.tag }
  }
  if (!facts.loaded.ours) {
    return {
      status: 'fallback',
      reason: 'foreign-addon',
      platformTag: facts.tag,
      loadedPath: facts.loaded.path,
    }
  }
  if (facts.loaded.stale) {
    return {
      status: 'fallback',
      reason: 'version-mismatch',
      platformTag: facts.tag,
      loadedPath: facts.loaded.path,
    }
  }
  return {
    status: 'active',
    platformTag: facts.tag,
    packageName: nativePackageName(facts.tag),
    version: facts.own.version,
    loadedPath: facts.loaded.path,
  }
}

/** Read the live status of this process: what is installed, and what actually loaded. */
export function readNativeStatus(): NativeStatusValue {
  const tag = `${process.platform}-${process.arch}`
  const own = resolveOwnNativePackage(tag)
  const addon = nativeAddonStatus()
  return nativeStatusFromFacts({
    tag,
    pinVersion: installedPinVersion(),
    own,
    loaded:
      addon === null
        ? null
        : {
          path: addon.path,
          stale: addon.stale,
          ours: own !== null && loadedAddonIsOurs(addon.path, own.dir),
        },
  })
}
