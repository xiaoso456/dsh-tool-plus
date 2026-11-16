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

/**
 * Decide the state from three facts: the host platform, whether our package is
 * installed, and whether it matches the installed pi-natives release. Pure
 * enough to unit-test by injection.
 */
export function nativeStatusFromFacts(facts: {
  tag: string
  pinVersion: string | null
  own: { version: string } | null
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
  return {
    status: 'active',
    platformTag: facts.tag,
    packageName: nativePackageName(facts.tag),
    version: facts.own.version,
  }
}

/** Read the live status of this process. */
export function readNativeStatus(): NativeStatusValue {
  const tag = `${process.platform}-${process.arch}`
  return nativeStatusFromFacts({
    tag,
    pinVersion: installedPinVersion(),
    own: resolveOwnNativePackage(tag),
  })
}
