/**
 * `edit` tool card: project the engine's already-computed diff into the
 * `{kind:'edit'}` meta this plugin's browser half consumes (plan §4.2).
 *
 * The engine puts the diff in `details.diff` (single file) and in
 * `details.perFileResults[].diff` (multi file), so the card costs no extra I/O
 * and no extra diff computation. Its rows are `<sign><line>|<content>`
 * (`omp/edit/diff.ts:54` `formatNumberedDiffLine`):
 *  - replace / hashline emit numbered rows only (`generateDiffString`);
 *  - patch / apply_patch emit a `@@ -x,y +a,b @@` header plus the same rows
 *    (`generateUnifiedDiffString`).
 *
 * The repo's `parseDiffHunks` parses the *authored* patch format and only
 * strips a `12 content` line-number prefix (space-separated), not the engine's
 * `12|content` (pipe-separated) — reusing it would leave the gutter inside the
 * card's content. `parseNumberedDiffHunks` below is the display-side minimum:
 * it drops the gutter, splits hunks on `@@` headers, blank gap rows and line
 * number breaks, and returns the line content byte-for-byte.
 *
 * Zero-dependency by design: the Node half imports it from `presentationMeta`,
 * the browser half never does.
 *
 * Defensive: a card never throws and never emits `undefined` values (the host
 * rejects non-lossless metadata and turns a successful call into an error), so
 * an empty or unparseable diff projects to `null`.
 *
 * @module @xiaoso/dsh-tool-plus/web/host/edit
 */
import { EDIT_META_MAX_BYTES, capTail } from '../contract.ts'
import type { CardDiffHunk, EditCardMeta } from '../contract.ts'

/** One engine diff row: `<sign><line>|<content>` (`-2|beta`, ` 3|gamma`). */
const NUMBERED_ROW = /^([+\- ])(\d+)\|([\s\S]*)$/
/** One authored unified row without a gutter: `-beta`, `+BETA`, ` gamma`. */
const PLAIN_ROW = /^([+\- ])([\s\S]*)$/
/** Diff metadata that is never line content (file headers, envelope markers). */
const METADATA_PREFIXES = ['*** ', 'diff --git ', 'index ', '--- ', '+++ ']

/** One hunk of a numbered diff, gutter stripped. */
export interface ParsedDiffHunk {
  /** Removed rows plus context rows, in diff order. */
  oldLines: string[]
  /** Added rows plus context rows, in diff order. */
  newLines: string[]
  /** Whether the hunk carries at least one removed or added row. */
  changed: boolean
}

/** Whether `line` continues the current hunk (a line-number break starts a new one). */
function breaksContinuity(
  prefix: '+' | '-' | ' ',
  oldNumber: number | null,
  newNumber: number | null,
  nextOld: number | null,
  nextNew: number | null,
): boolean {
  if (prefix === '-') return oldNumber !== null && nextOld !== null && oldNumber !== nextOld
  if (prefix === '+') return newNumber !== null && nextNew !== null && newNumber !== nextNew
  return (
    (oldNumber !== null && nextOld !== null && oldNumber !== nextOld) ||
    (newNumber !== null && nextNew !== null && newNumber !== nextNew)
  )
}

/**
 * Parse an engine diff body into display hunks.
 *
 * Boundaries: a `@@ … @@` header, a blank gap row (the engine's own
 * non-contiguity marker), or a line-number break after a change (how joined
 * per-entry diffs and skipped context regions read). Hunks without a change are
 * dropped — they would render as an empty diff.
 * @param diff - `details.diff` / `details.perFileResults[].diff`.
 * @returns the hunks, in diff order; empty when nothing parses.
 */
export function parseNumberedDiffHunks(diff: string): ParsedDiffHunk[] {
  const hunks: ParsedDiffHunk[] = []
  let current: ParsedDiffHunk | null = null
  let nextOld: number | null = null
  let nextNew: number | null = null

  const flush = (): void => {
    if (current !== null && current.changed) hunks.push(current)
    current = null
  }

  for (const rawLine of diff.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    // Blank rows are the engine's gap markers (and the tail of every diff).
    if (line === '' || line.startsWith('@@')) {
      flush()
      continue
    }
    if (METADATA_PREFIXES.some(prefix => line.startsWith(prefix))) continue

    const numbered = NUMBERED_ROW.exec(line)
    const plain = numbered === null ? PLAIN_ROW.exec(line) : null
    if (numbered === null && plain === null) continue
    const prefix = (numbered?.[1] ?? plain?.[1]) as '+' | '-' | ' '
    const content = numbered?.[3] ?? plain?.[2] ?? ''
    const digits = numbered?.[2]
    const oldNumber = digits === undefined || prefix === '+' ? null : Number.parseInt(digits, 10)
    const newNumber = digits === undefined || prefix === '-' ? null : Number.parseInt(digits, 10)

    if (current !== null && current.changed && breaksContinuity(prefix, oldNumber, newNumber, nextOld, nextNew)) {
      flush()
    }
    if (current === null) {
      current = { oldLines: [], newLines: [], changed: false }
      nextOld = null
      nextNew = null
    }
    if (prefix === '-') {
      current.oldLines.push(content)
      current.changed = true
      nextOld = oldNumber === null ? null : oldNumber + 1
    } else if (prefix === '+') {
      current.newLines.push(content)
      current.changed = true
      nextNew = newNumber === null ? null : newNumber + 1
    } else {
      current.oldLines.push(content)
      current.newLines.push(content)
      nextOld = oldNumber === null ? null : oldNumber + 1
      nextNew = newNumber === null ? null : newNumber + 1
    }
  }
  flush()
  return hunks
}

/** `value` as a plain record, or `null` (arrays, `null` and primitives drop). */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Append one file's hunks to `out`.
 *
 * A pure addition (no removed and no context rows) carries `oldText: null`, the
 * shape the shipped diff card reads as "new file". A move/rename has no
 * pre-move side to show in a two-column diff, so its target is recorded the
 * same way (the source side is deliberately not recorded).
 */
function pushFileHunks(
  out: CardDiffHunk[],
  pathValue: unknown,
  diffValue: unknown,
  isMove: boolean,
): void {
  if (typeof pathValue !== 'string' || pathValue.trim() === '') return
  if (typeof diffValue !== 'string' || diffValue.trim() === '') return
  for (const hunk of parseNumberedDiffHunks(diffValue)) {
    out.push({
      path: pathValue,
      oldText: isMove || hunk.oldLines.length === 0 ? null : hunk.oldLines.join('\n'),
      newText: hunk.newLines.join('\n'),
    })
  }
}

/**
 * Project the edit engine's result details into card metadata.
 *
 * Multi-file results (`perFileResults`) are read file by file; single-file
 * results use `path` + `diff`. The payload is capped at
 * {@link EDIT_META_MAX_BYTES} by dropping whole trailing files; when nothing is
 * left the call projects to `null` and falls back to the generic shell rather
 * than writing an oversized session entry.
 * @param details - the engine's `EditToolDetails` (or the adapter's value).
 * @returns the edit card metadata, or `null` when there is no usable diff.
 */
export function projectEditCardMeta(details: unknown): EditCardMeta | null {
  const record = asRecord(details)
  if (record === null) return null
  const hunks: CardDiffHunk[] = []
  const perFile = Array.isArray(record.perFileResults) ? record.perFileResults : null
  if (perFile !== null) {
    for (const entry of perFile) {
      const file = asRecord(entry)
      if (file === null) continue
      pushFileHunks(hunks, file.path, file.diff, file.move !== undefined)
    }
  } else {
    pushFileHunks(hunks, record.path, record.diff, record.move !== undefined)
  }
  if (hunks.length === 0) return null
  const retained = capTail(hunks, EDIT_META_MAX_BYTES, kept => ({ kind: 'edit', diffs: kept }))
  return retained.length === 0 ? null : { kind: 'edit', diffs: retained }
}
