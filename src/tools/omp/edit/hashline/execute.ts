/**
 * Coding-agent runner that drives the native hashline engine on behalf of the
 * `edit` tool. Converts an `{input}` tool-call payload into a fully-applied
 * patch, wraps the result in the agent's {@link AgentToolResult} shape, and
 * attaches `outputMeta` for the renderer.
 *
 * Before the native migration this file drove the vendored TS engine
 * (`Patch`/`Patcher`/`HashlineFilesystem`/`BlockResolver`/clipboard) and
 * hand-assembled the model-facing text from per-section fields. Upstream 18.x
 * moved all of that into Rust (`crates/pi-edit`), so the host side is now:
 *
 * 1. build the `EditPolicy` (`native/policy.ts`) and the writer
 *    (`native/writer.ts`),
 * 2. hand `EditSession.apply` the payload,
 * 3. shape the returned {@link EditApplyOutcome} into DSH's
 *    `EditToolDetails`.
 *
 * What the native engine now owns (and this file therefore no longer
 * implements — each was verified byte-for-byte against the old DSH output):
 * the parsed/aggregated model-facing text including the compact numbered
 * preview and `PUT N*:` block-resolution lines, mismatch / unseen-anchor /
 * missing-file diagnostics, the byte-identical no-op hint **and** its
 * 3-strike escalation (the old `noop-loop-guard.ts`), tag validation with
 * in-session recovery, `N*` block resolution, the `CUT`/`PUT` clipboard
 * registers, and the multi-section merge for sections naming one file.
 */
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { outputMeta } from "../../../edit/adapter/tools/output-meta";
import {
	EditSession,
	getEditStore,
	MismatchError,
	type EditApplyOutcome,
	type EditFileOutcome,
} from "../../../hashline/native/index.ts";
import { buildHashlineEditPolicy } from "../../../hashline/native/policy.ts";
import { createHashlineWriter } from "../../../hashline/native/writer.ts";
import type { ToolSession } from "../../../omp/tools/index.ts";
import type { WritethroughCallback } from "../../../omp/tools/writethrough.ts";
import type { EditToolDetails, EditToolPerFileResult, Operation } from "../details";
import { pruneOversizedEditSnapshots } from "../snapshot-details";
import { type HashlineParams, hashlineEditParamsSchema } from "./params";

export interface ExecuteHashlineSingleOptions {
	session: ToolSession;
	input: string;
	signal?: AbortSignal;
	writethrough: WritethroughCallback;
}

/**
 * Native reports `create` | `update` | `delete` (`EditFileOutcome.op`,
 * `@oh-my-pi/pi-natives` index.d.ts:1270); DSH's `Operation` is the same
 * union, and a move arrives as `update` with `moveTo` set — matching the op
 * the old TS engine reported for a section with `MV`. An unknown value is a
 * native contract change, not something to coerce silently.
 *
 * A no-op is deliberately **not** remapped: the old engine had a fourth
 * `"noop"` section op, native reports `update` with zero bytes written and the
 * soft hint in `text`. `"noop"` lived only in the deleted
 * `engine/patcher.ts:99-100` and has no consumer, so the native shape is the
 * oracle (Lead ruling; keeps T4's fixture spec and the auditor's differential
 * valid).
 */
function toOperation(op: string): Operation {
	if (op === "create" || op === "update" || op === "delete") return op;
	throw new Error(`Unexpected native edit op: ${op}`);
}

/**
 * DSH per-file detail for one landed file.
 *
 * `path` is the absolute path (`EditToolDetails.path` contract: "Required by
 * ACP diff metadata consumers"), and for a move it is the destination while
 * `sourcePath` carries the authored source path so the renderer can show
 * `source → dest`. The raw `oldText`/`newText` snapshots go through the DSH
 * pruner — native has its own `snapshotsPruned` flag, but the DSH budget
 * (#3786/#3787, 32 KiB) is the one that bounds the session JSONL, and pruning
 * an already-pruned entry is a no-op.
 */
function toPerFileResult(file: EditFileOutcome): EditToolPerFileResult {
	return pruneOversizedEditSnapshots({
		path: file.moveTo ?? file.path,
		diff: file.diff,
		firstChangedLine: file.firstChangedLine,
		op: toOperation(file.op),
		move: file.moveTo,
		sourcePath: file.moveTo ? file.displayPath : undefined,
		oldText: file.oldText,
		newText: file.newText,
	});
}

/**
 * Wrap a successful apply.
 *
 * The text is native's own `outcome.text`: for one file it is the section
 * header plus the compact numbered preview (and `PUT N*: → resolved …` lines
 * for block edits), for several files it is those per-file texts joined by a
 * blank line — byte-identical to what the old `renderSection` /
 * `executeHashlineSingle` assembly produced. The single-file branch also
 * carries the aggregate metadata fields (`op` / `move` / `path` / snapshots)
 * that the multi-file branch deliberately leaves to `perFileResults`.
 *
 * `text` (and with it `files[].warnings`, which native already rendered into
 * `text` as a parse+apply union in unspecified order) passes through
 * verbatim: no reordering, filtering, deduping or elision — the soft no-op
 * hint in particular is what DSH's tool-result copy depends on.
 */
function renderOutcome(
	outcome: EditApplyOutcome,
): AgentToolResult<EditToolDetails, typeof hashlineEditParamsSchema> {
	const files = outcome.files;
	const content: AgentToolResult<EditToolDetails, typeof hashlineEditParamsSchema>["content"] = [
		{ type: "text", text: outcome.text },
	];

	if (files.length === 1) {
		const file = files[0];
		return {
			content,
			details: pruneOversizedEditSnapshots({
				diff: file.diff,
				firstChangedLine: file.firstChangedLine,
				op: toOperation(file.op),
				move: file.moveTo,
				path: file.moveTo ?? file.path,
				sourcePath: file.moveTo ? file.displayPath : undefined,
				oldText: file.oldText,
				newText: file.newText,
				meta: outputMeta().get(),
			}),
		};
	}

	return {
		content,
		details: pruneOversizedEditSnapshots({
			diff: files
				.map(file => file.diff)
				.filter(Boolean)
				.join("\n"),
			perFileResults: files.map(toPerFileResult),
		}),
	};
}

/**
 * Re-attach the "which sections already landed" breadcrumb to a rejection.
 *
 * The engine applies one file at a time and aborts on the first writer throw
 * (`EditSession.apply` hands each landed change to the host callback), and on
 * failure it reports only the callback's own message with an empty `files`
 * list. A multi-section payload that fails on section #2 therefore leaves
 * section #1 on disk with nothing in the response saying so — the model would
 * re-issue the whole patch and double-apply it. The old TS engine wrapped the
 * same failure with `Sections already written: …` (`engine/patcher.ts:287-296`
 * at v17.3.5) from its prepared batch; the writer's
 * {@link HashlineWriter.landedPaths} supplies the identical list, in write
 * order and in authored display form.
 *
 * Appended only when something really landed: a single-file rejection (or a
 * rejection before the first write, e.g. a bad tag) keeps native's text
 * byte-identical.
 */
function withLandedSections(message: string, landedPaths: readonly string[]): string {
	if (landedPaths.length === 0) return message;
	return `${message} Sections already written: ${landedPaths.join(", ")}.`;
}

export async function executeHashlineSingle(
	options: ExecuteHashlineSingleOptions,
): Promise<AgentToolResult<EditToolDetails, typeof hashlineEditParamsSchema>> {
	const session = options.session;
	const editSession = new EditSession(getEditStore(session), buildHashlineEditPolicy(session));
	try {
		// DSH never streams tool arguments — `edit` hands over the parsed
		// `{ input }` payload — so the no-delta path is always taken
		// (upstream `edit/index.ts:474-478`). Consequently the session is built
		// without an `onPreview` pump: nothing in `src/tools/edit`,
		// `src/tools/omp/edit`, `read.ts` or `write.ts` consumes preview batches
		// (T1/Lead audit), and per `EditSession` the callback is optional. The
		// three lifecycle calls that *do* matter for apply semantics are kept
		// verbatim: `setArgsJson` → `finish` → `apply` → `close` in `finally`.
		editSession.setArgsJson(JSON.stringify({ input: options.input } satisfies HashlineParams));
		editSession.finish();

		const writer = createHashlineWriter({
			session,
			writethrough: options.writethrough,
			signal: options.signal,
		});
		const outcome = await editSession.apply({ lspFlush: false }, writer);

		if (outcome.isError) {
			// `apply` "never rejects for engine failures: those come back as
			// isError outcomes carrying the model-facing message"
			// (`EditSession.apply`, pi-natives index.d.ts:113-119). That covers
			// tag/anchor mismatches, unseen anchor lines, missing files, the
			// escalated no-op message, *and* a writer refusal (a guard throwing
			// inside the callback is converted to `isError` with the writer's own
			// message, verified against the native engine). DSH's edit tool is
			// throw-based and its per-file detail shape carries
			// `displayErrorText` sourced from `MismatchError.displayMessage`, so
			// re-raise the native text as that class — the model still sees the
			// teaching message verbatim, plus the landed-sections breadcrumb when
			// part of a multi-section payload is already on disk.
			throw new MismatchError(withLandedSections(outcome.text, writer.landedPaths));
		}

		return renderOutcome(outcome);
	} finally {
		// The session holds only this call's stream buffer; the store (and with
		// it the no-op counter and clipboard) stays on the session.
		editSession.close();
	}
}

export { MismatchError as HashlineMismatchError, type HashlineParams, hashlineEditParamsSchema };
