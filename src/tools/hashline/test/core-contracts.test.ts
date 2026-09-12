/**
 * Hashline engine contracts — migrated from the pre-18.0 TS engine to the
 * native (Rust) `EditSession` surface.
 *
 * The engine directory is gone, so every internal object the old suite drove
 * directly has a behavioural replacement here:
 *
 * - `Patch.parseSingle(...).applyTo(text)` → a session run over a real file
 *   (`run()` below writes, snapshots, authors `[rel#tag]`, applies). One
 *   payload stays content-independent across snapshots, which is the property
 *   the old reusable `PatchSection` pinned.
 * - `Patch.parseSingle(...)` → `{path, fileHash, diff}` projection → the
 *   native static projection `editInspect("hashline", argsJson)`
 *   (`paths` + `entries` added-lines digest) for path/body, plus a session run
 *   for the tag, which the engine validates against the store.
 * - `parsePatch(diff).edits` / `applyEdits(text, edits)` → payload text in,
 *   `fileOutcome(...).newText` / persisted bytes out.
 * - `new Recovery(cache).tryRecover(...)` → a stale-tag apply over a drifted
 *   file: the engine either replays from an older in-session snapshot
 *   (success + recovery warning) or rejects and stages nothing.
 * - `BlockingFilesystem.preflightWrite` → no host hook exists; see the
 *   preflight case for the staging-gate equivalent and GAP-2 in the report.
 * - `InMemorySnapshotStore` → `EditStore` (`recordSnapshot`), and
 *   `InMemoryFilesystem` → the real temp workspace the harness owns.
 *
 * Rejections do not throw: `{isError:true, text}` carries the model-facing
 * teaching text, and the message constants are byte-identical to the deleted
 * `engine/messages.ts`, so the original regexes are kept verbatim.
 */
import { describe, expect, it } from "vitest";

import {
	applyArgs,
	applyPatch,
	expectError,
	expectFile,
	expectSuccess,
	expectWarnings,
	fileOutcome,
	withWorkspace,
} from "./harness.ts";
import type { ApplyResult, Workspace } from "./harness.ts";
import {
	computeFileHash,
	detectLineEnding,
	editInspect,
	formatHashlineHeader,
	normalizeToLF,
	restoreLineEndings,
} from "../native/index.ts";

const REL = "a.ts";

/** The three-line text most range-anchor cases apply against. */
const CONTENT = "aaa\nbbb\nccc";

/** The `*** Abort` sentinel that ends a payload without a warning. */
const ABORT_SENTINEL = "*** Abort";

/**
 * Write `text`, snapshot it, and apply `payload` under a fresh `[rel#tag]`
 * header. Re-running against the same workspace rewrites and re-snapshots, so
 * every call starts from the case's own source text.
 */
async function run(ws: Workspace, text: string, payload: string, rel = REL): Promise<ApplyResult> {
	ws.write(rel, text);
	const tag = ws.snapshot(rel, text);
	return applyPatch(ws, `${ws.header(rel, tag)}\n${payload}`);
}

/** Applied text of one file — the old `applyTo(...).text` / `applyEdits(...).text`. */
function applied(result: ApplyResult, rel = REL): string | undefined {
	return fileOutcome(result, rel)?.newText;
}

describe("hashline normalization", () => {
	it("preserves the first newline style when restoring mixed-ending files", () => {
		expect(detectLineEnding("a\r\nb\nc")).toBe("\r\n");
		expect(detectLineEnding("a\nb\r\nc")).toBe("\n");
		// The engine normalizes to LF internally and restores the detected style
		// on write-back; the round trip must not lose the first style seen.
		expect(restoreLineEndings(normalizeToLF("a\r\nb\r\nc"), detectLineEnding("a\r\nb\nc"))).toBe("a\r\nb\r\nc");
	});
});

describe("hashline parser — range-anchor contracts", () => {
	it("keeps parsed sections reusable across target snapshots", async () => {
		await withWorkspace("core-range-reuse", async ws => {
			// Old: one `PatchSection` applied to two target texts. Native has no
			// section object, but one payload must stay content-independent:
			// `PUT >2:` lands after line 2 of whichever snapshot it is applied to.
			const payload = "PUT >2:\n+tail";

			const two = await run(ws, "aaa\nbbb", payload);
			expectSuccess(two);
			expect(applied(two)).toBe("aaa\nbbb\ntail");

			const three = await run(ws, "aaa\nbbb\nccc", payload);
			expectSuccess(three);
			expect(applied(three)).toBe("aaa\nbbb\ntail\nccc");
		});
	});

	it("applies canonical PUT/CUT operations against concrete anchors", async () => {
		await withWorkspace("core-range-canonical", async ws => {
			const diff = ["PUT <2:", "+before b", "PUT >2:", "+after b", "PUT <1:", "+top", "PUT >$:", "+tail"].join(
				"\n",
			);
			const multi = await run(ws, CONTENT, diff);
			expectSuccess(multi);
			expect(applied(multi)).toBe("top\naaa\nbefore b\nbbb\nafter b\nccc\ntail");

			const cutOne = await run(ws, CONTENT, "CUT 2");
			expectSuccess(cutOne);
			expect(applied(cutOne)).toBe("aaa\nccc");

			const cutRange = await run(ws, CONTENT, "CUT 2-3");
			expectSuccess(cutRange);
			expect(applied(cutRange)).toBe("aaa");

			const replace = await run(ws, CONTENT, "PUT 2:\n+BBB");
			expectSuccess(replace);
			expect(applied(replace)).toBe("aaa\nBBB\nccc");
		});
	});

	it("inserts after the final line without falling off the file", async () => {
		await withWorkspace("core-range-final-line", async ws => {
			const result = await run(ws, CONTENT, "PUT >3:\n+tail");
			expectSuccess(result);
			expect(applied(result)).toBe("aaa\nbbb\nccc\ntail");
		});
	});

	it("preserves whitespace-bearing and sigil-leading payload exactly", async () => {
		await withWorkspace("core-range-payload-verbatim", async ws => {
			const payload = "\tconst streamKeepaliveMs = opts.streamKeepaliveMs;";
			const spaced = await run(ws, CONTENT, `PUT >2:\n+${payload}`);
			expectSuccess(spaced);
			expect(applied(spaced)).toBe(`aaa\nbbb\n${payload}\nccc`);

			const sigils = await run(ws, CONTENT, "PUT 2:\n+|literal\n+^literal\n+↓literal");
			expectSuccess(sigils);
			expect(applied(sigils)).toBe("aaa\n|literal\n^literal\n↓literal\nccc");
		});
	});

	it("strips copied read-output prefixes only inside pasted bare body rows", async () => {
		await withWorkspace("core-range-bare-prefix", async ws => {
			const result = await run(ws, "aaa\nbbb\nccc\nddd\neee", "PUT 2-4:\n+line one\n3:line two");
			expectSuccess(result);
			expect(applied(result)).toBe("aaa\nline one\nline two\neee");
			expectWarnings(result, REL, {
				includes: ["Auto-prefixed bare body row(s) with `+`. Body rows must be `+TEXT` literal lines."],
			});
		});
	});

	it("rejects overlapping replacement ranges", async () => {
		await withWorkspace("core-range-overlap", async ws => {
			const diff = "PUT 2-4:\n+NEW1\nPUT 3-5:\n+NEW2";
			expectError(
				await run(ws, "aaa\nbbb\nccc\nddd\neee", diff),
				/anchor line 3 is already targeted by another hunk on line 1/,
			);
			// A rejected batch stages nothing.
			expectFile(ws, REL, "aaa\nbbb\nccc\nddd\neee");
		});
	});

	it("rejects obsolete line-hash anchors and applies line-number anchors without per-anchor hashes", async () => {
		await withWorkspace("core-range-obsolete-anchor", async ws => {
			expectError(await run(ws, CONTENT, "2ab:\n+BBB"), /payload line has no preceding hunk header/);
			expectFile(ws, REL, CONTENT);

			const result = await run(ws, CONTENT, "PUT 2:\n+BBB");
			expectSuccess(result);
			expect(applied(result)).toBe("aaa\nBBB\nccc");
		});
	});
});

describe("hashline input splitter", () => {
	it("extracts path, snapshot tag, and diff body from bracket headers", async () => {
		await withWorkspace("core-splitter-header", async ws => {
			const text = "l1\nl2\nl3\n";
			ws.write("src/foo.ts", text);
			const tag = ws.snapshot("src/foo.ts", text);
			const payload = "PUT 2:\n+BBB";

			// Old: `Patch.parseSingle(...)` → `{path, fileHash, diff}`. Native's
			// static projection carries the path and the added-lines body; the tag
			// is pinned through the session, where it must resolve in the store.
			const inspection = editInspect("hashline", JSON.stringify({ input: `[src/foo.ts#${tag}]\n${payload}` }));
			expect(inspection.paths).toEqual(["src/foo.ts"]);
			expect(inspection.entries).toEqual([{ path: "src/foo.ts", digest: "BBB" }]);

			// An invented tag is read out of the header and rejected before any write.
			const bogus = await applyPatch(ws, `[src/foo.ts#FFFF]\n${payload}`);
			expectError(bogus, /hash #FFFF is not from this session/);
			expect(bogus.requests).toEqual([]);
			expectFile(ws, "src/foo.ts", text);

			// The real tag binds the body to the snapshot and lands the edit.
			const result = await applyPatch(ws, `[src/foo.ts#${tag}]\n${payload}`);
			expectSuccess(result);
			expect(applied(result, "src/foo.ts")).toBe("l1\nBBB\nl3\n");
			expect(result.outcome.text).toBe(`[src/foo.ts#${computeFileHash("l1\nBBB\nl3\n")}]\n1:l1\n2:BBB\n3:l3`);
			expectFile(ws, "src/foo.ts", "l1\nBBB\nl3\n");
		});
	});

	it("normalizes leading blanks, cwd-relative paths, and explicit fallback paths", async () => {
		await withWorkspace("core-splitter-normalize", async ws => {
			// Leading blank lines before the header are skipped.
			const lead = editInspect("hashline", JSON.stringify({ input: `\n[foo.ts]\nPUT <1:\n+x` }));
			expect(lead.paths).toEqual(["foo.ts"]);
			expect(lead.entries).toEqual([{ path: "foo.ts", digest: "x" }]);

			// An absolute header path inside `policy.cwd` is reported cwd-relative
			// (old: `splitHashlineInput(..., {cwd}).path === "src/foo.ts"`).
			ws.write("src/foo.ts", "l1\n");
			const tag = ws.snapshot("src/foo.ts", "l1\n");
			const absolute = ws.abs("src/foo.ts").replaceAll("\\", "/");
			const relative = await applyPatch(ws, `[${absolute}#${tag}]\nPUT <1:\n+x`);
			expectSuccess(relative);
			expect(fileOutcome(relative, "src/foo.ts")?.displayPath).toBe("src/foo.ts");
			expectFile(ws, "src/foo.ts", "x\nl1\n");

			// The old `{path}` fallback has no native equivalent: the path AND the
			// tag must come from the header. An args-level `path` is ignored and
			// the payload is rejected — exactly the old "plain text" contract.
			expectError(await applyArgs(ws, { input: "PUT <1:\n+x", path: "src/foo.ts" }), /must begin with/);
			expectError(await applyArgs(ws, { input: "plain text", path: "src/foo.ts" }), /must begin with/);
			// A header without a tag is rejected too — there is no typeless fallback.
			expectError(await applyPatch(ws, "[src/foo.ts]\nPUT <1:\n+x"), /Missing hashline snapshot tag/);
			expectFile(ws, "src/foo.ts", "x\nl1\n");
		});
	});

	it("splits multiple sections and drops a trailing header without operations", async () => {
		await withWorkspace("core-splitter-sections", async ws => {
			const twoOps = ["[a.ts]", "PUT <1:", "+a", "[b.ts]", "PUT >$:", "+b"].join("\n");
			const inspection = editInspect("hashline", JSON.stringify({ input: twoOps }));
			expect(inspection.paths).toEqual(["a.ts", "b.ts"]);
			expect(inspection.entries).toEqual([
				{ path: "a.ts", digest: "a" },
				{ path: "b.ts", digest: "b" },
			]);

			// A trailing header with no operations still names its path but
			// contributes no ops.
			const trailing = ["[a.ts]", "PUT <1:", "+a", "[b.ts]"].join("\n");
			const trailingInspection = editInspect("hashline", JSON.stringify({ input: trailing }));
			expect(trailingInspection.paths).toEqual(["a.ts", "b.ts"]);
			expect(trailingInspection.entries).toEqual([{ path: "a.ts", digest: "a" }]);

			// Behaviourally: the bodyless trailing section stages no write.
			ws.write("a.ts", "l1\n");
			ws.write("b.ts", "b1\n");
			const aTag = ws.snapshot("a.ts");
			const bTag = ws.snapshot("b.ts");
			const bodyless = await applyPatch(ws, `[a.ts#${aTag}]\nPUT <1:\n+a\n[b.ts#${bTag}]`);
			expectSuccess(bodyless);
			expect(bodyless.requests.map(request => request.displayPath)).toEqual(["a.ts"]);
			expectFile(ws, "a.ts", "a\nl1\n");
			expectFile(ws, "b.ts", "b1\n");

			// Both sections really do apply when both carry operations.
			const aTag2 = ws.snapshot("a.ts");
			const both = await applyPatch(ws, `[a.ts#${aTag2}]\nPUT <1:\n+a\n[b.ts#${bTag}]\nPUT >$:\n+b`);
			expectSuccess(both);
			expect(applied(both, "a.ts")).toBe("a\na\nl1\n");
			expect(applied(both, "b.ts")).toBe("b1\nb\n");
			expectFile(ws, "a.ts", "a\na\nl1\n");
			expectFile(ws, "b.ts", "b1\nb\n");
		});
	});

	it("rejects unified-diff hunk headers on the first line", async () => {
		await withWorkspace("core-splitter-unified", async ws => {
			const input = ["@@ -1,3 +1,3 @@", "PUT <1:", "+x"].join("\n");
			expectError(await applyPatch(ws, input), /unified-diff hunk header/);
		});
	});
});

describe("Patcher preflight", () => {
	it("preflights write policy for every section before committing a batch", async () => {
		await withWorkspace("core-preflight", async ws => {
			ws.write("a.ts", "aaa\n");
			ws.write("b.ts", "bbb\n");
			const aTag = ws.snapshot("a.ts");

			// Old: `BlockingFilesystem.preflightWrite` refused b.ts and
			// `Patcher.apply` committed nothing. Native has no host preflight hook
			// — the writer is the write policy and is invoked per file — so the
			// equivalent contract is the staging gate: a section that cannot be
			// validated (here an invented tag on the SECOND section) rejects the
			// whole call before the first write lands.
			const input = [
				formatHashlineHeader("a.ts", aTag),
				"PUT 1:",
				"+AAA",
				formatHashlineHeader("b.ts", "FFFF"),
				"PUT 1:",
				"+BBB",
			].join("\n");

			const result = await applyPatch(ws, input);
			expectError(result, /hash #FFFF is not from this session/);
			expect(result.requests).toEqual([]);
			expectFile(ws, "a.ts", "aaa\n");
			expectFile(ws, "b.ts", "bbb\n");
		});
	});
});

describe("Recovery", () => {
	it("returns null when neither patch recovery nor replay can land", async () => {
		await withWorkspace("core-recovery-null", async ws => {
			const snapshotText = "alpha\nbeta\ngamma\ndelta\nepsilon";
			const currentText = "totally\nunrelated\ncontent\nhere\nnow\n";
			ws.write("u.ts", currentText);
			const tag = ws.snapshot("u.ts", snapshotText);

			// Old: `new Recovery(cache).tryRecover(...)` → null. Native reports the
			// same dead end as a rejection whose text pins both hashes, and stages
			// nothing.
			const result = await applyPatch(ws, `${ws.header("u.ts", tag)}\nPUT 2-2:\n+BETA-MODEL`);
			expectError(result, /file changed between read and edit/);
			expect(result.outcome.text).toContain(
				`Section is bound to #${tag}, but the current file hashes to #${computeFileHash(currentText)}`,
			);
			expect(result.requests).toEqual([]);
			expectFile(ws, "u.ts", currentText);
		});
	});

	it("recovers from an older in-session snapshot after the current file advanced", async () => {
		await withWorkspace("core-recovery-ring", async ws => {
			const v0Text = "L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10\n";
			const v1Text = "L1\nL2-EDITED\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10\n";
			const currentText = "L1\nL2-EDITED\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10\nTRAILER\n";
			ws.write("r.ts", currentText);
			const v0Tag = ws.snapshot("r.ts", v0Text);
			ws.snapshot("r.ts", v1Text);

			const result = await applyPatch(ws, `${ws.header("r.ts", v0Tag)}\nPUT 10-10:\n+L10-EDITED`);
			expectSuccess(result);
			expect(applied(result, "r.ts")).toContain("L10-EDITED");
			expectWarnings(result, "r.ts", {
				includes: [
					"Recovered from a stale file hash using an earlier in-session snapshot (a prior edit in this session advanced the hash).",
				],
			});
			expectFile(ws, "r.ts", "L1\nL2-EDITED\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10-EDITED\nTRAILER\n");
		});
	});
});

describe("hashline abort sentinel", () => {
	it("terminates parsing without surfacing a warning", async () => {
		await withWorkspace("core-abort-sentinel", async ws => {
			const text = "l1\nl2\nl3\n";
			ws.write(REL, text);
			const tag = ws.snapshot(REL, text);
			const diff = ["PUT >1:", "+HELLO", ABORT_SENTINEL, "PUT >99:", "+never"].join("\n");

			const result = await applyPatch(ws, `${ws.header(REL, tag)}\n${diff}`);
			expectSuccess(result);
			// Exactly one hunk was parsed and applied; the bogus post-sentinel hunk
			// (line 99 of a 3-line file) never lands.
			expect(result.requests.map(request => request.displayPath)).toEqual([REL]);
			expect(applied(result)).toBe("l1\nHELLO\nl2\nl3\n");
			// Old: `parsePatch(diff).warnings` was `[]` — the sentinel is silent.
			expectWarnings(result, REL, { exact: [] });
			expectFile(ws, REL, "l1\nHELLO\nl2\nl3\n");
		});
	});

	it("stops the input splitter before later sections", async () => {
		await withWorkspace("core-abort-splitter", async ws => {
			ws.write("a.ts", "l1\nl2\nl3\n");
			ws.write("b.ts", "b1\n");
			const aTag = ws.snapshot("a.ts");
			const bTag = ws.snapshot("b.ts");
			const input = [
				`[a.ts#${aTag}]`,
				"PUT >1:",
				"+a-payload",
				ABORT_SENTINEL,
				`[b.ts#${bTag}]`,
				"PUT >1:",
				"+never",
			].join("\n");

			const result = await applyPatch(ws, input);
			expectSuccess(result);
			// Old: the splitter returned one section whose diff excluded "never".
			// Native: the parse stops at the sentinel, so the second section is
			// never staged and b.ts keeps its bytes.
			expect(result.outcome.files.map(file => file.displayPath)).toEqual(["a.ts"]);
			expect(result.requests.map(request => request.displayPath)).toEqual(["a.ts"]);
			expectFile(ws, "a.ts", "l1\na-payload\nl2\nl3\n");
			expectFile(ws, "b.ts", "b1\n");
		});
	});
});

describe("hashline parser — cut and blank payload semantics", () => {
	it("applies inline cut operations", async () => {
		await withWorkspace("core-cut-inline", async ws => {
			const one = await run(ws, "line1\nline2\nline3\n", "CUT 2");
			expectSuccess(one);
			expect(applied(one)).toBe("line1\nline3\n");

			const range = await run(ws, "line1\nline2\nline3\nline4\n", "CUT 2-3");
			expectSuccess(range);
			expect(applied(range)).toBe("line1\nline4\n");
		});
	});

	it("treats old inline replacement syntax as orphan body", async () => {
		await withWorkspace("core-cut-orphan-body", async ws => {
			expectError(await run(ws, "a\nb\nc", "2.=2=replacement"), /payload line has no preceding hunk header/);
			expectFile(ws, REL, "a\nb\nc");
		});
	});

	it("preserves explicit blank replacement rows", async () => {
		await withWorkspace("core-blank-rows", async ws => {
			const text = "a\nb\nc\nd\ne\n";
			const ops = ["PUT 2-2:", "+", "+", "PUT 4-4:", "+D"].join("\n");
			const result = await run(ws, text, ops);
			expectSuccess(result);
			expect(applied(result)).toBe("a\n\n\nc\nD\ne\n");
			expectFile(ws, REL, "a\n\n\nc\nD\ne\n");

			const embedded = ["PUT 2-2:", "+first", "+", "+second"].join("\n");
			const embeddedResult = await run(ws, "a\nb\nc\n", embedded);
			expectSuccess(embeddedResult);
			expect(applied(embeddedResult)).toBe("a\nfirst\n\nsecond\nc\n");
			expectFile(ws, REL, "a\nfirst\n\nsecond\nc\n");
		});
	});
});
