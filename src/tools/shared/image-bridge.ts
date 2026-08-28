/**
 * Shared image bridge (拍板#22, 2026-08-28) — the single DSH-facing seam
 * through which the OMP engines (read's restored image path, fetch's URL
 * image path) turn image bytes into model-visible content.
 *
 * DSH's content model has no inline base64 image block: an ImageBlock is
 * exactly `{ type: 'image', attachment: ImageAttachmentRef }`
 * (dsh-llm types). Every image entering the model therefore MUST pass
 * through the host `attachments` service (saveImage → content-addressed
 * normalized master → per-request variants). This module owns:
 *
 *  - the extension → media-type table (mirrors official dsh-tool-fs),
 *  - the route vision-capability probe (omp flavor: unknown passes, explicit
 *    non-image routes soft-refuse to a model-facing metadata text instead of
 *    a thrown error — 用户拍板 2026-08-28),
 *  - saveImage + AttachmentError → recoverable-message mapping (official
 *    read_image's five-branch design, verbatim wording),
 *  - the `<path>/<type>/<content>` envelope with originalDimensions
 *    coordinate-multiplier advice (official formatImageReadOutput).
 *
 * The OMP layer never imports cordis/dsh packages: engines call these helpers
 * through `ToolSession.getAttachments` and the exec context the adapter
 * hands them, keeping the omp/ copies upstream-shaped.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** Normalized outcome of one attachment-store commit (official ref shape). */
export interface SavedImageRef {
  attachmentId: string
  mediaType: ImageMediaType
  bytes: number
  width: number
  height: number
  name?: string
  originalDimensions?: { width: number; height: number }
}

/** Minimal structural view of the host `attachments` service. */
export interface AttachmentsService {
  imageLimits?: {
    maxImageBytes?: number
    maxMessageImageBytes?: number
    maxImagePixels?: number
    maxImageDimension?: number
    mediaTypes?: readonly string[]
  }
  saveImage?: (input: { data: Uint8Array; mediaType: string; name?: string }) => Promise<unknown>
}

/** Minimal structural view of the host `llm` service. */
export interface LlmRouteService {
  resolveModelInfo?: (provider: string, model: string, signal: AbortSignal) => Promise<{ inputModalities?: readonly string[] }>
}

/**
 * Facade the DSH adapter builds over ctx.get('attachments')/ctx.get('llm')
 * plus the calling route, handed to the engines via ToolSession.
 */
export interface ImageBridge {
  attachments: AttachmentsService | undefined
  /** 'supported' = route declares image input; 'unsupported' = declares it does not; 'unknown' = not resolvable. */
  routeImageSupport: () => Promise<'supported' | 'unsupported' | 'unknown'>
}

// ---------------------------------------------------------------------------
// Extension → media type (official dsh-tool-fs IMAGE_EXTENSIONS)
// ---------------------------------------------------------------------------

export const IMAGE_EXTENSIONS: Readonly<Record<string, ImageMediaType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

export function imageMediaTypeForExtension(ext: string): ImageMediaType | undefined {
  return IMAGE_EXTENSIONS[ext.toLowerCase()]
}

/** Admission byte cap: min(source cap, per-message cap) — official formula. */
export function imageByteCap(bridge: ImageBridge, fallback = 20 * 1024 * 1024): number {
  const limits = bridge.attachments?.imageLimits
  const caps = [limits?.maxImageBytes, limits?.maxMessageImageBytes].filter(
    (n): n is number => typeof n === 'number' && n > 0,
  )
  return caps.length > 0 ? Math.min(...caps) : fallback
}

// ---------------------------------------------------------------------------
// saveImage + official error mapping
// ---------------------------------------------------------------------------

/** Commit bytes to the attachment store, mapping AttachmentErrors to the
 * official read_image recoverable messages. `displayPath` is only used for
 * message rendering. Throws Error (not AttachmentError) for model consumption. */
export async function saveImageViaBridge(
  bridge: ImageBridge,
  input: { data: Uint8Array; mediaType: ImageMediaType; name?: string; displayPath: string },
): Promise<SavedImageRef> {
  const { displayPath, ...commit } = input
  const saveImage = bridge.attachments?.saveImage
  if (typeof saveImage !== 'function') {
    throw new Error(`cannot read "${displayPath}" as an image: no attachment service is mounted`)
  }
  let ref: unknown
  try {
    ref = await saveImage.call(bridge.attachments, commit)
  } catch (error) {
    const code = (error as { code?: unknown })?.code
    const message = error instanceof Error ? error.message : String(error)
    if (typeof code !== 'string') throw error
    if (code === 'IMAGE_DIMENSION_TOO_LARGE') {
      const limit = bridge.attachments?.imageLimits?.maxImageDimension ?? 8192
      throw new Error(`cannot read "${displayPath}": at least one image side exceeds the ${limit}px limit; downscale the image and read the smaller copy`, { cause: error })
    }
    if (code === 'IMAGE_TOO_MANY_PIXELS') {
      const limit = bridge.attachments?.imageLimits?.maxImagePixels ?? 64_000_000
      throw new Error(`cannot read "${displayPath}": the image exceeds the ${limit}-pixel decoded-size limit; downscale the image and read the smaller copy`, { cause: error })
    }
    if (code === 'IMAGE_TOO_LARGE') {
      throw new Error(`cannot read "${displayPath}": the image cannot be stored within the deployment's byte limits; downscale the image and read the smaller copy`, { cause: error })
    }
    if (code === 'ATTACHMENT_WRITE_FAILED' && /16-bit PNG/iu.test(message)) {
      throw new Error(`cannot read "${displayPath}": the 16-bit PNG could not be converted to the normalized 8-bit sRGB form; convert it to an 8-bit PNG/JPEG/WebP and retry`, { cause: error })
    }
    if (code === 'IMAGE_TYPE_MISMATCH') {
      const ext = /\.[a-z0-9]+$/iu.exec(displayPath.toLowerCase())?.[0] ?? displayPath
      throw new Error(`cannot read "${displayPath}": the ${ext} extension declares ${input.mediaType}, but the bytes use a different image format; rename the file to match its actual format if it is PNG/JPEG/WebP/GIF, or convert it to one of those formats`, { cause: error })
    }
    throw error
  }
  return normalizeSavedImageRef(ref)
}

/** Accept either the official branded ref or a plain object from a mock. */
export function normalizeSavedImageRef(ref: unknown): SavedImageRef {
  const r = (ref ?? {}) as Record<string, unknown>
  const media = typeof r.mediaType === 'string' ? r.mediaType : 'image/png'
  return {
    attachmentId: String(r.attachmentId ?? ''),
    mediaType: (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(media)
      ? media
      : 'image/png') as ImageMediaType,
    bytes: typeof r.bytes === 'number' ? r.bytes : 0,
    width: typeof r.width === 'number' ? r.width : 0,
    height: typeof r.height === 'number' ? r.height : 0,
    ...(typeof r.name === 'string' && r.name.length > 0 ? { name: r.name } : {}),
    ...(isDimsRecord(r.originalDimensions) ? { originalDimensions: { width: r.originalDimensions.width, height: r.originalDimensions.height } } : {}),
  }
}

function isDimsRecord(v: unknown): v is { width: number; height: number } {
  return (
    typeof v === 'object' && v !== null &&
    typeof (v as { width?: unknown }).width === 'number' &&
    typeof (v as { height?: unknown }).height === 'number'
  )
}

// ---------------------------------------------------------------------------
// Official envelope (formatImageReadOutput, verbatim wording)
// ---------------------------------------------------------------------------

export function formatImageEnvelope(displayPath: string, image: SavedImageRef): string {
  let scaled = ''
  if (image.originalDimensions !== undefined && image.width > 0 && image.height > 0) {
    const x = (image.originalDimensions.width / image.width).toFixed(2)
    const y = (image.originalDimensions.height / image.height).toFixed(2)
    const advice = x === y ? `multiply coordinates by ${x}` : `multiply x coordinates by ${x} and y coordinates by ${y}`
    scaled = ` (downscaled from ${image.originalDimensions.width}x${image.originalDimensions.height} px; ${advice} to locate features in the original file)`
  }
  return `<path>${displayPath}</path>
<type>image</type>
<content>
${image.mediaType} image, ${image.width}x${image.height} px, ${image.bytes} bytes${scaled}
</content>`
}

/** Content blocks for one committed image: envelope text + attachment block. */
export function imageContentBlocks(displayPath: string, image: SavedImageRef): Array<
  | { type: 'text'; text: string }
  | { type: 'image'; attachment: SavedImageRef }
> {
  return [
    { type: 'text', text: formatImageEnvelope(displayPath, image) },
    { type: 'image', attachment: image },
  ]
}

// ---------------------------------------------------------------------------
// Soft refusal: metadata-only text when the route/model cannot see images
// (用户拍板 2026-08-28: 返回错误文本说明不支持，而不是程序抛错)
// ---------------------------------------------------------------------------

export function formatImageUnsupportedNote(
  displayPath: string,
  metadata: { mimeType?: string; width?: number; height?: number; bytes?: number } | undefined,
  reason: string,
): string {
  const dims = metadata?.width !== undefined && metadata?.height !== undefined
    ? `${metadata.width}x${metadata.height} px`
    : 'unknown dimensions'
  const bytes = typeof metadata?.bytes === 'number' ? `, ${metadata.bytes} bytes` : ''
  return (
    `cannot display "${displayPath}" as an image: ${reason}. ` +
    `The file is an image (${metadata?.mimeType ?? 'unknown type'}, ${dims}${bytes}). ` +
    'Switch the session to an image-capable model to read images, or convert the file to a text-extractable format (PDF/DOCX/notebook are read as text).'
  )
}
