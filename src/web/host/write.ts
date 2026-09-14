/**
 * `write` tool card: project the engine's result into the `{kind:'write'}` meta
 * this plugin's browser half consumes (plan §4.1).
 *
 * The card is a **content preview** (matching the OMP card the model already
 * sees), so metadata carries only the target path plus an optional grammar
 * hint — never a diff, never a `before` read, never `±` counts. Both fields are
 * pure computation over data the adapter already holds: `lang` comes from the
 * shared `getLanguageFromPath` table, and no I/O happens here.
 *
 * Zero-dependency by design, like the contract it fills in: the Node half
 * imports it from `presentationMeta`, the browser half never does.
 *
 * Defensive: a card never throws and never emits `undefined` values (the host
 * rejects non-lossless metadata and turns a successful call into an error), so
 * an unusable path projects to `null` and the row falls back to the generic
 * shell.
 *
 * @module @xiaoso/dsh-tool-plus/web/host/write
 */
import { getLanguageFromPath } from '../../tools/omp/utils/lang-from-path.ts'
import type { WriteCardMeta } from '../contract.ts'

/** `value` as a plain record, or `null` (arrays, `null` and primitives drop). */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** First non-blank string among `values`, or `null`. */
function firstNonBlank(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return null
}

/**
 * Project the write tool's result (and its call arguments) into card metadata.
 *
 * The path is the engine's resolved target when it has one, falling back to the
 * authored `args.path` (matching the value the adapter already emits). A blank
 * or missing path projects to `null`; an unrecognized extension omits `lang`
 * instead of writing `undefined`.
 * @param details - the engine's `resolvedPath` / the adapter's value (`path`).
 * @param args - the tool call arguments (`path`), used only as a fallback.
 * @returns the write card metadata, or `null` when no usable path is present.
 */
export function projectWriteCardMeta(details: unknown, args?: unknown): WriteCardMeta | null {
  const result = asRecord(details)
  const parameters = asRecord(args)
  const path = firstNonBlank(result?.resolvedPath, result?.path, parameters?.path)
  if (path === null) return null
  const language = getLanguageFromPath(path)
  return {
    kind: 'write',
    path,
    ...language !== undefined && language !== '' ? { lang: language } : {},
    ...result?.madeExecutable === true ? { madeExecutable: true } : {},
  }
}
