/**
 * DSH Bun compatibility shim — installs a Node implementation of the `Bun`
 * global that OMP tool code (copied verbatim into adapter/omp) uses.
 *
 * OMP is a Bun project; its code calls `Bun.file`, `Bun.write`, `Bun.hash`,
 * `Bun.stringWidth`, `Bun.Glob`, `Bun.Archive`, `Bun.FileSink`, … This module
 * provides those APIs on Node 22, plus the `Buffer`/`Uint8Array` `toBase64`/
 * `fromBase64` extensions Bun adds. Every change here is recorded in step.md
 * ("Bun 兼容" section).
 *
 * `Bun.Image` is backed by `sharp` resolved at runtime (拍板#22, 2026-08-28:
 * 图像链路重建——sharp 兼容层取代构造即抛错的桩，fetch/read 的 resizeImage
 * 后端由此复活）。sharp 是宿主 DSH 的传递依赖（dsh-attachment-local 直接依
 * 赖），本包不打包、不安装，运行时经 createRequire/import 级联解析；解析不到
 * 时抛带指引的错误，`resizeImage` 的 try/catch 降级语义保持不变。
 */
import * as fs from 'node:fs'
// NOTE: no `node:` prefix on fs/promises here — tsdown aliases
// 'node:fs/promises' → fs-promises-shim, which would create an import cycle
// with this shim's banner-installed installBunShim call.
import * as fsp from 'fs/promises'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
// json5 is kept external (neverBundle) so Node's ESM CJS default-interop
// applies; rolldown's default-interop for inlined CJS yields undefined.
import JSON5 from 'json5'

// ---------------------------------------------------------------------------
// Buffer / Uint8Array Bun extensions (runtime patch; types in bun-compat.d.ts)
// ---------------------------------------------------------------------------
function patchBase64(): void {
  const bufProto = Buffer.prototype as unknown as Record<string, unknown>
  const u8Proto = Uint8Array.prototype as unknown as Record<string, unknown>
  if (typeof bufProto.toBase64 !== 'function') {
    bufProto.toBase64 = function (this: Buffer): string {
      return this.toString('base64')
    }
  }
  if (typeof bufProto.fromBase64 !== 'function') {
    ;(Buffer as unknown as Record<string, unknown>).fromBase64 = function (s: string): Buffer {
      return Buffer.from(s, 'base64')
    }
  }
  if (typeof u8Proto.toBase64 !== 'function') {
    u8Proto.toBase64 = function (this: Uint8Array): string {
      return Buffer.from(this.buffer, this.byteOffset, this.byteLength).toString('base64')
    }
  }
  if (typeof u8Proto.fromBase64 !== 'function') {
    u8Proto.fromBase64 = function (s: string): Uint8Array {
      return new Uint8Array(Buffer.from(s, 'base64'))
    }
  }
}

// ---------------------------------------------------------------------------
// Bun.file / BunFile
// ---------------------------------------------------------------------------
export class BunFileShim {
  readonly path: string

  constructor(p: string) {
    this.path = p
  }  get size(): number {
    try {
      return fs.statSync(this.path).size
    } catch {
      return 0
    }
  }

  get name(): string {
    return path.basename(this.path)
  }

  async exists(): Promise<boolean> {
    try {
      await fsp.stat(this.path)
      return true
    } catch {
      return false
    }
  }

  async text(): Promise<string> {
    return fsp.readFile(this.path, 'utf8')
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text())
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const b = await fsp.readFile(this.path)
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
  }

  async bytes(): Promise<Uint8Array> {
    return fsp.readFile(this.path)
  }

  writer(): FileSinkShim {
    return new FileSinkShim(this.path)
  }

  /** Bun extension: stat the file (patched Node implementation). */
  async stat(): Promise<{ mtimeMs: number; size: number; isDirectory(): boolean }> {
    const st = await fsp.stat(this.path)
    return { mtimeMs: st.mtimeMs, size: st.size, isDirectory: () => st.isDirectory() }
  }

  /** Bun extension: delete the file. */
  async unlink(): Promise<void> {
    await fsp.unlink(this.path)
  }

  /** Bun extension: write content to the file (overwrite). */
  async write(content: string | Uint8Array | Blob | ArrayBuffer): Promise<void> {
    await bunWrite(this.path, content)
  }

  /** Bun extension: a sub-range view of the file. */
  slice(start?: number, end?: number): BunFileShim {
    return new BunFileSliceShim(this.path, start ?? 0, end)
  }

  stream(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start: async controller => {
        controller.enqueue(await fsp.readFile(this.path))
        controller.close()
      },
    })
  }
}

/** Sub-range view of a file (Bun's `BunFile.slice`). */
export class BunFileSliceShim extends BunFileShim {
  #start: number
  #end: number | undefined

  constructor(filePath: string, start: number, end: number | undefined) {
    super(filePath)
    this.#start = start
    this.#end = end
  }

  override get size(): number {
    const total = super.size
    return Math.max(0, (this.#end ?? total) - this.#start)
  }

  async #sliced(): Promise<Uint8Array> {
    const all = await fsp.readFile(this.path)
    return all.subarray(this.#start, this.#end)
  }

  override async text(): Promise<string> {
    return new TextDecoder('utf-8', { fatal: false }).decode(await this.#sliced())
  }

  override async bytes(): Promise<Uint8Array> {
    return this.#sliced()
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    const b = await this.#sliced()
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
  }
}

// ---------------------------------------------------------------------------
// Bun.FileSink
// ---------------------------------------------------------------------------
export class FileSinkShim {
  #fd: number | null = null
  #filePath: string

  constructor(filePath: string) {
    this.#filePath = filePath
  }

  #open(): void {
    fs.mkdirSync(path.dirname(this.#filePath), { recursive: true })
    this.#fd = fs.openSync(this.#filePath, 'a')
  }

  write(chunk: string | Uint8Array): void {
    if (this.#fd === null) this.#open()
    if (typeof chunk === 'string') fs.writeSync(this.#fd!, chunk)
    else fs.writeSync(this.#fd!, chunk)
  }

  flush(): void {
    /* sync writes are already flushed */
  }

  end(): void {
    this.close()
  }

  close(): void {
    if (this.#fd !== null) {
      fs.closeSync(this.#fd)
      this.#fd = null
    }
  }
}

// ---------------------------------------------------------------------------
// Bun.write / Bun.env / Bun.sleep / Bun.randomUUIDv7 / Bun.JSON / Bun.JSON5
// ---------------------------------------------------------------------------
async function bunWrite(dest: string, data: string | Uint8Array | Blob | ArrayBuffer): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  if (typeof data === 'string') {
    await fsp.writeFile(dest, data)
  } else if (data instanceof Blob) {
    await fsp.writeFile(dest, new Uint8Array(await data.arrayBuffer()))
  } else if (data instanceof ArrayBuffer) {
    await fsp.writeFile(dest, new Uint8Array(data))
  } else {
    await fsp.writeFile(dest, data)
  }
}

function bunSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function bunRandomUUIDv7(): string {
  return randomUUID()
}

// ---------------------------------------------------------------------------
// xxHash64 (standard algorithm; Bun's Bun.hash.xxHash64)
// ---------------------------------------------------------------------------
const PRIME64_1 = 0x9e3779b185ebca87n
const PRIME64_2 = 0xc2b2ae3d27d4eb4fn
const PRIME64_3 = 0x165667b19e3779f9n
const PRIME64_4 = 0x85ebca77c2b2ae63n
const PRIME64_5 = 0x27d4eb2f165667c5n
const MASK64 = 0xffffffffffffffffn

function rotl64(x: bigint, r: number): bigint {
  return ((x << BigInt(r)) | (x >> BigInt(64 - r))) & MASK64
}

function read64LE(bytes: Uint8Array, o: number): bigint {
  return (
    BigInt(bytes[o]!) |
    (BigInt(bytes[o + 1]!) << 8n) |
    (BigInt(bytes[o + 2]!) << 16n) |
    (BigInt(bytes[o + 3]!) << 24n) |
    (BigInt(bytes[o + 4]!) << 32n) |
    (BigInt(bytes[o + 5]!) << 40n) |
    (BigInt(bytes[o + 6]!) << 48n) |
    (BigInt(bytes[o + 7]!) << 56n)
  )
}

function xx64Round(acc: bigint, input: bigint): bigint {
  acc = (acc + input * PRIME64_2) & MASK64
  acc = rotl64(acc, 31)
  return (acc * PRIME64_1) & MASK64
}

function xx64MergeRound(acc: bigint, val: bigint): bigint {
  val = xx64Round(0n, val)
  return ((acc ^ val) * PRIME64_1 + PRIME64_4) & MASK64
}

function xx64ReadU64(bytes: Uint8Array, o: number): bigint {
  return (
    BigInt(bytes[o]!) |
    (BigInt(bytes[o + 1]!) << 8n) |
    (BigInt(bytes[o + 2]!) << 16n) |
    (BigInt(bytes[o + 3]!) << 24n) |
    (BigInt(bytes[o + 4]!) << 32n) |
    (BigInt(bytes[o + 5]!) << 40n) |
    (BigInt(bytes[o + 6]!) << 48n) |
    (BigInt(bytes[o + 7]!) << 56n)
  )
}

function bunHashXxHash64(data: string | ArrayBuffer | Uint8Array, seed?: bigint): bigint {
  let bytes: Uint8Array
  if (typeof data === 'string') bytes = new TextEncoder().encode(data)
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data)
  else bytes = data
  return xxHash64Core(bytes, seed)
}

function xxHash64Core(bytes: Uint8Array, seed: bigint | undefined): bigint {
  const s = seed ?? 0n
  const len = bytes.length
  let i = 0
  let h: bigint
  if (len >= 32) {
    let v1 = (s + PRIME64_1 + PRIME64_2) & MASK64
    let v2 = (s + PRIME64_2) & MASK64
    let v3 = (s + 0n) & MASK64
    let v4 = (s - PRIME64_1) & MASK64
    for (; i <= len - 32; i += 32) {
      v1 = xx64Round(v1, xx64ReadU64(bytes, i))
      v2 = xx64Round(v2, xx64ReadU64(bytes, i + 8))
      v3 = xx64Round(v3, xx64ReadU64(bytes, i + 16))
      v4 = xx64Round(v4, xx64ReadU64(bytes, i + 24))
    }
    h = (rotl64(v1, 1) + rotl64(v2, 7) + rotl64(v3, 12) + rotl64(v4, 18)) & MASK64
    h = xx64MergeRound(h, xx64ReadU64(bytes, i))
    i += 8
    h = xx64MergeRound(h, xx64ReadU64(bytes, i))
    i += 8
    h = xx64MergeRound(h, xx64ReadU64(bytes, i))
    i += 8
    h = xx64MergeRound(h, xx64ReadU64(bytes, i))
    i += 8
  } else {
    h = (s + PRIME64_5) & MASK64
  }
  h = (h + BigInt(len)) & MASK64
  for (; i + 8 <= len; i += 8) {
    h = xx64MergeRound(h, xx64ReadU64(bytes, i))
    h = (rotl64(h, 27) * PRIME64_1 + PRIME64_4) & MASK64
  }
  if (i + 4 <= len) {
    const v = BigInt(bytes[i]!) | (BigInt(bytes[i + 1]!) << 8n) | (BigInt(bytes[i + 2]!) << 16n) | (BigInt(bytes[i + 3]!) << 24n)
    h = (h ^ (v * PRIME64_1)) & MASK64
    h = (rotl64(h, 23) * PRIME64_2 + PRIME64_3) & MASK64
    i += 4
  }
  for (; i < len; i++) {
    h = (h ^ (BigInt(bytes[i]!) * PRIME64_5)) & MASK64
    h = (rotl64(h, 11) * PRIME64_1) & MASK64
  }
  h ^= h >> 33n
  h = (h * PRIME64_2) & MASK64
  h ^= h >> 29n
  h = (h * PRIME64_3) & MASK64
  h ^= h >> 32n
  return h & MASK64
}
function bunHash(data: string | ArrayBufferView | ArrayBuffer): number {
  let bytes: Uint8Array
  if (typeof data === 'string') bytes = new TextEncoder().encode(data)
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data)
  else bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  let h = 0x811c9dc5
  for (const b of bytes) {
    h ^= b
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

// ---------------------------------------------------------------------------
// Bun.stringWidth — east-asian width approximation (Bun's unicode width)
// ---------------------------------------------------------------------------
function isWideChar(c: number): boolean {
  return (
    c >= 0x1100 &&
    (c <= 0x115f || // Hangul Jamo
      c === 0x2329 ||
      c === 0x232a ||
      (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) || // CJK ... Yi
      (c >= 0xac00 && c <= 0xd7a3) || // Hangul Syllables
      (c >= 0xf900 && c <= 0xfaff) || // CJK Compatibility Ideographs
      (c >= 0xfe10 && c <= 0xfe19) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff) ||
      (c >= 0x20000 && c <= 0x3fffd))
  )
}

function bunStringWidth(s: string): number {
  let width = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    width += isWideChar(cp) ? 2 : 1
  }
  return width
}

// ---------------------------------------------------------------------------
// Bun.Glob
// ---------------------------------------------------------------------------
export class GlobShim {
  #re: RegExp

  constructor(pattern: string) {
    let src = ''
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i]!
      if (c === '*') {
        if (pattern[i + 1] === '*') {
          src += '.*'
          i++
        } else {
          src += '[^/]*'
        }
      } else if (c === '?') {
        src += '[^/]'
      } else {
        src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      }
    }
    this.#re = new RegExp(`^${src}$`)
  }

  async *scan(opts: { cwd?: string; absolute?: boolean; onlyFiles?: boolean; dot?: boolean } = {}): AsyncGenerator<string> {
    const root = opts.cwd ?? process.cwd()
    const onlyFiles = opts.onlyFiles ?? true
    for await (const abs of walkFiles(root, onlyFiles)) {
      const rel = path.relative(root, abs).split(path.sep).join('/')
      if (this.#re.test(rel)) yield opts.absolute ? abs : rel
    }
  }

  match(input: string): boolean {
    return this.#re.test(input)
  }
}

async function* walkFiles(dir: string, onlyFiles: boolean): AsyncGenerator<string> {
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!onlyFiles) yield p
      yield* walkFiles(p, onlyFiles)
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      yield p
    }
  }
}

// ---------------------------------------------------------------------------
// Bun.CryptoHasher
// ---------------------------------------------------------------------------
class CryptoHasherShim {
  #hash: ReturnType<typeof createHash>

  constructor(algorithm: string) {
    this.#hash = createHash(algorithm)
  }

  update(data: string | Uint8Array): this {
    this.#hash.update(data as never)
    return this
  }

  digest(encoding: 'hex' | 'base64' | 'buffer' | string): string | Buffer {
    if (encoding === 'buffer') return this.#hash.digest()
    return this.#hash.digest(encoding as 'hex')
  }
}

// ---------------------------------------------------------------------------
// Bun.color — minimal ANSI (TUI-only; DSH has no TUI)
// ---------------------------------------------------------------------------
function bunColor(color: string, format?: string): string {
  const hex = /^#?([0-9a-f]{6})$/i.exec(color)
  if (!hex) return ''
  const r = parseInt(hex[1]!.slice(0, 2), 16)
  const g = parseInt(hex[1]!.slice(2, 4), 16)
  const b = parseInt(hex[1]!.slice(4, 6), 16)
  if (format === 'ansi16') {
    const v = (r + g + b) / 3 >= 128 ? 97 : 30
    return `\x1b[${v}m`
  }
  if (format === 'ansi256') {
    const idx = 16 + 36 * Math.round(r / 255 * 5) + 6 * Math.round(g / 255 * 5) + Math.round(b / 255 * 5)
    return `\x1b[38;5;${idx}m`
  }
  return `\x1b[38;2;${r};${g};${b}m`
}

// ---------------------------------------------------------------------------
// Bun.Image — sharp-backed chainable pipeline (拍板#22)
//
// Implements the subset of the Bun.Image API that OMP's image-resize.ts (and
// the restored read/fetch image paths) consume: constructor over encoded
// bytes, async `metadata()`, lazy `.resize(w, h[, fit])`, terminal encoders
// `.png()/.jpeg({quality})/.webp({quality})`, and `.bytes()/.toBase64()`.
// Chains are re-playable: every instance is immutable until a terminal call,
// so `new Bun.Image(buf).resize(...).png().bytes()` and the parallel
// candidate fan-out in resizeImage all share one source buffer safely.
//
// sharp resolution cascade (the plugin bundles neither sharp nor libvips):
//   1. bare dynamic import — works when the plugin's dependency chain can
//      resolve sharp from its own chunk location;
//   2. createRequire(import.meta.url) — CJS interop through this file's
//      ancestor node_modules (the DSH install tree carries sharp under
//      @deepseek-ai/dsh/node_modules as dsh-attachment-local's dependency);
//   3. host-tree probe — walk up from this module for a
//      `@deepseek-ai/dsh/node_modules/sharp` sibling of the running app.
// Failures throw a guidance error; callers' try/catch degrade honestly
// (resizeImage returns the original bytes with decodeFailed metadata).
// ---------------------------------------------------------------------------

type SharpLike = {
  (input: Uint8Array, opts?: Record<string, unknown>): SharpLikeInstance
}
interface SharpLikeInstance {
  metadata(): Promise<Record<string, unknown>>
  resize(width: number, height: number, opts?: Record<string, unknown>): SharpLikeInstance
  png(opts?: Record<string, unknown>): SharpLikeInstance
  jpeg(opts?: Record<string, unknown>): SharpLikeInstance
  webp(opts?: Record<string, unknown>): SharpLikeInstance
  toBuffer(): Promise<Uint8Array>
}

let sharpLoaderPromise: Promise<SharpLike> | undefined

async function loadSharp(): Promise<SharpLike> {
  if (!sharpLoaderPromise) sharpLoaderPromise = resolveSharp()
  try {
    return await sharpLoaderPromise
  } catch (error) {
    // Cache only successes; let a later call retry resolution (the host tree
    // may mount sharp after an early boot-time attempt).
    sharpLoaderPromise = undefined
    throw error
  }
}

function normalizeSharp(mod: unknown): SharpLike | undefined {
  const candidate = (mod as { default?: unknown } | undefined)?.default ?? mod
  const fn = (candidate as { sharp?: unknown } | undefined)?.sharp ?? candidate
  return typeof fn === 'function' ? (fn as SharpLike) : undefined
}

async function resolveSharp(): Promise<SharpLike> {
  const errors: string[] = []
  try {
    const sharp = normalizeSharp(await import('sharp'))
    if (sharp) return sharp
    errors.push('import("sharp"): no callable export')
  } catch (error) {
    errors.push(`import("sharp"): ${(error as Error).message.split('\n')[0]}`)
  }
  try {
    const { createRequire } = await import('node:module')
    const required = normalizeSharp(createRequire(import.meta.url)('sharp'))
    if (required) return required
    errors.push('createRequire("sharp"): no callable export')
  } catch (error) {
    errors.push(`createRequire("sharp"): ${(error as Error).message.split('\n')[0]}`)
  }
  try {
    const { createRequire } = await import('node:module')
    const { fileURLToPath } = await import('node:url')
    const { existsSync } = await import('node:fs')
    let dir = path.dirname(fileURLToPath(import.meta.url))
    for (let depth = 0; depth < 10; depth++) {
      const parent = path.dirname(dir)
      if (parent === dir) break
      const probe = path.join(parent, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'sharp', 'package.json')
      if (existsSync(probe)) {
        const hostRequire = createRequire(path.join(parent, 'noop.js'))
        const sharp = normalizeSharp(hostRequire('sharp'))
        if (sharp) return sharp
      }
      dir = parent
    }
  } catch { /* fall through to the guidance error below */ }
  throw new Error(
    `DSH: Bun.Image 需要 sharp，但运行时解析失败（${errors.join('；')}）。` +
    'sharp 应随宿主 @deepseek-ai/dsh（dsh-attachment-local）安装；图片缩放将按调用方的降级路径处理。',
  )
}

/** Map sharp's format vocabulary onto Bun.Image's (width/height/format[/hasAlpha]). */
function mapImageMetadata(meta: Record<string, unknown>): { width: number; height: number; format?: string; hasAlpha?: boolean } {
  const format = typeof meta.format === 'string' ? meta.format : undefined
  return {
    width: typeof meta.width === 'number' ? meta.width : 0,
    height: typeof meta.height === 'number' ? meta.height : 0,
    ...(format !== undefined ? { format } : {}),
    ...(typeof meta.channels === 'number' ? { hasAlpha: meta.channels === 2 || meta.channels === 4 } : {}),
  }
}

interface ImageStep {
  op: 'resize' | 'png' | 'jpeg' | 'webp' | 'rotate' | 'flip' | 'blur' | 'sharpen'
  args: unknown[]
}

export class BunImageShim {
  #source: Uint8Array
  #steps: readonly ImageStep[]

  constructor(bytes: Uint8Array | ArrayBuffer, steps?: readonly ImageStep[]) {
    this.#source = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes
    this.#steps = steps ?? []
  }

  #extend(step: ImageStep): BunImageShim {
    return new BunImageShim(this.#source, [...this.#steps, step])
  }

  async metadata(): Promise<{ width: number; height: number; format?: string; hasAlpha?: boolean }> {
    const sharp = await loadSharp()
    return mapImageMetadata(await sharp(this.#source, { failOn: 'error' }).metadata())
  }

  resize(widthOrOpts?: number | { width?: number; height?: number; quality?: number }, height?: number): BunImageShim {
    if (typeof widthOrOpts === 'object' && widthOrOpts !== null) {
      return this.#extend({ op: 'resize', args: [widthOrOpts.width, widthOrOpts.height] })
    }
    return this.#extend({ op: 'resize', args: [widthOrOpts, height] })
  }

  /** Bun's resize() accepts { width, height, fit } — expose fit through to sharp. */
  resizeWithFit(width: number, height: number, fit: 'cover' | 'contain' | 'fill' | 'inside' | 'outside'): BunImageShim {
    return this.#extend({ op: 'resize', args: [width, height, { fit }] })
  }

  png(): BunImageShim { return this.#extend({ op: 'png', args: [] }) }
  jpeg(opts?: { quality?: number }): BunImageShim { return this.#extend({ op: 'jpeg', args: [opts] }) }
  webp(opts?: { quality?: number }): BunImageShim { return this.#extend({ op: 'webp', args: [opts] }) }
  rotate(): BunImageShim { return this.#extend({ op: 'rotate', args: [] }) }
  flip(flip: boolean): BunImageShim { return this.#extend({ op: 'flip', args: [flip] }) }
  blur(radius: number): BunImageShim { return this.#extend({ op: 'blur', args: [radius] }) }
  sharpen(radius?: number): BunImageShim { return this.#extend({ op: 'sharpen', args: [radius] }) }

  #build(): Promise<Uint8Array> {
    return loadSharp().then((sharp) => {
      let pipe: SharpLikeInstance = sharp(this.#source, { failOn: 'error' })
      for (const step of this.#steps) {
        switch (step.op) {
          case 'resize': {
            const [w, h, extra] = step.args as [number | undefined, number | undefined, { fit?: string } | undefined]
            pipe = pipe.resize(w ?? 0, h ?? 0, { fit: (extra?.fit as 'cover' | undefined) ?? 'cover' })
            break
          }
          case 'png': pipe = pipe.png(); break
          case 'jpeg': pipe = pipe.jpeg((step.args[0] ?? undefined) as { quality?: number } | undefined); break
          case 'webp': pipe = pipe.webp((step.args[0] ?? undefined) as { quality?: number } | undefined); break
          default: break // rotate/flip/blur/sharpen: declared for API parity, no in-repo consumer yet
        }
      }
      return pipe.toBuffer()
    })
  }

  async bytes(): Promise<Uint8Array> {
    return this.#build()
  }

  async toBase64(): Promise<string> {
    return Buffer.from(await this.#build()).toString('base64')
  }

  async write(destPath: string): Promise<number> {
    const data = await this.#build()
    await fsp.writeFile(destPath, data as never)
    return data.byteLength
  }
}


// ---------------------------------------------------------------------------
// Bun.Archive.write — tar / tar.gz writing (zip is framed in memory by zip.ts)
// ---------------------------------------------------------------------------
type ArchiveMemberContent = string | Uint8Array | Blob

async function memberToBytes(content: ArchiveMemberContent): Promise<Uint8Array> {
  if (typeof content === 'string') return new TextEncoder().encode(content)
  if (content instanceof Blob) return new Uint8Array(await content.arrayBuffer())
  return content
}

function encodeTarHeader(name: string, size: number): Uint8Array {
  const buf = new Uint8Array(512)
  const enc = new TextEncoder()
  const put = (offset: number, len: number, value: string): void => {
    buf.set(enc.encode(value).subarray(0, len), offset)
  }
  put(0, 100, name)
  put(100, 8, '0000644\0')
  put(108, 8, '0000000\0')
  put(116, 8, '0000000\0')
  put(124, 12, size.toString(8).padStart(11, '0') + '\0')
  put(136, 12, '00000000000\0')
  put(148, 8, '        ')
  put(156, 1, '0')
  put(257, 6, 'ustar\0')
  put(263, 2, '00')
  // checksum
  let sum = 0
  for (const b of buf) sum += b
  const checksum = sum.toString(8).padStart(6, '0')
  buf.set(enc.encode(checksum + '\0 '), 148)
  return buf
}

async function archiveWrite(
  destPath: string,
  record: Record<string, ArchiveMemberContent>,
  opts?: { compress?: 'gzip' },
): Promise<void> {
  const chunks: Uint8Array[] = []
  for (const [name, content] of Object.entries(record)) {
    const data = await memberToBytes(content)
    chunks.push(encodeTarHeader(name.replace(/\\/g, '/'), data.length), data)
    const pad = data.length % 512
    if (pad !== 0) chunks.push(new Uint8Array(512 - pad))
  }
  chunks.push(new Uint8Array(1024)) // two zero blocks terminate the archive
  let buf = Buffer.concat(chunks.map(c => Buffer.from(c.buffer, c.byteOffset, c.byteLength)))
  if (opts?.compress === 'gzip') buf = gzipSync(buf)
  await fsp.mkdir(path.dirname(destPath), { recursive: true })
  await fsp.writeFile(destPath, buf)
}

// ---------------------------------------------------------------------------
// Bun.stripANSI — strip ANSI escape sequences (S-2)
// ---------------------------------------------------------------------------
// pi-utils sanitizeText calls `Bun.stripANSI` on ESC-bearing text
// (@oh-my-pi/pi-utils src/sanitize-text.ts:35). The verbatim
// src/tools/omp/session/streaming-output.ts OutputSink instantiated on the
// bash chain (A-1) feeds every chunk through it, so the shim must provide it.
// Regex identical to src/tools/bash/sanitize-text.ts (CSI / OSC / simple
// escapes). Bun's built-in is a fuller ANSI parser (OSC 8 / DCS corner
// cases); for sanitize-then-strip usage this equivalence is sufficient.
const ANSI_RE = /\x1b(?:\[[0-9;]*[A-Za-z]|\][^\x07]*(?:\x07|\x1b\\)|[()][0-9A-B]|[^\[\]()])/g

function bunStripANSI(text: string): string {
  return text.replace(ANSI_RE, '')
}

// ---------------------------------------------------------------------------
// Global installation
// ---------------------------------------------------------------------------
export interface BunShimSurface {
  file(path: string): BunFileShim
  write(path: string, data: string | Uint8Array | Blob | ArrayBuffer): Promise<void>
  env: NodeJS.ProcessEnv
  sleep(ms: number): Promise<void>
  randomUUIDv7(): string
  stringWidth(s: string): number
  Glob: typeof GlobShim
  Archive: { write: typeof archiveWrite }
  FileSink: typeof FileSinkShim
  Image: typeof BunImageShim
  CryptoHasher: typeof CryptoHasherShim
  color(color: string, format?: string): string
  stripANSI(text: string): string
  JSON: { parse(s: string): unknown; stringify(v: unknown): string }
  JSON5: { parse(s: string): unknown }
  Encoding: Record<string, never>
  native: undefined
  BunFile: typeof BunFileShim
  version: string
  hash: ((input: string | ArrayBuffer | Uint8Array) => number) & {
    xxHash64(data: string | ArrayBuffer | Uint8Array, seed?: bigint): bigint
  }
}

export function installBunShim(): void {
  patchBase64()
  const g = globalThis as unknown as Record<string, unknown>
  if (g.Bun !== undefined) return
  g.Bun = {
    file: (p: string) => new BunFileShim(p),
    write: bunWrite,
    env: process.env,
    sleep: bunSleep,
    hash: bunHash,
    randomUUIDv7: bunRandomUUIDv7,
    stringWidth: bunStringWidth,
    Glob: GlobShim,
    Archive: { write: archiveWrite },
    FileSink: FileSinkShim,
    Image: BunImageShim,
    CryptoHasher: CryptoHasherShim,
    color: bunColor,
    stripANSI: bunStripANSI,
    JSON: JSON,
    JSON5,
    Encoding: {},
    native: undefined,
    BunFile: BunFileShim,
    version: 'node-shim',
  }
  // xxHash64 lives on the Bun.hash namespace in OMP usage (tui/utils HashChain)
  const bun = g.Bun as unknown as Record<string, unknown>
  ;(bun.hash as unknown as Record<string, unknown>).xxHash64 = bunHashXxHash64
}