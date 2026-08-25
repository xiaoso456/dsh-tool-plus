/**
 * DSH adapter for OMP `extensibility/custom-tools/types.ts`.
 *
 * The edit renderer only consumes `RenderResultOptions` (verbatim OMP shape);
 * the rest of the custom-tools type surface (factories, session contexts,
 * model registry) belongs to OMP's extensibility system and is not part of
 * the DSH edit port.
 */
/** Options passed to tool result renderers (verbatim OMP shape). */
export interface RenderResultOptions {
  /** Whether the result view is expanded */
  expanded: boolean
  /** Whether this is a partial/streaming result */
  isPartial: boolean
  /** Current spinner frame index for animated elements (0-9, only provided during partial results) */
  spinnerFrame?: number
}
