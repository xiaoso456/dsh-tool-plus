/**
 * DSH write callback for the native edit engine.
 *
 * `EditSession.apply(request, writer)` stages the payload in Rust and then
 * hands every landed change back to the host as an {@link EditWriteRequest};
 * the host owns the bytes. This module is DSH's implementation of that
 * callback, and it deliberately reuses **the existing DSH write path** rather
 * than writing files itself:
 *
 * - `writethrough` — the file-write channel built by
 *   `src/tools/edit/adapter/index.ts` (`ctx.fs.writeText` + the session's
 *   sandbox policy, or the plain-Node fallback when there is no host `ctx`).
 *   Routing through it preserves the DSH filesystem sandbox and the host
 *   write-approval tier; `Bun.write` would bypass both.
 * - `assertEditableFile` — the auto-generated guard
 *   (`omp/tools/auto-generated-guard.ts`), which DSH used to run on the read
 *   leg of `HashlineFilesystem.readText`. The native engine reads files
 *   itself, so the guard runs here, before the bytes are written.
 * - **verbatim content** — the engine hands over the final byte sequence
 *   (`EditWriteRequest.content`), including notebook nbformat JSON, which it
 *   serializes itself (`crates/pi-edit/src/files.rs::persist`). The host lands
 *   it unchanged, matching upstream's writer. DSH must *not* run it back
 *   through `serializeEditFileText`: that was the old TS engine's contract
 *   (where `content` was editable cell text) and re-serializing the engine's
 *   JSON makes every `.ipynb` edit throw.
 * - `enforcePlanModeWrite` — the plan-mode gate seam. It is a documented no-op
 *   in DSH (`edit/adapter/tools/plan-mode-guard.ts`), but the call is kept so
 *   the three ops keep declaring their intent at the same place upstream does.
 * - `invalidateFsScanAfter*` — shared scan-cache busting, so grep/glob see the
 *   new state immediately.
 *
 * The returned callable also carries the landed-file record
 * ({@link HashlineWriter.landedPaths}): the engine aborts on the first writer
 * throw, so after a rejected multi-file payload the list names exactly the
 * sections that are already on disk. `executeHashlineSingle` re-attaches that
 * list to the model-facing error, restoring the old engine's
 * `Sections already written: …` breadcrumb.
 *
 * Upstream's LSP half of the same callback (workspace `didChangeWatchedFiles`,
 * write-batch flush, pre/post-write byte comparison) is absent by design: DSH
 * cuts the LSP layer (`plan.md` 拍板#5) and its `writethrough` already reports
 * what landed.
 */
import * as fs from "node:fs/promises";
import {
	enforcePlanModeWrite,
} from "../../edit/adapter/tools/plan-mode-guard.ts";
import { assertEditableFile } from "../../omp/tools/auto-generated-guard.ts";
import type { ToolSession } from "../../omp/sdk.ts";
import {
	invalidateFsScanAfterDelete,
	invalidateFsScanAfterRename,
	invalidateFsScanAfterWrite,
} from "../../omp/tools/fs-cache-invalidation.ts";
import { ToolError } from "../../omp/tools/tool-errors.ts";
import type { WritethroughCallback } from "../../omp/tools/writethrough.ts";
import type { EditWriteRequest, EditWriteResponse } from "./index.ts";

/** Wiring for {@link createHashlineWriter}. */
export interface HashlineWriterOptions {
	session: ToolSession;
	/** DSH's sandbox-routed file-write channel. */
	writethrough: WritethroughCallback;
	signal?: AbortSignal;
}

/**
 * The `writer` argument for `EditSession.apply`, carrying the landed-file
 * record alongside the callback.
 *
 * The native callback signature carries a leading `error` (used by the
 * streaming *preview* channel, never by write requests) — upstream ignores it
 * the same way (`refs/.../edit/index.ts:576`).
 */
export interface HashlineWriter {
	/** The error-first callback the engine invokes for every landed change. */
	(error: Error | null, request: EditWriteRequest): Promise<EditWriteResponse>;
	/**
	 * DSH display paths (`EditWriteRequest.displayPath` — the authored form,
	 * e.g. `a.ts`; for a move the *source*, which is the section that landed) of
	 * every file this apply actually wrote, in write order.
	 *
	 * The engine calls the writer once per file and aborts on the first throw,
	 * so after a rejected payload this holds exactly the sections that are on
	 * disk — the breadcrumb `executeHashlineSingle` re-attaches to the
	 * model-facing error (the old TS engine reported the same list from its
	 * prepared batch, `engine/patcher.ts:287-296` at v17.3.5).
	 */
	readonly landedPaths: readonly string[];
}

/**
 * Build the `writer` argument for `EditSession.apply`.
 *
 * The returned callable also exposes {@link HashlineWriter.landedPaths}; only a
 * *successful* write is recorded, so a channel refusal on file #2 leaves just
 * file #1 in the list.
 */
export function createHashlineWriter(options: HashlineWriterOptions): HashlineWriter {
	const { session, writethrough, signal } = options;
	const landedPaths: string[] = [];

	const write = async (_error: Error | null, request: EditWriteRequest): Promise<EditWriteResponse> => {
		if (request.op === "delete") {
			// `REM`: the engine already validated the file exists, so a
			// vanished target is a genuine race and propagates as ENOENT.
			enforcePlanModeWrite(session, request.path, { op: "delete" });
			await fs.rm(request.path);
			invalidateFsScanAfterDelete(request.path);
			landedPaths.push(request.displayPath);
			return { written: "" };
		}

		if (request.content === undefined) {
			throw new ToolError(`Native edit ${request.op} request omitted content`, { path: request.path });
		}

		if (request.op === "move") {
			if (!request.moveTo) {
				throw new ToolError("Native edit move request omitted destination", { path: request.path });
			}
			enforcePlanModeWrite(session, request.path, { op: "update", move: request.moveTo });
			// The destination content is what actually lands, so the
			// auto-generated guard keys off it. `moveTo` is absolute and the
			// request carries no second display path, so the destination's own
			// path is the display form.
			await assertEditableFile(request.moveTo, request.moveTo, session.settings);
			// `request.content` is already the final byte sequence — the engine
			// serializes a notebook back to nbformat JSON itself
			// (`crates/pi-edit/src/files.rs::persist`, handed over by
			// `session.rs` as `content: file.persisted`), exactly as upstream's
			// writer does (`packages/coding-agent/src/edit/index.ts`). The host
			// only lands bytes. The old TS engine handed over *editable* text
			// instead, so the host had to serialize — do not reintroduce that
			// here: it double-serializes and makes every `.ipynb` edit throw.
			const finalContent = request.content;
			// Destination first, source second: a failed write must not destroy
			// the original (upstream :600-604 does the same).
			await writethrough(request.moveTo, finalContent, signal, Bun.file(request.moveTo));
			await fs.rm(request.path);
			invalidateFsScanAfterRename(request.path, request.moveTo);
			// The *source* is the section that landed (what the model authored);
			// the destination is new state it can discover from the response.
			landedPaths.push(request.displayPath);
			return { written: finalContent };
		}

		// `create` | `update`.
		enforcePlanModeWrite(session, request.path, { op: request.op === "create" ? "create" : "update" });
		// Missing files are editable (the guard returns "no marker" for ENOENT),
		// so this is a no-op for a create and the real guard for an update.
		await assertEditableFile(request.path, request.displayPath, session.settings);
		// Verbatim, for the same reason as the move branch above: the engine
		// owns notebook serialization (`files.rs::persist` / `persist_new`), and
		// DSH re-serializing its JSON output is what broke `.ipynb` edits.
		const finalContent = request.content;
		// The channel creates missing parent directories on ENOENT (see
		// `writethroughNoop`), so creates need no separate mkdir here.
		await writethrough(request.path, finalContent, signal, Bun.file(request.path));
		invalidateFsScanAfterWrite(request.path);
		landedPaths.push(request.displayPath);
		// Report what actually landed, which is exactly what the engine sent
		// (`EditWriteResponse.written` — "text actually persisted").
		return { written: finalContent };
	};

	return Object.assign(write, { landedPaths });
}
