/**
 * The read card's image box, pinned as a pure contract.
 *
 * The rule is not invented here: it is DSH's own lone-image rule (the one the
 * message gallery and the `tool.call.images` slot render by, see
 * `ui-attachment/src/MessageImage.tsx` `singleFit`), copied so a tool-card image
 * and a message image of the same file occupy the same box:
 *
 *  - the long edge is 240px;
 *  - the rendered aspect ratio is clamped to [0.25, 4] and the clamped overflow
 *    is cropped by `object-fit: cover`, anchored top for very tall images and
 *    left for very wide ones;
 *  - an image is never upscaled past its natural size.
 */
import { describe, expect, it } from 'vitest'
import { imageFitBox } from '../../src/web/client/rows/image-card.ts'

describe('imageFitBox', () => {
  it('sizes a square image to the 240 box, scaled back to its natural size', () => {
    expect(imageFitBox({ width: 200, height: 200 })).toEqual({ width: 200, height: 200, objectPosition: 'center' })
  })

  it('never upscales a small image', () => {
    expect(imageFitBox({ width: 32, height: 32 })).toEqual({ width: 32, height: 32, objectPosition: 'center' })
  })

  it('caps the long edge at 240 for a large image', () => {
    expect(imageFitBox({ width: 1000, height: 1000 })).toEqual({ width: 240, height: 240, objectPosition: 'center' })
  })

  it('clamps a very wide image to 4:1 and anchors the crop on the left', () => {
    expect(imageFitBox({ width: 1200, height: 200 })).toEqual({ width: 240, height: 60, objectPosition: 'left center' })
  })

  it('clamps a very tall image to 1:4 and anchors the crop on the top', () => {
    expect(imageFitBox({ width: 200, height: 1200 })).toEqual({ width: 60, height: 240, objectPosition: 'center top' })
  })

  it('leaves an exactly 4:1 image centred (the clamp is not strict)', () => {
    expect(imageFitBox({ width: 400, height: 100 })).toEqual({ width: 240, height: 60, objectPosition: 'center' })
  })
})
