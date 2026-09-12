/**
 * hashline leniency — migrated to the native (Rust) engine.
 *
 * The old file drove the deleted TS engine in memory
 * (`applyEdits(text, parsePatch(diff).edits).text`) with **no path**, and
 * asserted thrown parser errors plus parsed objects. Natively there is no
 * parse-layer API: every case now runs a real `EditSession` against a file on
 * disk and asserts the model-facing result — rejection text, the per-file
 * `newText`, or the engine warning list. Error/warning wording is byte-for-byte
 * the deleted `engine/messages.ts` text, so the original regexes are kept as
 * authored.
 *
 * Oracle: upstream `parity_leniency.json` (generated from this very file)
 * pins the same `text` / `warnings` these cases assert.
 */
import { describe, expect, it } from "vitest";

import type { ApplyResult, Workspace } from "./harness.ts";
import {
	applyPatch,
	expectError,
	expectSuccess,
	expectWarnings,
	fileOutcome,
	withWorkspace,
} from "./harness.ts";
import { computeFileHash } from "../native/index.ts";

const FILE = "a\nb\nc\nd\ne";

/**
 * Stand-in for the old **pathless** apply: `applyEdits(text, edits)` was called
 * without a path, so the engine never ran a syntax probe. The native engine
 * always has a path, and the closest representation of "no path" is an
 * extension no language parses — `.txt` yields no syntax data, so no syntax
 * advisory is appended to `warnings` and no syntax-driven boundary repair can
 * fire. Cases that must pin an empty warning set depend on this; never switch
 * one of them to a source extension.
 */
const NO_PATH_REL = "a.txt";

/* -------------------------------------------------------------------------- */
/* Engine warning texts                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Byte-identical to the deleted `engine/messages.ts` constants (the Rust engine
 * inherited the wording) and to `parity_leniency.json`. Exact strings, not
 * patterns: a warning case names a contract, and the harness compares sets.
 */
const W = {
	BARE_BODY_AUTO_PIPED: "Auto-prefixed bare body row(s) with `+`. Body rows must be `+TEXT` literal lines.",
	MINUS_BULLET_AUTO_PIPED:
		"Auto-prefixed bare `- ` bullet row(s) as literal content. `-` rows never remove lines — the range does that; always prefix literal body rows with `+`: `+- item`.",
	SNAPSHOT_ROWS_AUTO_PUT:
		"Recovered top-level `N:TEXT` snapshot row(s) as single-line `PUT N.=N:` replacements. Use explicit `PUT` headers for reliable edits.",
	READ_METADATA_IGNORED: "Ignored copied read-output elision row(s). Re-read elided ranges before editing them.",
	CUT_COLON_IGNORED: "Ignored a trailing `:` on bodyless `CUT`. Prefer `CUT N.=M` / `CUT N*` without a colon.",
	REPLACE_PAIR_COALESCED:
		"Multiple hunks targeted the same exact range; kept only the last. Issue one `PUT` or `CUT` hunk per range.",
	BARE_RANGE_AUTO_PUT: "Recovered a bare `N.=M:` header as `PUT N.=M:`. Prefix replacement ranges with `PUT`.",
	DIFF_OLD_ROWS_IGNORED:
		"Ignored unified-diff `-old` row(s); the range already removes old content, so only `+new` rows were kept.",
} as const;

/* -------------------------------------------------------------------------- */
/* Session helper                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Materialize `text` at `rel`, mint a real content tag for it, and apply `body`
 * under that `[rel#tag]` header — the native paradigm for what the old helper
 * did with a bare patch body against an in-memory string.
 */
async function run(
	ws: Workspace,
	body: string,
	text: string = FILE,
	rel: string = NO_PATH_REL,
): Promise<ApplyResult> {
	ws.write(rel, text);
	const tag = ws.snapshot(rel, text);
	return applyPatch(ws, `[${rel}#${tag}]\n${body}`);
}

/** {@link run} plus the assertion most text cases make: the resulting file text. */
async function runText(
	ws: Workspace,
	body: string,
	expected: string,
	text: string = FILE,
	rel: string = NO_PATH_REL,
): Promise<ApplyResult> {
	const result = await run(ws, body, text, rel);
	expectSuccess(result);
	expect(fileOutcome(result, rel)?.newText).toBe(expected);
	return result;
}

describe("hashline section headers", () => {
	it("accepts paths with spaces in anchored section headers", async () => {
		await withWorkspace("leniency-spaces", async ws => {
			const rel = "dir with spaces/file.ts";
			ws.write(rel, "before");
			ws.snapshot(rel, "before");

			// The old case read `section.path` / `section.fileHash` off a parsed
			// section. Natively the same two facts surface in the rejection the
			// header produces: the path is echoed exactly (spaces intact) and the
			// authored lowercase tag is bound uppercased, against the live content
			// hash computed from the section's own text.
			const mismatch = await applyPatch(ws, `[${rel}#1a2b]\nPUT 1-1:\n+after`);
			expectError(mismatch, /Edit rejected for dir with spaces\/file\.ts: hash #1A2B is not from this session\./);
			expect(mismatch.outcome.text).toContain(`The current file hashes to #${computeFileHash("before")}.`);

			// ...and the anchored edit really applies to the file the header names.
			const applied = await applyPatch(ws, `[${rel}#${computeFileHash("before")}]\nPUT 1-1:\n+after`);
			expectSuccess(applied);
			expect(fileOutcome(applied, rel)?.newText).toBe("after");
		});
	});

	it("recovers apply_patch-contaminated headers whose paths contain spaces", async () => {
		await withWorkspace("leniency-spaces-noise", async ws => {
			const rel = "dir with spaces/file.ts";
			ws.write(rel, "before");
			ws.snapshot(rel, "before");

			// Same contract as above through the `*** Update File:` noise: the
			// engine strips the prefix, so the path (and only the path) is what the
			// tag binds to.
			const mismatch = await applyPatch(ws, `[*** Update File: ${rel}#1A2B]\nPUT 1-1:\n+after`);
			expectError(mismatch, /Edit rejected for dir with spaces\/file\.ts: hash #1A2B is not from this session\./);
			expect(mismatch.outcome.text).toContain(`The current file hashes to #${computeFileHash("before")}.`);

			const applied = await applyPatch(
				ws,
				`[*** Update File: ${rel}#${computeFileHash("before")}]\nPUT 1-1:\n+after`,
			);
			expectSuccess(applied);
			expect(fileOutcome(applied, rel)?.newText).toBe("after");
		});
	});

	it("rejects trailing junk after a snapshot tag", async () => {
		await withWorkspace("leniency-trailing-junk", async ws => {
			ws.write("src/a.ts", FILE);
			ws.snapshot("src/a.ts", FILE);

			const copied = await applyPatch(ws, "[src/a.ts#1A2B copied from read]\nPUT 1-1:\n+after");
			expectError(copied, /Input header must be/);

			const numbered = await applyPatch(ws, "[src/a.ts#1A2B:812]\nPUT 1-1:\n+after");
			expectError(numbered, /Input header must be/);
		});
	});

	it("rejects trailing junk after a snapshot tag even with apply_patch noise", async () => {
		await withWorkspace("leniency-trailing-junk-noise", async ws => {
			ws.write("src/a.ts", FILE);
			ws.snapshot("src/a.ts", FILE);

			const copied = await applyPatch(ws, "[Update File: src/a.ts#1A2B copied from read]\nPUT 1-1:\n+after");
			expectError(copied, /Input header must be/);

			const numbered = await applyPatch(ws, "[Update File: src/a.ts#1A2B:812]\nPUT 1-1:\n+after");
			expectError(numbered, /Input header must be/);
		});
	});

	it("rejects malformed snapshot tags", async () => {
		await withWorkspace("leniency-malformed-tags", async ws => {
			ws.write("src/a.ts", FILE);
			ws.snapshot("src/a.ts", FILE);

			const three = await applyPatch(ws, "[src/a.ts#1A2]\nPUT 1-1:\n+after");
			expectError(three, /Input header must be/);

			const nonHex = await applyPatch(ws, "[src/a.ts#1A2G]\nPUT 1-1:\n+after");
			expectError(nonHex, /Input header must be/);

			const five = await applyPatch(ws, "[src/a.ts#1A2B5]\nPUT 1-1:\n+after");
			expectError(five, /Input header must be/);
		});
	});

	it("rejects malformed snapshot tags even with apply_patch noise", async () => {
		await withWorkspace("leniency-malformed-tags-noise", async ws => {
			ws.write("src/a.ts", FILE);
			ws.snapshot("src/a.ts", FILE);

			const result = await applyPatch(ws, "[Update File: src/a.ts#1A2G]\nPUT 1-1:\n+after");
			expectError(result, /Input header must be/);
		});
	});

	it("reports bracket syntax with a 4-hex example when the header is missing", async () => {
		await withWorkspace("leniency-missing-header", async ws => {
			// The only case that stays headerless: it is the missing-header error.
			const result = await applyPatch(ws, "CUT 38-40");
			expectError(result, /input must begin with "\[PATH#HASH\]"/);
			expect(result.outcome.text).toContain('Example: "[src/foo.ts#1A2B]"');
			expect(result.outcome.text).not.toContain("#0A3");
		});
	});
});

describe("hashline core — verb header forms", () => {
	it("rejects a bare single-number hunk header with verb guidance", async () => {
		await withWorkspace("leniency-bare-single", async ws => {
			const result = await run(ws, "2\n+B");
			expectError(result, /hunk headers need a verb/);
		});
	});

	it("rejects a bare numeric range with verb guidance", async () => {
		await withWorkspace("leniency-bare-range", async ws => {
			const result = await run(ws, "2 3\n+X");
			expectError(result, /Hunk headers need a verb/);
		});
	});

	it("accepts canonical dot-equals replace/cut and gap forms", async () => {
		await withWorkspace("leniency-canonical-forms", async ws => {
			await runText(ws, "PUT 2.=3:\n+X", "a\nX\nd\ne");
			await runText(ws, "CUT 2.=3", "a\nd\ne");
			await runText(ws, "PUT <2:\n+X", "a\nX\nb\nc\nd\ne");
			await runText(ws, "PUT >2:\n+X", "a\nb\nX\nc\nd\ne");
			await runText(ws, "PUT <1:\n+X", "X\na\nb\nc\nd\ne");
			await runText(ws, "PUT >$:\n+X", "a\nb\nc\nd\ne\nX");
		});
	});

	it("leniently accepts single-number replace and cut shorthand", async () => {
		await withWorkspace("leniency-single-number", async ws => {
			await runText(ws, "PUT 2:\n+X", "a\nX\nc\nd\ne");
			await runText(ws, "CUT 2", "a\nc\nd\ne");
		});
	});

	it("recovers a dangling range separator as a single-line range", async () => {
		await withWorkspace("leniency-dangling-separator", async ws => {
			await runText(ws, "PUT 2.=:\n+X", "a\nX\nc\nd\ne");
			await runText(ws, "PUT 2-:\n+X", "a\nX\nc\nd\ne");
			await runText(ws, "CUT 2.=", "a\nc\nd\ne");
		});
	});

	it("still rejects a dangling separator followed by junk", async () => {
		await withWorkspace("leniency-dangling-junk", async ws => {
			const result = await run(ws, "PUT 2.= junk:\n+X");
			expectError(result, /payload line has no preceding hunk header/);
		});
	});

	it("recovers top-level numbered snapshot rows as single-line replacements", async () => {
		await withWorkspace("leniency-snapshot-rows", async ws => {
			for (const separator of [":", "|"]) {
				const result = await runText(ws, `2${separator}B\n4${separator}D`, "a\nB\nc\nD\ne");
				expectWarnings(result, NO_PATH_REL, { includes: [W.SNAPSHOT_ROWS_AUTO_PUT] });
			}
		});
	});

	// The xutf incident: a body written as consecutive lines under one number
	// (`4:` four times). Each row lowers to `PUT 4.=4:`, so the same-range
	// coalescer kept only the last — silently replacing the block opener with
	// `}` and dropping the rest. Recovery cannot read this; reject it.
	it("rejects repeated snapshot-row line numbers instead of keeping only the last", async () => {
		await withWorkspace("leniency-repeated-snapshot-rows", async ws => {
			const result = await run(ws, "2:B\n4:first\n4:second");
			expectError(result, /name line 4/);
			expect(result.outcome.text).toMatch(/keep only the last row/);
		});
	});

	// The xutf `native.rs` incident: `+CUT 1266.=1277` inside a `PUT` body is a
	// literal row by spec, so it was inserted into the Rust file as text. That
	// reading is correct, but it must be named — the agent that hit this filed a
	// bug against the tool instead of repairing the line it had just planted.
	it("warns when a body row is itself a hunk header written with the payload prefix", async () => {
		await withWorkspace("leniency-literal-op-row", async ws => {
			const result = await runText(ws, "PUT >1:\n+inserted();\n+CUT 1266.=1277", "a\ninserted();\nCUT 1266.=1277\nb\nc\nd\ne");
			expectWarnings(result, NO_PATH_REL, {
				includes: [
					"line 3: body row `+CUT 1266.=1277` is itself a valid hunk header, so it was inserted into the file as literal text rather than executed. Ops are never `+`-prefixed — drop the `+` to run it, and re-issue if this line landed in the file by mistake.",
				],
			});
		});
	});

	it("recovers a bare range header as an implicit PUT", async () => {
		await withWorkspace("leniency-bare-range-header", async ws => {
			const result = await runText(ws, "2.=3:\n+X", "a\nX\nd\ne");
			expectWarnings(result, NO_PATH_REL, { includes: [W.BARE_RANGE_AUTO_PUT] });
		});
	});

	it("ignores copied read elisions instead of writing them", async () => {
		await withWorkspace("leniency-elisions", async ws => {
			const result = await run(
				ws,
				["1:a", "2-3:  omitted() { … }", "4:d", "[…2ln elided; re-read needed ranges with a.ts:2-3]"].join("\n"),
			);
			// Native contract for a payload that lowers to no change: still a
			// successful apply (`op: "update"`), zero writes, the unchanged text,
			// plus the engine's own explanation of the no-op. The old engine's
			// silent in-memory apply had no counterpart for any of this.
			expectSuccess(result);
			const file = fileOutcome(result, NO_PATH_REL);
			expect(file?.newText).toBe(FILE);
			expect(file?.op).toBe("update");
			expect(file?.firstChangedLine).toBe(1);
			expect(result.requests).toHaveLength(0);
			expect(result.outcome.text).toContain("parsed and applied cleanly, but produced no change");
			expectWarnings(result, NO_PATH_REL, {
				includes: [W.SNAPSHOT_ROWS_AUTO_PUT, W.READ_METADATA_IGNORED],
			});
		});
	});

	it("accepts a harmless trailing colon on bodyless CUT", async () => {
		await withWorkspace("leniency-cut-colon", async ws => {
			const result = await runText(ws, "CUT 2-3:", "a\nd\ne");
			expectWarnings(result, NO_PATH_REL, { includes: [W.CUT_COLON_IGNORED] });
		});
	});

	it("keeps the final hunk when numbered context targets the same exact line", async () => {
		await withWorkspace("leniency-final-hunk", async ws => {
			const result = await runText(ws, "2:b\nPUT 2:\n+B", "a\nB\nc\nd\ne");
			expectWarnings(result, NO_PATH_REL, {
				includes: [W.SNAPSHOT_ROWS_AUTO_PUT, W.REPLACE_PAIR_COALESCED],
			});
		});
	});

	it("lets a CUT supersede a placeholder PUT over the same exact range", async () => {
		await withWorkspace("leniency-cut-supersedes-put", async ws => {
			// The old case inspected the parsed `Edit` list (no `lineNum: 1` PUT
			// edit, and a `{kind: "cut", register: "block"}` edit). Natively the
			// same fact is observable end to end: the persisted bytes are exactly
			// the CUT's result — the placeholder PUT body never lands — and that
			// body appears nowhere in the model-facing text.
			const result = await run(ws, "PUT 2-3:\n+// moved block removed\nCUT 2-3 @block");
			expectSuccess(result);
			expect(fileOutcome(result, NO_PATH_REL)?.newText).toBe("a\nd\ne");
			// The model-facing echo carries the CUT's result, not the placeholder's.
			expect(result.outcome.text).toContain("1:a\n2:d\n3:e");
			expect(result.outcome.text).not.toContain("// moved block removed");
			expectWarnings(result, NO_PATH_REL, { includes: [W.REPLACE_PAIR_COALESCED] });
		});
	});

	it("rejects missing colon on body-bearing insert headers", async () => {
		await withWorkspace("leniency-missing-colon", async ws => {
			const spaced = await run(ws, "PUT < 2\n+X");
			expectError(spaced, /`PUT` without `:` is clipboard-backed/);

			const tight = await run(ws, "PUT <1\n+X");
			expectError(tight, /`PUT` without `:` is clipboard-backed/);
		});
	});
});

describe("hashline body contracts", () => {
	it("auto-pipes a bare body row while warning", async () => {
		await withWorkspace("leniency-bare-body", async ws => {
			const result = await runText(ws, "PUT 2-2:\n  hello", "a\n  hello\nc\nd\ne");
			expectWarnings(result, NO_PATH_REL, { includes: [W.BARE_BODY_AUTO_PIPED] });
		});
	});

	it("strips read-output line number prefixes from auto-piped bare body rows", async () => {
		await withWorkspace("leniency-bare-body-prefixes", async ws => {
			for (const separator of [":", "|"]) {
				const result = await runText(ws, `PUT 2-2:\n2${separator}hello`, "a\nhello\nc\nd\ne");
				expectWarnings(result, NO_PATH_REL, { includes: [W.BARE_BODY_AUTO_PIPED] });
			}
		});
	});

	it("preserves `+N:` literal payloads without stripping", async () => {
		await withWorkspace("leniency-plus-prefixed", async ws => {
			const result = await runText(ws, "PUT 2-2:\n+3:keep", "a\n3:keep\nc\nd\ne");
			// Exact set, not a pattern: an explicit `+` row is literal content and
			// must produce no engine warning at all (the `.txt` path adds no syntax
			// advisory either).
			expectWarnings(result, NO_PATH_REL, { exact: [] });
		});
	});

	it("strips only one N: prefix from bare body rows (preserves nested digits:colon)", async () => {
		await withWorkspace("leniency-nested-prefix", async ws => {
			// "2:42:hello" → should yield "42:hello", NOT "hello" (recursive would over-strip)
			await runText(ws, "PUT 2-2:\n2:42:hello", "a\n42:hello\nc\nd\ne");
		});
	});

	it("strips N: prefixes only when every bare body row carries one", async () => {
		await withWorkspace("leniency-uniform-prefixes", async ws => {
			await runText(ws, "PUT 2-3:\n2:foo\n3:bar", "a\nfoo\nbar\nd\ne");
		});
	});

	it("leaves bare body rows untouched when only some carry an N: prefix", async () => {
		await withWorkspace("leniency-mixed-prefixes", async ws => {
			// "3:keep" looks like a snapshot prefix but "plain" does not, so the body
			// is genuine content (not a pasted snapshot) — strip nothing.
			await runText(ws, "PUT 2-3:\n3:keep\nplain", "a\n3:keep\nplain\nd\ne");
		});
	});

	it("keeps interior blank rows in a bare replace body", async () => {
		await withWorkspace("leniency-interior-blank", async ws => {
			await runText(ws, "PUT 2-3:\nfoo\n\nbar", "a\nfoo\n\nbar\nd\ne");
		});
	});

	it("drops trailing blank rows between a bare body and the next hunk", async () => {
		await withWorkspace("leniency-trailing-blank", async ws => {
			await runText(ws, "PUT 2-2:\nfoo\n\nPUT 4-4:\nbaz", "a\nfoo\nc\nbaz\ne");
		});
	});

	it("skips blank rows when checking N: prefix uniformity", async () => {
		await withWorkspace("leniency-blank-uniformity", async ws => {
			await runText(ws, "PUT 2-3:\n2:foo\n\n3:bar", "a\nfoo\n\nbar\nd\ne");
		});
	});

	it("leaves numeric-keyed literal bodies untouched (dict/YAML shape)", async () => {
		await withWorkspace("leniency-numeric-keys", async ws => {
			await runText(ws, 'PUT 2-3:\n1: "one",\n2: "two",', 'a\n1: "one",\n2: "two",\nd\ne');
		});
	});

	it("rejects ambiguous standalone `-` body rows with Markdown bullet guidance", async () => {
		await withWorkspace("leniency-minus-row", async ws => {
			const result = await run(ws, "PUT 2-2:\n-old");
			expectError(result, /Markdown bullets or other literal `-` lines.*`\+- item`/);
		});
	});

	it("auto-pipes a fully bare Markdown bullet body with a warning", async () => {
		await withWorkspace("leniency-bullet-body", async ws => {
			const result = await runText(ws, "PUT 2-2:\n- item\n  - nested", "a\n- item\n  - nested\nc\nd\ne");
			expectWarnings(result, NO_PATH_REL, { includes: [W.MINUS_BULLET_AUTO_PIPED] });
		});
	});

	it("auto-pipes a bare bullet row next to explicit `+- item` siblings", async () => {
		await withWorkspace("leniency-bullet-siblings", async ws => {
			const result = await runText(ws, "PUT 2-2:\n+### Fixed\n+- one\n- two", "a\n### Fixed\n- one\n- two\nc\nd\ne");
			expectWarnings(result, NO_PATH_REL, { includes: [W.MINUS_BULLET_AUTO_PIPED] });
		});
	});

	it("still rejects non-bullet bare `-` rows even in a fully bare body", async () => {
		await withWorkspace("leniency-minus-row-nonbullet", async ws => {
			const result = await run(ws, "PUT 2-2:\n-old()");
			expectError(result, /`-` rows are not valid/);
		});
	});

	it("still rejects bullet-shaped `-` rows beside a plain `+new` row (diff paste)", async () => {
		await withWorkspace("leniency-minus-row-diff-paste", async ws => {
			const result = await run(ws, "PUT 2-2:\n- x\n+new()");
			expectError(result, /`-` rows are not valid/);
		});
	});

	it("allows literal Markdown bullets and plus-prefixed text when prefixed with `+`", async () => {
		await withWorkspace("leniency-plus-literal", async ws => {
			await runText(ws, "PUT 2-2:\n+- item\n+  - nested\n++plus", "a\n- item\n  - nested\n+plus\nc\nd\ne");
		});
	});

	it("treats an empty replace as deletion and still rejects an empty insert", async () => {
		await withWorkspace("leniency-empty-put", async ws => {
			await runText(ws, "PUT 2-2:", "a\nc\nd\ne");

			const insert = await run(ws, "PUT >$:");
			expectError(insert, /promises body rows/);
		});
	});

	it("rejects cut with a body", async () => {
		await withWorkspace("leniency-cut-body", async ws => {
			const result = await run(ws, "CUT 2\n+X");
			expectError(result, /takes no body rows/);
		});
	});
});

describe("hashline — apply_patch / unified-diff contamination", () => {
	it("rejects apply_patch sentinels as contamination", async () => {
		await withWorkspace("leniency-apply-patch-sentinel", async ws => {
			for (const sentinel of ["*** Update File: a.ts", "*** Add File: a.ts"]) {
				const result = await run(ws, `${sentinel}\nPUT 2-2:\n+X`);
				// The case's own regex survives verbatim: native still names the
				// sentinel. The old parse-only assertion had no notion of a write, so
				// the migration adds the part that matters after the engine swap —
				// the payload is rejected and nothing reaches disk.
				expectError(result, /apply_patch sentinel/);
				expect(result.outcome.text).toContain(`apply_patch sentinel "${sentinel}" is not valid in hashline.`);
				expect(result.requests).toHaveLength(0);
				expect(ws.read(NO_PATH_REL)).toBe(FILE);
			}
		});
	});

	it("rejects unified-diff hunk headers as contamination", async () => {
		await withWorkspace("leniency-unified-diff-header", async ws => {
			const result = await run(ws, "@@ -1,3 +1,3 @@\nPUT 2-2:\n+X");
			expectError(result, /unified-diff hunk header/);
		});
	});

	it("discards unified-diff old rows when explicit new rows follow", async () => {
		await withWorkspace("leniency-unified-diff-old-rows", async ws => {
			const result = await runText(ws, "PUT 2:\n-b\n+B", "a\nB\nc\nd\ne");
			expectWarnings(result, NO_PATH_REL, { includes: [W.DIFF_OLD_ROWS_IGNORED] });
		});
	});

	it("treats top-level `+TEXT` as an orphan literal payload", async () => {
		await withWorkspace("leniency-orphan-payload", async ws => {
			// The old case parsed `+const X = 1;` with no header at all. Natively a
			// valid `[path#tag]` header is required to reach the orphan payload row
			// inside the section, so the header is the one the harness mints.
			const result = await run(ws, "+const X = 1;\nPUT 2-2:");
			expectError(result);
			expect(result.outcome.text).toContain('payload line has no preceding hunk header. Got "+const X = 1;".');
		});
	});
});

describe("hashline apply — duplicate boundary payloads", () => {
	it("keeps replacement boundary echoes literal unless balance repair applies", async () => {
		await withWorkspace("leniency-boundary-echo", async ws => {
			await runText(
				ws,
				"PUT 3-3:\n+// one\n+// two\n+new();",
				["// one", "// two", "// one", "// two", "new();"].join("\n"),
				["// one", "// two", "old();"].join("\n"),
			);
		});
	});

	it("keeps pure-insert context echoes literal", async () => {
		await withWorkspace("leniency-insert-echo", async ws => {
			await runText(ws, "PUT >$:\n+bbb\n+ccc\n+NEW", "aaa\nbbb\nccc\nbbb\nccc\nNEW", ["aaa", "bbb", "ccc"].join("\n"));
		});
	});
});
