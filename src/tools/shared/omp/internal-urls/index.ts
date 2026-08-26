/**
 * DSH adapter for OMP `internal-urls/` — the internal URL protocol system
 * (agent://, memory://, skill://, local://, …).
 *
 * plan.md 判定：DSH 无 OMP 内部 URL 协议（read/write 不解析这些 scheme），
 * 因此适配层仅提供 `path-utils` 引用的表面：
 * - `LocalProtocolOptions`（verbatim 类型）
 * - `InternalUrlRouter`（空路由：canHandle 恒 false —— DSH 没有可解析的
 *   内部协议；engine 的调用方在 canHandle=false 时走普通路径解析）
 */
export interface LocalProtocolOptions {
  getArtifactsDir?: () => string | null
  getSessionId?: () => string | null
}

/** Raw resource payload shape (verbatim OMP, unused in DSH). */
export interface InternalResource {
  url: string
  content: string
  contentType: 'text/markdown' | 'application/json' | 'text/plain'
  size?: number
  sourcePath?: string
  immutable?: boolean
}

/** Resolve context passed to router handlers (verbatim OMP surface). */
export interface ResolveContext {
  cwd?: string
  signal?: AbortSignal
  localProtocolOptions?: LocalProtocolOptions
  pathOnly?: boolean
  settings?: unknown
  skills?: readonly unknown[]
  /** Session-bound `xd://` documentation resolver. */
  xd?: {
    read: (name: string | null) => Promise<string>
  }
}

/** Write context passed to router write handlers (verbatim OMP surface). */
export interface WriteContext {
  cwd?: string
  signal?: AbortSignal
  localProtocolOptions?: LocalProtocolOptions
  /** Session-bound `xd://` device dispatcher. */
  xd?: {
    write(name: string | null, content: string): Promise<void>
  }
}

/** Internal URL shape (verbatim OMP minimal surface). */
export interface InternalUrl {
  scheme: string
  host: string
  pathname: string
  search?: string
  hash?: string
}

/** Loose URL shape accepted by resolvers (parse.ts's InternalUrl extends URL). */
type InternalUrlLike = {
  protocol?: string
  host?: string
  pathname: string
  search?: string
  hash?: string
}

/** Parse an internal URL into its parts (verbatim OMP semantics). */
export function parseInternalUrl(input: string): InternalUrl {
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(input)
  const scheme = schemeMatch?.[1]?.toLowerCase() ?? 'local'
  const rest = input.slice(schemeMatch?.[0].length ?? 0)
  const hashIdx = rest.indexOf('#')
  const hash = hashIdx >= 0 ? rest.slice(hashIdx) : undefined
  const pathAndSearch = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest
  const searchIdx = pathAndSearch.indexOf('?')
  const search = searchIdx >= 0 ? pathAndSearch.slice(searchIdx) : undefined
  const pathPart = searchIdx >= 0 ? pathAndSearch.slice(0, searchIdx) : pathAndSearch
  const slashIdx = pathPart.indexOf('/')
  const host = slashIdx >= 0 ? pathPart.slice(0, slashIdx) : pathPart
  const pathname = slashIdx >= 0 ? pathPart.slice(slashIdx) : ''
  return { scheme, host, pathname, search, hash }
}

/** Minimal router: no internal protocol handlers are registered in DSH. */
export class InternalUrlRouter {
  static #instance: InternalUrlRouter | undefined

  static instance(): InternalUrlRouter {
    if (!InternalUrlRouter.#instance) {
      InternalUrlRouter.#instance = new InternalUrlRouter()
    }
    return InternalUrlRouter.#instance
  }

  canHandle(_url: string): boolean {
    return false
  }

  canResolve(_input: string): boolean {
    return false
  }

  getHandler(_scheme: string): { write?: (url: unknown, content: string, context?: unknown) => Promise<void> } | undefined {
    return undefined
  }

  async resolve(_url: string, _context?: ResolveContext): Promise<InternalResource> {
    throw new Error(`No internal URL handler for: ${_url}`)
  }

  async write(_input: string, _content: string, _context?: WriteContext): Promise<void> {
    throw new Error(`No internal URL write handler for: ${_input}`)
  }
}

/** DSH: no local:// sandbox — resolve to the raw path. */
export function resolveLocalUrlToPath(
  input: string | InternalUrlLike,
  _options?: LocalProtocolOptions,
  _platform?: NodeJS.Platform,
): string {
  if (typeof input === 'string') {
    const parsed = parseInternalUrl(input)
    return parsed.host ? `/${parsed.host}${parsed.pathname}` : parsed.pathname
  }
  return input.host ? `/${input.host}${input.pathname}` : input.pathname
}

/** DSH: no memory root registry — empty. */
export function memoryRootsFromRegistry(): string[] {
  return []
}

/** DSH: no memory:// backing — resolve to the raw path. */
export function resolveMemoryUrlToPath(url: InternalUrl, _memoryRoot: string): string {
  return url.host ? `/${url.host}${url.pathname}` : url.pathname
}

/** DSH: no local:// sandbox — static handler with no options. */
export class LocalProtocolHandler {
  static resolveOptions(_context?: ResolveContext): LocalProtocolOptions | undefined {
    return undefined
  }
}

/** DSH: no local:// sandbox — the local root is the cwd. */
export function resolveLocalRoot(_options: LocalProtocolOptions, _platform?: NodeJS.Platform): string {
  return ''
}

/** DSH: no vault:// — resolve to the raw path. */
export function resolveVaultUrlToPath(input: string | InternalUrlLike): string {
  const parsed = typeof input === 'string' ? parseInternalUrl(input) : input
  return parsed.host ? `/${parsed.host}${parsed.pathname}` : parsed.pathname
}

/** DSH: no local:// file backing — resolve to nothing (caller falls back to text path). */
export async function resolveLocalUrlToFile(
  _input: string | InternalUrlLike,
  _context?: ResolveContext,
): Promise<{ path: string; size: number } | null> {
  return null
}
