/**
 * `N*` block locators (`PUT N*:`, `PUT >N*:`, `CUT N*`) against the native engine.
 *
 * Migrated from the deleted TypeScript `@oh-my-pi/hashline` surface. The old
 * file drove `resolveBlockEdits` through an injected stub resolver
 * (`{ start: line, end: line + 1 }`), `Patch.parseSingle(header).applyTo(text,
 * resolver)` / `applyPartialTo(text)`, and `new Patcher({ blockResolver })`,
 * then asserted parsed `Edit` objects and `sections[0].blockResolutions`.
 *
 * The native engine resolves `N*` itself: there is no resolver seam, no
 * `onResolved`/`onWarning` callback, no parsed edit list, and no
 * `blockResolutions` field. Every case is therefore re-expressed at the
 * behaviour layer:
 *
 * - the anchor → span oracle is the exported native primitive `blockRangeAt`,
 *   which is the same primitive the engine's resolver calls, used to
 *   cross-check the span the engine reports;
 * - `PUT N*:` ≡ `PUT start.=end:` cases run two sessions over identical fixture
 *   text and require equal — and explicitly expected — `newText`;
 * - diagnostics keep the reserved messages verbatim (`outcome.text`), including
 *   the ±2-line context preview, the blank-anchor suggestion, the
 *   statement-vs-enclosing suggestion, the single-line rejection and the
 *   reversed-range enrichment;
 * - the lenient path (`applyPartialTo`, `onUnresolved: "drop"`) is the
 *   streaming preview pass, which drops an unresolvable or single-line block
 *   and keeps every other edit — see {@link runWithPreviews};
 * - a resolved span is surfaced in `outcome.text` as
 *   ``PUT 2*: → resolved lines 2-3 (2 lines)``.
 */
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
import type { ApplyResult, NativeOutcome } from "./harness.ts";
import { blockRangeAt, computeFileHash, EditSession } from "../native/index.ts";
import type { EditPreviewBatch } from "../native/index.ts";

const PATH = "x.ts";

/** `function x() {` … — the `if` construct beginning on line 2 spans lines 2-3. */
const TS_BLOCK = "function x() {\n  if (y) {\n  }\n}\n";
/** Nested construct: the `if` beginning on line 2 spans lines 2-4. */
const TS_NESTED = "function x() {\n  if (y) {\n    run();\n  }\n}\n";
/** Two-line construct on line 1, so `PUT 1*:` ≡ `PUT 1.=2:`. */
const TWO_LINE = "function f() {\n}\nconst tail = 1;\n";
/** Language the tree-sitter resolver cannot read: every `N*` anchor fails. */
const UNKNOWN_PATH = "x.unknown";
const UNKNOWN_TEXT = "one\ntwo\nthree";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** The native span oracle: the syntactic block that begins on `line`. */
function spanAt(code: string, rel: string, line: number): { startLine: number; endLine: number } | null {
	return blockRangeAt({ code, path: rel, line });
}

/**
 * Write `source` to `rel` in a fresh workspace, mint its tag, and apply `body`
 * (the hunk text, without the `[path#tag]` header). Returns the engine result
 * plus the bytes that actually landed on disk.
 */
async function applyTo(label: string, rel: string, source: string, body: string): Promise<{ result: ApplyResult; text: string | undefined }> {
	return withWorkspace(label, async ws => {
		ws.write(rel, source);
		const tag = ws.snapshot(rel);
		const result = await applyPatch(ws, `[${rel}#${tag}]\n${body}`);
		return { result, text: ws.read(rel) };
	});
}

/**
 * Let the native preview pump deliver its batch (one callback per generation).
 * The pump computes a small tree-sitter parse + diff on the blocking pool, so
 * 200 ms is a generous bound while keeping the whole file fast.
 */
function settle(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 200));
}

/**
 * Drive a payload through a session the shared harness cannot express.
 *
 * Preview batches come from an async native pump, so `push()` has to settle
 * before `finish()`/`apply()` — and `apply()` closes the pump. `harness.applyArgs`
 * enqueues every arg op back-to-back and closes immediately, so its
 * `collectPreviews` list is always empty. The streaming pass is the only native
 * equivalent of the deleted `applyPartialTo` / `onUnresolved: "drop"` surface,
 * hence this local driver (the same shape `hashline-fixtures.test.ts` uses for
 * the cross-call clipboard case).
 */
async function runWithPreviews(
	label: string,
	rel: string,
	source: string,
	body: string,
): Promise<ApplyResult & { text: string | undefined }> {
	return withWorkspace(label, async ws => {
		ws.write(rel, source);
		const tag = ws.snapshot(rel);
		const payload = JSON.stringify({ input: `[${rel}#${tag}]\n${body}` });
		const previews: EditPreviewBatch[] = [];
		const writer = makeWriter();
		const session = new EditSession(ws.store, ws.policy(), (_error, batch) => previews.push(batch));
		try {
			session.push(payload);
			await settle();
			session.setArgsJson(payload);
			session.finish();
			await settle();
			const outcome = (await session.apply({ lspFlush: false }, writer.fn)) as unknown as NativeOutcome;
			return {
				outcome,
				requests: writer.requests,
				lastText: writer.lastText(),
				previews,
				writerErrors: writer.errors,
				text: ws.read(rel),
			};
		} finally {
			session.close();
		}
	});
}

/** 255-line TS file whose construct beginning on line 195 ends on line 255. */
function bigBlockSource(): string {
	const lines: string[] = [];
	for (let line = 1; line <= 194; line += 1) lines.push(`// filler ${line}`);
	lines.push("function big() {");
	for (let line = 196; line <= 254; line += 1) lines.push(`  const v${line} = ${line};`);
	lines.push("}");
	return `${lines.join("\n")}\n`;
}

/* -------------------------------------------------------------------------- */
/* PUT N*: parsing                                                             */
/* -------------------------------------------------------------------------- */

describe("PUT N*: parsing", () => {
	it("parses `PUT N*: N:` into a single deferred block edit", async () => {
		// Re-expressed: native exposes no parsed `Edit`. The observable shape of a
		// single deferred block edit is that ONE `2*` hunk replaces the whole
		// syntactic span (2-4, three lines) with its two body rows — not a
		// body-length range and not two separate hunks.
		const { result, text } = await applyTo("block-parse", PATH, TS_NESTED, "PUT 2*:\n+A\n+B");
		expectSuccess(result);
		expect(text).toBe("function x() {\nA\nB\n}\n");
		expect(result.outcome.text).toContain("PUT 2*: → resolved lines 2-4 (3 lines)");
	});

	it("still parses a literal `SWAP N.=M:` range (distinct from `PUT N*:`)", async () => {
		// Re-expressed: a literal range stops at the lines written and is never
		// widened to the enclosing construct, so the same payload lands
		// differently from the `2*` locator and carries no resolution echo.
		const literal = await applyTo("block-literal", PATH, TS_NESTED, "PUT 2-3:\n+A");
		const block = await applyTo("block-literal-ref", PATH, TS_NESTED, "PUT 2*:\n+A\n+B");
		expectSuccess(literal.result);
		expectSuccess(block.result);
		expect(literal.text).toBe("function x() {\nA\n  }\n}\n");
		expect(literal.text).not.toBe(block.text);
		expect(literal.result.outcome.text).not.toContain("→ resolved");
	});

	it("treats a `PUT N*:` hunk with no body row as a delete-only block edit", async () => {
		const { result, text } = await applyTo("block-empty-body", PATH, TS_BLOCK, "PUT 2*:");
		expectSuccess(result);
		expect(text).toBe("function x() {\n}\n");
		expectWarnings(result, PATH, {
			includes: [
				"Interpreted an empty `PUT` body as deletion. Use `CUT N.=M` or `CUT N*` for bodyless deletes.",
			],
		});
	});
});

/* -------------------------------------------------------------------------- */
/* resolveBlockEdits                                                           */
/* -------------------------------------------------------------------------- */

describe("resolveBlockEdits", () => {
	it("expands a block edit exactly like the equivalent `SWAP start.=end:`", async () => {
		// Two sessions over identical fixture text: the `1*` locator and the
		// explicit `1.=2:` range must produce the same bytes, and both must equal
		// the expected replacement of the two-line construct.
		const expected = "function g() {\n}\nconst tail = 1;\n";
		const blockRun = await applyTo("block-equiv", PATH, TWO_LINE, "PUT 1*:\n+function g() {\n+}");
		const rangeRun = await applyTo("block-equiv-ref", PATH, TWO_LINE, "PUT 1.=2:\n+function g() {\n+}");
		expectSuccess(blockRun.result);
		expectSuccess(rangeRun.result);
		expect(spanAt(TWO_LINE, PATH, 1)).toEqual({ startLine: 1, endLine: 2 });
		expect(blockRun.text).toBe(expected);
		expect(blockRun.text).toBe(rangeRun.text);
		expect(blockRun.result.outcome.text).toContain("PUT 1*: → resolved lines 1-2 (2 lines)");
	});

	it("returns the input untouched when there are no block edits (fast path)", async () => {
		// Re-expressed: reference identity is a TS-internal detail. A payload with
		// no `*` locator lands byte-exact, resolves nothing, and raises no
		// advisory at all.
		const source = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
		const { result, text } = await applyTo("block-fast-path", PATH, source, "PUT 2-2:\n+const b = 22;");
		expectSuccess(result);
		expect(text).toBe("const a = 1;\nconst b = 22;\nconst c = 3;\n");
		expect(result.outcome.text).not.toContain("→ resolved");
		expectWarnings(result, PATH, { exact: [] });
	});

	it("throws (default) when no resolver is wired", async () => {
		// Re-expressed: native has no resolver injection seam, and its ported
		// "no block resolver configured" constant is unreachable. The equivalent
		// state is a path with no syntax support: the locator is rejected with the
		// explicit-range fallback, byte-for-byte.
		const { result, text } = await applyTo("block-no-resolver", UNKNOWN_PATH, UNKNOWN_TEXT, "PUT 2*:\n+X");
		expectError(result, "could not resolve a syntactic block beginning on line 2");
		expect(result.outcome.text).toBe(
			"line 1: `PUT 2*:` could not resolve a syntactic block beginning on line 2 (unsupported language, blank/closer line, or parse error). Use `PUT 2.=M:` with explicit lines.\n\n 1:one\n*2:two\n 3:three",
		);
		expect(text).toBe(UNKNOWN_TEXT);
		expect(result.requests).toHaveLength(0);
	});

	it("drops an unresolvable block edit in `drop` mode", async () => {
		// Re-expressed: the lenient (streaming) preview pass is the drop surface.
		// Its diff for a mixed payload must equal the diff of the same payload
		// with the unresolvable block edit removed outright — the block is
		// dropped, every other edit survives, and the strict apply still rejects.
		const source = "one\ntwo\nthree\nfour\n";
		const mixed = await runWithPreviews(
			"block-drop-mode",
			UNKNOWN_PATH,
			source,
			"PUT 2*:\n+X\nPUT 4-4:\n+Z",
		);
		const survivor = await runWithPreviews("block-drop-mode-ref", UNKNOWN_PATH, source, "PUT 4-4:\n+Z");
		const mixedStreaming = mixed.previews.filter(batch => batch.streaming);
		const survivorStreaming = survivor.previews.filter(batch => batch.streaming);

		expect(mixedStreaming).toHaveLength(1);
		expect(mixedStreaming[0]?.files).toHaveLength(1);
		expect(mixedStreaming[0]?.files[0]?.diff).toBe("-4|four\n+4|Z");
		expect(mixedStreaming[0]?.files[0]?.diff).toBe(survivorStreaming[0]?.files[0]?.diff);
		expectError(mixed, "could not resolve a syntactic block beginning on line 2");
		expect(mixed.requests).toHaveLength(0);
		expect(mixed.text).toBe(source);
	});

	it("throws a block-unresolved error in `throw` mode when the resolver returns null", async () => {
		// Re-expressed: the anchor simply has no resolvable block (line 7 is past
		// the end of a five-line file).
		const { result, text } = await applyTo("block-unresolved", PATH, TS_BLOCK, "PUT 7*:\n+X");
		expectError(result, "could not resolve a syntactic block beginning on line 7");
		expect(text).toBe(TS_BLOCK);
		expect(result.requests).toHaveLength(0);
	});

	it("includes a nearby-context preview in the block-unresolved error", async () => {
		const source = "alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot";
		const { result } = await applyTo("block-context", UNKNOWN_PATH, source, "PUT 3*:\n+X");
		expectError(result, "could not resolve a syntactic block beginning on line 3");
		// ±2 lines of context around the anchor, anchor `*`-marked.
		expect(result.outcome.text).toContain(" 1:alpha");
		expect(result.outcome.text).toContain("*3:charlie");
		expect(result.outcome.text).toContain(" 5:echo");
		expect(result.outcome.text).not.toContain("foxtrot");
	});

	it("suggests the next multi-line opener for a blank anchor without applying it", async () => {
		const source = "alpha\n\nfunction x() {\n  return 1;\n}";
		const { result, text } = await applyTo("block-blank-anchor", PATH, source, "PUT 2*:\n+function y() {}");
		expectError(
			result,
			"Line 2 is blank; no syntactic block can begin there. The next multi-line block begins at line 3 and ends at line 5. Retry `PUT 3*:`.",
		);
		expect(text).toBe(source);
		expect(result.requests).toHaveLength(0);
	});

	it("suggests both the exact statement range and nearest enclosing block", async () => {
		const source = "function x() {\n  run();\n}";
		const { result } = await applyTo("block-statement", PATH, source, "PUT 2*:\n+  stop();");
		expectError(
			result,
			"For only this statement use `PUT 2:`. The nearest enclosing multi-line block begins at line 1 and ends at line 3; use `PUT 1*:` to target it.",
		);
	});

	it("omits the context preview when the anchor line is out of range", async () => {
		const { result } = await applyTo("block-out-of-range", PATH, "only\ntwo", "PUT 9*:\n+X");
		expectError(result, "could not resolve a syntactic block beginning on line 9");
		expect(result.outcome.text).not.toContain("\n\n");
	});

	it("fires onResolved with the resolved span for replace and cut blocks", async () => {
		// Re-expressed: no callback exists, so the span each op resolved to is
		// read off the model-facing echo and cross-checked against `blockRangeAt`.
		const replaceRun = await applyTo("block-resolution-replace", PATH, TS_BLOCK, "PUT 2*:\n+A\n+B");
		expectSuccess(replaceRun.result);
		expect(spanAt(TS_BLOCK, PATH, 2)).toEqual({ startLine: 2, endLine: 3 });
		expect(replaceRun.result.outcome.text).toContain("PUT 2*: → resolved lines 2-3 (2 lines)");

		const cutSource = "function a() {\n}\nfunction b() {\n}\nfunction c() {\n}\n";
		const cutRun = await applyTo("block-resolution-cut", PATH, cutSource, "CUT 5*");
		expectSuccess(cutRun.result);
		expect(spanAt(cutSource, PATH, 5)).toEqual({ startLine: 5, endLine: 6 });
		expect(cutRun.result.outcome.text).toContain("CUT 5* → resolved lines 5-6 (2 lines)");
	});

	it("does not fire onResolved for a dropped unresolvable block", async () => {
		// Re-expressed: the lenient pass delivers nothing for a dropped block (no
		// resolution to surface), and the strict rejection carries no span echo.
		const run = await runWithPreviews("block-no-resolution", UNKNOWN_PATH, UNKNOWN_TEXT, "PUT 2*:\n+X");
		expect(run.previews.filter(batch => batch.streaming)).toHaveLength(0);
		expectError(run, "could not resolve a syntactic block beginning on line 2");
		expect(run.outcome.text).not.toContain("→ resolved");
		expect(run.requests).toHaveLength(0);
	});

	it("rejects a `PUT N*:` that resolves to a single line", async () => {
		const { result, text } = await applyTo("block-single-line", PATH, "a\nb\nc", "PUT 2*:\n+X");
		expectError(result, "For only this statement use `PUT 2:`.");
		expect(text).toBe("a\nb\nc");
		expect(result.requests).toHaveLength(0);
	});

	it("rejects an `PUT >N*:` that resolves to a single line", async () => {
		const { result, text } = await applyTo("block-single-line-insert", PATH, "a\nb\nc", "PUT >2*:\n+X");
		expectError(
			result,
			"`PUT >2*:` resolved a single-line block — line 2 is a bare statement, not the opening line of a multi-line construct. For only this statement use `PUT >2:`.",
		);
		expect(text).toBe("a\nb\nc");
		expect(result.requests).toHaveLength(0);
	});

	it("drops a single-line block resolution on the lenient preview path", async () => {
		// The lenient pass silently drops the single-line block (nothing to
		// preview), while the final pass and the apply report the strict
		// diagnostic — the native split between `applyPartialTo` and `applyTo`.
		const run = await runWithPreviews("block-lenient-single-line", PATH, "a\nb\nc", "PUT 2*:\n+X");
		expect(run.previews.filter(batch => batch.streaming)).toHaveLength(0);
		expect(run.previews.find(batch => !batch.streaming)?.files[0]?.error).toBe(
			"line 1: `PUT 2*:` resolved a single-line block — line 2 is a bare statement, not the opening line of a multi-line construct. For only this statement use `PUT 2:`.",
		);
		expectError(run, "resolved a single-line block");
		expect(run.requests).toHaveLength(0);
		expect(run.text).toBe("a\nb\nc");
	});
});

/* -------------------------------------------------------------------------- */
/* PatchSection.applyTo / applyPartialTo with block edits                      */
/* -------------------------------------------------------------------------- */

describe("PatchSection.applyTo / applyPartialTo with block edits", () => {
	const text = "function x() {\n  if (y) {\n  }\n}\n";

	it("applyTo resolves a block edit and matches the equivalent `replace`", async () => {
		const expected = "function x() {\n  if (y || z) {\n  }\n}\n";
		const blockRun = await applyTo("section-block", PATH, text, "PUT 2*:\n+  if (y || z) {\n+  }");
		const rangeRun = await applyTo("section-block-ref", PATH, text, "PUT 2-3:\n+  if (y || z) {\n+  }");
		expectSuccess(blockRun.result);
		expectSuccess(rangeRun.result);
		expect(blockRun.text).toBe(expected);
		expect(blockRun.text).toBe(rangeRun.text);
		expect(blockRun.result.outcome.text).toContain("PUT 2*: → resolved lines 2-3 (2 lines)");
		expect(rangeRun.result.outcome.text).not.toContain("→ resolved");
	});

	it("applyTo throws when a block edit has no resolver", async () => {
		// Re-expressed: a block edit whose anchor has no syntax to resolve
		// against is rejected and never silently applied.
		const { result, text: persisted } = await applyTo("section-no-resolver", PATH, TS_BLOCK, "PUT 9*:\n+X");
		expectError(result, "could not resolve a syntactic block beginning on line 9");
		expect(result.outcome.text).toContain("Use `PUT 9.=M:` with explicit lines.");
		expect(persisted).toBe(TS_BLOCK);
		expect(result.requests).toHaveLength(0);
	});

	it("applyPartialTo drops an unresolvable block edit instead of throwing", async () => {
		// The lenient pass stays silent (the only edit is dropped), and only the
		// final pass surfaces the diagnostic — no exception, no write.
		const run = await runWithPreviews("section-partial", PATH, TS_BLOCK, "PUT 9*:\n+X");
		expect(run.previews.filter(batch => batch.streaming)).toHaveLength(0);
		expect(run.previews.find(batch => !batch.streaming)?.files[0]?.error).toBe(
			"line 1: `PUT 9*:` could not resolve a syntactic block beginning on line 9 (unsupported language, blank/closer line, or parse error). Use `PUT 9.=M:` with explicit lines.",
		);
		expectError(run, "could not resolve a syntactic block beginning on line 9");
		expect(run.requests).toHaveLength(0);
		expect(run.text).toBe(TS_BLOCK);
	});
});

/* -------------------------------------------------------------------------- */
/* Patcher with a block resolver                                               */
/* -------------------------------------------------------------------------- */

describe("Patcher with a block resolver", () => {
	const text = "function x() {\n  if (y) {\n  }\n}\n";

	it("applies a block edit on the hash-match path", async () => {
		const { result, text: persisted } = await applyTo(
			"patcher-block",
			PATH,
			text,
			"PUT 2*:\n+  if (y || z) {\n+  }",
		);
		expectSuccess(result);
		expect(fileOutcome(result, PATH)?.op).toBe("update");
		expect(persisted).toBe("function x() {\n  if (y || z) {\n  }\n}\n");
	});

	it("surfaces the resolved span on the section result (hash-match path)", async () => {
		// Re-expressed: there is no `sections[0].blockResolutions` field; the span
		// is reported in the result text, cross-checked with `blockRangeAt`.
		const { result } = await applyTo("patcher-block-span", PATH, text, "PUT 2*:\n+  if (y || z) {\n+  }");
		expectSuccess(result);
		expect(spanAt(text, PATH, 2)).toEqual({ startLine: 2, endLine: 3 });
		expect(result.outcome.text).toContain("PUT 2*: → resolved lines 2-3 (2 lines)");
	});

	it("enriches reversed absolute ranges with the resolved block endpoint without writing", async () => {
		const source = bigBlockSource();
		const { result, text: persisted } = await applyTo(
			"patcher-reversed-range",
			PATH,
			source,
			"PUT 195-61:\n+replacement",
		);
		expectError(result, "Invalid absolute range: start 195, end 61.");
		expect(spanAt(source, PATH, 195)).toEqual({ startLine: 195, endLine: 255 });
		expect(result.outcome.text).toContain(
			"The syntactic block beginning at 195 ends at 255, so `PUT 195*:` is also valid.",
		);
		expect(persisted).toBe(source);
		expect(result.requests).toHaveLength(0);
	});

	it("resolves against the tagged snapshot and recovers onto drifted content", async () => {
		const snapshotText = "// head\nconst obj = {\n  a: 1,\n};\nconst tail = 1;\n";
		// The live file gained a trailing line after the read minted the tag.
		const liveText = `${snapshotText}const extra = 2;\n`;
		await withWorkspace("patcher-drift", async ws => {
			ws.write(PATH, liveText);
			const tag = ws.snapshot(PATH, snapshotText);
			const result = await applyPatch(ws, `[${PATH}#${tag}]\nPUT 2*:\n+const obj2 = {\n+  b: 2,\n+};`);
			expectSuccess(result);
			expect(fileOutcome(result, PATH)?.op).toBe("update");
			// `2*` resolved against the SNAPSHOT (lines 2-4), and recovery carried
			// that replacement onto the drifted live file.
			expect(spanAt(snapshotText, PATH, 2)).toEqual({ startLine: 2, endLine: 4 });
			expect(ws.read(PATH)).toBe("// head\nconst obj2 = {\n  b: 2,\n};\nconst tail = 1;\nconst extra = 2;\n");
			expectWarnings(result, PATH, {
				includes: [
					"Recovered from a stale file hash using a previous read snapshot (file changed externally between read and edit).",
				],
			});
			// The old case asserted `blockResolutions === undefined` after recovery
			// (shifted line numbers would mislead). Positive form: no span echo.
			expect(result.outcome.text).not.toContain("→ resolved");
		});
	});

	it("rejects a block edit whose tag was never recorded for this path", async () => {
		await withWorkspace("patcher-bogus-tag", async ws => {
			ws.write(PATH, text);
			const live = computeFileHash(text);
			const bogus = live === "FFFF" ? "0000" : "FFFF";
			const result = await applyPatch(ws, `[${PATH}#${bogus}]\nPUT 2*:\n+NEW`);
			expectError(result, `hash #${bogus} is not from this session.`);
			expect(result.outcome.text).toContain(`The current file hashes to #${live}.`);
			expect(ws.read(PATH)).toBe(text);
			expect(result.requests).toHaveLength(0);
		});
	});

	it("throws a block-unresolved error when the resolver returns null", async () => {
		const { result, text: persisted } = await applyTo("patcher-unresolved", PATH, text, "PUT 7*:\n+X");
		expectError(result, "could not resolve a syntactic block");
		expect(persisted).toBe(text);
		expect(result.requests).toHaveLength(0);
	});
});

/* -------------------------------------------------------------------------- */
/* CUT N*                                                                      */
/* -------------------------------------------------------------------------- */

describe("CUT N*", () => {
	const text = "function x() {\n  if (y) {\n  }\n}\n";

	it("parses `CUT N* N` into a cut block edit", async () => {
		// Re-expressed: no parsed `Edit`. The observable cut block is the
		// resolved span echoed with the `CUT N*` op and its whole span removed.
		const { result, text: persisted } = await applyTo("cut-parse", PATH, text, "CUT 2*");
		expectSuccess(result);
		expect(spanAt(text, PATH, 2)).toEqual({ startLine: 2, endLine: 3 });
		expect(result.outcome.text).toContain("CUT 2* → resolved lines 2-3 (2 lines)");
		expect(persisted).toBe("function x() {\n}\n");
	});

	it("rejects body rows under `CUT N* N`", async () => {
		const { result, text: persisted } = await applyTo("cut-body-rows", PATH, text, "CUT 2*\n+X");
		expect(result.outcome.text).toBe(
			"line 2: `CUT` deletes (and captures) the named lines and takes no body rows. To write new content, use `PUT N.=M:` with `+TEXT` rows.",
		);
		expect(persisted).toBe(text);
		expect(result.requests).toHaveLength(0);
	});

	it("resolveBlockEdits expands a cut block into capture and deletes", async () => {
		// Re-expressed: the capture is observable because the trailing `PUT >4`
		// register paste can only restore lines that `CUT 1*` captured.
		const source = "function a() {\n}\nfunction b() {\n}\n";
		const { result, text: persisted } = await applyTo("cut-expand", PATH, source, "CUT 1*\nPUT >4");
		expectSuccess(result);
		expect(result.outcome.text).toContain("CUT 1* → resolved lines 1-2 (2 lines)");
		expect(persisted).toBe("function b() {\n}\nfunction a() {\n}\n");
	});

	it("applyTo deletes the resolved block span", async () => {
		const { result, text: persisted } = await applyTo("cut-delete", PATH, text, "CUT 2*");
		expectSuccess(result);
		expect(persisted).toBe("function x() {\n}\n");
		expect(fileOutcome(result, PATH)?.op).toBe("update");
		expect(fileOutcome(result, PATH)?.firstChangedLine).toBe(2);
		expect(fileOutcome(result, PATH)?.diff).toContain("-2|  if (y) {");
		expect(fileOutcome(result, PATH)?.diff).toContain("-3|  }");
	});

	it("applyPartialTo drops an unresolvable cut-block edit", async () => {
		const run = await runWithPreviews("cut-partial", PATH, text, "CUT 7*");
		expect(run.previews.filter(batch => batch.streaming)).toHaveLength(0);
		expectError(run, "`CUT 7*` could not resolve a syntactic block beginning on line 7");
		expect(run.outcome.text).toContain("Use `CUT 7.=M` with explicit lines.");
		expect(run.requests).toHaveLength(0);
		expect(run.text).toBe(text);
	});

	it("Patcher applies a cut-block edit on the hash-match path", async () => {
		const { result, text: persisted } = await applyTo("cut-patcher", PATH, text, "CUT 2*");
		expectSuccess(result);
		expect(fileOutcome(result, PATH)?.op).toBe("update");
		expect(persisted).toBe("function x() {\n}\n");
	});
});

/* -------------------------------------------------------------------------- */
/* PUT >N*:                                                                    */
/* -------------------------------------------------------------------------- */

describe("PUT >N*:", () => {
	const text = "function x() {\n  if (y) {\n  }\n}\n";

	it("parses `PUT >N*: N:` into a deferred block edit with insert mode", async () => {
		// Re-expressed: insert mode is observable as the body landing after the
		// resolved block's LAST line (4), not after the anchor (2).
		const { result, text: persisted } = await applyTo(
			"insert-parse",
			PATH,
			TS_NESTED,
			"PUT >2*:\n+  extra();",
		);
		expectSuccess(result);
		expect(spanAt(TS_NESTED, PATH, 2)).toEqual({ startLine: 2, endLine: 4 });
		expect(result.outcome.text).toContain(
			"PUT >2*: → resolved lines 2-4 (3 lines); body lands after line 4",
		);
		expect(persisted).toBe("function x() {\n  if (y) {\n    run();\n  }\n  extra();\n}\n");
	});

	it("still parses a literal `PUT > N:` anchor (distinct from `PUT >N*:`)", async () => {
		const literal = await applyTo("insert-literal", PATH, text, "PUT >2:\n+  A");
		const block = await applyTo("insert-literal-ref", PATH, text, "PUT >2*:\n+  A");
		expectSuccess(literal.result);
		expectSuccess(block.result);
		// The literal anchor lands right after line 2 (inside the construct); the
		// `2*` locator lands after the construct's last line (3).
		expect(literal.text).toBe("function x() {\n  if (y) {\n  A\n  }\n}\n");
		expect(block.text).toBe("function x() {\n  if (y) {\n  }\n  A\n}\n");
		expect(literal.result.outcome.text).not.toContain("→ resolved");
	});

	it("rejects an `PUT >N*: N:` hunk with no body row", async () => {
		const { result, text: persisted } = await applyTo("insert-empty-body", PATH, text, "PUT >2*:");
		expect(result.outcome.text).toBe(
			"line 1: `PUT <N:` / `PUT >N:` promises body rows and got none. Write `+TEXT` rows, or drop the `:` to paste a register (`PUT >N` = anonymous, `PUT >N @name` = named).",
		);
		expect(persisted).toBe(text);
		expect(result.requests).toHaveLength(0);
	});

	it("resolveBlockEdits expands to the equivalent `insert after end:` lowering", async () => {
		const expected = "function x() {\n  if (y) {\n  }\n  done();\n}\n";
		const blockRun = await applyTo("insert-equiv", PATH, text, "PUT >2*:\n+  done();");
		const plainRun = await applyTo("insert-equiv-ref", PATH, text, "PUT >3:\n+  done();");
		expectSuccess(blockRun.result);
		expectSuccess(plainRun.result);
		expect(blockRun.text).toBe(expected);
		expect(blockRun.text).toBe(plainRun.text);
		expect(blockRun.result.outcome.text).toContain("body lands after line 3");
		expect(plainRun.result.outcome.text).not.toContain("→ resolved");
	});

	it("fires onResolved with op insert_after", async () => {
		// Re-expressed: the `insert_after` op and its landing line are carried by
		// the resolution echo, cross-checked with `blockRangeAt`.
		const { result } = await applyTo("insert-resolution", PATH, TS_NESTED, "PUT >2*:\n+  extra();");
		expectSuccess(result);
		expect(spanAt(TS_NESTED, PATH, 2)).toEqual({ startLine: 2, endLine: 4 });
		expect(result.outcome.text).toContain(
			"PUT >2*: → resolved lines 2-4 (3 lines); body lands after line 4",
		);
	});

	it("lowers an unresolvable anchor to plain `PUT > N:` with a warning", async () => {
		const source = "function x() {\n\n  done();\n}\n";
		const lowerRun = await applyTo("insert-lower", PATH, source, "PUT >2*:\n+X");
		const plainRun = await applyTo("insert-lower-ref", PATH, source, "PUT >2:\n+X");
		expectSuccess(lowerRun.result);
		expectSuccess(plainRun.result);
		expect(lowerRun.text).toBe(plainRun.text);
		expect(lowerRun.text).toBe("function x() {\n\nX\n  done();\n}\n");
		expectWarnings(lowerRun.result, PATH, {
			includes: [
				"`PUT >2*:` could not resolve a syntactic block on line 2, so it was applied as plain `PUT >2:`. Verify the landing line; anchor on a line that OPENS a construct.",
			],
		});
	});

	it("lowers `PUT >N*:` even when no resolver is wired", async () => {
		// Re-expressed: a path the parser cannot read at all is the native "no
		// resolver" state — `PUT >N*:` still lowers instead of rejecting.
		const { result, text: persisted } = await applyTo(
			"insert-no-resolver",
			UNKNOWN_PATH,
			UNKNOWN_TEXT,
			"PUT >2*:\n+X",
		);
		expectSuccess(result);
		expect(persisted).toBe("one\ntwo\nX\nthree");
		expectWarnings(result, UNKNOWN_PATH, {
			includes: [
				"`PUT >2*:` could not resolve a syntactic block on line 2, so it was applied as plain `PUT >2:`. Verify the landing line; anchor on a line that OPENS a construct.",
			],
		});
	});

	it("lowers a closing-delimiter anchor to plain `PUT > N:` with a warning", async () => {
		const { result, text: persisted } = await applyTo("insert-closer", PATH, text, "PUT >3*:\n+  done();");
		expectSuccess(result);
		// line 3 is `  }` — no block begins there, but it ends one; the body
		// lands after it, exactly where `insert_after_block` would have put it.
		expect(persisted).toBe("function x() {\n  if (y) {\n  }\n  done();\n}\n");
		expectWarnings(result, PATH, {
			includes: [
				"`PUT >3*:` anchors on a closing delimiter, so it was applied as plain `PUT >3:`. Anchor on the line that OPENS the construct.",
			],
		});
	});

	it("Patcher surfaces the closer-anchor lowering warning", async () => {
		const { result, text: persisted } = await applyTo("insert-closer-patcher", PATH, text, "PUT >3*:\n+  done();");
		expectSuccess(result);
		expect(fileOutcome(result, PATH)?.op).toBe("update");
		expect(persisted).toBe("function x() {\n  if (y) {\n  }\n  done();\n}\n");
		expectWarnings(result, PATH, {
			includes: [
				"`PUT >3*:` anchors on a closing delimiter, so it was applied as plain `PUT >3:`. Anchor on the line that OPENS the construct.",
			],
		});
	});

	it("applyTo inserts the body after the resolved block's last line", async () => {
		const { result, text: persisted } = await applyTo("insert-apply", PATH, text, "PUT >2*:\n+  done();");
		expectSuccess(result);
		// stub-equivalent span [2,3] → body lands after "  }" (line 3), before "}".
		expect(persisted).toBe("function x() {\n  if (y) {\n  }\n  done();\n}\n");
		expect(fileOutcome(result, PATH)?.firstChangedLine).toBe(3);
	});

	it("Patcher applies an insert-after-block edit and surfaces the resolution", async () => {
		const { result, text: persisted } = await applyTo("insert-patcher", PATH, text, "PUT >2*:\n+  done();");
		expectSuccess(result);
		expect(fileOutcome(result, PATH)?.op).toBe("update");
		expect(persisted).toBe("function x() {\n  if (y) {\n  }\n  done();\n}\n");
		expect(result.outcome.text).toContain(
			"PUT >2*: → resolved lines 2-3 (2 lines); body lands after line 3",
		);
	});

	it("lowers an unresolvable blank-line anchor to plain `PUT > N:` instead of failing", async () => {
		const source = "### Changed\n\n- old entry\n";
		const { result, text: persisted } = await applyTo(
			"insert-blank-anchor",
			"notes.md",
			source,
			"PUT >2*:\n+- new entry",
		);
		expectSuccess(result);
		expect(persisted).toBe("### Changed\n\n- new entry\n- old entry\n");
		expectWarnings(result, "notes.md", {
			includes: [
				"`PUT >2*:` could not resolve a syntactic block on line 2, so it was applied as plain `PUT >2:`. Verify the landing line; anchor on a line that OPENS a construct.",
			],
		});
	});
});
