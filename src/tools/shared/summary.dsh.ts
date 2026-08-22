/**
 * DSH code summary (plan.md 拍板#4 — code summary 整体移植, Node adaptation).
 *
 * Ported from OMP `shared/read-summary.ts` + `shared/read-format.ts` keeping
 * only the model-facing text surface: `summarizeCode` (pi-natives) folds
 * non-critical spans and this module renders the folded segments with
 * hashline-numbered lines plus an elision footer that teaches the re-read
 * selector. OMP's TUI renderer, session display-mode plumbing and the
 * per-session parse LRU are intentionally absent (DSH has no TUI; the parse
 * cost without a cache is ~12-18ms on a 1500-line file).
 */

import {
	computeFileHash,
	formatHashlineHeader,
	formatNumberedLine,
} from "../hashline/omp-hashline/src/format.ts";
import { summarizeCode, type SummaryResult } from "@oh-my-pi/pi-natives";

export interface ElidedRange {
	start: number;
	end: number;
}

const FOOTER_RANGE_SAMPLES = 2;

/** OMP `read.summarize.*` defaults (settings-schema.ts:3290ff). */
export const SUMMARY_DEFAULTS = {
	minBodyLines: 4,
	minCommentLines: 6,
	minTotalLines: 100,
	unfoldUntil: 50,
	unfoldLimit: 100,
} as const;

const MAX_SUMMARY_BYTES = 2 * 1024 * 1024;
const MAX_SUMMARY_LINES = 20_000;

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".mdown", ".mkd"]);

export function isMarkdownPath(filePath: string): boolean {
	const dot = filePath.lastIndexOf(".");
	if (dot === -1) return false;
	return MARKDOWN_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}

/** Prose files (Markdown flavors and plain text) skip code-block summarization. */
export function isProseSummaryPath(filePath: string): boolean {
	return isMarkdownPath(filePath) || filePath.toLowerCase().endsWith(".txt");
}

export function countTextLines(text: string): number {
	if (text.length === 0) return 0;
	let lines = 1;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) lines++;
	}
	return lines;
}

export interface SummarizeOptions {
	minBodyLines?: number;
	minCommentLines?: number;
	minTotalLines?: number;
	unfoldUntilLines?: number;
	unfoldLimitLines?: number;
}

/**
 * Summarize a code file. Returns null when the file is too large, below the
 * line threshold, prose, or the native parser produced nothing elidable —
 * callers fall back to the plain text read (OMP parity).
 */
export function trySummarizeCode(
	code: string,
	filePath: string,
	options: SummarizeOptions = {},
): SummaryResult | null {
	if (Buffer.byteLength(code, "utf-8") > MAX_SUMMARY_BYTES) return null;
	if (isProseSummaryPath(filePath)) return null;
	const minTotalLines = options.minTotalLines ?? SUMMARY_DEFAULTS.minTotalLines;
	const lineCount = countTextLines(code);
	if (lineCount > MAX_SUMMARY_LINES) return null;
	if (lineCount < minTotalLines) return null;

	try {
		const result = summarizeCode({
			code,
			path: filePath,
			minBodyLines: options.minBodyLines ?? SUMMARY_DEFAULTS.minBodyLines,
			minCommentLines: options.minCommentLines ?? SUMMARY_DEFAULTS.minCommentLines,
			unfoldUntilLines: options.unfoldUntilLines ?? SUMMARY_DEFAULTS.unfoldUntil,
			unfoldLimitLines: options.unfoldLimitLines ?? SUMMARY_DEFAULTS.unfoldLimit,
		});
		return result.parsed && result.elided ? result : null;
	} catch {
		return null;
	}
}

// ── Rendering (OMP renderSummary, hashline display mode fixed) ──────────────

const BRACE_PAIRS: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
const BRACE_TAIL_TRAILING_RE = /^[;,)\]}]*$/;

/**
 * Decide whether the kept lines surrounding an elided range collapse to a
 * single brace-pair line (`… {` head + `}`/`});` tail → one merged line).
 */
export function canMergeBracePair(headLine: string, tailLine: string): boolean {
	const head = headLine.trimEnd();
	const tail = tailLine.trim();
	const opener = head.slice(-1);
	const closer = BRACE_PAIRS[opener];
	if (!closer) return false;
	if (!tail.startsWith(closer)) return false;
	return BRACE_TAIL_TRAILING_RE.test(tail.slice(closer.length));
}

export function formatSummaryElisionFooter(
	readPath: string,
	elidedRanges: ReadonlyArray<ElidedRange>,
	elidedLines: number,
): string {
	if (elidedRanges.length === 0) return "";
	const sampleCount = Math.min(elidedRanges.length, FOOTER_RANGE_SAMPLES);
	const selector = elidedRanges
		.slice(0, sampleCount)
		.map(r => `${r.start}-${r.end}`)
		.join(",");
	const example = `${readPath}:${selector}`;
	const tail = elidedRanges.length > sampleCount ? `, e.g. ${example}` : ` with ${example}`;
	return `[…${elidedLines}ln elided; re-read needed ranges${tail}]`;
}

export interface RenderedSummary {
	text: string;
	elidedRanges: ElidedRange[];
	elidedLines: number;
}

/**
 * Render a SummaryResult as hashline-numbered text (OMP hashLines display
 * mode): kept lines render as `N:text`, elided spans as `…`, and a kept
 * head/tail brace sandwich merges into `start-end:head … tail`.
 */
export function renderSummary(summary: SummaryResult): RenderedSummary {
	type Unit =
		| { kind: "line"; line: number; text: string }
		| { kind: "elided"; startLine: number; endLine: number }
		| { kind: "merged"; startLine: number; endLine: number; headText: string; tailText: string };

	const raw: Unit[] = [];
	for (const segment of summary.segments) {
		if (segment.kind === "elided") {
			raw.push({ kind: "elided", startLine: segment.startLine, endLine: segment.endLine });
			continue;
		}
		const text = segment.text ?? "";
		if (text.length === 0) continue;
		const lines = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			raw.push({ kind: "line", line: segment.startLine + i, text: lines[i]! });
		}
	}

	const units: Unit[] = [];
	let i = 0;
	while (i < raw.length) {
		const cur = raw[i]!;
		if (cur.kind === "elided") {
			const prev = units.length > 0 ? units[units.length - 1]! : null;
			const next = i + 1 < raw.length ? raw[i + 1]! : null;
			if (prev?.kind === "line" && next?.kind === "line" && canMergeBracePair(prev.text, next.text)) {
				units.pop();
				units.push({
					kind: "merged",
					startLine: prev.line,
					endLine: next.line,
					headText: prev.text,
					tailText: next.text,
				});
				i += 2;
				continue;
			}
		}
		units.push(cur);
		i++;
	}

	const modelParts: string[] = [];
	const elidedRanges: ElidedRange[] = [];
	let elidedLines = 0;
	for (const unit of units) {
		if (unit.kind === "elided") {
			modelParts.push("…");
			elidedRanges.push({ start: unit.startLine, end: unit.endLine });
			elidedLines += unit.endLine - unit.startLine + 1;
			continue;
		}
		if (unit.kind === "merged") {
			const merged = `${unit.headText.trimEnd()} … ${unit.tailText.trim()}`;
			modelParts.push(`${unit.startLine}-${unit.endLine}:${merged}`);
			elidedRanges.push({ start: unit.startLine, end: unit.endLine });
			elidedLines += Math.max(0, unit.endLine - unit.startLine - 1);
			continue;
		}
		modelParts.push(formatNumberedLine(unit.line, unit.text));
	}

	return {
		text: modelParts.join("\n"),
		elidedRanges,
		elidedLines,
	};
}

/** `[PATH#TAG]` header line for a read result (OMP formatReadHashlineHeader). */
export function formatReadHeader(displayPath: string, fullText: string): string {
	return formatHashlineHeader(displayPath, computeFileHash(fullText));
}
