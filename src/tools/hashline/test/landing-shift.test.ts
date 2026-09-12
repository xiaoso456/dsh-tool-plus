import { describe, expect, it } from "vitest";

import { applyPatch, expectSuccess, expectWarnings, fileOutcome, withWorkspace } from "./harness.ts";
import type { ApplyResult } from "./harness.ts";
import { blockRangeAt } from "../native/index.ts";

/**
 * After-insert landing correction: an `insert after N:` body indented
 * shallower than line N slides past the structural closer lines below the
 * anchor until depth returns to the body's level. Contract under test: the
 * shift fires only on a comparable, strictly-shallower depth claim, crosses
 * closers only, respects other hunks' targets, and always reports a warning.
 *
 * Native migration: the old suite applied edits in memory
 * (`parsePatch` + `applyEdits(text, edits)`) and injected a stub
 * `BlockResolver` for the six `N*` cases. The native engine has no in-memory
 * entry point — it reads and writes real bytes and resolves `N*` against real
 * syntax — so every case is a session run over a real file, and the six former
 * stub cases use real source text whose tree-sitter span equals the stub's
 * span, asserted independently through `blockRangeAt`.
 */

const REL = "x.ts";

const FILE = [
	"function f() {", // 1
	"    if (x) {", // 2
	"        a();", // 3
	"    }", // 4
	"    b();", // 5
	"}", // 6
	"",
].join("\n");

const NESTED = [
	"function f() {", // 1
	"    if (x) {", // 2
	"        for (y) {", // 3
	"            a();", // 4
	"        }", // 5
	"    }", // 6
	"    b();", // 7
	"}", // 8
	"",
].join("\n");

const BLOCK_FILE = [
	"function f() {", // 1
	"    afterEach(() => {", // 2
	"        destroy();", // 3
	"    });", // 4
	"}", // 5
	"",
].join("\n");

/* -------------------------------------------------------------------------- */
/* Engine messages (verbatim from the native messages module)                  */
/* -------------------------------------------------------------------------- */

const W_SHIFT_ONE_AFTER_4 =
	"PUT >3: body indented shallower than the anchor, so the landing moved past 1 closing line to after line 4. For the deeper position inside the block, re-issue with the body indented to match.";
const W_SHIFT_TWO_AFTER_6 =
	"PUT >4: body indented shallower than the anchor, so the landing moved past 2 closing lines to after line 6. For the deeper position inside the block, re-issue with the body indented to match.";
const W_SHIFT_ONE_AFTER_5 =
	"PUT >4: body indented shallower than the anchor, so the landing moved past 1 closing line to after line 5. For the deeper position inside the block, re-issue with the body indented to match.";
const W_SHIFT_PAST_GAP =
	"PUT >3: body indented shallower than the anchor, so the landing moved past 1 closing line to after line 5. For the deeper position inside the block, re-issue with the body indented to match.";
const W_INWARD_AFTER_3 =
	"PUT >2*: body indented deeper than closing line 4, so it was placed inside the block, after line 3. `PUT >N*` lands AFTER the block at sibling depth — if inside was intended, use plain `PUT >4:`.";
const W_INWARD_AFTER_2 =
	"PUT >2*: body indented deeper than closing line 3, so it was placed inside the block, after line 2. `PUT >N*` lands AFTER the block at sibling depth — if inside was intended, use plain `PUT >3:`.";
const W_INWARD_AFTER_4 =
	"PUT >1*: body indented deeper than closing line 5, so it was placed inside the block, after line 4. `PUT >N*` lands AFTER the block at sibling depth — if inside was intended, use plain `PUT >5:`.";
/**
 * Advisory, not a landing-shift warning: both "pure closers" and the
 * other-hunk case below really do leave the file unparseable, and the native
 * applier machine-confirms that instead of staying silent the way the old
 * engine did. Asserting the whole warning set keeps the original "no
 * landing-shift warning" intent exact.
 */
const W_PARSE_REGRESSION_3 =
	"This edit introduced a syntax error near line 3: the file parsed before the patch and no longer does. It was applied exactly as written, so a line number or range endpoint is likely wrong — re-read the touched region and re-issue a correcting edit.";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** The real span an `N*` locator resolves to — native's replacement for the stub resolver. */
function spanOf(rel: string, file: string, line: number): { startLine: number; endLine: number } | null {
	return blockRangeAt({ code: file, path: rel, line });
}

/**
 * Run one payload as a session: write the file, snapshot it, author
 * `[rel#tag]` + payload, apply, then hand the settled result to `check`.
 */
async function runCase(
	label: string,
	rel: string,
	file: string,
	payload: string,
	check: (result: ApplyResult) => void,
): Promise<void> {
	await withWorkspace(label, async ws => {
		ws.write(rel, file);
		const tag = ws.snapshot(rel, file);
		const result = await applyPatch(ws, `[${rel}#${tag}]\n${payload}`);
		expectSuccess(result);
		check(result);
	});
}

/** Text the engine reports for `rel` — the persisted bytes. */
function appliedText(result: ApplyResult, rel = REL): string | undefined {
	return fileOutcome(result, rel)?.newText;
}

/* -------------------------------------------------------------------------- */
/* Cases                                                                       */
/* -------------------------------------------------------------------------- */

describe("after-insert landing shift", () => {
	it("slides a shallower body past the closing line and warns", async () => {
		await runCase("landing-shift-slide", REL, FILE, "PUT >3:\n+    c();", result => {
			expect(appliedText(result)).toBe(
				["function f() {", "    if (x) {", "        a();", "    }", "    c();", "    b();", "}", ""].join("\n"),
			);
			expectWarnings(result, REL, { includes: [W_SHIFT_ONE_AFTER_4] });
		});
	});

	it("crosses multiple closer levels and stops when depth returns to the body's", async () => {
		// Body at depth 4 escapes both the `for` and the `if`.
		await runCase("landing-shift-escape-both", REL, NESTED, "PUT >4:\n+    c();", result => {
			expect(appliedText(result)).toBe(
				[
					"function f() {",
					"    if (x) {",
					"        for (y) {",
					"            a();",
					"        }",
					"    }",
					"    c();",
					"    b();",
					"}",
					"",
				].join("\n"),
			);
			expectWarnings(result, REL, { includes: [W_SHIFT_TWO_AFTER_6] });
		});

		// Body at depth 8 escapes only the `for`, staying inside the `if`.
		await runCase("landing-shift-escape-one", REL, NESTED, "PUT >4:\n+        c();", result => {
			expect(appliedText(result)).toBe(
				[
					"function f() {",
					"    if (x) {",
					"        for (y) {",
					"            a();",
					"        }",
					"        c();",
					"    }",
					"    b();",
					"}",
					"",
				].join("\n"),
			);
			expectWarnings(result, REL, { includes: [W_SHIFT_ONE_AFTER_5] });
		});
	});

	it("does not shift when the body matches the anchor's depth", async () => {
		await runCase("landing-shift-same-depth", REL, FILE, "PUT >3:\n+        c();", result => {
			expect(appliedText(result)).toBe(
				[
					"function f() {",
					"    if (x) {",
					"        a();",
					"        c();",
					"    }",
					"    b();",
					"}",
					"",
				].join("\n"),
			);
			expectWarnings(result, REL, { exact: [] });
		});
	});

	it("never crosses content lines (indentation-only languages stay put)", async () => {
		// Real Python so the syntax probe reads the indentation language itself.
		const py = ["def f():", "    if x:", "        a()", "    b()", ""].join("\n");
		await runCase("landing-shift-python", "x.py", py, "PUT >3:\n+    c()", result => {
			expect(appliedText(result, "x.py")).toBe(["def f():", "    if x:", "        a()", "    c()", "    b()", ""].join("\n"));
			expectWarnings(result, "x.py", { exact: [] });
		});
	});

	it("treats a body of pure closers as depth-neutral", async () => {
		await runCase("landing-shift-pure-closers", REL, FILE, "PUT >3:\n+    }", result => {
			expect(appliedText(result)).toBe(
				[
					"function f() {",
					"    if (x) {",
					"        a();",
					"    }",
					"    }",
					"    b();",
					"}",
					"",
				].join("\n"),
			);
			expectWarnings(result, REL, { exact: [W_PARSE_REGRESSION_3] });
		});
	});

	it("skips incomparable indentation styles (tabs file, spaces body)", async () => {
		const tabs = ["function f() {", "\tif (x) {", "\t\ta();", "\t}", "\tb();", "}", ""].join("\n");
		await runCase("landing-shift-tabs", REL, tabs, "PUT >3:\n+    c();", result => {
			expect(appliedText(result)).toBe(
				["function f() {", "\tif (x) {", "\t\ta();", "    c();", "\t}", "\tb();", "}", ""].join("\n"),
			);
			expectWarnings(result, REL, { exact: [] });
		});
	});

	it("refuses to cross a line targeted by another hunk", async () => {
		await runCase("landing-shift-other-hunk", REL, FILE, "PUT >3:\n+    c();\nCUT 4", result => {
			// The closer on line 4 is owned by the cut; the insert stays put.
			expect(appliedText(result)).toBe(
				["function f() {", "    if (x) {", "        a();", "    c();", "    b();", "}", ""].join("\n"),
			);
			expectWarnings(result, REL, { exact: [W_PARSE_REGRESSION_3] });
		});
	});

	it("looks past blank lines between the anchor and the closer", async () => {
		const gapped = ["function f() {", "    if (x) {", "        a();", "", "    }", "    b();", "}", ""].join("\n");
		await runCase("landing-shift-gap", REL, gapped, "PUT >3:\n+    c();", result => {
			expect(appliedText(result)).toBe(
				["function f() {", "    if (x) {", "        a();", "", "    }", "    c();", "    b();", "}", ""].join("\n"),
			);
			expectWarnings(result, REL, { includes: [W_SHIFT_PAST_GAP] });
		});
	});

	it("leaves `PUT < N:` untouched", async () => {
		await runCase("landing-shift-before", REL, FILE, "PUT <4:\n+    c();", result => {
			expect(appliedText(result)).toBe(
				["function f() {", "    if (x) {", "        a();", "    c();", "    }", "    b();", "}", ""].join("\n"),
			);
			expectWarnings(result, REL, { exact: [] });
		});
	});

	it("composes with `PUT >N*: N:` to escape enclosing closers", async () => {
		// The former stub claimed the block beginning on line 2 spans [2, 3];
		// `mk({` / `});` is real syntax with that exact span.
		const text = ["function f() {", "    const t = mk({", "    });", "}", "x();", ""].join("\n");
		expect(spanOf(REL, text, 2)).toEqual({ startLine: 2, endLine: 3 });

		await runCase("landing-shift-compose", REL, text, "PUT >2*:\n+ref = t;", result => {
			// after_anchor lands on span.end (line 3); the depth-0 body then slides
			// past the function's closing `}` on line 4.
			expect(appliedText(result)).toBe(
				["function f() {", "    const t = mk({", "    });", "}", "ref = t;", "x();", ""].join("\n"),
			);
			expectWarnings(result, REL, { includes: [W_SHIFT_ONE_AFTER_4] });
		});
	});
});

/**
 * Inward landing correction for `insert_after_block N:` — a body indented
 * deeper than the block's closing line claims a depth INSIDE the block (the
 * "append at the end of the block's body" misreading), so the landing slides
 * back across the block's trailing closers. Contract under test: fires only
 * for block-lowered inserts with a strictly-deeper body, lands after the last
 * content line at the claimed depth, respects other hunks' targets, and
 * warns; sibling-depth bodies and plain `insert after M:` stay literal.
 *
 * Native migration: the six cases below replaced a stub `BlockResolver` with
 * real source text whose tree-sitter span equals the stub's span (asserted
 * through `blockRangeAt`), so the `N*` locator resolves to the same block the
 * stub declared.
 */
describe("insert-after-block inward landing shift", () => {
	it("pulls a deeper body inside the block, after its last content line", async () => {
		// Stub span [2, 4] — `afterEach(() => {` / `});` is that real span.
		expect(spanOf(REL, BLOCK_FILE, 2)).toEqual({ startLine: 2, endLine: 4 });

		await runCase("landing-shift-inward", REL, BLOCK_FILE, "PUT >2*:\n+        setup();", result => {
			expect(appliedText(result)).toBe(
				[
					"function f() {",
					"    afterEach(() => {",
					"        destroy();",
					"        setup();",
					"    });",
					"}",
					"",
				].join("\n"),
			);
			expectWarnings(result, REL, { includes: [W_INWARD_AFTER_3] });
		});
	});

	it("lands right after the opener of an empty block", async () => {
		const text = ["function f() {", "    afterEach(() => {", "    });", "}", ""].join("\n");
		// Stub span [2, 3].
		expect(spanOf(REL, text, 2)).toEqual({ startLine: 2, endLine: 3 });

		await runCase("landing-shift-empty-block", REL, text, "PUT >2*:\n+        setup();", result => {
			expect(appliedText(result)).toBe(
				["function f() {", "    afterEach(() => {", "        setup();", "    });", "}", ""].join("\n"),
			);
			expectWarnings(result, REL, { includes: [W_INWARD_AFTER_2] });
		});
	});

	it("crosses nested trailing closers and stops at the body's claimed depth", async () => {
		const text = ["foo(() => {", "    bar(() => {", "        x();", "    });", "});", ""].join("\n");
		// Stub span [1, 5] — the whole `foo(...)` expression statement.
		expect(spanOf(REL, text, 1)).toEqual({ startLine: 1, endLine: 5 });

		await runCase("landing-shift-nested-closers", REL, text, "PUT >1*:\n+    baz();", result => {
			// depth-4 body = sibling of `bar(...)` inside `foo`: crosses the outer
			// `});` only, stopping at the inner closer that sits at its depth.
			expect(appliedText(result)).toBe(
				["foo(() => {", "    bar(() => {", "        x();", "    });", "    baz();", "});", ""].join("\n"),
			);
			expectWarnings(result, REL, { includes: [W_INWARD_AFTER_4] });
		});
	});

	it("leaves a sibling-depth body after the block (the literal contract)", async () => {
		await runCase("landing-shift-sibling-depth", REL, BLOCK_FILE, "PUT >2*:\n+    cleanup();", result => {
			expect(appliedText(result)).toBe(
				[
					"function f() {",
					"    afterEach(() => {",
					"        destroy();",
					"    });",
					"    cleanup();",
					"}",
					"",
				].join("\n"),
			);
			expectWarnings(result, REL, { exact: [] });
		});
	});

	it("never shifts a plain `insert after M:` anchored on a closer", async () => {
		await runCase("landing-shift-plain-after-closer", REL, BLOCK_FILE, "PUT >4:\n+        leak();", result => {
			expect(appliedText(result)).toBe(
				[
					"function f() {",
					"    afterEach(() => {",
					"        destroy();",
					"    });",
					"        leak();",
					"}",
					"",
				].join("\n"),
			);
			expectWarnings(result, REL, { exact: [] });
		});
	});

	it("refuses to cross a closer targeted by another hunk", async () => {
		const text = ["foo(() => {", "    bar(() => {", "        x();", "    });", "});", ""].join("\n");
		// Stub span [1, 5], same as the nested-closers case above.
		expect(spanOf(REL, text, 1)).toEqual({ startLine: 1, endLine: 5 });

		await runCase(
			"landing-shift-block-other-hunk",
			REL,
			text,
			"PUT 4-4:\n+    }); // bar\nPUT >1*:\n+        y();",
			result => {
				expect(appliedText(result)).toBe(
					["foo(() => {", "    bar(() => {", "        x();", "    }); // bar", "});", "        y();", ""].join("\n"),
				);
				expectWarnings(result, REL, { exact: [] });
			},
		);
	});
});
