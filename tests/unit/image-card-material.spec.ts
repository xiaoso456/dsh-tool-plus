/**
 * The read card's image material, pinned as a pure contract.
 *
 * A `read` that resolves to an image settles with the reference in the result's
 * own image block — never in `meta`, which stays on the 256 KiB lossless-JSON
 * budget and is the wrong carrier for a session-authorized resource. This spec
 * locks the derivation (and every decline) so the row stays a thin render.
 */
import { describe, expect, it } from 'vitest'
import { imageCardMaterial } from '../../src/web/client/rows/image-card.ts'

/** One durable normalized attachment reference, shaped like the host writes it. */
const ATTACHMENT = {
  attachmentId: 'sha256:0f1e2d3c',
  mediaType: 'image/png',
  bytes: 2565,
  width: 64,
  height: 64,
  name: 'sample.png',
}

const SECOND = { ...ATTACHMENT, attachmentId: 'sha256:99887766', width: 32, height: 32 }

const PATH = 'D:/code/包下载/_twc-card-check/sample.png'
const CWD = 'D:/code/包下载'

/** A settled `read` result carrying the given content blocks. */
function settled(content: unknown[], overrides: Record<string, unknown> = {}): never {
  return {
    kind: 'tool-result',
    name: 'read',
    // The real settled node carries the call head (`call`), never a top-level
    // `argsRaw`; a truncated window leaves `call: null`.
    call: { name: 'read', argsRaw: JSON.stringify({ path: PATH }) },
    content,
    isError: false,
    ...overrides,
  } as never
}

describe('imageCardMaterial', () => {
  it('derives the shortened label and the references from the result content', () => {
    const material = imageCardMaterial(
      settled([
        { type: 'image', attachment: ATTACHMENT },
        { type: 'text', text: 'sample.png (image/png, 64x64, 2565 bytes)' },
      ]),
      CWD,
    )
    expect(material).toEqual({ label: '_twc-card-check/sample.png', path: PATH, images: [ATTACHMENT] })
  })

  it('keeps every image in result order', () => {
    const material = imageCardMaterial(
      settled([{ type: 'image', attachment: ATTACHMENT }, { type: 'image', attachment: SECOND }]),
      CWD,
    )
    expect(material?.images).toEqual([ATTACHMENT, SECOND])
  })

  it('declines a failed call so the error card keeps its own body', () => {
    expect(imageCardMaterial(settled([{ type: 'image', attachment: ATTACHMENT }], { isError: true }), CWD)).toBeNull()
  })

  it('declines a running call (no result content yet)', () => {
    expect(imageCardMaterial({ kind: 'tool-call', name: 'read', argsRaw: JSON.stringify({ path: PATH }) } as never, CWD)).toBeNull()
  })

  it('declines when a block is neither text nor image (nothing may be silently hidden)', () => {
    expect(imageCardMaterial(settled([{ type: 'image', attachment: ATTACHMENT }, { type: 'file', name: 'x.bin' }]), CWD)).toBeNull()
  })

  it('declines a malformed attachment reference', () => {
    expect(imageCardMaterial(settled([{ type: 'image', attachment: {} }]), CWD)).toBeNull()
    expect(imageCardMaterial(settled([{ type: 'image' }]), CWD)).toBeNull()
    expect(imageCardMaterial(settled([{ type: 'image', attachment: { ...ATTACHMENT, width: 'wide' } }]), CWD)).toBeNull()
    // The card lays the image out from its intrinsic size, so a non-positive one
    // is a reference the layout cannot use.
    expect(imageCardMaterial(settled([{ type: 'image', attachment: { ...ATTACHMENT, width: 0 } }]), CWD)).toBeNull()
    expect(imageCardMaterial(settled([{ type: 'image', attachment: { ...ATTACHMENT, height: -1 } }]), CWD)).toBeNull()
  })

  it('declines a text-only read so the existing read card keeps rendering it', () => {
    expect(imageCardMaterial(settled([{ type: 'text', text: 'plain file' }]), CWD)).toBeNull()
  })

  it('declines when the call carries no usable path', () => {
    const image = [{ type: 'image', attachment: ATTACHMENT }]
    expect(imageCardMaterial(settled(image, { call: { name: 'read', argsRaw: '{}' } }), CWD)).toBeNull()
    expect(imageCardMaterial(settled(image, { call: null }), CWD)).toBeNull()
    // A settled node carries the head in `call`; a top-level `argsRaw` belongs to
    // a running call and must not stand in for a truncated settled one.
    expect(imageCardMaterial(settled(image, { call: null, argsRaw: JSON.stringify({ path: PATH }) }), CWD)).toBeNull()
    expect(imageCardMaterial(settled(image, { call: { name: 'read', argsRaw: JSON.stringify({ path: '  ' }) } }), CWD)).toBeNull()
  })
})
