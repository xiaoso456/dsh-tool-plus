/**
 * `read` row: a line-numbered window view, or the image the read returned.
 *
 * Two mutually exclusive bodies hang off one call:
 * - The Host projected a readable window (`meta`) → the line-numbered text card.
 * - It did not (an image, a directory, a sqlite or archive target, an internal
 *   URL, a multi-range `:raw` read) → this row tries the image branch, which
 *   draws the result's image blocks through the session-authorized loader the
 *   slot hands every tool view. Anything else keeps the generic shell and its
 *   result text.
 *
 * The image branch reimplements the shipped message-image interaction — the
 * `singleFit` box, 64px gallery tiles, a retry control on a failed load, and a
 * body-portal lightbox for the original — so a tool-card image and a message
 * image of the same file behave identically. It lives here rather than in
 * `image-card.ts` because that module stays pure: this file owns the loader
 * calls, their cancellation, and the DOM.
 * @module @xiaoso/dsh-tool-plus/web/client/rows/ReadRow
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ReadBlock, IconCloseOutlineRegular, fileSizeText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { narrowReadCardMeta } from '../../contract.ts'
import { CARD_LOCALE_NS } from '../labels.ts'
import {
  cardMeta, cardState, cardTitle, displayPath, isErrorResult, isSubCall, parseCardArgs, readBlockLabels,
  resultText, type CardBlockView, type CardOpenFileOptions, type CardTranslate,
} from '../row-utils.ts'
import { CardBoundary, GenericCard, ToolCardShell } from '../ToolCardShell.tsx'
import { imageCardMaterial, imageFitBox, type CardImageMaterial } from './image-card.ts'
import { readCardSummary } from './read-card-facts.ts'

/** Props the slot hands this row, plus its own locale seat. */
type RowProps = ToolCallViewProps & PropsLocale<typeof CARD_LOCALE_NS>

/**
 * The session-authorized image loader every tool view receives: a promise of a
 * viewable URL for one durable reference, plus the host's optional synchronous
 * cache peek.
 */
interface ImageLoader {
  (attachment: ImageAttachmentRef): Promise<string>
  peek?: ((attachment: ImageAttachmentRef) => string | undefined) | undefined
}

/**
 * Render a `read` call as a line-numbered window or an image.
 * @param props - the slot's owner props and this plugin's translate seat.
 * @returns the read card, or the generic shell when nothing else fits.
 */
export default function ReadRow(props: RowProps) {
  const { t, block } = props
  const title = cardTitle(props.toolName, t, 'title.read')
  return (
    <CardBoundary t={t} title={title} block={block}>
      <ReadCard {...props} title={title} />
    </CardBoundary>
  )
}

/**
 * The card itself, inside the boundary.
 * @param props - row props plus the resolved title.
 * @returns the read card.
 */
function ReadCard(props: RowProps & { title: string }) {
  const { t, block, cwd, inspect, openFile, title, toolName } = props
  const args = parseCardArgs(block)
  const meta = narrowReadCardMeta(cardMeta(block))
  // Derived once per frozen node. The hook runs before this component's early
  // returns, and the derivation is cheap enough for the text path to pay it.
  const material = useMemo(() => imageCardMaterial(block, cwd), [block, cwd])
  // A Code Dispatch child's window is drawn by its parent card's own body.
  if (isSubCall(block) || isErrorResult(block)) {
    return <GenericCard t={t} title={title} block={block} args={args} toolName={toolName} cwd={cwd} openFile={openFile} inspect={inspect} />
  }
  if (meta === null) {
    // An image read is exactly the read that produces no window, so the image
    // branch sits here; with no material to draw the shell stays generic.
    if (material === null) {
      return <GenericCard t={t} title={title} block={block} args={args} toolName={toolName} cwd={cwd} openFile={openFile} inspect={inspect} />
    }
    return (
      <ImageReadCard
        t={t}
        block={block}
        material={material}
        title={title}
        toolName={toolName}
        inspect={inspect}
        openFile={openFile}
        loadImage={props.loadImage}
      />
    )
  }
  return (
    <ToolCardShell
      t={t}
      state={cardState(block)}
      title={title}
      tool={toolName}
      // The head reports the call verbatim (selector included, so a windowed
      // read is distinguishable from a whole-file one); the link below keeps the
      // projected path, which is the part that must name a real file.
      summary={readCardSummary(args, meta.path, cwd)}
      filePath={meta.path}
      filePathLine={meta.offset}
      openFile={openFile}
      inspect={inspect}
    >
      <ReadBlock
        label={displayPath(meta.path, cwd)}
        lines={meta.lines}
        totalLines={meta.totalLines}
        lang={meta.lang}
        labels={readBlockLabels(t)}
        className="twc-body"
      />
    </ToolCardShell>
  )
}

/** Props of the image body. */
interface ImageReadCardProps {
  /** Card translate seat. */
  t: CardTranslate
  /** The frozen settled node, for its result text. */
  block: CardBlockView
  /** The derived image material (never empty). */
  material: CardImageMaterial
  /** Resolved card title. */
  title: string
  /** Wire tool name selecting the leading glyph. */
  toolName?: string | null | undefined
  /** Jump to this call in the trajectory view. */
  inspect?: (() => void) | undefined
  /** Opens the read path in the host's file viewer. */
  openFile?: ((path: string, options?: CardOpenFileOptions) => void) | undefined
  /** The host's image loader; absent leaves the images undrawn. */
  loadImage: ImageLoader | undefined
}

/** One image's resolved state: the URL to draw, or the load that failed. */
interface ImageState {
  url: string | null
  failed: boolean
}

/**
 * Ask the loader's synchronous cache for an already-known URL.
 * @param loader - the host's image loader.
 * @param attachment - the reference to resolve.
 * @returns the cached URL, or `null` when there is none.
 */
function peekUrl(loader: ImageLoader | undefined, attachment: ImageAttachmentRef): string | null {
  if (loader?.peek === undefined) return null
  try {
    const url = loader.peek(attachment)
    return typeof url === 'string' && url !== '' ? url : null
  } catch {
    // A broken cache peek is not a reason to lose the card.
    return null
  }
}

/** Whether two per-image states are the same, so state identity can be kept. */
function sameImageState(left: ImageState, right: ImageState): boolean {
  return left.url === right.url && left.failed === right.failed
}

/**
 * The image body: one framed thumbnail per reference over the result's own
 * envelope text.
 *
 * A rejected load or a missing loader leaves that image's frame as a retry
 * control and the text in place: an image card that cannot show its picture
 * must still show that the call returned one.
 * @param props - see {@link ImageReadCardProps}.
 * @returns the image card.
 */
function ImageReadCard({ t, block, material, title, toolName, inspect, openFile, loadImage }: ImageReadCardProps) {
  const images = material.images
  const text = resultText(block)
  return (
    <ToolCardShell
      t={t}
      state={cardState(block)}
      title={title}
      tool={toolName}
      summary={material.label}
      filePath={material.path}
      openFile={openFile}
      inspect={inspect}
    >
      <div className="twc-media">
        <div className="twc-imgGallery">
          {images.map((image, index) => (
            <CardImage
              key={`${image.attachmentId}:${index}`}
              t={t}
              image={image}
              single={images.length === 1}
              loadImage={loadImage}
            />
          ))}
        </div>
      </div>
      {text !== '' && <p className="twc-note">{text}</p>}
    </ToolCardShell>
  )
}

/** Props of one framed image. */
interface CardImageProps {
  /** Card translate seat. */
  t: CardTranslate
  /** The durable reference to load. */
  image: ImageAttachmentRef
  /** A lone image renders at its fit size; a gallery renders 64px tiles. */
  single: boolean
  /** The host's image loader; absent makes the frame a retry control. */
  loadImage: ImageLoader | undefined
}

/**
 * One image: a framed thumbnail that opens the original.
 *
 * The load runs under a liveness guard and is re-armed by {@link CardImage}'s
 * retry counter, so a failed load costs one click rather than a page reload.
 * @param props - see {@link CardImageProps}.
 * @returns the frame, or the retry control when the load failed.
 */
function CardImage({ t, image, single, loadImage }: CardImageProps) {
  // The cache peek seeds the FIRST frame only, so an image the host already
  // holds paints immediately. It is never a substitute for the load below: a
  // cached URL can be stale (a revoked blob, a rotated cache), and a
  // short-circuit would leave the picture broken with no way back.
  const [state, setState] = useState<ImageState>(
    () => ({ url: peekUrl(loadImage, image), failed: false }),
  )
  const [attempt, setAttempt] = useState(0)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => { setOpen(false) }, [])
  const retry = useCallback(() => { setAttempt(value => value + 1) }, [])
  // The thumbnail is the preview's opener, and it is the ONLY opener: focus is
  // handed back to this element explicitly rather than snapshotted from
  // `document.activeElement`. A pointer opening (or a mask press during the
  // preview) can leave that snapshot on `BODY`, and the close control unmounts
  // before the restore runs, so only Escape ever landed back on the frame.
  const frameRef = useRef<HTMLButtonElement | null>(null)
  const focusOpener = useCallback(() => { frameRef.current?.focus() }, [])
  useEffect(() => {
    let live = true
    // A retry re-arms this same effect (the shipped image's attempt counter):
    // a failed frame goes back to its reserved loading box first.
    setState(previous => (previous.failed ? { url: peekUrl(loadImage, image), failed: false } : previous))
    const load = async (): Promise<void> => {
      if (loadImage === undefined) {
        if (live) setState(previous => (previous.failed ? previous : { url: null, failed: true }))
        return
      }
      try {
        const url = await loadImage(image)
        const next: ImageState = typeof url === 'string' && url !== ''
          ? { url, failed: false }
          : { url: null, failed: true }
        // The load is authoritative: a rejected one drops the image rather than
        // pinning the possibly-stale peeked URL forever. An unchanged result
        // keeps the previous state object, so a re-rendered loader identity
        // cannot drive this effect into a render loop.
        if (live) setState(previous => (sameImageState(previous, next) ? previous : next))
      } catch {
        if (live) setState(previous => (previous.failed ? previous : { url: null, failed: true }))
      }
    }
    void load()
    return () => { live = false }
  }, [image, loadImage, attempt])

  const variant = single ? 'single' : 'tile'
  const name = image.name ?? t('image.unnamed')
  const fit = useMemo(() => imageFitBox(image), [image])
  // The retry control stands in for the frame, so it must occupy the SAME box:
  // a lone image is sized by the same `imageFitBox` result the frame uses, and
  // a gallery tile is 64×64 in CSS for both. Otherwise a failed load would jump
  // the card after the loading state had held the reserved size.
  if (state.failed) {
    return (
      <button
        type="button"
        className="twc-imgError"
        data-variant={variant}
        style={single ? { width: fit.width, height: fit.height } : undefined}
        // The box is the image's own reserved size, so a tiny image clamps the
        // label; the tooltip keeps the full sentence reachable there.
        title={t('image.loadFailed')}
        aria-label={t('image.loadFailed')}
        onClick={retry}
      >
        {t('image.loadFailed')}
      </button>
    )
  }
  return (
    <>
      <button
        ref={frameRef}
        type="button"
        className="twc-imgFrame"
        data-variant={variant}
        // The reserved box is the image's own fit size, so the frame does not
        // jump when the bytes arrive (a gallery tile is fixed at 64px in CSS).
        style={single ? { width: fit.width, height: fit.height } : undefined}
        title={t('image.open')}
        aria-label={t('image.openNamed', { name })}
        onClick={() => { if (state.url !== null) setOpen(true) }}
      >
        {state.url === null
          ? <span className="twc-imgLoading">{t('image.loading')}</span>
          : (
            <img
              className="twc-mediaImg"
              src={state.url}
              alt={name}
              style={single ? { objectPosition: fit.objectPosition } : undefined}
            />
          )}
      </button>
      {open && state.url !== null && (
        <CardLightbox
          t={t}
          src={state.url}
          image={image}
          name={name}
          onClose={close}
          focusOpener={focusOpener}
        />
      )}
    </>
  )
}

/** Props of the original-image lightbox. */
interface CardLightboxProps {
  /** Card translate seat. */
  t: CardTranslate
  /** The original image URL. */
  src: string
  /** The reference, for the caption's own numbers. */
  image: ImageAttachmentRef
  /** The image's display name. */
  name: string
  /** Dismiss callback owned by the opener. */
  onClose: () => void
  /** Returns focus to the thumbnail that opened this preview. */
  focusOpener: () => void
}

/**
 * The document-level original-image preview.
 *
 * Closes on Escape, a mask press, or the close control, and restores focus to
 * the opener on unmount. Rendered through a body portal: an opener inside a
 * transformed or filtered ancestor would otherwise trap the fixed backdrop in
 * that ancestor's box instead of covering the viewport.
 * @param props - see {@link CardLightboxProps}.
 * @returns the modal preview.
 */
function CardLightbox({ t, src, image, name, onClose, focusOpener }: CardLightboxProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      // Every close path — Escape, the mask, the control — ends here, and the
      // opener is a known element rather than a snapshot of whatever held focus
      // when the preview opened.
      focusOpener()
    }
  }, [onClose, focusOpener])
  const caption = t('image.caption', {
    name,
    width: image.width,
    height: image.height,
    size: fileSizeText(image.bytes),
  })
  return createPortal(
    <div className="twc-lightbox" role="dialog" aria-modal="true" aria-label={t('image.dialog')}>
      <div
        className="twc-lightboxMask"
        aria-hidden="true"
        // Closing on mousedown is what the official lightbox does; suppressing
        // the default focus move keeps the pointer press from overwriting the
        // focus the unmount hands back to the thumbnail.
        onMouseDown={(event) => { event.preventDefault(); onClose() }}
      />
      {/* Image and caption travel as one stack: pinned to the viewport the
          caption read as an unrelated element next to a centred image. */}
      <div className="twc-lightboxStack">
        <img className="twc-lightboxImg" src={src} alt={name} />
        <p className="twc-lightboxCaption">{caption}</p>
      </div>
      <button
        ref={closeRef}
        type="button"
        className="twc-lightboxClose"
        aria-label={t('image.close')}
        onClick={onClose}
      >
        <IconCloseOutlineRegular size={16} />
      </button>
    </div>,
    document.body,
  )
}
