/**
 * Hashline file operations (`REM` whole-file delete / `MV` move), migrated to
 * the native (Rust) engine.
 *
 * Ground rules this file encodes, per `D:/tmp/hashline-tests/MIGRATION-BRIEF.md`:
 * - There is no parse layer any more. The old `parsePatch("REM").fileOp` /
 *   `Patch.parseSingle(...).fileOp` assertions are re-expressed on
 *   {@link editInspect}, the native static projection: it reports
 *   `fileOps: [{kind:"delete", path}]` and `[{kind:"move", path, to}]`
 *   (native spellings; the deleted TS engine said `rem` and `dest`).
 * - Refusals do not throw: the engine returns `{isError:true, text}`.
 * - The host owns the bytes through the writer callback, so every case that
 *   used `InMemoryFilesystem` now runs against a real temp directory and
 *   asserts the recorded write request, the persisted tree (`ws.tree()`), and
 *   the store semantics at the destination (`headHash` / `byHashText` /
 *   `seenLines`), which is where `InMemorySnapshotStore.byHash`/`head` moved.
 */
import { describe, expect, it } from "vitest";

import {
	applyPatch,
	expectError,
	expectFile,
	expectSuccess,
	fileOutcome,
	withWorkspace,
} from "./harness.ts";
import { computeFileHash, editInspect } from "../native/index.ts";

const PATH = "src/old.ts";
const DEST = "src/new.ts";
const CONTENT = "one\ntwo\nthree\n";
const EDITED = "one\nTWO\nthree\n";

/**
 * Native replacement for the deleted `parsePatch` / `Patch.parseSingle` layer:
 * a static projection of the payload's destructive intents, no filesystem
 * access. Old engine: `{kind:"rem"}` / `{kind:"move", dest}`.
 */
function fileOpsOf(input: string): Array<{ kind: string; path: string; to?: string }> {
	return editInspect("hashline", JSON.stringify({ input })).fileOps;
}

describe("hashline file ops", () => {
	it("parses REM and rejects line ops in the same section", async () => {
		// `fileOps` replaces `parsePatch("REM").fileOp`. Native binds the
		// whole-file delete to a section header, so the payload carries one.
		expect(fileOpsOf(`[${PATH}#AB12]\nREM`)).toEqual([{ kind: "delete", path: PATH }]);

		await withWorkspace("file-ops-rem-lineops", async ws => {
			ws.write(PATH, CONTENT);
			const tag = ws.snapshot(PATH, CONTENT);

			const result = await applyPatch(ws, `[${PATH}#${tag}]\nPUT 1-1:\n+one\nREM`);

			expectError(result, /REM.*line ops/);
			// `parsePatch` used to raise synchronously; native rejects at apply
			// time. A rejection must stage nothing: no write request, no change
			// to the file on disk.
			expect(result.requests).toEqual([]);
			expectFile(ws, PATH, CONTENT);
		});
	});

	it("parses MV with a normalized destination path", async () => {
		// `Patch.parseSingle(...).fileOp` → native `fileOps[0]`: exact object,
		// including the `to` field that replaced the old `dest`.
		expect(fileOpsOf(`[${PATH}#AB12]\nMV ${DEST}`)).toEqual([{ kind: "move", path: PATH, to: DEST }]);

		await withWorkspace("file-ops-mv-normalize", async ws => {
			ws.write(PATH, CONTENT);
			const tag = ws.snapshot(PATH, CONTENT);

			// The authored destination keeps its dot segments in the echoed
			// text, but the write is normalized onto the real workspace path.
			const result = await applyPatch(ws, `[${PATH}#${tag}]\nMV ./src/./new.ts`);

			expectSuccess(result);
			expect(result.requests).toHaveLength(1);
			expect(result.requests[0].op).toBe("move");
			expect(result.requests[0].moveTo).toBe(ws.abs(DEST));
			expect(ws.tree()).toEqual({ [DEST]: CONTENT });
		});
	});

	it("deletes a tagged file with REM", async () => {
		await withWorkspace("file-ops-rem-delete", async ws => {
			ws.write(PATH, CONTENT);
			const tag = ws.snapshot(PATH, CONTENT);

			const result = await applyPatch(ws, `[${PATH}#${tag}]\nREM`);

			expectSuccess(result);
			// The writer request is a whole-file delete carrying no bytes
			// (`InMemoryFilesystem` used to be the observable side of this).
			expect(result.requests).toHaveLength(1);
			expect(result.requests[0].op).toBe("delete");
			expect(result.requests[0].path).toBe(ws.abs(PATH));
			expect(result.requests[0].content).toBeUndefined();
			expect(fileOutcome(result, PATH)?.op).toBe("delete");
			// There is no post-delete content to tag, so the echo is tag-free.
			expect(result.outcome.text).toBe(`Deleted ${PATH}`);
			// Persisted tree: the workspace is empty again.
			expect(ws.tree()).toEqual({});
			// Store semantics: the per-path snapshot history dies with the file
			// (old: `snapshots.byHash(PATH, tag)` → null).
			expect(ws.store.headHash(ws.abs(PATH))).toBeNull();
			expect(ws.store.byHashText(ws.abs(PATH), tag)).toBeNull();
		});
	});

	it("moves a file without content edits", async () => {
		await withWorkspace("file-ops-move", async ws => {
			ws.write(PATH, CONTENT);
			const tag = ws.snapshot(PATH, CONTENT, [1, 2]);

			const result = await applyPatch(ws, `[${PATH}#${tag}]\nMV ${DEST}`);

			expectSuccess(result);
			// One `move` request: write the bytes at `moveTo`, drop the source.
			expect(result.requests).toHaveLength(1);
			expect(result.requests[0].op).toBe("move");
			expect(result.requests[0].path).toBe(ws.abs(PATH));
			expect(result.requests[0].moveTo).toBe(ws.abs(DEST));
			expect(result.requests[0].content).toBe(CONTENT);
			// Per-file outcome: the old engine also reported a move as an
			// `update` section that carries a destination.
			expect(fileOutcome(result, PATH)?.op).toBe("update");
			expect(fileOutcome(result, PATH)?.moveTo).toBe(ws.abs(DEST));
			// Persisted tree: only the destination exists, with the same bytes.
			expect(ws.tree()).toEqual({ [DEST]: CONTENT });
			expectFile(ws, DEST, CONTENT);
			// Store semantics: the version history (text AND seenLines) follows
			// the file to the destination; the source path is forgotten.
			const movedTag = computeFileHash(CONTENT);
			expect(ws.store.headHash(ws.abs(DEST))).toBe(movedTag);
			expect(ws.store.byHashText(ws.abs(DEST), tag)).toBe(CONTENT);
			expect(ws.store.seenLines(ws.abs(DEST), tag)).toEqual([1, 2]);
			expect(ws.store.headHash(ws.abs(PATH))).toBeNull();
			expect(ws.store.byHashText(ws.abs(PATH), tag)).toBeNull();
			// The tag in the model-facing echo is the destination's head tag.
			expect(result.outcome.text).toBe(`[${DEST}#${movedTag}]\nMoved to ${DEST}`);
		});
	});

	it("applies line edits then moves the updated content", async () => {
		await withWorkspace("file-ops-edit-move", async ws => {
			ws.write(PATH, CONTENT);
			const tag = ws.snapshot(PATH, CONTENT);

			const result = await applyPatch(ws, `[${PATH}#${tag}]\nPUT 2-2:\n+TWO\nMV ${DEST}`);

			expectSuccess(result);
			// The edit is applied first and the single move request carries the
			// EDITED bytes — never the original ones.
			expect(result.requests).toHaveLength(1);
			expect(result.requests[0].op).toBe("move");
			expect(result.requests[0].moveTo).toBe(ws.abs(DEST));
			expect(result.requests[0].content).toBe(EDITED);
			// Persisted tree: source gone, destination holds the edited text
			// (old: `fs.get(PATH)` undefined, `fs.get(DEST)` === edited).
			expect(ws.tree()).toEqual({ [DEST]: EDITED });
			expectFile(ws, DEST, EDITED);
			// Per-file detail keeps the diff anchor from the edited content.
			const outcomeFile = fileOutcome(result, PATH);
			expect(outcomeFile?.op).toBe("update");
			expect(outcomeFile?.moveTo).toBe(ws.abs(DEST));
			expect(outcomeFile?.newText).toBe(EDITED);
			expect(outcomeFile?.firstChangedLine).toBe(2);
			// Store semantics: the destination head tag is the content hash of
			// the edited text, and the echo shows that same tag (old:
			// `sections[0].fileHash` === computeFileHash(edited) and
			// `snapshots.head(DEST).hash` === that hash).
			const editedTag = computeFileHash(EDITED);
			expect(ws.store.headHash(ws.abs(DEST))).toBe(editedTag);
			expect(ws.store.byHashText(ws.abs(DEST), editedTag)).toBe(EDITED);
			expect(ws.store.headHash(ws.abs(PATH))).toBeNull();
			expect(result.outcome.text).toBe(`[${DEST}#${editedTag}]\nMoved to ${DEST}\n1:one\n2:TWO\n3:three`);
		});
	});
});
