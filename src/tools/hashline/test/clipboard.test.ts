import { describe, expect, it } from "vitest";

import {
	applyPatch,
	expectError,
	expectSuccess,
	expectWarnings,
	fileOutcome,
	makeWriter,
	withWorkspace,
} from "./harness.ts";
import type { ApplyResult, NativeOutcome, RecordingWriter, Workspace } from "./harness.ts";
import { blockRangeAt, EditSession } from "../native/index.ts";
import type { EditPreviewBatch } from "../native/index.ts";

/**
 * Clipboard registers. The old suite drove `parsePatch` / `parsePatchStreaming`
 * / `applyPartialTo` / `resolveBlockEdits` and read edit-kind arrays, stub
 * spans and callback payloads out of them. Native has none of those seams: a
 * host supplies only a payload, and shared state is reachable through payload
 * text alone — named registers persist across `apply` calls on one
 * `EditStore` (so a cross-call case keeps one `Workspace`), anonymous
 * registers never cross calls (so a cross-file move is one payload).
 *
 * Every case below is therefore a session run: author the section, apply, and
 * assert persisted bytes, `firstChangedLine`, the exact warning list, or the
 * exact model-facing rejection text. The two streaming cases drive
 * `EditSession` directly, because the harness's `delta` option cannot reach
 * them: `setArgsJson` replaces the buffer, so a pushed fragment never survives
 * into the applied payload.
 */

const REL = "x.ts";

/* -------------------------------------------------------------------------- */
/* Engine messages (verbatim)                                                  */
/* -------------------------------------------------------------------------- */

const M_COLON_ON_REGISTER_PUT =
	"line 1: `PUT … @name` pastes the register and never takes `:` — the colon promises body rows. Drop the colon (`PUT >40 @name`), or drop `@name` and write `+TEXT` body rows.";
const M_CUT_TAKES_NO_BODY =
	"line 2: `CUT` deletes (and captures) the named lines and takes no body rows. To write new content, use `PUT N.=M:` with `+TEXT` rows.";
const M_RANGE_OVERLAP =
	"line 2: anchor line 3 is already targeted by another hunk on line 1. Issue ONE hunk per range; payload is only the final desired content, never a before/after pair.";
const M_INVERTED_RANGE =
	"line 1: Invalid absolute range: start 5, end 2. The value after `.=` is an absolute source line, not a line count or replacement length. For one line use `CUT 5`. For 2 lines starting at 5, use `CUT 5.=6`.";
const M_EMPTY_ANONYMOUS_REGISTER =
	"line 1: Nothing to paste: no unlabeled `CUT` precedes this `PUT` in this call, and the anonymous register never carries across calls. Put `CUT N.=M` / `CUT N*` above it, or use named registers (`CUT … @name` → `PUT … @name`) for cross-call moves.";
const M_EMPTY_NAMED_SPAN_PASTE =
	"line 1: `@gone` is empty — no `CUT … @gone` precedes this op in this call and no persisted register has that name — so pasting it over a range would delete those lines and write nothing back. Capture the register first (`CUT … @gone`), or use `CUT` if deleting the range is what you meant.";
const M_EMPTY_NAMED_GAP_PASTE =
	"line 2: `@gone` was empty — no `CUT … @gone` precedes this op in this call and no persisted register has that name — so nothing was pasted. Available registers: `@kept`.";
const M_AMBIGUOUS_ANONYMOUS_PASTE =
	"line 3: 2 unlabeled `CUT`s are pending (CUT 1, CUT 3) — an unlabeled paste cannot tell which one you meant. Label the moves (`CUT … @name` → `PUT … @name`), or keep at most one unlabeled `CUT` before each unlabeled paste.";
const M_CUT_OUT_OF_RANGE = "line 1: `CUT 8.=9` is out of range (file has 3 lines).";
const M_SINGLE_LINE_BLOCK =
	"line 1: `CUT 2*` resolved a single-line block — line 2 is a bare statement, not the opening line of a multi-line construct. For only this statement use `CUT 2`. The nearest enclosing multi-line block begins at line 1 and ends at line 3; use `CUT 1*` to target it.";
const M_UNRESOLVED_PUT_BLOCK =
	"`PUT >2*` could not resolve a syntactic block on line 2, so it was applied as plain `PUT >2`. Verify the landing line; anchor on a line that OPENS a construct.";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** The real span an `N*` locator resolves to — native's replacement for a stub resolver. */
function spanOf(rel: string, file: string, line: number): { startLine: number; endLine: number } | null {
	return blockRangeAt({ code: file, path: rel, line });
}

/** Write, snapshot and apply one payload; assert it landed, then inspect it. */
async function runCase(
	label: string,
	rel: string,
	file: string,
	payload: string,
	check: (result: ApplyResult) => void,
): Promise<void> {
	await withWorkspace(`clipboard-${label}`, async ws => {
		ws.write(rel, file);
		const tag = ws.snapshot(rel, file);
		const result = await applyPatch(ws, `[${rel}#${tag}]\n${payload}`);
		expectSuccess(result);
		check(result);
	});
}

/**
 * The old `toThrow(/…/)` cases. Native rejections are settled `isError`
 * outcomes whose `text` is the whole model-facing message, so the message is
 * pinned byte-for-byte rather than matched loosely.
 */
async function expectRejection(
	label: string,
	rel: string,
	file: string,
	payload: string,
	message: string,
): Promise<void> {
	await withWorkspace(`clipboard-${label}`, async ws => {
		ws.write(rel, file);
		const tag = ws.snapshot(rel, file);
		const result = await applyPatch(ws, `[${rel}#${tag}]\n${payload}`);
		expectError(result);
		expect(result.outcome.text).toBe(message);
	});
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 25));

/**
 * Drive a genuinely streamed session: the serialized args JSON is pushed in
 * two fragments, the first ending exactly on `tailMarker` (the op whose
 * stream-boundary behaviour is under test). The preview pump settles
 * asynchronously, so each push and `finish()` gets a turn before the apply.
 */
async function streamCase(
	label: string,
	rel: string,
	file: string,
	payload: string,
	tailMarker: string,
): Promise<ApplyResult> {
	return withWorkspace(`clipboard-${label}`, async ws => {
		ws.write(rel, file);
		const tag = ws.snapshot(rel, file);
		const argsJson = JSON.stringify({ input: `[${rel}#${tag}]\n${payload}` });
		const cut = argsJson.indexOf(tailMarker) + tailMarker.length;
		const previews: EditPreviewBatch[] = [];
		const writer: RecordingWriter = makeWriter();
		const session = new EditSession(ws.store, ws.policy(), (_error, batch) => {
			previews.push(JSON.parse(JSON.stringify(batch)) as EditPreviewBatch);
		});
		try {
			for (const fragment of [argsJson.slice(0, cut), argsJson.slice(cut)]) {
				session.push(fragment);
				await settle();
			}
			session.finish();
			await settle();
			const outcome = (await session.apply({ lspFlush: false }, writer.fn)) as unknown as NativeOutcome;
			return {
				outcome,
				requests: writer.requests,
				lastText: writer.lastText(),
				previews,
				writerErrors: writer.errors,
			};
		} finally {
			session.close();
		}
	});
}

/** One apply against an already-written file, re-snapshotting it first. */
async function withTag(ws: Workspace, rel: string, payload: string): Promise<ApplyResult> {
	const tag = ws.snapshot(rel);
	return applyPatch(ws, `[${rel}#${tag}]\n${payload}`);
}

/** Text the engine reports for `rel` — the persisted bytes. */
function appliedText(result: ApplyResult, rel = REL): string | undefined {
	return fileOutcome(result, rel)?.newText;
}

/* -------------------------------------------------------------------------- */
/* Cases                                                                       */
/* -------------------------------------------------------------------------- */

describe("clipboard parsing", () => {
	it("lowers `CUT N-M` to a capture plus per-line deletes", async () => {
		// Was: the parsed `edits` sequence `["cut","delete","delete"]`. The bytes
		// pin both halves — the range is gone and the captured lines come back.
		await runCase("cut-range", REL, "l1\nl2\nl3\nl4", "CUT 2-3\nPUT <1", result => {
			expect(appliedText(result)).toBe("l2\nl3\nl1\nl4");
			expect(fileOutcome(result, REL)?.firstChangedLine).toBe(1);
		});
	});

	it("lands every PUT paste locator at its own position and rejects a colon on a register PUT", async () => {
		// Was: the parsed cursor kinds for `<N`, `>N`, `<$`, `>$`. The captured
		// line is identical at all four destinations, so the surviving bytes are
		// order-independent evidence of all four locators.
		await runCase("put-locators", REL, "l1\nl2\nl3\nl4", "CUT 1\nPUT <2\nPUT >3\nPUT <1\nPUT >$", result => {
			expect(appliedText(result)).toBe("l1\nl1\nl2\nl3\nl1\nl4\nl1");
		});
		await expectRejection("put-locators-colon", REL, "l1\nl2\n", "PUT >2 @name:", M_COLON_ON_REGISTER_PUT);
	});

	it("rejects colon on register PUT", async () => {
		await expectRejection("reject-colon", REL, "l1\nl2\n", "PUT >2 @name:", M_COLON_ON_REGISTER_PUT);
	});

	it("rejects body rows under CUT", async () => {
		await expectRejection("reject-cut-body", REL, "l1\nl2\n", "CUT 1-2\n+x", M_CUT_TAKES_NO_BODY);
	});

	it("rejects a CUT range overlapping another hunk's range", async () => {
		await expectRejection("reject-overlap", REL, "l1\nl2\nl3\nl4\n", "CUT 2-4\nPUT 3:\n+x", M_RANGE_OVERLAP);
	});

	it("reports inverted CUT ranges with op-specific retry forms", async () => {
		await expectRejection("reject-inverted", REL, "l1\nl2\n", "CUT 5-2", M_INVERTED_RANGE);
	});

	it("flushes a trailing bodyless clipboard op in streaming mode", async () => {
		// The stream stops exactly on the bodyless `PUT >$` — the op a streaming
		// parser is tempted to hold back until body rows arrive. Both the settled
		// streaming preview (`-1|l1` cut, `+3|l1` pasted) and the applied bytes
		// show it was flushed rather than dropped.
		const result = await streamCase("stream-tail", REL, "l1\nl2", "CUT 1\nPUT >$", "PUT >$");
		const streaming = result.previews.find(batch => batch.streaming);
		expect(streaming?.files[0]?.diff).toBe("-1|l1\n+3|l1");
		expect(streaming?.files[0]?.error).toBeUndefined();
		expectSuccess(result);
		expect(appliedText(result)).toBe("l2\nl1");
		expect(result.requests.map(request => request.op)).toEqual(["update"]);
	});
});

describe("clipboard apply semantics", () => {
	it("moves a range within a file (CUT + PUT)", async () => {
		await runCase("move-range", REL, "l1\nl2\nl3\nl4\nl5\n", "CUT 2-3\nPUT >5", result => {
			expect(appliedText(result)).toBe("l1\nl4\nl5\nl2\nl3\n");
			expect(fileOutcome(result, REL)?.firstChangedLine).toBe(2);
		});
	});

	it("repeats CUT content without consuming the clipboard", async () => {
		await runCase("repeat-cut", REL, "l1\nl2\nl3\n", "CUT 2\nPUT <1\nPUT >$", result => {
			expect(appliedText(result)).toBe("l2\nl1\nl3\nl2\n");
			expect(fileOutcome(result, REL)?.firstChangedLine).toBe(1);
		});
	});

	it("swaps two regions with named registers", async () => {
		await runCase("named-swap", REL, "a1\na2\nb1\nb2", "CUT 1-2 @a\nCUT 3-4 @b\nPUT <1 @b\nPUT >$ @a", result => {
			expect(appliedText(result)).toBe("b1\nb2\na1\na2");
			expect(fileOutcome(result, REL)?.firstChangedLine).toBe(1);
		});
	});

	it("rejects PUT with an empty register", async () => {
		await expectRejection("empty-anon", REL, "l1\nl2\n", "PUT >1", M_EMPTY_ANONYMOUS_REGISTER);
	});

	// Pasting a never-captured register over a span would delete the range and
	// write nothing back — a mistyped register name must not silently destroy
	// content. (Gap pastes stay a warned no-op; see the next test.)
	it("rejects a span paste from an empty named register instead of deleting the range", async () => {
		await expectRejection("empty-named-span", REL, "l1\nl2\nl3\nl4\n", "PUT 2-3 @gone", M_EMPTY_NAMED_SPAN_PASTE);
	});

	it("pastes nothing at a gap from an empty named register, with a warning", async () => {
		await runCase("empty-named-gap", REL, "l1\nl2\n", "CUT 1 @kept\nPUT >2 @gone", result => {
			expect(appliedText(result)).toBe("l2\n");
			expectWarnings(result, REL, { exact: [M_EMPTY_NAMED_GAP_PASTE] });
		});
	});

	it("drops an empty-register PUT on the streaming-tolerant path", async () => {
		// Was: `applyPartialTo(...).text` unchanged, i.e. the tolerant pass drops
		// the empty paste instead of throwing. The payload carries one more hunk
		// so that pass has a settled preview batch to read the drop out of (an
		// empty-register op alone renders nothing); the settled streaming batch
		// reports no error for the file and still previews the other hunk, while
		// the strict post-`finish()` pass rejects it and writes nothing.
		const result = await streamCase("tolerant-drop", REL, "l1\nl2\n", "PUT >1\nPUT 2:\n+two", "PUT >1");
		const streaming = result.previews.filter(batch => batch.streaming);
		expect(streaming.length).toBeGreaterThan(0);
		for (const batch of streaming) {
			expect(batch.files.map(file => file.path)).toEqual([REL]);
			expect(batch.files[0]?.error).toBeUndefined();
		}
		expect(streaming[0]?.files[0]?.diff).toBe("-2|l2\n+2|two");
		expect(result.previews.find(batch => !batch.streaming)?.files[0]?.error).toBe(M_EMPTY_ANONYMOUS_REGISTER);
		expectError(result);
		expect(result.outcome.text).toBe(M_EMPTY_ANONYMOUS_REGISTER);
		expect(result.requests).toEqual([]);
	});

	it("allows a CUT without a following PUT", async () => {
		await runCase("cut-only", REL, "l1\nl2\nl3\n", "CUT 2", result => {
			expect(appliedText(result)).toBe("l1\nl3\n");
			expect(fileOutcome(result, REL)?.firstChangedLine).toBe(2);
		});
	});

	it("rejects multiple unlabeled CUTs before an unlabeled paste", async () => {
		await expectRejection("ambiguous-anon", REL, "l1\nl2\nl3\n", "CUT 1\nCUT 3\nPUT >$", M_AMBIGUOUS_ANONYMOUS_PASTE);
	});

	it("allows consecutive CUTs into named registers", async () => {
		await runCase("consecutive-named", REL, "l1\nl2\nl3\n", "CUT 1 @first\nCUT 3 @second\nPUT >$ @second", result => {
			expect(appliedText(result)).toBe("l2\nl3\n");
			expect(fileOutcome(result, REL)?.firstChangedLine).toBe(1);
		});
	});

	it("rejects an out-of-range capture", async () => {
		await expectRejection("cut-out-of-range", REL, "l1\nl2\n", "CUT 8-9\nPUT <1", M_CUT_OUT_OF_RANGE);
	});

	it("threads host-owned named registers across applies on one store", async () => {
		// Was: two `applyEdits` calls sharing a host clipboard. Native keeps the
		// registers on the `EditStore`, so both applies run in one workspace.
		await withWorkspace("clipboard-named-carry", async ws => {
			ws.write("a.ts", "a\nb");
			ws.write("b.ts", "x\ny");
			const first = await withTag(ws, "a.ts", "CUT 1 @r");
			expectSuccess(first);
			expect(appliedText(first, "a.ts")).toBe("b");
			expect(fileOutcome(first, "a.ts")?.firstChangedLine).toBe(1);

			const second = await withTag(ws, "b.ts", "PUT >$ @r");
			expectSuccess(second);
			expect(appliedText(second, "b.ts")).toBe("x\ny\na");
			expect(fileOutcome(second, "b.ts")?.firstChangedLine).toBe(3);
		});
	});
});

describe("clipboard block ops", () => {
	it("expands CUT N* to a span capture plus per-line deletes", async () => {
		// Was: the resolved edit sequence `["cut","delete","delete","paste"]` for a
		// stub span [2, 3]. `foo(() => {` / `});` is real syntax with that span.
		const text = ["head();", "foo(() => {", "});", "tail();", ""].join("\n");
		expect(spanOf(REL, text, 2)).toEqual({ startLine: 2, endLine: 3 });
		await runCase("cut-block", REL, text, "CUT 2*\nPUT >$", result => {
			expect(appliedText(result)).toBe("head();\ntail();\nfoo(() => {\n});\n");
			expect(fileOutcome(result, REL)?.firstChangedLine).toBe(2);
			expectWarnings(result, REL, { exact: [] });
		});
	});

	it("moves a block after another block via PUT >N*", async () => {
		// Stub blocks [1, 2] and [3, 4] — two empty `foo`/`bar` calls are exactly
		// those spans.
		const text = ["foo(() => {", "});", "bar(() => {", "});", "rest();", ""].join("\n");
		expect(spanOf(REL, text, 1)).toEqual({ startLine: 1, endLine: 2 });
		expect(spanOf(REL, text, 3)).toEqual({ startLine: 3, endLine: 4 });
		await runCase("move-block", REL, text, "CUT 1*\nPUT >3*", result => {
			expect(appliedText(result)).toBe("bar(() => {\n});\nfoo(() => {\n});\nrest();\n");
			expect(fileOutcome(result, REL)?.firstChangedLine).toBe(1);
			expectWarnings(result, REL, { exact: [] });
		});
	});

	it("echoes clipboard block resolutions with their op", async () => {
		// Was: the `onResolved` callback firing once with `op: "cut"`. Native
		// replaces that callback with the model-facing resolution echo: exactly
		// one line, labelled with the op, carrying the resolved span.
		const text = ["head();", "foo(() => {", "});", "tail();", ""].join("\n");
		await runCase("block-echo", REL, text, "CUT 2*\nPUT >$", result => {
			const echoes = result.outcome.text.split("\n").filter(line => line.includes("→ resolved"));
			expect(echoes).toEqual(["CUT 2* → resolved lines 2-3 (2 lines)"]);
			expect(appliedText(result)).toBe("head();\ntail();\nfoo(() => {\n});\n");
		});
	});

	it("rejects a single-line CUT N* resolution with the plain-op retry", async () => {
		// The stub returned `{start: 2, end: 2}`; `g();` on line 2 is a real
		// single-line node, which the resolver confirms before rejecting.
		const text = ["function f() {", "    g();", "}", "tail();", ""].join("\n");
		expect(spanOf(REL, text, 2)).toEqual({ startLine: 2, endLine: 2 });
		await expectRejection("single-line-block", REL, text, "CUT 2*\nPUT >$", M_SINGLE_LINE_BLOCK);
	});

	it("lowers an unresolvable PUT >2* to a plain paste with a warning", async () => {
		// The stub resolver returned null; an unknown extension resolves to no
		// block at all, so the block paste degrades to `PUT >2` and says so.
		const text = "a\nb\nc";
		expect(spanOf("x.unknown", text, 2)).toBeNull();
		await runCase("unresolved-put-block", "x.unknown", text, "CUT 1\nPUT >2*", result => {
			expect(appliedText(result, "x.unknown")).toBe("b\na\nc");
			expect(fileOutcome(result, "x.unknown")?.firstChangedLine).toBe(1);
			expectWarnings(result, "x.unknown", { exact: [M_UNRESOLVED_PUT_BLOCK] });
		});
	});
});

describe("clipboard across sections and batches", () => {
	it("moves lines between files within one patch", async () => {
		// One payload: the anonymous register only lives for the call it was cut in.
		await withWorkspace("clipboard-cross-file", async ws => {
			ws.write("a.ts", "keep\nmove1\nmove2\n");
			ws.write("b.ts", "b1\n");
			const tagA = ws.snapshot("a.ts", "keep\nmove1\nmove2\n");
			const tagB = ws.snapshot("b.ts", "b1\n");
			const result = await applyPatch(ws, `[a.ts#${tagA}]\nCUT 2-3\n[b.ts#${tagB}]\nPUT >$`);
			expectSuccess(result);

			expect(appliedText(result, "a.ts")).toBe("keep\n");
			expect(fileOutcome(result, "a.ts")?.firstChangedLine).toBe(2);
			expect(appliedText(result, "b.ts")).toBe("b1\nmove1\nmove2\n");
			expect(fileOutcome(result, "b.ts")?.firstChangedLine).toBe(2);
		});
	});
});
