/**
 * Ported from @deepseek-ai/dsh-tool-fs read-image.ts (dsh 0.1.0-rc.8).
 * Replicates official `read_image` logic for dsh-tool-plus full-house.
 * The tool is registered only when the `attachments` service is mounted,
 * mirroring the official `ctx.inject(['attachments'], applyReadImageTool)` gate.
 * @module @xiaoso/dsh-tool-plus/tools/read-image
 */

import { basename, extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import { FsError } from '@deepseek-ai/dsh-fs'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'

// ---------------------------------------------------------------------------
// Image extension → media type
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS: Readonly<Record<string, ImageMediaType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

export interface ImageReadValue {
  path: string
  image: {
    attachmentId: string
    mediaType: ImageMediaType
    bytes: number
    width: number
    height: number
    name?: string
    originalDimensions?: { width: number; height: number }
  }
}

export function imageMediaTypeForPath(filePath: string): ImageMediaType | undefined {
  return IMAGE_EXTENSIONS[extname(filePath).toLowerCase()]
}

// ---------------------------------------------------------------------------
// Session cwd helpers (copied from dsh-tool-fs session-cwd.ts)
// ---------------------------------------------------------------------------

const PARENT_PATH_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/

function sessionCwd(exec: ToolExecution, requestedPath: string): string | undefined {
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined || (!PARENT_PATH_SEGMENT.test(cwd) && !PARENT_PATH_SEGMENT.test(requestedPath))) return cwd
  return canonicalPath(cwd)
}

function sessionResolveOptions(
  exec: ToolExecution,
  requestedPath: string,
): { cwd?: string; signal?: AbortSignal } {
  const cwd = sessionCwd(exec, requestedPath)
  return {
    ...(cwd !== undefined ? { cwd } : {}),
    signal: exec.signal,
  }
}

async function resolveRegularReadTarget(
  ctx: Context,
  exec: ToolExecution,
  requestedPath: string,
) {
  const target = await ctx.fs.resolve(requestedPath, sessionResolveOptions(exec, requestedPath))
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) {
    ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
    throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
  }
  if (info.type !== 'file') {
    throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  }
  return { target, info }
}

// ---------------------------------------------------------------------------
// Route capability gate (optional — skipped when `llm` absent, per task note)
// ---------------------------------------------------------------------------

export async function assertImageCapableRoute(
  ctx: Context,
  exec: ToolExecution,
  requestedPath: string,
): Promise<void> {
  const routed = (exec.agent?.session as unknown as { requestHeader?: () => { config?: { provider?: string; model?: string } } })?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm' as never) as unknown as { resolveModelInfo?: (p: string, m: string, s: AbortSignal) => Promise<{ inputModalities?: string[] }> } | undefined
  if (provider === undefined || model === undefined || llm === undefined || typeof llm.resolveModelInfo !== 'function') {
    // When llm service or route is not resolvable, skip the gate — the
    // attachment store's own media-type/size checks remain authoritative.
    // Official implementation would throw here; tool-plus treats this as
    // non-fatal for simplicity (see plan §0.2: "skip model capability check").
    return
  }
  const active = await llm.resolveModelInfo(provider, model, exec.signal)
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new Error(
      `cannot read "${requestedPath}" as an image: model "${model}" does not declare image input; switch to an image-capable model to read images`,
    )
  }
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

export function imageRefFromValue(image: ImageReadValue['image']): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(image.attachmentId),
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...(image.name === undefined ? {} : { name: image.name }),
    ...(image.originalDimensions === undefined
      ? {}
      : { originalDimensions: { ...image.originalDimensions } }),
  }
}

export function formatImageReadOutput(displayPath: string, image: ImageReadValue['image']): string {
  let scaled = ''
  if (image.originalDimensions !== undefined) {
    const x = (image.originalDimensions.width / image.width).toFixed(2)
    const y = (image.originalDimensions.height / image.height).toFixed(2)
    const advice = x === y ? `multiply coordinates by ${x}` : `multiply x coordinates by ${x} and y coordinates by ${y}`
    scaled = ` (downscaled from ${image.originalDimensions.width}x${image.originalDimensions.height} px; ${advice} to locate features in the original file)`
  }
  return `<path>${displayPath}</path>\n<type>image</type>\n<content>\n${image.mediaType} image, ${image.width}x${image.height} px, ${image.bytes} bytes${scaled}\n</content>`
}

function imageReadContent(value: ImageReadValue): ContentBlock[] {
  return [
    { type: 'text', text: formatImageReadOutput(value.path, value.image) },
    { type: 'image', attachment: imageRefFromValue(value.image) },
  ]
}

// ---------------------------------------------------------------------------
// Core registration — mirrors official applyReadImageTool
// ---------------------------------------------------------------------------

function applyReadImageTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'read_image',
      description:
        'Read a PNG/JPEG/WebP/GIF file and return the image itself. Harness validates and downscales large supported images before the next model request, so use this tool directly instead of installing image libraries or creating thumbnails merely to inspect an image. Independent files may be read concurrently in small batches. Requires the current model to accept image input.',
      parameters: {
        file_path: {
          type: 'string',
          required: true,
          description: 'Path to the image file, resolved by the filesystem backend.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            image: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                attachmentId: { type: 'string', required: true },
                mediaType: {
                  type: 'string',
                  enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
                  required: true,
                },
                bytes: { type: 'integer', required: true },
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
                name: { type: 'string' },
                originalDimensions: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    width: { type: 'integer', required: true },
                    height: { type: 'integer', required: true },
                  },
                },
              },
            },
          },
        },
        render: (_args: unknown, value: unknown) => imageReadContent(value as ImageReadValue),
      },
      isConcurrencySafe: () => true,
      async execute(args: { file_path: string }, exec: ToolExecution): Promise<ImageReadValue> {
        if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')

        const mediaType = imageMediaTypeForPath(args.file_path)
        if (mediaType === undefined) {
          throw new Error(`cannot read "${args.file_path}": read_image only accepts PNG/JPEG/WebP/GIF paths`)
        }
        const attachments = ctx.get('attachments' as never) as
          | {
              imageLimits: {
                mediaTypes: readonly string[]
                maxImageBytes: number
                maxMessageImageBytes: number
                maxImageDimension: number
                maxImagePixels: number
              }
              saveImage: (input: { data: Uint8Array; mediaType: ImageMediaType; name?: string }) => Promise<ImageAttachmentRef>
            }
          | undefined
        if (attachments === undefined) {
          throw new Error(`cannot read "${args.file_path}" as an image: no attachment service is mounted`)
        }
        if (!attachments.imageLimits.mediaTypes.includes(mediaType)) {
          throw new Error(`cannot read "${args.file_path}": ${mediaType} images are not accepted by this deployment`)
        }
        await assertImageCapableRoute(ctx, exec, args.file_path)

        const { target, info } = await resolveRegularReadTarget(ctx, exec, args.file_path)

        const byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
        const data = await ctx.fs.readBytes(target, exec.signal, byteCap)

        let ref: ImageAttachmentRef
        try {
          ref = await attachments.saveImage({ data, mediaType, name: basename(target.displayPath) })
        } catch (error: unknown) {
          if (!(error instanceof AttachmentError)) throw error
          if (error.code === 'IMAGE_DIMENSION_TOO_LARGE') {
            throw new Error(
              `cannot read "${target.displayPath}": at least one image side exceeds the ${attachments.imageLimits.maxImageDimension}px limit; downscale the image and read the smaller copy`,
              { cause: error },
            )
          }
          if (error.code === 'IMAGE_TOO_MANY_PIXELS') {
            throw new Error(
              `cannot read "${target.displayPath}": the image exceeds the ${attachments.imageLimits.maxImagePixels}-pixel decoded-size limit; downscale the image and read the smaller copy`,
              { cause: error },
            )
          }
          if (error.code === 'IMAGE_TOO_LARGE') {
            throw new Error(
              `cannot read "${target.displayPath}": the image cannot be stored within the deployment's byte limits; downscale the image and read the smaller copy`,
              { cause: error },
            )
          }
          if (error.code === 'ATTACHMENT_WRITE_FAILED' && /16-bit PNG/iu.test(error.message)) {
            throw new Error(
              `cannot read "${target.displayPath}": the 16-bit PNG could not be converted to the normalized 8-bit sRGB form; convert it to an 8-bit PNG/JPEG/WebP and retry`,
              { cause: error },
            )
          }
          if (error.code !== 'IMAGE_TYPE_MISMATCH') throw error
          const extension = extname(target.displayPath).toLowerCase()
          throw new Error(
            `cannot read "${target.displayPath}": the ${extension} extension declares ${mediaType}, but the bytes use a different image format; rename the file to match its actual format if it is PNG/JPEG/WebP/GIF, or convert it to one of those formats`,
            { cause: error },
          )
        }
        ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
        const value: ImageReadValue = {
          path: target.displayPath,
          image: {
            attachmentId: ref.attachmentId as unknown as string,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            ...(ref.name === undefined ? {} : { name: ref.name }),
            ...(ref.originalDimensions === undefined
              ? {}
              : { originalDimensions: { ...ref.originalDimensions } }),
          },
        }
        return value
      },
      presentCall(args: { file_path: string }): GenericCallView {
        return {
          card: 'generic',
          title: `Read image ${args.file_path}`,
          kind: 'read',
          locations: [{ path: args.file_path }],
        }
      },
    }),
  )
}

// ---------------------------------------------------------------------------
// Public entry — deferred registration when `attachments` not yet mounted
// ---------------------------------------------------------------------------

/**
 * Register `read_image` when the `attachments` service is available.
 * If the service is not yet mounted, defer via `ctx.inject(['attachments'], …)`
 * so the tool appears as soon as the store does — identical to the official
 * `dsh-tool-fs` gate (`ctx.inject(['attachments'], applyReadImageTool)`).
 */
export function registerReadImage(ctx: Context): void {
  const attachments = ctx.get('attachments' as never)
  if (attachments !== undefined) {
    applyReadImageTool(ctx)
    return
  }
  // Cordis inject: re-run when `attachments` appears. The callback receives a
  // context that is guaranteed to have the service.
  try {
    ;(ctx as unknown as { inject: (deps: string[], fn: (c: Context) => void) => void }).inject(
      ['attachments'],
      (injectedCtx: Context) => {
        applyReadImageTool(injectedCtx)
      },
    )
  } catch {
    // Fallback for test harnesses where `inject` is not available — no-op
    // until attachments is mounted.
  }
}

// Back-compat alias: official name is applyReadImageTool
export { applyReadImageTool }
