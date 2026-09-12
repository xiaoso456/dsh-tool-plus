/**
 * Migrated to the native (Rust) hashline engine.
 *
 * The old suite drove `Patcher` directly; the native engine has no such
 * object — a payload goes through `EditSession` and every observable comes
 * back as the model-facing outcome plus the host writer's requests. Assertions
 * therefore target persisted bytes, per-file outcomes, warnings and the
 * write-gate seam (see `./harness.ts`).
 *
 * Four cases are behavioural re-expressions of three seams native does not
 * expose (a `Patcher` construction guard, `Filesystem.allowTagPathRecovery`,
 * and `Filesystem.preflightWrite`); each says what it now pins and is called
 * out in the migration report:
 * - "requires a snapshot store at construction" → the store is mandatory at
 *   `EditSession` construction (native type-checked guard).
 * - "declines path recovery for a file outside the session cwd" → the same
 *   refuse-recovery contract observed through native's cwd-bounded policy gate.
 * - "runs the write gate on the recovered path…" / "…before the host write gate
 *   is consulted" → the writer-failure seam, which pins what the gate is asked
 *   to gate and that a refusal persists nothing.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	applyPatch,
	expectError,
	expectFile,
	expectSuccess,
	expectWarnings,
	fileOutcome,
	warningsOf,
	withWorkspace,
	Workspace,
} from "./harness.ts";
import type { ApplyResult } from "./harness.ts";
import { computeFileHash, EditSession, formatHashlineHeader } from "../native/index.ts";

const PATH = "a.ts";

/* -------------------------------------------------------------------------- */
/* Engine text the native surface does not export                             */
/* -------------------------------------------------------------------------- */

/**
 * Byte-identical to the old engine's `HEADTAIL_DRIFT_WARNING`
 * (`engine/messages.ts`); the Rust engine emits the same literal
 * (`modes/hashline/messages.rs`).
 */
const HEADTAIL_DRIFT_WARNING =
	"Applied the `PUT <1:`/`PUT >$:` edit despite a stale snapshot tag (file changed since your read) — head/tail position is content-independent. Re-read if the drift was unexpected.";

/** Byte-identical to the old engine's `writeDriftWarning(path)`. */
function writeDriftWarning(path: string): string {
	return (
		`${path}: the file on disk after this write differs from what was sent — the client ` +
		"(editor/IDE) likely reformatted it on save (e.g. format-on-save, tab/space settings). " +
		"The returned snapshot reflects the actual file; re-read before further edits if the " +
		"extra changes were unexpected."
	);
}

/** Byte-identical to the old engine's tag-based path recovery warning. */
function tagPathRecoveryWarning(authored: string, tag: string, resolved: string): string {
	return (
		`Path "${authored}" does not exist; matched its filename and snapshot tag #${tag} to ` +
		`${resolved} (read earlier this session). Anchor future edits on [${resolved}#TAG].`
	);
}

/**
 * The new tag the engine echoed for an applied payload — the `[path#TAG]`
 * header row of the model-facing text (the native replacement for
 * `section.fileHash`).
 */
function tagInOutcome(result: ApplyResult): string | undefined {
	for (const line of result.outcome.text.split("\n")) {
		const match = /^\[.+#([0-9A-Fa-f]{4})\]$/.exec(line.trim());
		if (match) return match[1]?.toUpperCase();
	}
	return undefined;
}

describe("Patcher snapshot tag integrity", () => {
	it("requires a snapshot store at construction", () => {
		// Re-expressed: the old `Patcher` threw `/requires a SnapshotStore/` when
		// built without one. Native replaces the constructor seam with
		// `new EditSession(store, policy, onPreview)` and enforces the same
		// invariant at the napi boundary — a session cannot exist without the
		// store that owns tag provenance.
		const ws = new Workspace("patcher-ctor");
		try {
			expect(() => new EditSession(undefined as never, ws.policy(), null)).toThrow(/EditStore/);
		} finally {
			ws.dispose();
		}
	});

	it("applies when the section tag is the live file's content hash", async () => {
		await withWorkspace("patcher-live-tag", async ws => {
			ws.write(PATH, "before\n");
			const tag = ws.snapshot(PATH, "before\n");

			const result = await applyPatch(ws, `${ws.header(PATH, tag)}\nPUT 1-1:\n+after`);
			expectSuccess(result);

			expect(fileOutcome(result, PATH)?.op).toBe("update");
			const returned = tagInOutcome(result) ?? ws.store.headHash(ws.abs(PATH));
			expect(returned).toMatch(/^[0-9A-F]{4}$/);
			expect(returned).not.toBe(tag);
			expectFile(ws, PATH, "after\n");
		});
	});

	it("restores a UTF-8 BOM hidden by Bun text decoding", async () => {
		await withWorkspace("patcher-bom", async ws => {
			const filePath = ws.abs("Program.cs");
			const source = "using A;\n";
			fs.writeFileSync(filePath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source, "utf8")]));
			const tag = ws.store.recordSnapshot(filePath, source);

			const result = await applyPatch(
				ws,
				[ws.header("Program.cs", tag), "PUT 1-1:", "+using B;"].join("\n"),
			);
			expectSuccess(result);

			const bytes = fs.readFileSync(filePath);
			expect(Array.from(bytes.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
			expect(new TextDecoder().decode(bytes.subarray(3))).toBe("using B;\n");
		});
	});

	it("validates any anchor purely from the content hash, even with no recorded snapshot", async () => {
		// The core fix: the tag fingerprints the WHOLE file. An edit anchored at
		// a line the model never saw recorded applies whenever the live file
		// still hashes to the tag — no stored snapshot is consulted.
		await withWorkspace("patcher-content-hash", async ws => {
			const content = "l1\nl2\nl3\nl4\nl5\n";
			ws.write(PATH, content);
			const tag = computeFileHash(content);
			// Store is intentionally empty: the tag resolves to no snapshot text.
			expect(ws.store.headHash(ws.abs(PATH))).toBeNull();
			expect(ws.store.byHashText(ws.abs(PATH), tag)).toBeNull();

			const result = await applyPatch(ws, `${ws.header(PATH, tag)}\nPUT 3-3:\n+L3`);
			expectSuccess(result);

			expect(fileOutcome(result, PATH)?.op).toBe("update");
			expectFile(ws, PATH, "l1\nl2\nL3\nl4\nl5\n");
		});
	});

	it("normalizes lowercase section tags while parsing", async () => {
		// Native has no parse accessor, so the old `section.fileHash === "1A2B"`
		// assertion is re-expressed on the rejection echo: an authored `#1a2b` is
		// upper-cased before it is compared with the live content hash, so the
		// diagnostic reports the normalized tag.
		await withWorkspace("patcher-lowercase-tag", async ws => {
			ws.write(PATH, "before\n");

			const result = await applyPatch(ws, `[${PATH}#1a2b]\nPUT 1-1:\n+after`);
			expectError(result, /hash #1A2B is not from this session/);
			expectFile(ws, PATH, "before\n");
		});
	});

	it("refuses with mismatch when the recorded version no longer matches live content", async () => {
		await withWorkspace("patcher-mismatch", async ws => {
			ws.write(PATH, "drifted\n");
			// Tag was minted from "before\n" but the live file is "drifted\n".
			const tag = ws.snapshot(PATH, "before\n");

			const result = await applyPatch(ws, `${ws.header(PATH, tag)}\nPUT 1-1:\n+after`);
			// Hash WAS observed for this path, so we land on the "file changed" branch.
			expectError(result, /file changed between read and edit/);
			expect(result.outcome.text).toContain(`Section is bound to #${tag}`);
			// Disk untouched — refusal must never leave a partial write.
			expectFile(ws, PATH, "drifted\n");
			expect(result.requests.length).toBe(0);
		});
	});

	it("refuses with a 'not from this session' diagnostic when the tag was never recorded for this path", async () => {
		await withWorkspace("patcher-not-recorded", async ws => {
			ws.write(PATH, "current\n");
			// A 4-hex tag that is neither the live content hash nor a recorded
			// version — equivalent to the model fabricating it or carrying it over
			// from a prior session.
			const live = computeFileHash("current\n");
			const bogus = live === "FFFF" ? "0000" : "FFFF";

			const result = await applyPatch(ws, `[${PATH}#${bogus}]\nPUT 1-1:\n+after`);
			expectError(result, new RegExp(`hash #${bogus} is not from this session`));
			expect(result.outcome.text).toMatch(/never invent the tag/);
			// Still surfaces the current hash so the model can pivot to a re-read.
			expect(result.outcome.text).toMatch(/current file hashes to #[0-9A-F]{4}/);
			expectFile(ws, PATH, "current\n");
			expect(result.requests.length).toBe(0);
		});
	});

	// A 16-bit snapshot tag can collide across two different file states. Tag
	// equality with the live content is trusted as-is: the model did nothing
	// wrong, and a forced re-read would mint the very same tag. Line anchors
	// therefore index the live text, colliding retained snapshots notwithstanding.
	it("applies onto live content when the tag matches, even against a retained colliding snapshot", async () => {
		// These two texts both hash to `1D84`.
		const SNAPSHOT_TEXT = "line one 263\nline two 4471\n";
		const LIVE_TEXT = "line one 410\nline two 6970\n";
		expect(computeFileHash(SNAPSHOT_TEXT)).toBe(computeFileHash(LIVE_TEXT));

		await withWorkspace("patcher-collision", async ws => {
			ws.write(PATH, LIVE_TEXT);
			// Tag was minted from SNAPSHOT_TEXT; live is the colliding LIVE_TEXT.
			const tag = ws.snapshot(PATH, SNAPSHOT_TEXT, [1, 2]);
			expect(tag).toBe(computeFileHash(SNAPSHOT_TEXT));

			const result = await applyPatch(ws, `${ws.header(PATH, tag)}\nPUT 2-2:\n+edited live`);
			expectSuccess(result);
			expectFile(ws, PATH, "line one 410\nedited live\n");
		});
	});
});

// A write-time transform outside the patcher's control (e.g. an ACP-connected
// editor's format-on-save rewriting indentation on every save) must never
// poison the next section's snapshot tag with content that no longer exists
// on disk. The harness writer's `rewrite` option stands in for that editor:
// every write is persisted verbatim to the backing store (so `ws.read` sees
// ground truth, like the file the reporter grepped with `cat`/`grep` right
// after the tool call returned), but the writer reports back a *reformatted*
// copy — spaces turned into tabs, exactly the corruption reported against the
// ACP bridge.
describe("Patcher snapshot tag stays honest across a write-time content transform", () => {
	it("keys the returned snapshot tag on what the Filesystem actually persisted, not the pre-write content", async () => {
		await withWorkspace("patcher-write-drift", async ws => {
			const original = "function f() {\n    return 1;\n}\n";
			ws.write(PATH, original);
			const tag = ws.snapshot(PATH, original);

			const result = await applyPatch(ws, `${ws.header(PATH, tag)}\nPUT 2-2:\n+    return 2;`, {
				writer: { rewrite: request => (request.content ?? "").replace(/^ {4}/gm, "\t") },
			});
			expectSuccess(result);

			// Ground truth: the Filesystem drifted the untouched line's indentation
			// to tabs on write, exactly like a hostile format-on-save would.
			const onDisk = ws.read(PATH);
			expect(onDisk).toBe("function f() {\n\treturn 2;\n}\n");

			// The returned tag MUST hash the drifted (real) content, not the
			// pre-write text the patcher computed — otherwise the very next edit's
			// tag validation is checked against content the file no longer has.
			const returned = tagInOutcome(result) ?? ws.store.headHash(ws.abs(PATH));
			expect(returned).toBe(computeFileHash(onDisk ?? ""));
			expect(ws.store.headHash(ws.abs(PATH))).toBe(computeFileHash(onDisk ?? ""));
			expect(result.outcome.text.split("\n")[0]).toBe(
				formatHashlineHeader(PATH, computeFileHash(onDisk ?? "")),
			);

			// The drift is surfaced, not swallowed: silent divergence is exactly
			// what turned a one-line edit into unexplained whole-file corruption.
			expectWarnings(result, PATH, { includes: [writeDriftWarning(PATH)] });

			// A follow-up edit anchored on the returned tag must succeed against
			// the real (drifted) file instead of failing a stale-tag mismatch.
			const followUp = await applyPatch(ws, `${ws.header(PATH, returned ?? "")}\nPUT 1-1:\n+function g() {`);
			expectSuccess(followUp);
			expectFile(ws, PATH, "function g() {\n\treturn 2;\n}\n");
		});
	});
});

describe("Patcher mandatory snapshot tag policy", () => {
	it("rejects a hashless head/tail insert — the tag is required on every section", async () => {
		await withWorkspace("patcher-hashless-tail", async ws => {
			ws.write(PATH, "a\nb\n");

			const result = await applyPatch(ws, `[${PATH}]\nPUT >$:\n+c`);
			expectError(result, /Missing hashline snapshot tag.*use the write tool/s);
			expectFile(ws, PATH, "a\nb\n");
			expect(result.requests.length).toBe(0);
		});
	});

	it("still hard-rejects an anchored edit that omits the snapshot tag", async () => {
		await withWorkspace("patcher-hashless-anchor", async ws => {
			ws.write(PATH, "a\nb\n");

			const result = await applyPatch(ws, `[${PATH}]\nPUT 1-1:\n+X`);
			expectError(result, /Missing hashline snapshot tag/);
			expectFile(ws, PATH, "a\nb\n");
		});
	});

	it("rejects a tagged edit whose target file does not exist (create with write instead)", async () => {
		await withWorkspace("patcher-missing-file", async ws => {
			const result = await applyPatch(ws, `[ghost.ts#1A2B]\nPUT >$:\n+c`);
			expectError(result, /File not found.*use the write tool/is);
			expect(result.requests.length).toBe(0);
		});
	});

	it("applies a head/tail insert with a stale tag and warns instead of hard-failing", async () => {
		await withWorkspace("patcher-stale-tail", async ws => {
			const content = "a\nb\n";
			ws.write(PATH, content);
			const live = computeFileHash(content);
			const stale = live === "0000" ? "FFFF" : "0000";

			const result = await applyPatch(ws, `${ws.header(PATH, stale)}\nPUT >$:\n+c`);
			expectSuccess(result);

			expect(fileOutcome(result, PATH)?.op).toBe("update");
			expectFile(ws, PATH, "a\nb\nc\n");
			expectWarnings(result, PATH, { includes: [HEADTAIL_DRIFT_WARNING] });
		});
	});

	it("does not warn when a head/tail insert carries the live tag", async () => {
		await withWorkspace("patcher-live-tail", async ws => {
			const content = "a\nb\n";
			ws.write(PATH, content);
			const tag = ws.snapshot(PATH, content);

			const result = await applyPatch(ws, `${ws.header(PATH, tag)}\nPUT >$:\n+c`);
			expectSuccess(result);

			expect(fileOutcome(result, PATH)?.op).toBe("update");
			expect(warningsOf(result, PATH)).not.toContain(HEADTAIL_DRIFT_WARNING);
			expectFile(ws, PATH, "a\nb\nc\n");
		});
	});
});

describe("Patcher seen-line provenance", () => {
	const CONTENT = "l1\nl2\nl3\nl4\nl5\n";

	it("rejects an edit anchored on a line the read never displayed", async () => {
		await withWorkspace("patcher-unseen-line", async ws => {
			ws.write(PATH, CONTENT);
			// A partial read displayed only lines 1-2 under this tag.
			const tag = ws.snapshot(PATH, CONTENT, [1, 2]);

			const result = await applyPatch(ws, `${ws.header(PATH, tag)}\nPUT 4-4:\n+L4`, {
				policy: { enforceSeenLines: true },
			});
			expectError(result, /never displayed \(it showed/);
			expectFile(ws, PATH, CONTENT);
			expect(result.requests.length).toBe(0);
		});
	});

	it("applies an edit anchored on a displayed line", async () => {
		await withWorkspace("patcher-seen-line", async ws => {
			ws.write(PATH, CONTENT);
			const tag = ws.snapshot(PATH, CONTENT, [1, 2]);

			const result = await applyPatch(ws, `${ws.header(PATH, tag)}\nPUT 2-2:\n+L2`, {
				policy: { enforceSeenLines: true },
			});
			expectSuccess(result);

			expect(fileOutcome(result, PATH)?.op).toBe("update");
			expectFile(ws, PATH, "l1\nL2\nl3\nl4\nl5\n");
		});
	});

	it("widens coverage when more of the same content is re-read (read fusion)", async () => {
		await withWorkspace("patcher-read-fusion", async ws => {
			ws.write(PATH, CONTENT);
			const tag = ws.snapshot(PATH, CONTENT, [1, 2]);
			// Second read of identical content displays lines 4-5: union into the tag.
			ws.snapshot(PATH, CONTENT, [4, 5]);
			expect(ws.store.seenLines(ws.abs(PATH), tag)).toEqual([1, 2, 4, 5]);

			const result = await applyPatch(ws, `${ws.header(PATH, tag)}\nPUT 4-4:\n+L4`, {
				policy: { enforceSeenLines: true },
			});
			expectSuccess(result);

			expect(fileOutcome(result, PATH)?.op).toBe("update");
			expectFile(ws, PATH, "l1\nl2\nl3\nL4\nl5\n");
		});
	});

	it("reveals the actual line content in the rejection and unblocks a same-tag retry", async () => {
		await withWorkspace("patcher-reveal-retry", async ws => {
			ws.write(PATH, CONTENT);
			// Read only surfaced lines 1-2; anchor line 4 is unseen.
			const tag = ws.snapshot(PATH, CONTENT, [1, 2]);

			const first = await applyPatch(ws, `${ws.header(PATH, tag)}\nPUT 4-4:\n+L4`, {
				policy: { enforceSeenLines: true },
			});
			expectError(first, /never displayed \(it showed/);
			expect(first.outcome.text).toContain("Actual file content at those lines:");
			expect(first.outcome.text).toContain("4:l4");
			expectFile(ws, PATH, CONTENT);
			// The revealed line joins the snapshot's seen set.
			expect(ws.store.seenLines(ws.abs(PATH), tag)).toEqual([1, 2, 4]);

			// The revealed line joins the snapshot's seen set, so a straight retry
			// with the same [path#tag] header applies — no extra read required.
			const retry = await applyPatch(ws, `${ws.header(PATH, tag)}\nPUT 4-4:\n+L4`, {
				policy: { enforceSeenLines: true },
			});
			expectSuccess(retry);
			expect(fileOutcome(retry, PATH)?.op).toBe("update");
			expectFile(ws, PATH, "l1\nl2\nl3\nL4\nl5\n");
		});
	});

	it("truncates the reveal at the cap and directs the tail back to a range re-read", async () => {
		await withWorkspace("patcher-reveal-cap", async ws => {
			const bigContent = `${Array.from({ length: 200 }, (_, i) => `l${i + 1}`).join("\n")}\n`;
			ws.write(PATH, bigContent);
			const tag = ws.snapshot(PATH, bigContent, [1]);

			// Anchor 60 unseen lines — over the 40-line inline reveal cap.
			const dels = Array.from({ length: 60 }, (_, i) => `CUT ${100 + i}`).join("\n");
			const attempt = () =>
				applyPatch(ws, `${ws.header(PATH, tag)}\n${dels}`, { policy: { enforceSeenLines: true } });

			const first = await attempt();
			expectError(first, /never displayed \(it showed/);
			expect(first.outcome.text).toContain("Preview of the actual file content at the first 40 unseen line(s)");
			expect(first.outcome.text).toContain("100:l100");
			expect(first.outcome.text).toContain("139:l139");
			expect(first.outcome.text).not.toContain("140:l140");
			expect(first.outcome.text).toMatch(new RegExp(`${PATH}:100-159`));
			expectFile(ws, PATH, bigContent);
			// The truncated reveal must not merge into seenLines.
			expect(ws.store.seenLines(ws.abs(PATH), tag)).toEqual([1]);

			// A straight retry of the same over-cap patch STILL rejects: the
			// truncated reveal must not merge its prefix into seenLines, or the
			// model could split a blind over-cap edit into <=cap-line retries and
			// slip past the range-re-read gate. The reveal window stays anchored
			// at the head (100..139), never advancing to the tail across retries.
			const retry = await attempt();
			expectError(retry, /never displayed \(it showed/);
			expect(retry.outcome.text).toContain("Preview of the actual file content at the first 40 unseen line(s)");
			expect(retry.outcome.text).toContain("100:l100");
			expect(retry.outcome.text).toContain("139:l139");
			expect(retry.outcome.text).not.toContain("140:l140");
			expectFile(ws, PATH, bigContent);
		});
	});

	it("column-clips wide revealed lines, keeps the merge gate closed, and stays anchored across retries", async () => {
		await withWorkspace("patcher-reveal-clip", async ws => {
			// Minified-bundle-style single wide line at anchor 2. Anchor 3 is a
			// short line so we can see the width truncation applied only where
			// needed. The 4KB cap is comfortably over SEEN_LINE_REVEAL_MAX_COLUMNS.
			const wide = "a".repeat(4096);
			const wideContent = `l1\n${wide}\nl3\nl4\n`;
			ws.write(PATH, wideContent);
			const tag = ws.snapshot(PATH, wideContent, [1]);
			const attempt = () =>
				applyPatch(ws, `${ws.header(PATH, tag)}\nPUT 2-3:\n+X\n+Y`, { policy: { enforceSeenLines: true } });

			const first = await attempt();
			expectError(first, /never displayed \(it showed/);
			expect(first.outcome.text).toContain("Preview of the actual file content at the first 2 unseen line(s)");
			// Line 2 is clipped at 512 chars + ellipsis; the full 4KB never leaks
			// into the error preview.
			expect(first.outcome.text).toMatch(/2:a{512}…/);
			expect(first.outcome.text).not.toContain("a".repeat(513));
			// Short line surfaces verbatim.
			expect(first.outcome.text).toContain("3:l3");
			// Guidance routes to a range re-read.
			expect(first.outcome.text).toMatch(new RegExp(`${PATH}:2-3`));
			expectFile(ws, PATH, wideContent);
			expect(ws.store.seenLines(ws.abs(PATH), tag)).toEqual([1]);

			// A straight retry STILL rejects: column-truncated reveals must not
			// merge into seenLines, otherwise the model would land the edit
			// having only seen the first 512 chars of a >4KB line.
			const retry = await attempt();
			expectError(retry, /never displayed \(it showed/);
			expect(retry.outcome.text).toContain("Preview of the actual file content at the first 2 unseen line(s)");
			expect(retry.outcome.text).toMatch(/2:a{512}…/);
			expect(retry.outcome.text).not.toContain("a".repeat(513));
			expectFile(ws, PATH, wideContent);
		});
	});

	it("skips the check when no seen lines were recorded (absent → allow)", async () => {
		await withWorkspace("patcher-no-provenance", async ws => {
			ws.write(PATH, CONTENT);
			const tag = ws.snapshot(PATH, CONTENT);
			expect(ws.store.seenLines(ws.abs(PATH), tag)).toBeNull();

			const result = await applyPatch(ws, `${ws.header(PATH, tag)}\nPUT 4-4:\n+L4`, {
				policy: { enforceSeenLines: true },
			});
			expectSuccess(result);

			expect(fileOutcome(result, PATH)?.op).toBe("update");
			expectFile(ws, PATH, "l1\nl2\nl3\nL4\nl5\n");
		});
	});
});

describe("Patcher tag-based path recovery", () => {
	const NESTED = path.join("pkg", "test", "file.ts");
	const CONTENT = "one\ntwo\nthree\n";

	it("redirects a bare filename to the full path of the file its tag names", async () => {
		await withWorkspace("patcher-recover", async ws => {
			ws.write(NESTED, CONTENT);
			const tag = ws.snapshot(NESTED, CONTENT);
			const resolved = ws.abs(NESTED);

			// The header carries only the basename — the model dropped the directory.
			const result = await applyPatch(ws, `[file.ts#${tag}]\nPUT 2-2:\n+TWO`);
			expectSuccess(result);

			const file = fileOutcome(result, NESTED);
			// The edit landed on the real nested file; the result reports its full path.
			expect(file?.op).toBe("update");
			expect(file?.path).toBe(resolved);
			expectFile(ws, NESTED, "one\nTWO\nthree\n");
			expectWarnings(result, NESTED, { includes: [tagPathRecoveryWarning("file.ts", tag, resolved)] });
		});
	});

	it("declines recovery when the filename does not match the recorded file", async () => {
		await withWorkspace("patcher-recover-name", async ws => {
			ws.write(NESTED, CONTENT);
			const tag = ws.snapshot(NESTED, CONTENT);

			const result = await applyPatch(ws, `[other.ts#${tag}]\nPUT 2-2:\n+TWO`);
			expectError(result, /File not found/);
			expectFile(ws, NESTED, CONTENT);
			expect(result.requests.length).toBe(0);
		});
	});

	it("declines recovery when the tag matches no retained snapshot", async () => {
		await withWorkspace("patcher-recover-unknown-tag", async ws => {
			ws.write(NESTED, CONTENT);
			const tag = ws.snapshot(NESTED, CONTENT);
			const bogus = tag === "FFFF" ? "0000" : "FFFF";

			const result = await applyPatch(ws, `[file.ts#${bogus}]\nPUT 2-2:\n+TWO`);
			expectError(result, /File not found/);
			expectFile(ws, NESTED, CONTENT);
		});
	});

	it("declines recovery when two retained files share the filename and tag", async () => {
		await withWorkspace("patcher-recover-ambiguous", async ws => {
			ws.write(path.join("a", "file.ts"), CONTENT);
			ws.write(path.join("b", "file.ts"), CONTENT);
			const tag = ws.snapshot(path.join("a", "file.ts"), CONTENT);
			ws.snapshot(path.join("b", "file.ts"), CONTENT);

			const result = await applyPatch(ws, `[file.ts#${tag}]\nPUT 2-2:\n+TWO`);
			expectError(result, /File not found/);
			expectFile(ws, path.join("a", "file.ts"), CONTENT);
			expectFile(ws, path.join("b", "file.ts"), CONTENT);
		});
	});

	it("declines recovery for a file outside the session cwd", async () => {
		// Re-expressed: the old host switch (`Filesystem.allowTagPathRecovery() →
		// false`) has no native equivalent, but the policy gate it stood for does
		// exist natively and is observable — tag recovery only rebinds inside
		// `policy.cwd`. A snapshot of the same-named file *outside* the cwd
		// therefore declines recovery: the authored bare path is used as-is, the
		// edit is refused with not-found, the real file stays untouched and the
		// host writer is never consulted.
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "hashline-outside-"));
		try {
			await withWorkspace("patcher-recover-refused", async ws => {
				const outsideAbs = path.join(outside, NESTED);
				fs.mkdirSync(path.dirname(outsideAbs), { recursive: true });
				fs.writeFileSync(outsideAbs, CONTENT);
				const tag = ws.store.recordSnapshot(outsideAbs, CONTENT);

				const result = await applyPatch(ws, `[file.ts#${tag}]\nPUT 2-2:\n+TWO`);
				expectError(result, /File not found/);
				expect(result.requests.length).toBe(0);
				expect(fs.readFileSync(outsideAbs, "utf8")).toBe(CONTENT);
				expect(ws.exists("file.ts")).toBe(false);
			});
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	it("runs the write gate on the recovered path, not the authored bare path", async () => {
		// Re-expressed through the writer-failure seam: the host gate refuses the
		// write, and what it was asked to gate is the contract — recovery has
		// already rebound the section to the real nested path, so the single write
		// request targets it (never the authored `file.ts`), the refusal surfaces
		// verbatim, and nothing is persisted.
		await withWorkspace("patcher-gate-recovered", async ws => {
			ws.write(NESTED, CONTENT);
			const tag = ws.snapshot(NESTED, CONTENT);

			const result = await applyPatch(ws, `[file.ts#${tag}]\nPUT 2-2:\n+TWO`, {
				writer: { failAt: [0, "write gate: read-only"] },
			});
			expectError(result, "write gate: read-only");
			expect(result.requests.length).toBe(1);
			expect(result.requests[0]?.path).toBe(ws.abs(NESTED));
			expect(result.requests[0]?.op).toBe("update");
			expect(result.requests.every(request => request.path !== "file.ts")).toBe(true);
			expect(result.writerErrors).toEqual(["write gate: read-only"]);
			expectFile(ws, NESTED, CONTENT);
		});
	});

	it("surfaces file-not-found before the host write gate is consulted", async () => {
		// Re-expressed (ordering inverted by the engine swap): the old suite ran
		// `preflightWrite()` first, so the gate rejection won over not-found.
		// Native resolves and reads the target before staging any write, so an
		// unrecoverable authored path yields not-found with the host writer never
		// called — the gate cannot win because it is never asked, and the disk is
		// untouched either way.
		await withWorkspace("patcher-gate-notfound", async ws => {
			ws.write(NESTED, CONTENT);

			const result = await applyPatch(ws, `[file.ts#ABCD]\nPUT 1-1:\n+X`, {
				writer: { failAt: [0, "write gate: read-only"] },
			});
			expectError(result, /File not found/);
			expect(result.requests.length).toBe(0);
			expect(result.writerErrors).toEqual([]);
			expectFile(ws, NESTED, CONTENT);
		});
	});
});
