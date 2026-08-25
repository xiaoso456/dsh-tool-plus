/**
 * DSH named-import shim for `import { ... } from "bun"` (pi-utils and other
 * always-bundled OMP packages). tsdown aliases "bun" to this module.
 * Runtime Bun global is installed separately by src/tools/shared/bun-shim.ts.
 */
import { parse as yamlParse, stringify as yamlStringify } from 'yaml'
import { GlobShim } from './bun-shim.ts'

export { GlobShim as Glob } from './bun-shim.ts'

/** Bun.YAML (pi-utils frontmatter) — yaml package under the hood. */
export const YAML = {
  parse: (s: string): unknown => yamlParse(s),
  stringify: (v: unknown): string => yamlStringify(v),
}

/** Bun build plugin hook (pi-utils module-timer) — inert under Node. */
export function plugin(): void {
  /* no-op: Bun's build plugin system does not exist on Node */
}

/** Minimal Bun-shell result (pi-ai perplexity OAuth; never reached on non-macOS). */
class BunShellResult {
  get exitCode(): number {
    return 1
  }

  text(): string {
    return ''
  }

  quiet(): this {
    return this
  }

  nothrow(): this {
    return this
  }

  cwd(): this {
    return this
  }
}

/** Bun shell template tag (Bun `$`). Perplexity's macOS defaults read only. */
export function $(_strings: TemplateStringsArray, ..._expr: unknown[]): BunShellResult {
  return new BunShellResult()
}

/** HTTP cookie (pi-ai OAuth flows). */
export class Cookie {
  name: string
  value: string
  #expires: Date | undefined

  constructor(name: string, value: string, expires?: Date) {
    this.name = name
    this.value = value
    this.#expires = expires
  }

  static parse(header: string): Cookie {
    const segments = header.split(';')
    const first = segments[0] ?? ''
    const eq = first.indexOf('=')
    const name = eq >= 0 ? first.slice(0, eq).trim() : first.trim()
    const value = eq >= 0 ? first.slice(eq + 1).trim() : ''
    let expires: Date | undefined
    for (const segment of segments.slice(1)) {
      const [key, val] = segment.trim().split('=')
      if (key?.toLowerCase() === 'expires') {
        const t = Date.parse(val ?? '')
        if (!Number.isNaN(t)) expires = new Date(t)
      }
    }
    return new Cookie(name, value, expires)
  }

  isExpired(): boolean {
    return this.#expires !== undefined && this.#expires.getTime() < Date.now()
  }
}

/** Ordered cookie jar (Bun CookieMap surface used by pi-ai OAuth). */
export class CookieMap implements Iterable<[string, string]> {
  #map = new Map<string, string>()

  get size(): number {
    return this.#map.size
  }

  set(name: string, value: string): void {
    this.#map.set(name, value)
  }

  get(name: string): string | undefined {
    return this.#map.get(name)
  }

  delete(name: string): boolean {
    return this.#map.delete(name)
  }

  has(name: string): boolean {
    return this.#map.has(name)
  }

  clear(): void {
    this.#map.clear()
  }

  *[Symbol.iterator](): Iterator<[string, string]> {
    yield* this.#map
  }
}

export type Subprocess = unknown
export type Spawn = unknown
export type BunFile = GlobShim
