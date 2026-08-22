/**
 * DSH markit orchestration — the equivalent of OMP's `utils/markit.ts`
 * (plan.md 拍板#6: 文档转换整体复制). Differences from OMP:
 * - no on-disk conversion cache (session-scoped cache dir is an OMP internal);
 *   conversion is lazy and runs per call.
 * - `untilAborted` collapses to a simple aborted check + native signal pass.
 */

import * as path from "node:path";
import { Markit } from "./registry";
import type { ConversionResult, StreamInfo } from "./types";
import { ToolError } from "../tool-errors";

/**
 * File extensions markit can convert to markdown — one per registered
 * converter in `./registry.ts` (pdf, docx, pptx, xlsx, epub). Legacy binary
 * formats (.doc/.ppt/.xls/.rtf) are intentionally absent, matching OMP.
 */
export const CONVERTIBLE_EXTENSIONS: ReadonlySet<string> = new Set([".pdf", ".docx", ".pptx", ".xlsx", ".epub"]);

export interface MarkitConversionResult {
	content: string;
	ok: boolean;
	error?: string;
}

let markitInstance: () => Markit | Promise<Markit> = async () => {
	// Lazy: keep the document engine off the startup import graph — it loads
	// only when a document is first converted.
	const promise = Promise.resolve(new Markit());
	markitInstance = () => promise;
	return promise;
};

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new ToolError(signal.reason instanceof Error ? signal.reason.message : "Aborted");
}

function normalizeError(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) return error.message.trim();
	return "Conversion failed";
}

function finalizeConversion(markdown?: string): MarkitConversionResult {
	if (typeof markdown === "string" && markdown.length > 0) {
		return { content: markdown, ok: true };
	}
	return { content: "", ok: false, error: "Conversion produced no output" };
}

/** Convert a document file to markdown (OMP convertFileWithMarkit, uncached). */
export async function convertFileWithMarkit(
	filePath: string,
	signal?: AbortSignal,
	options?: { imageDir?: string },
): Promise<MarkitConversionResult> {
	throwIfAborted(signal);
	try {
		const instance = await markitInstance();
		const result: ConversionResult = await instance.convertFile(filePath, { imageDir: options?.imageDir });
		return finalizeConversion(result.markdown);
	} catch (error) {
		if ((error as Error)?.name === "AbortError") throw new ToolError("Aborted");
		return { content: "", ok: false, error: normalizeError(error) };
	}
}

/** Stream info helper shared by callers that already hold the bytes. */
export function streamInfoForPath(filePath: string): StreamInfo {
	return {
		localPath: filePath,
		extension: path.extname(filePath).toLowerCase(),
		filename: path.basename(filePath),
	};
}
