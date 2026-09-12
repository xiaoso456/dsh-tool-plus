/**
 * Boundary-balance repair — the `boundary-repair.test.ts` suite on the native
 * session harness.
 *
 * Migrated from the deleted TS engine (`git show HEAD:…/boundary-repair.test.ts`).
 * The old `apply`/`applyTsx`/`applyRust`/`applyProse` helpers named a fixture
 * path purely so the syntax probe could judge whether an authored range
 * boundary broke the file. A native session takes that same evidence from the
 * on-disk file, so every case here writes its source to `fixture.ts` /
 * `fixture.tsx` / `fixture.rs` / `fixture.md` (or `fixture.unknownlang` for the
 * "no structural evidence" sentinel), snapshots it to mint the tag the model
 * would have read, and applies the authored `[rel#tag]` section for real.
 *
 * Three mechanical differences from the old file, all deliberate:
 * - Assertions target `fileOutcome(result, rel)?.newText` (the applied bytes)
 *   instead of an `applyEdits` return value.
 * - A rejection is an outcome (`isError` + model-facing text), never a throw:
 *   the old `expect(...).toThrow(/…/)` cases use `expectError(result, /…/)`
 *   with the same regexes (native's wording already contained them verbatim).
 * - Warnings are asserted as the exact engine strings via `expectWarnings`
 *   (`exact` where the old test pinned the whole list, `includes` where it
 *   pinned one named repair). The upstream fixture oracle
 *   (`fixtures/parity_boundary_repair.json`) pins every string used here.
 */
import { describe, expect, it } from "vitest";

import {
	applyPatch,
	expectError,
	expectFile,
	expectSuccess,
	expectWarnings,
	fileOutcome,
	withWorkspace,
	warningsOf,
	Workspace,
} from "./harness.ts";
import type { ApplyResult } from "./harness.ts";

/* -------------------------------------------------------------------------- */
/* Verbatim native warnings (each one pinned by the upstream fixture oracle)   */
/* -------------------------------------------------------------------------- */

/** Uniform base-indent restore over unchanged structural rows. */
const W_AUTO_INDENT = "Auto-indented a replacement body to match unchanged structural rows in its source range.";

/**
 * `Auto-repaired replacement boundaries at line N: …` — the repair family the
 * syntax probe verifies before boundary rows may be dropped or retained.
 */
function boundaryRepair(line: number, detail: string): string {
	return `Auto-repaired replacement boundaries at line ${line}: ${detail} The result was verified by the syntax probe — re-issue with the range covering exactly the changed lines and the body as their complete final content.`;
}

/** A range row the payload needed was retained. */
const RETAINED = (line: number, rows = 1): string =>
	boundaryRepair(line, `retained ${rows} syntax-essential source boundary row(s) selected by the range.`);

/** Body rows duplicated just outside the range were dropped. */
const DROPPED_ROWS = (line: number, rows = 1): string =>
	boundaryRepair(line, `dropped ${rows} body row(s) duplicated just outside the range.`);

/**
 * `Auto-repaired a replacement boundary echo at line N: …` — the exact
 * line-equality spare (no syntax probe involved).
 */
const ECHO = (line: number, leading: number, trailing: number): string => {
	const dropped =
		leading > 0 && trailing > 0
			? `${leading} leading and ${trailing} trailing body line(s)`
			: leading > 0
				? `${leading} leading body line(s)`
				: `${trailing} trailing body line(s)`;
	return `Auto-repaired a replacement boundary echo at line ${line}: dropped ${dropped} already present outside the range. Issue the body as final content for the selected range only.`;
};

const ECHO_LEADING = (line: number): string => ECHO(line, 1, 0);
const ECHO_TRAILING = (line: number): string => ECHO(line, 0, 1);
const ECHO_BOTH = (line: number): string => ECHO(line, 1, 1);

/** Post-apply parse advisory — the parse probe is the only witness. */
const SYNTAX_ADVISORY = (line: number): string =>
	`This edit introduced a syntax error near line ${line}: the file parsed before the patch and no longer does. It was applied exactly as written, so a line number or range endpoint is likely wrong — re-read the touched region and re-issue a correcting edit.`;

/** Banner the session adds when it replays a stale-tag edit onto current bytes. */
const RECOVERED_FROM_STALE_HASH =
	"Recovered from a stale file hash using a previous read snapshot (file changed externally between read and edit).";

/** The old file's `boundaryRepairWarnings` filter, kept verbatim. */
function boundaryRepairWarnings(warnings: readonly string[]): string[] {
	return warnings.filter(warning => /Auto-repaired (?:a )?replacement boundar/.test(warning));
}

/* -------------------------------------------------------------------------- */
/* Driving one case                                                            */
/* -------------------------------------------------------------------------- */

/** Everything one migrated case may assert on. */
interface Applied {
	ws: Workspace;
	result: ApplyResult;
	rel: string;
	/** Applied bytes for `rel` — the primary assertion target. */
	newText: string | undefined;
}

/**
 * Write `source` to `rel`, snapshot it (minting the tag the model read), author
 * `[rel#tag]` over `diff`, and apply it through a real session.
 *
 * `rel` carries the whole language signal: the extension is what the native
 * probe keys off, exactly as the old helpers' `path` option did.
 */
async function withApply(
	label: string,
	rel: string,
	source: string,
	diff: string,
	assertions: (applied: Applied) => void,
): Promise<void> {
	await withWorkspace(label, async ws => {
		ws.write(rel, source);
		const tag = ws.snapshot(rel, source);
		const result = await applyPatch(ws, `${ws.header(rel, tag)}\n${diff}`);
		assertions({ ws, result, rel, newText: fileOutcome(result, rel)?.newText });
	});
}

describe("boundary-balance repair", () => {
	it("restores a uniformly omitted base indent from unchanged structural rows", async () => {
		const file = [
			"    if (value > 90) {",
			"      result = error;",
			"    } else if (value > 70) {",
			"      result = plain;",
			"    } else {",
			"      result = warning;",
			"    }",
		].join("\n");
		const diff = [
			"PUT 2.=6:",
			"+  result = error;",
			"+} else if (value > 70) {",
			"+  result = warning;",
			"+} else {",
			"+  result = plain;",
		].join("\n");
		await withApply("boundary-base-indent", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(
				[
					"    if (value > 90) {",
					"      result = error;",
					"    } else if (value > 70) {",
					"      result = warning;",
					"    } else {",
					"      result = plain;",
					"    }",
				].join("\n"),
			);
			expectWarnings(result, rel, { includes: [W_AUTO_INDENT] });
		});
	});

	it("preserves intentional indentation-only replacements", async () => {
		const file = ["    first();", "    second();"].join("\n");
		await withApply(
			"boundary-indent-only",
			"fixture.ts",
			file,
			"PUT 1.=2:\n+first();\n+second();",
			({ result, rel, newText }) => {
				expectSuccess(result);
				expect(newText).toBe("first();\nsecond();");
				expectWarnings(result, rel, { exact: [] });
			},
		);
	});

	it("retains a swallowed opening comment fence when syntax and indentation prove the boundary", async () => {
		const file = ["class C {", "\t/**", "\t * Old summary.", "\t */", "\tmethod() {}", "}"].join("\n");
		const diff = ["PUT 2-4:", "+\t * New summary.", "+\t */"].join("\n");

		await withApply("boundary-comment-fence", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["class C {", "\t/**", "\t * New summary.", "\t */", "\tmethod() {}", "}"].join("\n"));
			expectWarnings(result, rel, { exact: [RETAINED(2)] });
		});
	});

	// The canonical incident: a range-replace whose payload restates the
	// fragment + paren close that still live just below the range, doubling
	// `</>` and `);`. The range covers `const …` through the first `/>`.
	it("drops a duplicated multi-line closing block (the Root.tsx incident)", async () => {
		const file = [
			'import type React from "react";',
			'import { Composition } from "remotion";',
			'import { Sizzle, type SizzleProps } from "./compositions/Sizzle";',
			'import { FPS, totalDurationInFrames } from "./lib/scenes";',
			"",
			"export const RemotionRoot: React.FC = () => {",
			"\tconst durationInFrames = totalDurationInFrames();",
			"\treturn (",
			"\t\t<>",
			"\t\t\t<Composition",
			'\t\t\t\tid="Sizzle"',
			"\t\t\t\tcomponent={Sizzle}",
			"\t\t\t\tdurationInFrames={durationInFrames}",
			"\t\t\t\twidth={1920}",
			'\t\t\t\tdefaultProps={{ layout: "landscape" }}',
			"\t\t\t/>",
			"\t\t</>",
			"\t);",
			"};",
		].join("\n");
		// Range 7..16 = `const …` through the first `/>`; payload restates the
		// `</>` + `);` that survive at lines 17-18.
		const diff = [
			"PUT 7-16:",
			"+\treturn (",
			"+\t\t<>",
			"+\t\t\t<Composition",
			'+\t\t\t\tid="Sizzle"',
			"+\t\t\t\tcomponent={Sizzle}",
			"+\t\t\t\tdurationInFrames={durationInFrames}",
			"+\t\t\t\twidth={1920}",
			'+\t\t\t\tdefaultProps={{ layout: "landscape" } satisfies SizzleProps}',
			"+\t\t\t/>",
			"+\t\t</>",
			"+\t);",
		].join("\n");
		await withApply("boundary-root-tsx", "fixture.tsx", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			// Exactly one `</>` and one `);` survive — no doubling.
			expect(newText?.split("\n").filter(l => l.trim() === "</>")).toHaveLength(1);
			expect(newText?.split("\n").filter(l => l.trim() === ");")).toHaveLength(1);
			expect(newText?.endsWith("\t\t</>\n\t);\n};")).toBe(true);
			expectWarnings(result, rel, { includes: [DROPPED_ROWS(7, 2)] });
		});
	});

	// Single structural-closer duplication: the range ends one line short and
	// the payload restates the `});` that survives just below it.
	it("drops a single duplicated structural closer (`});`)", async () => {
		const file = ["it('a', () => {", "\tsetup();", "\trun();", "});", "after();"].join("\n");
		// The range replaces the two body lines but the payload also restates the
		// `});` at line 4, which survives — a duplicate close.
		const diff = ["PUT 2-3:", "+\tsetup2();", "+\trun2();", "+});"].join("\n");
		await withApply("boundary-dup-closer", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["it('a', () => {", "\tsetup2();", "\trun2();", "});", "after();"].join("\n"));
			expectWarnings(result, rel, { includes: [ECHO_TRAILING(2)] });
		});
	});

	// Single structural-opener duplication: the range starts one line late and
	// the payload restates the method-signature opener that survives just above
	// it (the tui.ts `#planRender(` incident).
	it("drops a single duplicated structural opener (`planRender(`)", async () => {
		const file = [
			"class Foo {",
			"\t/** doc */",
			"\tplanRender(",
			"\t\ta: string[],",
			"\t\tb: boolean,",
			"\t): Intent {",
			"\t\treturn x;",
			"\t}",
			"}",
		].join("\n");
		// The range covers the params + return-type line, but the payload also
		// restates the `planRender(` at line 3, which survives — a duplicate open.
		const diff = [
			"PUT 4-6:",
			"+\tplanRender(",
			"+\t\ta: string[],",
			"+\t\tb: boolean,",
			"+\t\tc: number,",
			"+\t): Intent {",
		].join("\n");
		await withApply("boundary-dup-opener", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(
				[
					"class Foo {",
					"\t/** doc */",
					"\tplanRender(",
					"\t\ta: string[],",
					"\t\tb: boolean,",
					"\t\tc: number,",
					"\t): Intent {",
					"\t\treturn x;",
					"\t}",
					"}",
				].join("\n"),
			);
			expect(newText?.split("\n").filter(line => line === "\tplanRender(")).toHaveLength(1);
			expectWarnings(result, rel, { includes: [ECHO_LEADING(4)] });
		});
	});

	// A duplicated opener whose imbalance does NOT explain the delta is left alone.
	it("preserves a duplicated opener when it does not account for the imbalance", async () => {
		const file = ["if (a) {", "\tfoo();", "}", "bar();"].join("\n");
		// Payload duplicates `if (a) {` but is net +2 braces; dropping the one
		// opener cannot zero the delta, so nothing is repaired — the result is
		// applied as written and the breakage is reported, not rewritten.
		const diff = ["PUT 2-2:", "+if (a) {", "+\tif (b) {", "+\t\tfoo();"].join("\n");
		await withApply("boundary-unexplained-imbalance", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["if (a) {", "if (a) {", "\tif (b) {", "\t\tfoo();", "}", "bar();"].join("\n"));
			expectWarnings(result, rel, { exact: [SYNTAX_ADVISORY(2)] });
		});
	});

	// Genuine missing-closer: payload omits the trailing `});`.
	it("spares the deleted closing line when the payload omits it", async () => {
		const file = ["const handlers = {", "\ta() {", "\t\treturn 1;", "\t},", "};"].join("\n");
		// The range is the final `};`. The model inserts a new method but forgets
		// to restate `};`; sparing it keeps the object literal balanced.
		const diff = ["PUT 5-5:", "+\tb() {", "+\t\treturn 2;", "+\t},"].join("\n");
		await withApply("boundary-missing-closer", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(
				["const handlers = {", "\ta() {", "\t\treturn 1;", "\t},", "\tb() {", "\t\treturn 2;", "\t},", "};"].join(
					"\n",
				),
			);
			expectWarnings(result, rel, { includes: [RETAINED(5)] });
		});
	});

	// If the selected range is already imbalanced internally, a payload that
	// restates the range's final closer must not trigger "missing closer" repair;
	// keeping the deleted suffix would duplicate the closer outside the payload.
	it("does not spare a deleted closing line that the payload already restates", async () => {
		const file = ["class Foo {", "\tok();", "\t}", "}"].join("\n");
		const diff = ["PUT 1-4:", "+class Foo {", "+\tok();", "+}"].join("\n");

		await withApply("boundary-restated-closer", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["class Foo {", "\tok();", "}"].join("\n"));
			expect(newText?.split("\n").filter(line => line === "}")).toHaveLength(1);
			expectWarnings(result, rel, { exact: [] });
		});
	});

	it("drops duplicated leading and trailing boundary lines around a range replacement", async () => {
		const file = [
			"func _cmd_travel_homeworld():",
			"\tvar destination = get_homeworld()",
			"\ttravel_to(destination)",
			"\tprint_status()",
		].join("\n");
		const diff = [
			"PUT 2-3:",
			"+func _cmd_travel_homeworld():",
			"+\tvar destination = find_homeworld()",
			"+\ttravel_to(destination)",
			"+\tprint_status()",
		].join("\n");

		await withApply("boundary-both-edges", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(
				[
					"func _cmd_travel_homeworld():",
					"\tvar destination = find_homeworld()",
					"\ttravel_to(destination)",
					"\tprint_status()",
				].join("\n"),
			);
			expect(newText?.split("\n").filter(line => line === "func _cmd_travel_homeworld():")).toHaveLength(1);
			expect(newText?.split("\n").filter(line => line === "\tprint_status()")).toHaveLength(1);
			expectWarnings(result, rel, { includes: [ECHO_BOTH(2)] });
		});
	});

	it("preserves payloads where multi-line boundary echoes cover every line", async () => {
		const file = ["A", "B", "old", "C", "D"].join("\n");
		const diff = ["PUT 3-3:", "+A", "+B", "+C", "+D"].join("\n");

		await withApply("boundary-full-echo", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["A", "B", "A", "B", "C", "D", "C", "D"].join("\n"));
			expectWarnings(result, rel, { exact: [] });
		});
	});

	it("preserves payloads made only of lines matching both replacement neighbors", async () => {
		const file = ["a", "old", "c"].join("\n");
		const diff = ["PUT 2-2:", "+a", "+c"].join("\n");

		await withApply("boundary-neighbor-echo", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["a", "a", "c", "c"].join("\n"));
			expectWarnings(result, rel, { exact: [] });
		});
	});

	// An echo whose dropped edges shift delimiter balance without explaining a
	// payload/range delta is intentional structural content, not a boundary
	// mistake: stripping the edges would corrupt the brace structure.
	it("preserves balance-shifting boundary echoes that do not explain the delta", async () => {
		const file = ["}", "old();", "}"].join("\n");
		// Payload deliberately opens with the same bare `}` that sits above the
		// range and closes with the same `}` that sits below it; the payload is
		// internally balanced (delta 0) while the dropped edges sum to -2 braces.
		const diff = ["PUT 2-2:", "+}", "+if (a) {", "+if (b) {", "+x();", "+}"].join("\n");

		await withApply("boundary-balance-shifting-echo", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["}", "}", "if (a) {", "if (b) {", "x();", "}", "}"].join("\n"));
			expectWarnings(result, rel, { exact: [] });
		});
	});

	// The common wrapper-echo mistake stays repaired: balance-neutral edges
	// (opener + closer) that duplicate the surviving neighbors are dropped.
	it("still drops a balance-neutral wrapper echo", async () => {
		const file = ["function f() {", "old();", "}"].join("\n");
		const diff = ["PUT 2-2:", "+function f() {", "+fresh();", "+}"].join("\n");

		await withApply("boundary-wrapper-echo", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["function f() {", "fresh();", "}"].join("\n"));
			expectWarnings(result, rel, { includes: [ECHO_BOTH(2)] });
		});
	});

	// Balance-preserving edits are never touched, even when the payload's last
	// line coincidentally equals the line just below the range.
	it("leaves a balance-preserving replacement alone (no false positive)", async () => {
		const file = ["foo();", "bar();", "bar();", "baz();"].join("\n");
		// Replace line 2 with two balanced statements; the tail `bar();` equals
		// the surviving line 3 but the payload is balanced — must NOT be dropped.
		const diff = ["PUT 2-2:", "+qux();", "+bar();"].join("\n");
		await withApply("boundary-no-false-positive", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["foo();", "qux();", "bar();", "bar();", "baz();"].join("\n"));
			expectWarnings(result, rel, { exact: [] });
		});
	});

	// A duplicated full statement (balance-neutral) is left intact: dropping it
	// could discard intended content, and it does not break syntax.
	it("does not drop a balance-neutral duplicated statement", async () => {
		const file = ["a = 1;", "b = 2;", "c = 3;"].join("\n");
		const diff = ["PUT 1-1:", "+a = 1;", "+b = 2;"].join("\n");
		await withApply("boundary-duplicated-statement", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["a = 1;", "b = 2;", "b = 2;", "c = 3;"].join("\n"));
			expectWarnings(result, rel, { exact: [] });
		});
	});

	// Brackets inside strings must not trigger a spurious balance mismatch.
	it("ignores brackets inside string literals", async () => {
		const file = ['const a = "}";', 'const b = "x";', 'const c = "y";'].join("\n");
		const diff = ["PUT 2-2:", '+const b = "}}}";'].join("\n");
		await withApply("boundary-string-brackets", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(['const a = "}";', 'const b = "}}}";', 'const c = "y";'].join("\n"));
			expectWarnings(result, rel, { exact: [] });
		});
	});

	// A MULTI-line construct rewrite whose payload restates the keeper that
	// survives just below the range — the att#1 `replace 639.=644` shape where
	// the range was one line short of the `const changedFiles` it retyped.
	it("drops a one-sided trailing keeper echo in a multi-line rewrite", async () => {
		const file = ["function f() {", "  a();", "  b();", "  const out = [];", "  return out;", "}"].join("\n");
		const diff = ["PUT 2-3:", "+  a2();", "+  b2();", "+  const out = [];"].join("\n");
		await withApply("boundary-trailing-keeper-echo", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(
				["function f() {", "  a2();", "  b2();", "  const out = [];", "  return out;", "}"].join("\n"),
			);
			expectWarnings(result, rel, { includes: [ECHO_TRAILING(2)] });
		});
	});

	it("drops a one-sided JSX closer echo in a single-line expansion", async () => {
		const file = ["const view = (", "  <section>", "    <Old />", "  </section>", ");"].join("\n");
		const diff = ["PUT 3-3:", "+    <New />", "+  </section>"].join("\n");
		await withApply("boundary-jsx-closer-echo", "fixture.tsx", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["const view = (", "  <section>", "    <New />", "  </section>", ");"].join("\n"));
			expect(newText?.split("\n").filter(line => line === "  </section>")).toHaveLength(1);
			expectWarnings(result, rel, { includes: [DROPPED_ROWS(3)] });
		});
	});

	it("drops a JSX closer echo after a self-closing tag with a greater-than prop expression", async () => {
		const file = ["const view = (", "<Foo>", "old text", "</Foo>", ");"].join("\n");
		const diff = ["PUT 3-3:", "+<Foo value={a > b} />", "+</Foo>"].join("\n");
		await withApply("boundary-jsx-gt-prop", "fixture.tsx", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["const view = (", "<Foo>", "<Foo value={a > b} />", "</Foo>", ");"].join("\n"));
			expect(newText?.split("\n").filter(line => line === "</Foo>")).toHaveLength(1);
			expectWarnings(result, rel, { includes: [DROPPED_ROWS(3)] });
		});
	});

	it("preserves a nested JSX closer that matches the surviving parent closer", async () => {
		const file = ["const view = (", '<section className="outer">', "old text", "</section>", ");"].join("\n");
		const diff = ["PUT 3-3:", "+<section>", "+new text", "+</section>"].join("\n");
		await withApply("boundary-nested-jsx-closer", "fixture.tsx", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(
				[
					"const view = (",
					'<section className="outer">',
					"<section>",
					"new text",
					"</section>",
					"</section>",
					");",
				].join("\n"),
			);
			expect(newText?.split("\n").filter(line => line.trim() === "</section>")).toHaveLength(2);
			expectWarnings(result, rel, { exact: [] });
		});
	});

	it("preserves a nested JSX closer when the opener spans payload lines", async () => {
		const file = ["const view = (", '<section className="outer">', "old text", "</section>", ");"].join("\n");
		const diff = ["PUT 3-3:", "+<section", '+  className="inner"', "+>", "+new text", "+</section>"].join("\n");
		await withApply("boundary-jsx-multiline-opener", "fixture.tsx", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(
				[
					"const view = (",
					'<section className="outer">',
					"<section",
					'  className="inner"',
					">",
					"new text",
					"</section>",
					"</section>",
					");",
				].join("\n"),
			);
			expect(newText?.split("\n").filter(line => line.trim() === "</section>")).toHaveLength(2);
			expectWarnings(result, rel, { exact: [] });
		});
	});

	// Mirror direction: the payload restates the keeper that survives just above
	// the multi-line range (range one line low instead of one short).
	it("drops a one-sided leading keeper echo in a multi-line rewrite", async () => {
		const file = ["setup();", "a();", "b();", "c();"].join("\n");
		const diff = ["PUT 3-4:", "+a();", "+B();", "+C();"].join("\n");
		await withApply("boundary-leading-keeper-echo", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["setup();", "a();", "B();", "C();"].join("\n"));
			expectWarnings(result, rel, { includes: [ECHO_LEADING(3)] });
		});
	});

	// A one-sided echo whose payload cannot fill the widened range is rejected,
	// not repaired: dropping the echo would silently delete the range's far
	// boundary line (here the `return threadError(...)`), leaving a dangling
	// `if`. The PyThreadRuntime incident: a SWAP restating the line above.
	it("rejects a leading keeper echo when the payload cannot fill the widened range", async () => {
		const file = [
			"{",
			"    auto* handle = payloadFor<PyThreadHandle>(self);",
			"    if (!handle)",
			'        return threadError(globalObject, "thread not started");',
			"    handle.setDone();",
			"}",
		].join("\n");
		const diff = [
			"PUT 3-4:",
			"+    auto* handle = payloadFor<PyThreadHandle>(self);",
			"+    if (!handle || !handle.isStarted())",
		].join("\n");
		await withApply("boundary-leading-echo-too-short", "fixture.ts", file, diff, ({ result }) => {
			expectError(result, /rejected: the body opens by restating/);
		});
	});

	// Mirror direction: trailing echo, payload one line short of the widened
	// range — repairing would delete `c();` even though the payload never
	// mentions it.
	it("rejects a trailing keeper echo when the payload cannot fill the widened range", async () => {
		const file = ["a();", "b();", "c();", "keep();"].join("\n");
		const diff = ["PUT 2-3:", "+B();", "+keep();"].join("\n");
		await withApply("boundary-trailing-echo-too-short", "fixture.ts", file, diff, ({ result }) => {
			expectError(result, /rejected: the body ends by restating/);
		});
	});

	// A statement swapped onto a lone closer at the closer's own depth claims
	// no position inside the block: sparing the closer would land the payload
	// after `return;` as dead code. The PyThreadRuntime setIdent incident.
	it("rejects sparing a deleted closer when the payload claims no position inside the block", async () => {
		const file = [
			"        if (!global) {",
			"            handle.setDone();",
			"            return;",
			"        }",
			"        handle.setIdent(currentIdent());",
		].join("\n");
		const diff = ["PUT 4-4:", "+        after();"].join("\n");
		await withApply("boundary-closer-no-position", "fixture.ts", file, diff, ({ result }) => {
			expectError(result, /selected boundary row is required/);
		});
	});

	// Contrast with the rejection above: a payload indented deeper than the
	// spared closer claims the inside of the block, so the spare still fires.
	it("still spares a closer when the payload indentation claims the block interior", async () => {
		const file = ["if (!global) {", "    setDone();", "    return;", "}", "after();"].join("\n");
		const diff = ["PUT 4-4:", "+    setIdent();"].join("\n");
		await withApply("boundary-closer-block-interior", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(
				["if (!global) {", "    setDone();", "    return;", "    setIdent();", "}", "after();"].join("\n"),
			);
			expectWarnings(result, rel, { includes: [RETAINED(4)] });
		});
	});

	// #3142: the range's deleted `}` is matched by an opener another hunk deletes
	// (`CUT 1`). The patch nets to balanced, so the closer must stay deleted —
	// the per-group repair wrongly kept it, leaving a stray `}`.
	it("does not keep a deleted closer when another hunk removes its opener (#3142)", async () => {
		const file = ["if enabled {", '\tText("Old")', "}", '\tText("Tail")'].join("\n");
		const diff = ["CUT 1", "PUT 2-3:", '+Text("New")'].join("\n");
		await withApply("boundary-3142", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(['Text("New")', '\tText("Tail")'].join("\n"));
			expectWarnings(result, rel, { exact: [] });
		});
	});

	// A wrapper removal and a genuine missing closer in the same patch: the
	// residual must be spent on the genuine hunk, not the wrapper-removed one.
	it("spends the missing-closer residual on the genuine hunk, not an earlier wrapper removal", async () => {
		const file = ["if enabled {", '\tText("Old")', "}", "const config = {", "\ta: 1,", "};"].join("\n");
		const diff = ["CUT 1", "PUT 2-3:", '+Text("New")', "PUT 6-6:", "+\tb: 2,"].join("\n");
		await withApply("boundary-residual", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(['Text("New")', "const config = {", "\ta: 1,", "\tb: 2,", "};"].join("\n"));
			expectWarnings(result, rel, { includes: [RETAINED(6)] });
		});
	});

	// A replaced opener (not removed) leaves a genuine missing closer downstream:
	// the net deleted-prefix balance is zero, so the closer is correctly kept.
	it("keeps the closer when the matching opener is replaced rather than removed", async () => {
		const file = ["if (a) {", "\told();", "}"].join("\n");
		const diff = ["PUT 1-1:", "+if (b) {", "PUT 2-3:", "+\tfresh();"].join("\n");
		await withApply("boundary-opener-replaced", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["if (b) {", "\tfresh();", "}"].join("\n"));
			expectWarnings(result, rel, { includes: [RETAINED(2)] });
		});
	});

	it("does not keep deleted closer suffixes whose tail the payload already restates", async () => {
		const file = [
			"const REASONING_LABEL_PATTERN = /think/i;",
			"const NO_REASONING_LABEL_PATTERN = /no/i;",
			"",
			"\treturn config.supportsThinking === true;",
			"}",
			"}",
		].join("\n");
		const diff = [
			"PUT 3-6:",
			"+function supportsDevinThinking(config: ClientModelConfig): boolean {",
			"+\tif (NO_REASONING_LABEL_PATTERN.test(config.label)) return false;",
			"+\treturn config.supportsThinking === true;",
			"+}",
		].join("\n");
		await withApply("boundary-restated-suffix", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(
				[
					"const REASONING_LABEL_PATTERN = /think/i;",
					"const NO_REASONING_LABEL_PATTERN = /no/i;",
					"function supportsDevinThinking(config: ClientModelConfig): boolean {",
					"\tif (NO_REASONING_LABEL_PATTERN.test(config.label)) return false;",
					"\treturn config.supportsThinking === true;",
					"}",
				].join("\n"),
			);
			expectWarnings(result, rel, { exact: [] });
		});
	});

	it("keeps only the non-restated outer closer for a nested deleted suffix", async () => {
		const file = ["class C {", "\told();", "\t}", "}"].join("\n");
		const diff = ["PUT 2-4:", "+\tnewMethod() {", "+\t\treturn 1;", "+\t}"].join("\n");
		await withApply("boundary-nested-suffix", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["class C {", "\tnewMethod() {", "\t\treturn 1;", "\t}", "}"].join("\n"));
			expectWarnings(result, rel, { includes: [RETAINED(2)] });
		});
	});

	it("ignores non-contiguously deleted openers when choosing which closer to keep", async () => {
		const file = ["if (a) {", "\told();", "\tmore();", "}", "const obj = {", "\ta: 1,", "};"].join("\n");
		const diff = ["CUT 1", "PUT 3-4:", "+\tfresh();", "PUT 7-7:", "+\tb: 2,"].join("\n");
		await withApply("boundary-noncontiguous-openers", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["\told();", "\tfresh();", "const obj = {", "\ta: 1,", "\tb: 2,", "};"].join("\n"));
			expectWarnings(result, rel, { includes: [RETAINED(7)] });
		});
	});

	it("counts earlier kept closers in later projected prefixes", async () => {
		const file = [
			"if (a) {",
			"\told();",
			"}",
			"const NO_REASONING_LABEL_PATTERN = /no/i;",
			"\treturn config.supportsThinking === true;",
			"\t}",
		].join("\n");
		const diff = [
			"PUT 2-3:",
			"+\tfresh();",
			"PUT 4-6:",
			"+function supportsDevinThinking(config: ClientModelConfig): boolean {",
			"+\treturn config.supportsThinking === true;",
			"+}",
		].join("\n");
		await withApply("boundary-earlier-kept-closers", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(
				[
					"if (a) {",
					"\tfresh();",
					"}",
					"function supportsDevinThinking(config: ClientModelConfig): boolean {",
					"\treturn config.supportsThinking === true;",
					"}",
				].join("\n"),
			);
			expectWarnings(result, rel, { includes: [RETAINED(2)] });
		});
	});

	it("does not let an earlier kept closer cover a later orphan closer", async () => {
		const file = ["if (a) {", "\told();", "}", "}"].join("\n");
		const diff = ["PUT 2-3:", "+\tfresh();", "PUT 4-4:", "+after();"].join("\n");
		await withApply("boundary-orphan-closer", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["if (a) {", "\tfresh();", "}", "after();"].join("\n"));
			expectWarnings(result, rel, { includes: [RETAINED(2)] });
		});
	});

	it("does not keep a deleted outer closer when one survives below the range", async () => {
		const file = ["class C {", "\tmethod() {", "\t\told();", "\t}", "}", "}"].join("\n");
		const diff = ["PUT 2-5:", "+\tmethod() {", "+\t\tfresh();", "+\t}"].join("\n");
		await withApply("boundary-outer-closer-below", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["class C {", "\tmethod() {", "\t\tfresh();", "\t}", "}"].join("\n"));
			expectWarnings(result, rel, { exact: [] });
		});
	});

	it("keeps an omitted inner closer when the outer closer survives below", async () => {
		const file = ["class C {", "\tmethod() {", "\t\told();", "\t}", "}", "}"].join("\n");
		const diff = ["PUT 2-5:", "+\tmethod() {", "+\t\tfresh();"].join("\n");
		await withApply("boundary-inner-closer", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["class C {", "\tmethod() {", "\t\tfresh();", "\t}", "}"].join("\n"));
			expectWarnings(result, rel, { includes: [RETAINED(2)] });
		});
	});

	it("counts head insertions before replacement payloads in original coordinates", async () => {
		const file = ["\told();", "}"].join("\n");
		const diff = ["PUT <1:", "+if (a) {", "PUT 1-2:", "+\tfresh();"].join("\n");
		await withApply("boundary-head-insertion", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["if (a) {", "\tfresh();", "}"].join("\n"));
			expectWarnings(result, rel, { includes: [RETAINED(1)] });
		});
	});

	it("counts a separately inserted closer immediately below the range", async () => {
		const file = ["class C {", "\told();", "}", "after();", "const obj = {", "\ta: 1,", "};"].join("\n");
		const diff = ["PUT 2-3:", "+\tfresh();", "PUT <4:", "+}", "PUT 7-7:", "+\tb: 2,"].join("\n");
		await withApply("boundary-inserted-closer", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(
				["class C {", "\tfresh();", "}", "after();", "const obj = {", "\ta: 1,", "\tb: 2,", "};"].join("\n"),
			);
			expectWarnings(result, rel, { includes: [RETAINED(7)] });
		});
	});

	it("keeps an omitted outer closer even when the payload restates an inner closer", async () => {
		const file = ["if (a) {", "\tif (b) {", "\t\told();", "\t}", "}", "after();"].join("\n");
		const diff = ["PUT 1-5:", "+if (a) {", "+\tif (c) {", "+\t\tfresh();", "+\t}"].join("\n");
		await withApply("boundary-outer-closer-restated-inner", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["if (a) {", "\tif (c) {", "\t\tfresh();", "\t}", "}", "after();"].join("\n"));
			expectWarnings(result, rel, { includes: [RETAINED(1)] });
		});
	});

	// A dupSuffix repair in hunk A zeroes its contribution; the residual must be
	// recomputed post-repair so hunk B's genuine missing closer still fires.
	it("still keeps a missing closer when another hunk's dupSuffix repair masks the raw delta", async () => {
		const file = [
			'addEventListener("click", () => {',
			"\tfoo();",
			"\tbar();",
			"});",
			"",
			"const config = {",
			"\ta: 1,",
			"};",
		].join("\n");
		const diff = ["PUT 2-3:", "+\tsetup();", "+\tfoo();", "+\tbar();", "+});", "PUT 8-8:", "+\tb: 2,"].join("\n");
		await withApply("boundary-dupsuffix-mask", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(
				[
					'addEventListener("click", () => {',
					"\tsetup();",
					"\tfoo();",
					"\tbar();",
					"});",
					"",
					"const config = {",
					"\ta: 1,",
					"\tb: 2,",
					"};",
				].join("\n"),
			);
			// Both repairs are named: the hunk-A echo and the hunk-B spare.
			expectWarnings(result, rel, { exact: [ECHO_TRAILING(2), RETAINED(8)] });
		});
	});

	// Per-slot residual: an unterminated backtick template in one hunk must not
	// bleed across into another hunk's delimiter count and mask its missing closer.
	it("does not let an unterminated template in one hunk mask a missing closer in another", async () => {
		const file = ["const log = makeLog(`", "prefix", "`);", "const obj = {", "\ta: 1", "};"].join("\n");
		const diff = ["PUT 1-1:", "+const log = createLog(`", "PUT 5-6:", "+\ta: 2"].join("\n");
		await withApply("boundary-template-hunk", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["const log = createLog(`", "prefix", "`);", "const obj = {", "\ta: 2", "};"].join("\n"));
			expectWarnings(result, rel, { includes: [RETAINED(5)] });
		});
	});

	// The neon.rs incident: the range starts one line early, on the lone `}`
	// closing the `if` above, and the payload (sibling-depth statements) never
	// restates it. The closer is spared and the payload lands after it.
	it("spares a leading closer the range swallowed when the payload claims sibling depth", async () => {
		const file = [
			"fn f() {",
			"\tif a {",
			"\t\treturn;",
			"\t}",
			"\tlet lead = old1();",
			"\tlet t4 = old2();",
			"\tlet done = old3();",
			"}",
		].join("\n");
		const diff = ["PUT 4-6:", "+\tlet mask = new1();", "+\tlet lead = new2();", "+\tlet t4 = new3();"].join("\n");
		await withApply("boundary-rust-leading-closer", "fixture.rs", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(
				[
					"fn f() {",
					"\tif a {",
					"\t\treturn;",
					"\t}",
					"\tlet mask = new1();",
					"\tlet lead = new2();",
					"\tlet t4 = new3();",
					"\tlet done = old3();",
					"}",
				].join("\n"),
			);
			expectWarnings(result, rel, { includes: [RETAINED(4)] });
		});
	});

	// A payload indented deeper than the swallowed closer claims the inside of
	// the block the closer just terminated — before vs after is a coin flip,
	// so the edit is rejected instead of guessed.
	it("rejects a swallowed leading closer when the payload claims the block interior", async () => {
		const file = ["fn f() {", "\tif a {", "\t\treturn;", "\t}", "\tlet lead = old1();", "}"].join("\n");
		const diff = ["PUT 4-5:", "+\t\tcompute();", "+\t\tstore();"].join("\n");
		await withApply("boundary-rust-block-interior", "fixture.rs", file, diff, ({ result }) => {
			expectError(result, /selected boundary row is required/);
		});
	});

	// Deliberate two-hunk unwrap: another hunk deletes the matching `if` opener,
	// so the whole-patch residual is clean and the leading closer stays deleted.
	it("does not spare a leading closer whose opener another hunk removes", async () => {
		const file = ["fn f() {", "\tif a {", "\t\treturn;", "\t}", "\tlet lead = old1();", "}"].join("\n");
		const diff = ["PUT 2-2:", "+\tguard();", "PUT 4-5:", "+\tlet lead = new1();"].join("\n");
		await withApply("boundary-rust-unwrap", "fixture.rs", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["fn f() {", "\tguard();", "\t\treturn;", "\tlet lead = new1();", "}"].join("\n"));
			expectWarnings(result, rel, { exact: [] });
		});
	});

	// The "complete new function over a head-only range" incident: the payload
	// is a fully balanced construct but the range ends mid-block, which would
	// orphan the old body's closers below. The edit applies as authored (text
	// shape cannot prove a syntactic block) but warns with the block-op remedy.
	it("warns when a balanced payload's range ends mid-block", async () => {
		const file = [
			"fn old(a: u32) -> bool {",
			"\tlet x = a + 1;",
			"\tlet y = x * 2;",
			"\tlet z = y - 3;",
			"\tz > 0",
			"}",
		].join("\n");
		const diff = ["PUT 1-3:", "+fn new(a: u32) -> bool {", "+\tlet x = a + 2;", "+\tx > 0", "+}"].join("\n");
		await withApply("boundary-mid-block", "fixture.rs", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(
				["fn new(a: u32) -> bool {", "\tlet x = a + 2;", "\tx > 0", "}", "\tlet z = y - 3;", "\tz > 0", "}"].join(
					"\n",
				),
			);
			expectWarnings(result, rel, { exact: [SYNTAX_ADVISORY(1)] });
		});
	});

	// The applier is language-agnostic: the deleted `{` here is prose-shaped
	// content, so the edit must apply verbatim — never be rejected and never
	// "repaired" into a different shape. (The old engine's comment expected its
	// mid-block advisory to fire for this shape; the native oracle records no
	// warning at all, so only the boundary-repair family is asserted here.)
	it("applies a prose edit that deletes a literal opening brace in Markdown", async () => {
		const file = ["Intro {", "body", "}"].join("\n");
		const diff = ["PUT 1-2:", "+Revised"].join("\n");
		await withApply("boundary-prose-opening-brace", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["Revised", "}"].join("\n"));
			expect(boundaryRepairWarnings(warningsOf(result, rel))).toEqual([]);
		});
	});

	// Repairing an already-broken file by appending closers is deliberate
	// net-closing content — never a mid-block mistake. (The old engine had a
	// dedicated `mid-block` warning variant; native reports breakage through
	// the parse advisory only, so this case pins the whole warning set.)
	it("does not warn for a net-closing payload that repairs a broken file", async () => {
		const file = ["fn f() {", "\tif a {", "\t\treturn;", "\tdone();", "}"].join("\n");
		const diff = ["PUT 3-3:", "+\t\treturn;", "+\t}"].join("\n");
		await withApply("boundary-net-closing", "fixture.rs", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["fn f() {", "\tif a {", "\t\treturn;", "\t}", "\tdone();", "}"].join("\n"));
			expectWarnings(result, rel, { exact: [] });
		});
	});

	// Symmetric invalid→valid repair: the file already carries a surplus
	// opener, so replacing that opener line with a plain statement rebalances
	// the file — the surviving `}` below pairs with `fn f() {`, not with the
	// deleted `if a {`. Must apply without a mid-block warning.
	it("does not warn when deleting a surplus opener from an already-broken file", async () => {
		const file = ["fn f() {", "\tif a {", "\t\twork();", "}"].join("\n");
		const diff = ["PUT 2-2:", "+\tprepare();"].join("\n");
		await withApply("boundary-surplus-opener", "fixture.rs", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["fn f() {", "\tprepare();", "\t\twork();", "}"].join("\n"));
			expectWarnings(result, rel, { exact: [] });
		});
	});

	// The balance scanner counts regex-literal braces naively; that miscount
	// may only ever suppress, never trigger the mid-block warning. Replacing
	// the `/{/` line is valid JS before and after.
	it("does not warn when replacing a regex literal whose braces fooled the balance scanner", async () => {
		const file = ["const open = /{/;", "const close = /}/;"].join("\n");
		const diff = ["PUT 1-1:", "+const open = /x/;"].join("\n");
		await withApply("boundary-regex-literal", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["const open = /x/;", "const close = /}/;"].join("\n"));
			expectWarnings(result, rel, { exact: [] });
		});
	});

	// Same regex pair embedded in a real function: the enclosing `}` below is
	// a genuine lone closer, so the closer witness alone is satisfied — the
	// opener-shape witness must still suppress the warning.
	it("does not warn for a regex-literal replacement inside a real block", async () => {
		const file = ["function setup() {", "\tconst open = /{/;", "\tconst close = /}/;", "}"].join("\n");
		const diff = ["PUT 2-2:", "+\tconst open = /x/;"].join("\n");
		await withApply("boundary-regex-in-block", "fixture.ts", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["function setup() {", "\tconst open = /x/;", "\tconst close = /}/;", "}"].join("\n"));
			expectWarnings(result, rel, { exact: [] });
		});
	});

	// The parser's veto in prose: Markdown parses with or without the literal
	// `}`, so the leading-closer spare must not fire and — since nothing is
	// wrong — must not even warn.
	it("applies a prose edit verbatim when the range deletes a literal leading brace", async () => {
		const file = ["Intro {", "}", "old"].join("\n");
		const diff = ["PUT 2-3:", "+Revised"].join("\n");
		await withApply("boundary-prose-leading-brace", "fixture.md", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["Intro {", "Revised"].join("\n"));
			expectWarnings(result, rel, { exact: [] });
		});
	});

	// Mirror for the trailing edge: the long-shipped suffix spare is vetoed by
	// the same parse.
	it("applies a prose edit verbatim when the range deletes a literal trailing brace", async () => {
		const file = ["old", "}", "Outro"].join("\n");
		const diff = ["PUT 1-2:", "+Revised"].join("\n");
		await withApply("boundary-prose-trailing-brace", "fixture.md", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["Revised", "Outro"].join("\n"));
			expectWarnings(result, rel, { exact: [] });
		});
	});

	// Same leading-closer shape in real code: no veto is available (the authored
	// result does not parse), so the spare fires and the file stays valid.
	it("spares the swallowed leading closer when the authored edit does not parse", async () => {
		const file = ["fn f() {", "\tif a {", "\t\treturn;", "\t}", "\tlet lead = old1();", "}"].join("\n");
		const diff = ["PUT 4-5:", "+\tlet lead = new1();"].join("\n");
		await withApply("boundary-spare-no-veto", "fixture.rs", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["fn f() {", "\tif a {", "\t\treturn;", "\t}", "\tlet lead = new1();", "}"].join("\n"));
			expectWarnings(result, rel, { includes: [RETAINED(4)] });
		});
	});

	// No proof, no mutation. The old case applied with no path at all so the
	// probe could not judge anything. A native session always carries an
	// absolute path, so the pathless leg is re-expressed with the
	// `fixture.unknownlang` sentinel — a language no probe can read — which
	// produces the same "no structural evidence" outcome: the edit lands
	// exactly as authored even though the delimiter heuristics alone would
	// have "repaired" it.
	it("applies as authored when no structural evidence is available, since no repair can be proven", async () => {
		const file = ["fn f() {", "\tif a {", "\t\treturn;", "\t}", "\tlet lead = old1();", "}"].join("\n");
		const diff = ["PUT 4-5:", "+\tlet lead = fresh1();"].join("\n");
		await withApply("boundary-no-path-sentinel", "fixture.unknownlang", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["fn f() {", "\tif a {", "\t\treturn;", "\tlet lead = fresh1();", "}"].join("\n"));
			expect(boundaryRepairWarnings(warningsOf(result, rel))).toEqual([]);
		});
	});

	// Same for a language tree-sitter does not know: nothing can be proven, so
	// nothing is rewritten and no advisory is invented.
	it("applies as authored for a language the parser does not know", async () => {
		const file = ["fn f() {", "\tif a {", "\t\treturn;", "\t}", "\tlet lead = old1();", "}"].join("\n");
		const diff = ["PUT 4-5:", "+\tlet lead = fresh1();"].join("\n");
		await withApply("boundary-unknown-language", "fixture.unknownlang", file, diff, ({ result, rel, newText }) => {
			expectSuccess(result);
			expect(newText).toBe(["fn f() {", "\tif a {", "\t\treturn;", "\tlet lead = fresh1();", "}"].join("\n"));
			expectWarnings(result, rel, { exact: [] });
		});
	});

	// The one-sided boundary echo is proven by exact line equality, not by
	// delimiter semantics, so the parser has no say over it. It must reject even
	// on a language the probe cannot read — otherwise suppressing the
	// closer-spare verdict would also let this unsafe edit through, deleting
	// range lines the body never restates.
	//
	// The old case looped over `[undefined, "fixture.unknownlang", "fixture.ts"]`;
	// the truly pathless leg has no native counterpart (a session is always
	// path-bound), so the unknown-language and TypeScript legs run here.
	it("still rejects a too-short one-sided echo on a language the parser cannot read", async () => {
		const file = ["alpha", "beta", "gamma", "delta", "eps"].join("\n");
		const diff = ["PUT 2-4:", "+alpha", "+fresh1"].join("\n");
		await withApply("boundary-short-echo-unknown", "fixture.unknownlang", file, diff, ({ result }) => {
			expectError(result, /too short to be the full final content/);
		});
		await withApply("boundary-short-echo-ts", "fixture.ts", file, diff, ({ result }) => {
			expectError(result, /too short to be the full final content/);
		});
	});
});

describe("boundary-balance repair through stale-snapshot recovery", () => {
	// Native recovery composes the same applier the authored edit goes through,
	// so boundary repair runs inside recovery too. The snapshot (what the model
	// read) carries the structure; the live file has drifted far from the edit
	// region, so unchanged-anchor replay succeeds and the repaired
	// (de-duplicated) hunk lands without doubling the closer.
	it("de-duplicates a closer while recovering from a drifted file", async () => {
		const ws = new Workspace("boundary-recovery");
		try {
			const rel = "fixture.ts";
			const snapshotLines = [
				'import { x } from "y";',
				"",
				"it('a', () => {",
				"\tsetup();",
				"\trun();",
				"});",
				"",
				"function filler1() { return 1; }",
				"function filler2() { return 2; }",
				"function filler3() { return 3; }",
				"function filler4() { return 4; }",
				"function filler5() { return 5; }",
				"const tail = 0;",
				"export { tail };",
			];
			const snapshotText = `${snapshotLines.join("\n")}\n`;
			// Live file drifted only at the tail (line 13) — far outside the edit
			// region (lines 4-6), so unchanged-anchor recovery succeeds.
			const currentText = snapshotText.replace("const tail = 0;", "const tail = 99;");
			ws.write(rel, currentText);
			// The snapshot is the model's stale read; the tag names it, not the
			// bytes now on disk.
			const tag = ws.snapshot(rel, snapshotText);

			// The range replaces the body lines but the payload also restates the
			// `});` that survives at line 6 — the duplicate-closer mistake.
			const diff = ["PUT 4-5:", "+\tsetup2();", "+\trun2();", "+});"].join("\n");
			const result = await applyPatch(ws, `${ws.header(rel, tag)}\n${diff}`);

			expectSuccess(result);
			const newText = fileOutcome(result, rel)?.newText;
			const expected = `${[
				'import { x } from "y";',
				"",
				"it('a', () => {",
				"\tsetup2();",
				"\trun2();",
				"});",
				"",
				"function filler1() { return 1; }",
				"function filler2() { return 2; }",
				"function filler3() { return 3; }",
				"function filler4() { return 4; }",
				"function filler5() { return 5; }",
				"const tail = 99;",
				"export { tail };",
			].join("\n")}\n`;
			// Exactly one `});` — the duplicate was absorbed during recovery — and
			// the unrelated drift on the live file survives the merge.
			expect(newText).toBe(expected);
			expect(newText?.split("\n").filter(l => l === "});")).toHaveLength(1);
			expect(newText).toContain("setup2();");
			expect(newText).toContain("run2();");
			expect(newText).toContain("const tail = 99;");
			expectFile(ws, rel, expected);
			// The repair warning propagates out through the recovery result,
			// alongside the stale-hash banner the session prepends.
			expect(boundaryRepairWarnings(warningsOf(result, rel))).toHaveLength(1);
			expectWarnings(result, rel, { includes: [RECOVERED_FROM_STALE_HASH, ECHO_TRAILING(4)] });
		} finally {
			ws.dispose();
		}
	});
});

// Regressions from a live omp-ar refactor session: two hashline edits broke a
// Rust file with zero feedback. Both must now surface a warning in the same
// response, and correctly authored edits on the same shapes must stay silent.
describe("rust lifetime delimiter counting (the extension() incident)", () => {
	// `pub const fn extension(self) -> &'static str {` — the `'` of the
	// lifetime used to enter string state and swallow the trailing `{`, so a
	// range covering signature + match block looked balance-neutral and the
	// missing-signature result applied silently.
	const file = [
		"/// Archive container format.",
		"#[derive(Debug, Clone, Copy, PartialEq, Eq)]",
		"pub enum Format {",
		"   Zip,",
		"   Tar,",
		"   TarGz,",
		"}",
		"",
		"impl Format {",
		"   /// Returns the canonical filename extension for this format.",
		"   pub const fn extension(self) -> &'static str {",
		"      match self {",
		'         Self::Zip => "zip",',
		'         Self::Tar => "tar",',
		'         Self::TarGz => "tar.gz",',
		"      }",
		"   }",
		"}",
	].join("\n");

	it("flags a range that swallows a lifetime-carrying signature line", async () => {
		// Range 11-16 deletes the signature's `{` (hidden behind `'static`
		// before the fix) and the match block; payload is only the new body.
		await withApply("rust-lifetime-flag", "fixture.rs", file, "PUT 11.=16:\n+\t\tself.into()", ({ result, rel, newText }) => {
			expectSuccess(result);
			// Applied as authored — advisory, not repair.
			expect(newText).toContain("\t\tself.into()");
			expect(newText).not.toContain("pub const fn extension");
			expectWarnings(result, rel, { includes: [SYNTAX_ADVISORY(11)] });
		});
	});

	it("does not resurrect a swallowed signature when body indentation matches", async () => {
		await withApply(
			"rust-lifetime-no-resurrect",
			"fixture.rs",
			file,
			"PUT 11.=16:\n+      self.into()",
			({ result, rel, newText }) => {
				expectSuccess(result);
				expect(newText).toContain("      self.into()");
				expect(newText).not.toContain("pub const fn extension");
				expect(boundaryRepairWarnings(warningsOf(result, rel))).toHaveLength(0);
				expectWarnings(result, rel, { exact: [SYNTAX_ADVISORY(11)] });
			},
		);
	});

	it("stays silent for the correct whole-construct replacement", async () => {
		const diff = [
			"PUT 11.=17:",
			"+   pub const fn extension(self) -> &'static str {",
			"+      self.into()",
			"+   }",
		].join("\n");
		await withApply("rust-lifetime-silent", "fixture.rs", file, diff, ({ result, rel }) => {
			expectSuccess(result);
			expectWarnings(result, rel, { exact: [] });
		});
	});

	it("stays silent editing below a multi-lifetime signature", async () => {
		// `<'a>(left: &'a str, right: &'a str)` — pairing apostrophes across
		// lifetimes would swallow the `(` and fabricate a paren delta.
		const multi = [
			"fn join<'a>(left: &'a str, right: &'a str) -> String {",
			'   let out = format!("{left}{right}");',
			"   out",
			"}",
		].join("\n");
		await withApply(
			"rust-multi-lifetime",
			"fixture.rs",
			multi,
			'PUT 2.=2:\n+   let out = format!("{left}-{right}");',
			({ result, rel }) => {
				expectSuccess(result);
				expectWarnings(result, rel, { exact: [] });
			},
		);
	});

	it("still lexes rust char literals as literals", async () => {
		// `'{'` / `'}'` in match arms are content, not delimiters.
		const arms = [
			"fn depth(c: char, mut n: i32) -> i32 {",
			"   match c {",
			"      '{' => n += 1,",
			"      '}' => n -= 1,",
			"      _ => {},",
			"   }",
			"   n",
			"}",
		].join("\n");
		await withApply("rust-char-literals", "fixture.rs", arms, "PUT 7.=7:\n+   n + 1", ({ result, rel }) => {
			expectSuccess(result);
			expectWarnings(result, rel, { exact: [] });
		});
	});
});

describe("post-apply parse advisory (the resolve_alias_path incident)", () => {
	// A balance-neutral single-line replacement landed on the wrong line — a
	// `return` swapped onto a method-chain step — leaving no delimiter anomaly
	// for the repair heuristics. The parse probe is the only witness.
	const file = [
		"impl A {",
		"   fn write_all(&self) -> Result<()> {",
		"      let paths: Vec<_> = self",
		"         .entries",
		"         .iter()",
		"         .filter(|entry| !entry.is_directory())",
		"         .map(|entry| entry.path.clone())",
		"         .collect();",
		"      Ok(())",
		"   }",
		"",
		"   fn resolve_path(&self, path: Str) -> Result<Str> {",
		"      if matches!(self.format, Format::Tar | Format::TarGz) {",
		"         return tar::resolve_alias_path(&self.entries, path);",
		"      }",
		"      Ok(path)",
		"   }",
		"}",
	].join("\n");
	const misplaced = "PUT 7.=7:\n+\t\t\treturn tar::resolve_alias_path(&self.entries, path, self.limits);";

	it("warns when a balance-neutral edit stops the file parsing", async () => {
		await withApply("advisory-misplaced", "fixture.rs", file, misplaced, ({ result, rel, newText }) => {
			expectSuccess(result);
			// Applied as authored; the warning names the landing line.
			expect(newText).toContain("return tar::resolve_alias_path(&self.entries, path, self.limits);");
			expectWarnings(result, rel, { exact: [SYNTAX_ADVISORY(7)] });
		});
	});

	it("stays silent when the same statement lands on the intended line", async () => {
		await withApply(
			"advisory-intended-line",
			"fixture.rs",
			file,
			"PUT 14.=14:\n+         return tar::resolve_alias_path(&self.entries, path, self.limits);",
			({ result, rel }) => {
				expectSuccess(result);
				expectWarnings(result, rel, { exact: [] });
			},
		);
	});

	it("casts no advisory when the baseline was already broken", async () => {
		// Mid-refactor file that never parsed: the edit did not cause the
		// damage, so reporting it would be noise.
		const broken = ["impl A {", "   fn half(", "   let x = 1;"].join("\n");
		await withApply("advisory-broken-baseline", "fixture.rs", broken, "PUT 3.=3:\n+   let x = 2;", ({ result, rel }) => {
			expectSuccess(result);
			expectWarnings(result, rel, { exact: [] });
		});
	});

	it("casts no advisory for languages the probe cannot parse", async () => {
		// Markdown braces are prose; `parsesCleanly` never vouches for the
		// baseline, so breakage cannot be attributed to the edit.
		const prose = ["# Title", "", "Uses { braces } freely.", "Done."].join("\n");
		await withApply("advisory-unknown-language", "fixture.md", prose, "PUT 4.=4:\n+Still { unbalanced", ({ result, rel }) => {
			expectSuccess(result);
			expectWarnings(result, rel, { exact: [] });
		});
	});
});
