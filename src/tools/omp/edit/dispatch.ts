/**
 * Edit dispatch layer — path resolution + multi-entry/multi-file aggregation.
 *
 * Ported verbatim from upstream `packages/coding-agent/src/edit/index.ts`
 * (refs/oh-my-pi, 17.3.5): `resolveEditPath` (:77-93), `executeApplyPatchPerFile`
 * (:139-256) and `executeSinglePathEntries` (:258-365). Algorithm and user-facing
 * copy are byte-for-byte upstream; only the import surface was redirected to the
 * DSH-resident modules and the LSP-only surface was cut, per the established
 * omp/ adaptation conventions:
 *   - `renderer` → `./details` (TUI renderer cut, plan.md 拍板#17): the
 *     `EditToolDetails` / `EditToolPerFileResult` shapes live in `./details.ts`;
 *     the upstream per-file `diagnostics` field went with the LSP layer.
 *   - `resolvePlanPath` → DSH adapter shim (`edit/adapter/tools/plan-mode-guard`,
 *     verbatim resolution minus local:// schemes) — same redirection the local
 *     engines (modes/replace.ts, modes/patch.ts) already use.
 *   - `LspBatchRequest` / `flushLspWritethroughBatch` → local type + no-op below.
 *     DSH never constructs an outer batch request, so every `batchRequest` inside
 *     the aggregators resolves to `undefined` and the flush branches stay
 *     unreachable; the flow is kept verbatim so this file stays diffable
 *     against refs.
 */

import { MismatchError as HashlineMismatchError } from "@oh-my-pi/hashline";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isEnoent, isEnotdir } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../tools/index.ts";
import { findUniqueWorkspaceSuffix, isInternalUrlPath } from "../tools/path-utils.ts";
import { resolvePlanPath } from "../../edit/adapter/tools/plan-mode-guard.ts";
import type { EditToolDetails, EditToolPerFileResult } from "./details";
import { pruneOversizedEditSnapshots } from "./snapshot-details";

/**
 * LSP write-batch handle (upstream `tools/render-utils.ts`, surfaced through the
 * edit renderer). Shape verbatim; DSH cuts the LSP layer (plan.md 拍板#5), so no
 * caller ever constructs one — see {@link flushLspWritethroughBatch}.
 */
export interface LspBatchRequest {
	id: string;
	flush: boolean;
}

/**
 * Upstream flushes the LSP writethrough batch when aggregation stops early
 * (refs `lsp/writethrough.ts`). DSH has no LSP batch to flush — the engines
 * write through directly — so this is a documented no-op that keeps the
 * verbatim call sites compilable.
 */
async function flushLspWritethroughBatch(
	_id: string,
	_cwd: string,
	_signal?: AbortSignal,
): Promise<void> {}

export async function resolveEditPath(
	session: ToolSession,
	authoredPath: string,
	options: { mustExist: boolean; signal?: AbortSignal },
): Promise<string> {
	if (!options.mustExist || isInternalUrlPath(authoredPath)) return authoredPath;

	try {
		await Bun.file(resolvePlanPath(session, authoredPath)).stat();
		return authoredPath;
	} catch (error) {
		if (!isEnoent(error) && !isEnotdir(error)) throw error;
	}

	const match = await findUniqueWorkspaceSuffix(authoredPath, session.cwd, options.signal);
	return match?.displayPath ?? authoredPath;
}

/** Run apply_patch file operations and aggregate their multi-file result. */
export async function executeApplyPatchPerFile(
	fileEntries: {
		path: string;
		run: (batchRequest: LspBatchRequest | undefined) => Promise<AgentToolResult<EditToolDetails>>;
	}[],
	outerBatchRequest: LspBatchRequest | undefined,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate?: (partialResult: AgentToolResult<EditToolDetails>) => void,
): Promise<AgentToolResult<EditToolDetails>> {
	if (fileEntries.length === 1) {
		// Single file — just run directly, no wrapping
		return fileEntries[0].run(outerBatchRequest);
	}

	const perFileResults: EditToolPerFileResult[] = [];
	const contentTexts: string[] = [];
	let hasError = false;

	for (let i = 0; i < fileEntries.length; i++) {
		const { path, run } = fileEntries[i];
		const isLast = i === fileEntries.length - 1;
		// Per-file writes join the outer LSP write batch; only the last entry
		// flushes it, so cross-file writes coalesce into a single
		// format+diagnostics pass. The failure path below flushes explicitly
		// when the loop stops early.
		const batchRequest: LspBatchRequest | undefined = outerBatchRequest
			? { id: outerBatchRequest.id, flush: isLast && outerBatchRequest.flush }
			: undefined;

		try {
			const result = await run(batchRequest);
			const details = result.details;
			perFileResults.push({
				path: details?.path ?? path,
				diff: details?.diff ?? "",
				firstChangedLine: details?.firstChangedLine,
				// Upstream also carries `diagnostics: details?.diagnostics` here;
				// that field went with the LSP layer DSH cuts (details.ts type).
				op: details?.op,
				move: details?.move,
				sourcePath: details?.sourcePath,
				meta: details?.meta,
				oldText: details?.oldText,
				newText: details?.newText,
				snapshotsPruned: details?.snapshotsPruned,
			});
			const text = result.content?.find(c => c.type === "text")?.text ?? "";
			if (text) contentTexts.push(text);
		} catch (err) {
			const errorText = err instanceof Error ? err.message : String(err);
			const displayErrorText = err instanceof HashlineMismatchError ? err.displayMessage : undefined;
			perFileResults.push({ path, diff: "", isError: true, errorText, displayErrorText });
			contentTexts.push(`Error editing ${path}: ${errorText}`);
			hasError = true;
			// Later entries were authored assuming this file's post-state; a
			// partial cascade after failure typically compounds damage. Stop
			// here, report applied vs. skipped, and let the caller re-issue
			// only the failed and unapplied files. Matches
			// `executeSinglePathEntries` semantics.
			if (i > 0) {
				const appliedPaths = fileEntries
					.slice(0, i)
					.map(e => e.path)
					.join(", ");
				contentTexts.push(`Files already applied: ${appliedPaths}.`);
			}
			if (i + 1 < fileEntries.length) {
				const skippedPaths = fileEntries
					.slice(i + 1)
					.map(e => e.path)
					.join(", ");
				contentTexts.push(
					`Files NOT applied: ${skippedPaths}; re-read the affected files and re-issue only the failed and unapplied files.`,
				);
			}
			// Stopping early skips the last-entry flush above; finalize the
			// already-written files so an intervening failure cannot leave them
			// sitting in an unfinalized LSP write batch (mirrors the delete-path
			// flush in executePatchSingle).
			if (outerBatchRequest?.flush) {
				await flushLspWritethroughBatch(outerBatchRequest.id, cwd, signal);
			}
			break;
		}

		// Emit partial result after each file so UI shows progressive completion
		if (!isLast && onUpdate) {
			onUpdate({
				content: [{ type: "text", text: contentTexts.join("\n") }],
				details: {
					diff: perFileResults
						.map(r => r.diff)
						.filter(Boolean)
						.join("\n"),
					firstChangedLine: perFileResults.find(r => r.firstChangedLine)?.firstChangedLine,
					perFileResults: [...perFileResults],
				},
			});
		}
	}

	return {
		content: [{ type: "text", text: contentTexts.join("\n") }],
		details: pruneOversizedEditSnapshots({
			diff: perFileResults
				.map(r => r.diff)
				.filter(Boolean)
				.join("\n"),
			firstChangedLine: perFileResults.find(r => r.firstChangedLine)?.firstChangedLine,
			perFileResults,
		}),
		// Any per-file failure marks the aggregate result as an error so the
		// agent loop and renderer take the error branch instead of treating
		// a mixed partial application as a successful edit.
		...(hasError ? { isError: true } : {}),
	};
}

export async function executeSinglePathEntries(
	path: string,
	runs: ((batchRequest: LspBatchRequest | undefined) => Promise<AgentToolResult<EditToolDetails>>)[],
	outerBatchRequest: LspBatchRequest | undefined,
	onUpdate: ((partialResult: AgentToolResult<EditToolDetails>) => void) | undefined,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<EditToolDetails>> {
	if (runs.length === 1) {
		return runs[0](outerBatchRequest);
	}

	const contentTexts: string[] = [];
	const diffTexts: string[] = [];
	let firstChangedLine: number | undefined;
	let hasError = false;
	let metadataPath: string | undefined;
	let hasFirstOldText = false;
	let firstOldText: string | undefined;
	let hasLastNewText = false;
	let lastNewText: string | undefined;
	// Any pruned child invalidates the aggregate snapshot: combining a kept
	// first-entry oldText with a pruned next entry's newText (or vice-versa)
	// would describe a transition the file never made. Suppress aggregate
	// snapshots and stamp the marker so ACP/downstream can degrade cleanly.
	let snapshotsPruned = false;

	for (let i = 0; i < runs.length; i++) {
		const isLast = i === runs.length - 1;
		const batchRequest: LspBatchRequest | undefined = outerBatchRequest
			? { id: outerBatchRequest.id, flush: isLast && outerBatchRequest.flush }
			: undefined;

		try {
			const result = await runs[i](batchRequest);
			const details = result.details;
			if (details?.diff) diffTexts.push(details.diff);
			firstChangedLine ??= details?.firstChangedLine;
			if (details?.path) {
				metadataPath ??= details.path;
			}
			if (details && "oldText" in details && !hasFirstOldText) {
				firstOldText = details.oldText;
				hasFirstOldText = true;
			}
			if (details && "newText" in details) {
				lastNewText = details.newText;
				hasLastNewText = true;
			}
			if (details?.snapshotsPruned) snapshotsPruned = true;
			const text = result.content?.find(c => c.type === "text")?.text ?? "";
			if (text) contentTexts.push(text);
		} catch (err) {
			const errorText = err instanceof Error ? err.message : String(err);
			contentTexts.push(`Error editing ${path} (entry ${i + 1} of ${runs.length}): ${errorText}`);
			if (i > 0) {
				contentTexts.push(i === 1 ? `Entry 1 was already applied.` : `Entries 1-${i} were already applied.`);
			}
			if (i + 1 < runs.length) {
				contentTexts.push(
					(i + 2 === runs.length
						? `Entry ${runs.length} was NOT applied`
						: `Entries ${i + 2}-${runs.length} were NOT applied`) +
						`; re-read the file and re-issue only the failed and unapplied entries.`,
				);
			}
			hasError = true;
			// Stop at the first failure: later entries were authored against
			// line numbers/content that assumed this entry succeeded, and
			// applying them after a failure compounds the damage.
			if (outerBatchRequest?.flush) {
				await flushLspWritethroughBatch(outerBatchRequest.id, cwd, signal);
			}
			break;
		}

		if (!isLast && onUpdate) {
			onUpdate({
				content: [{ type: "text", text: contentTexts.join("\n") }],
				details: {
					diff: diffTexts.join("\n"),
					firstChangedLine,
				},
				...(hasError ? { isError: true } : {}),
			});
		}
	}

	return {
		content: [{ type: "text", text: contentTexts.join("\n") }],
		details: pruneOversizedEditSnapshots({
			diff: diffTexts.join("\n"),
			firstChangedLine,
			path: metadataPath ?? path,
			...(snapshotsPruned
				? { snapshotsPruned: true as const }
				: {
						...(hasFirstOldText ? { oldText: firstOldText } : {}),
						...(hasLastNewText ? { newText: lastNewText } : {}),
					}),
		}),
		// Any per-entry failure marks the aggregate result as an error so the
		// renderer takes the error branch instead of falling through to the
		// streaming-edit preview (which displays the *proposed* diff and looks
		// indistinguishable from success).
		...(hasError ? { isError: true } : {}),
	};
}