/**
 * Minimal text-shape normalization: line-ending detection / round-trip and
 * BOM stripping. The edit engines use these to canonicalize text to LF before
 * applying edits and to restore the original shape on write-back.
 *
 * Migration note: this is a **verbatim port** of the vendored
 * `src/tools/hashline/engine/normalize.ts` (itself a verbatim port of the
 * pre-18.0 TS engine). The Rust engine has no equivalent exports — it
 * normalizes internally and never hands these primitives back to the host —
 * but DSH's own edit paths (`omp/edit/normalize.ts`, which re-exports this
 * module through the `@oh-my-pi/hashline` alias, plus `read`/`write`/`grep`
 * snapshot recording) still need them. Kept here so the single hashline seam
 * keeps its old export surface after the engine directory was deleted.
 */

export type LineEnding = "\r\n" | "\n";

/** Detect the first line ending style in `content`. Defaults to LF when neither is present. */
export function detectLineEnding(content: string): LineEnding {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

/** Normalize every line ending to LF. */
export function normalizeToLF(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

/** Re-encode LF text with the requested line ending. */
export function restoreLineEndings(text: string, ending: LineEnding): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export interface BomResult {
	/** Either the empty string or the BOM sequence (currently UTF-8 BOM). */
	bom: string;
	/** Text with any leading BOM removed. */
	text: string;
}

/** Strip a UTF-8 BOM if present and return both the BOM and the trailing text. */
export function stripBom(content: string): BomResult {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}
