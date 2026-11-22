import type { LineRange } from "../../omp/tools/path-utils.ts";
import { parseLineRanges } from "../../omp/tools/path-utils.ts";
import { ToolError } from "../../omp/tools/tool-errors.ts";
/** Parsed representation of a path-embedded selector. */
export type ParsedSelector =
	| { kind: "none" }
	| { kind: "raw" }
	| { kind: "conflicts" }
	/** `:img`: rasterize an SVG/SVGZ instead of returning its markup. */
	| { kind: "image" }
	| { kind: "lines"; ranges: [LineRange, ...LineRange[]]; raw?: boolean }
	/** `:-N`: the last N lines. Resolved against a known line count before use. */
	| { kind: "tail"; count: number; ranges?: [LineRange, ...LineRange[]]; raw?: boolean };

/** Returns true when the selector requested verbatim/raw output (alone or combined with a range). */
export function isRawSelector(parsed: ParsedSelector): boolean {
	return (
		parsed.kind === "raw" ||
		((parsed.kind === "lines" || parsed.kind === "tail") && parsed.raw === true)
	);
}

/** Returns true when the selector requested multiple line ranges. */
export function isMultiRange(parsed: ParsedSelector): boolean {
	return parsed.kind === "lines" && parsed.ranges.length > 1;
}

function selectorChunkLooksReadLike(chunk: string): boolean {
	const lower = chunk.toLowerCase();
	return (
		lower === "raw" ||
		lower === "conflicts" ||
		lower === "img" ||
		/^-\d+(?:[-+]\d+)?$/.test(chunk) ||
		parseLineRanges(chunk) !== null
	);
}

function invalidSelector(sel: string): ToolError {
	return new ToolError(
		`Invalid selector ':${sel}'. Use :N, :N-M, :N+K, :N- (open-ended), a comma-separated list of ranges, :raw, or a range combined with raw (e.g. :raw:50-100).`,
	);
}

export function parseSel(sel: string | undefined): ParsedSelector {
	if (!sel || sel.length === 0) return { kind: "none" };

	// Compound selector: `1-50:raw` or `raw:1-50`. Split into chunks and accept
	// exactly one line range (possibly multi) plus the literal `raw`. Selector-like
	// compounds that are not in that accepted set are invalid rather than "none";
	// otherwise `read` can silently widen a malformed selector like
	// `artifact://5:conflicts:1-1` while `grep` rejects it.
	if (sel.includes(":")) {
		const chunks = sel.split(":");
		if (chunks.length === 2) {
			const [a, b] = chunks as [string, string];
			const aIsRaw = a.toLowerCase() === "raw";
			const bIsRaw = b.toLowerCase() === "raw";
			const rangeChunk = aIsRaw ? b : bIsRaw ? a : null;
			const rawChunk = aIsRaw ? a : bIsRaw ? b : null;
			if (rangeChunk !== null && rawChunk !== null) {
				const tailMatch = /^-(\d+)$/.exec(rangeChunk);
				if (tailMatch) {
					return { kind: "tail", count: Number.parseInt(tailMatch[1]!, 10), raw: true };
				}
				// Beside `:raw` a bare number is that one line (`:17:raw`), not "17 onward".
				const ranges = parseLineRanges(rangeChunk, "single");
				if (ranges) {
					return { kind: "lines", ranges, raw: true };
				}
			}
		}
		if (chunks.every(selectorChunkLooksReadLike)) throw invalidSelector(sel);
		// Unrecognized compound — fall through (sqlite/archive/url consume their own colon syntax).
		return { kind: "none" };
	}

	if (sel.toLowerCase() === "raw") return { kind: "raw" };
	if (sel.toLowerCase() === "conflicts") return { kind: "conflicts" };
	if (sel.toLowerCase() === "img") return { kind: "image" };
	// `:-N` is the tail selector (OMP 18.12.6). It cannot be resolved here: the
	// line count is only known once the source is in hand, so it stays symbolic.
	const tail = /^-(\d+)$/.exec(sel);
	if (tail) return { kind: "tail", count: Number.parseInt(tail[1]!, 10) };
	const ranges = parseLineRanges(sel);
	if (ranges) {
		return { kind: "lines", ranges };
	}
	// Unrecognized selectors fall through; sqlite/archive/url readers consume their own colon syntax.
	return { kind: "none" };
}

/**
 * Convert a single-range selector to the offset/limit pair used by internal pagination.
 * Returns the FIRST range only — multi-range callers MUST branch on `isMultiRange` before
 * calling this helper.
 */
export function selToOffsetLimit(parsed: ParsedSelector): { offset?: number; limit?: number } {
	if (parsed.kind === "lines") {
		const first = parsed.ranges[0];
		const limit = first.endLine !== undefined ? first.endLine - first.startLine + 1 : undefined;
		return { offset: first.startLine, limit };
	}
	if (parsed.kind === "tail") {
		// Falling through to `{}` here would render the whole source, which looks
		// like a successful tail read. Fail loudly instead (see resolveTailSelector).
		throw new ToolError(
			`Tail selector ':-${parsed.count}' needs a line count this source cannot provide; use an explicit range instead.`,
		);
	}
	return {};
}

/** Sort and coalesce overlapping or adjacent ranges (the shape `resolveTailSelector` needs). */
function mergeLineRanges(ranges: readonly LineRange[]): [LineRange, ...LineRange[]] {
	const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine);
	const merged: LineRange[] = [];
	for (const range of sorted) {
		const last = merged[merged.length - 1];
		if (!last) {
			merged.push({ ...range });
			continue;
		}
		// Open-ended means "to EOF", so everything after it is already covered.
		if (last.endLine === undefined) continue;
		if (range.startLine <= last.endLine + 1) {
			if (range.endLine === undefined || range.endLine > last.endLine) last.endLine = range.endLine;
		} else {
			merged.push({ ...range });
		}
	}
	return merged as [LineRange, ...LineRange[]];
}

/**
 * Pin `:-N` to concrete line numbers once the source's line count is known.
 * `count` larger than the file clamps to the whole file (lines are 1-indexed).
 * Any ranges carried alongside the tail are merged in, matching OMP 18.12.6.
 */
export function resolveTailSelector(parsed: ParsedSelector, totalLines: number): ParsedSelector {
	if (parsed.kind !== "tail") return parsed;
	const startLine = Math.max(1, totalLines - parsed.count + 1);
	const endLine = Math.max(startLine, totalLines);
	if (!parsed.ranges) {
		return { kind: "lines", ranges: [{ startLine, endLine }], raw: parsed.raw };
	}
	return {
		kind: "lines",
		ranges: mergeLineRanges([...parsed.ranges, { startLine, endLine }]),
		raw: parsed.raw,
	};
}
