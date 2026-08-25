/**
 * DSH Bun compatibility type declarations (runtime provided by
 * src/tools/shared/bun-shim.ts, installed at plugin apply).
 *
 * Types mirror the Bun surface OMP tool code (copied verbatim) actually uses.
 * Changes recorded in step.md ("Bun 兼容").
 */

declare global {
  /** Bun's timer handle type (Node setTimeout return — compatible with clearTimeout). */
  type Timer = ReturnType<typeof setTimeout>

  interface Buffer {
    /** Bun extension: base64 encode (Node runtime patched by bun-shim). */
    toBase64(): string
  }

  interface BufferConstructor {
    /** Bun extension: base64 decode (patched by bun-shim). */
    fromBase64(data: string): Buffer
  }

  interface Uint8Array {
    /** Bun extension (patched by bun-shim). */
    toBase64(): string
  }

  interface Uint8ArrayConstructor {
    fromBase64(data: string): Uint8Array
  }

  namespace Bun {
    interface BunFile {
      readonly path: string
      readonly size: number
      readonly name: string
      exists(): Promise<boolean>
      text(): Promise<string>
      json(): Promise<unknown>
      arrayBuffer(): Promise<ArrayBuffer>
      bytes(): Promise<Uint8Array>
      writer(): Bun.FileSink
      stream(): ReadableStream<Uint8Array>
      stat(): Promise<{ mtimeMs: number; size: number; isDirectory(): boolean }>
      unlink(): Promise<void>
      write(content: string | Uint8Array | Blob | ArrayBuffer): Promise<void>
      slice(start?: number, end?: number): BunFile
    }

    interface FileSink {
      write(chunk: string | Uint8Array): void
      flush(): void
      end(): void
      close(): void
    }

    interface Glob {
      scan(opts?: {
        cwd?: string
        absolute?: boolean
        onlyFiles?: boolean
        dot?: boolean
      }): AsyncIterable<string>
      match(input: string): boolean
    }

    type Encoding = 'ascii' | 'utf8' | 'utf-8' | 'utf16le' | 'ucs2' | 'ucs-2' | 'base64' | 'base64url' | 'latin1' | 'binary' | 'hex'

    /** Bun's stream read result; widened to Node's `{done, value?}` shape so
     *  both runtimes' readers satisfy it. */
    type ReadableStreamDefaultReadResult<T> = { done: boolean; value?: T }

    const file: (path: string) => BunFile
    const write: (path: string, data: string | Uint8Array | Blob | ArrayBuffer) => Promise<void>
    const env: NodeJS.ProcessEnv
    const sleep: (ms: number) => Promise<void>
    const hash: {
      (input: string | ArrayBuffer | Uint8Array): number
      xxHash64(input: string | ArrayBuffer | Uint8Array, seed?: bigint): bigint
    }
    const randomUUIDv7: () => string
    const stringWidth: (s: string) => number
    const Glob: new (pattern: string) => Glob
    const Archive: { write(dest: string, record: Record<string, string | Uint8Array | Blob>, opts?: { compress?: 'gzip' }): Promise<void> }
    const FileSink: new (path: string) => FileSink
    interface BunImage {
      metadata(): Promise<{ width: number; height: number; format?: string }>
      resize(width?: number, height?: number): BunImage
      resize(opts: { width?: number; height?: number; quality?: number }): BunImage
      png(): BunImage
      jpeg(opts?: { quality?: number }): BunImage
      webp(opts?: { quality?: number }): BunImage
      bytes(): Promise<Uint8Array>
      toBase64(): Promise<string>
      rotate(deg: number): BunImage
      flip(): BunImage
      blur(radius: number): BunImage
      sharpen(radius?: number): BunImage
      write(path: string): Promise<number>
    }

    const Image: new (bytes: Uint8Array | ArrayBuffer) => BunImage
    const CryptoHasher: new (algorithm: string) => {
      update(data: string | Uint8Array): { digest(encoding: 'hex' | 'base64' | 'buffer' | string): string | Buffer }
      digest(encoding: 'hex' | 'base64' | 'buffer' | string): string | Buffer
    }
    const color: (color: string, format?: string) => string
    const JSON: { parse(s: string): unknown; stringify(v: unknown): string }
    const JSON5: { parse(s: string): unknown }
    const Encoding: Record<string, never>
    const native: undefined
    const BunFile: typeof BunFile
    const version: string
  }

  const Bun: typeof Bun
}

// Text imports (`*.md`/`*.lark`) ambient declarations live in
// ./text-imports.d.ts (non-module file so the wildcards resolve).

export {}
