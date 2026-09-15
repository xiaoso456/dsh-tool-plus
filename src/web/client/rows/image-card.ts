/**
 * Image material for the `read` card, as a pure derivation.
 *
 * A `read` that resolves to an image settles with the reference in the
 * result's own image block, never in `meta`: metadata rides the 256 KiB
 * lossless-JSON budget and is the wrong carrier for a session-authorized
 * resource, so the image branch of the read row is exactly the case where the
 * text card declines (`narrowReadCardMeta` returns `null`).
 *
 * The derivation is deliberately strict — one block of an unknown type, one
 * malformed reference, or a missing path declines the whole card — because the
 * alternative is a card that draws a picture while silently dropping whatever
 * else the result carried.
 * @module @xiaoso/dsh-tool-plus/web/client/rows/image-card
 */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { displayPath, isSettled, type CardBlockView } from '../row-utils.ts'

/** What the read row needs to draw a result's images, and nothing more. */
export interface CardImageMaterial {
  /** Display label for the card header: the request path, workspace-shortened. */
  label: string
  /** The requested path, verbatim — the absolute path the file viewer opens. */
  path: string
  /** The result's durable references, in result order. */
  images: ImageAttachmentRef[]
}

/** Whether `value` is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A finite number — a `NaN` dimension would only break layout later. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Display box for a lone image — DSH's own rule, copied from
 * `ui-attachment/src/MessageImage.tsx::singleFit` so a tool-card image and a
 * message image of the same file occupy the same box: long edge 240px, the
 * rendered aspect ratio clamped to [0.25, 4] (the clamped overflow is cropped
 * by `object-fit: cover`), never upscaled past the natural size, and the crop
 * anchored to the top of very tall images / the left of very wide ones, where
 * the informative content usually starts.
 *
 * The clamp is deliberately not strict: an exactly 4:1 image stays centred.
 * @param size - the reference's intrinsic dimensions, in pixels.
 * @returns the rendered box and the crop anchor.
 */
export function imageFitBox(size: { width: number; height: number }): {
  width: number
  height: number
  objectPosition: string
} {
  const natural = size.width / size.height
  const ratio = Math.min(4, Math.max(0.25, natural))
  const box = ratio >= 1 ? { width: 240, height: 240 / ratio } : { width: 240 * ratio, height: 240 }
  const scale = Math.min(1, size.width / box.width, size.height / box.height)
  return {
    width: Math.max(1, Math.round(box.width * scale)),
    height: Math.max(1, Math.round(box.height * scale)),
    objectPosition: natural < 0.25 ? 'center top' : natural > 4 ? 'left center' : 'center',
  }
}

/**
 * The call's arguments.
 *
 * A settled node carries the paired call head under `call`, and that is the
 * only source: the node-level `argsRaw` belongs to a *running* call, so reading
 * it here would let a truncated settled call (head outside the window) render a
 * card whose argument summary is empty. `parseCardArgs` narrows the same field
 * the same way.
 * @param block - the settled call node.
 * @returns the parsed argument object, or `null`.
 */
function callArgs(block: CardBlockView): Record<string, unknown> | null {
  const raw = block.call?.argsRaw
  if (typeof raw !== 'string') return null
  try {
    const value: unknown = JSON.parse(raw)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

/**
 * Validate one wire attachment object as a durable image reference.
 *
 * The store's `ImageAttachmentRef` brands `attachmentId` and `mediaType`; the
 * result's JSON carries plain strings. This is the single boundary where a
 * validated wire object becomes that typed reference, field by field — and the
 * copy keeps the optional fields (`name`, `originalDimensions`) the wire may
 * carry.
 * @param value - the image block's `attachment` field.
 * @returns the typed reference, or `null` when any required field is wrong.
 */
function typedAttachment(value: unknown): ImageAttachmentRef | null {
  if (!isRecord(value)) return null
  if (typeof value.attachmentId !== 'string') return null
  if (typeof value.mediaType !== 'string') return null
  if (!isFiniteNumber(value.bytes)) return null
  if (!isFiniteNumber(value.width)) return null
  if (!isFiniteNumber(value.height)) return null
  // The card lays the image out from its intrinsic size, so a zero or negative
  // dimension is a reference the layout cannot use.
  if (value.width <= 0 || value.height <= 0) return null
  return { ...value } as unknown as ImageAttachmentRef
}

/**
 * Derive the read card's image material from a settled result.
 *
 * Declines — rather than guessing — whenever the result would not be fully
 * representable: a running call, a failed call, a result whose content carries
 * a block that is neither text nor image, an image whose reference is
 * malformed, a text-only result (the text card owns those), or a call whose
 * arguments name no path.
 * @param block - the frozen call node.
 * @param cwd - the session workspace root, for shortening the label.
 * @returns the material, or `null` to leave the row on its existing path.
 */
export function imageCardMaterial(block: CardBlockView, cwd: string | undefined): CardImageMaterial | null {
  if (!isSettled(block) || block.isError === true) return null
  const content = block.content
  if (!Array.isArray(content)) return null
  const images: ImageAttachmentRef[] = []
  for (const blockContent of content) {
    if (!isRecord(blockContent)) return null
    if (blockContent.type === 'text') continue
    if (blockContent.type !== 'image') return null
    const image = typedAttachment(blockContent.attachment)
    if (image === null) return null
    images.push(image)
  }
  if (images.length === 0) return null
  const path = callArgs(block)?.path
  // A blank path names nothing to open: it fails the `{ path: '  ' }` case the
  // same way a missing one does.
  if (typeof path !== 'string' || path.trim() === '') return null
  return { label: displayPath(path, cwd), path, images }
}