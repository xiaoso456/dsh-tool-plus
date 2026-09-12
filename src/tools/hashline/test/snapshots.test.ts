/**
 * Native snapshot-store contract (`EditStore`), migrated from the deleted TS
 * `InMemorySnapshotStore` suite.
 *
 * The old store was a JS class with constructor options (`maxVersionsPerPath`,
 * `maxPaths`) and extra read APIs (`head`, `byHash`, `byContent`, `findByHash`).
 * The native store keeps the same observable model — content-derived 4-hex tags,
 * per-path version history, provenance, promotion, LRU eviction — behind a
 * narrower N-API surface:
 *
 *   `recordSnapshot(abs, text, seenLines?) → tag`, `recordSnapshotFile`,
 *   `recordSeenLines`, `recordSeenLinesFromBody`, `headText`, `headHash`,
 *   `byHashText(abs, tag)`, `seenLines(abs, tag)`, `invalidate`, `relocate`,
 *   `clear`.
 *
 * The cases below therefore assert the same behaviour through those accessors.
 * Four formerly-internals-bound cases (per-path version limit, path-count
 * eviction, cross-path `findByHash`, collider `byContent` separation) are
 * re-expressed behaviourally against the production defaults; the exact limit
 * semantics are owned upstream by
 * `refs/oh-my-pi/crates/pi-edit/tests/hashline_parity.rs::snapshot_store_matches_snapshot_contract_cases`
 * (it drives `with_limits(8, 2)` / `with_limits(1, 4)`, `find_by_hash` and
 * `by_content`) and `refs/oh-my-pi/crates/pi-edit/src/store.rs::version_and_lru_limits_are_enforced`.
 * Each re-expression names what it pins.
 */
import { describe, expect, it } from "vitest";

import { withWorkspace } from "./harness.ts";
import { computeFileHash, EditStore } from "../native/index.ts";

const PATH = "snapshots.ts";
const OTHER = "snapshots-other.ts";
const DEST = "snapshots-dest.ts";
const TAG_RE = /^[0-9A-F]{4}$/;

/** Production retention defaults (`pi-edit/src/store.rs`). */
const DEFAULT_MAX_VERSIONS_PER_PATH = 4;
const DEFAULT_MAX_PATHS = 256;

describe("EditStore (native snapshot store)", () => {
	it("derives the tag from whole-file content (matches computeFileHash)", async () => {
		await withWorkspace("snapshots-hash", async ws => {
			const store = new EditStore();
			const text = "L1\nL2\nL3\n";
			const tag = store.recordSnapshot(ws.abs(PATH), text);
			expect(tag).toMatch(TAG_RE);
			expect(tag).toBe(computeFileHash(text));
		});
	});

	it("fuses repeated reads of identical content onto one tag", async () => {
		await withWorkspace("snapshots-fuse", async ws => {
			const store = new EditStore();
			const abs = ws.abs(PATH);
			const text = "alpha\nbeta\ngamma\n";
			const first = store.recordSnapshot(abs, text);
			const second = store.recordSnapshot(abs, text);
			expect(second).toBe(first);
			// One head, and the tag resolves to that same full text.
			expect(store.headHash(abs)).toBe(first);
			expect(store.headText(abs)).toBe(text);
			expect(store.byHashText(abs, first)).toBe(text);
		});
	});

	it("mints a new tag when content changes and retains the prior version", async () => {
		await withWorkspace("snapshots-newtag", async ws => {
			const store = new EditStore();
			const abs = ws.abs(PATH);
			const v1 = "one\ntwo\n";
			const v2 = "one\ntwo\nthree\n";
			const tag1 = store.recordSnapshot(abs, v1);
			const tag2 = store.recordSnapshot(abs, v2);
			expect(tag2).not.toBe(tag1);
			// Head is the latest; the older version is still resolvable by its tag.
			expect(store.headHash(abs)).toBe(tag2);
			expect(store.headText(abs)).toBe(v2);
			expect(store.byHashText(abs, tag1)).toBe(v1);
			expect(store.byHashText(abs, tag2)).toBe(v2);
		});
	});

	it("promotes a re-observed older version back to head", async () => {
		await withWorkspace("snapshots-promote", async ws => {
			const store = new EditStore();
			const abs = ws.abs(PATH);
			const v1 = "x\n";
			const v2 = "y\n";
			const tag1 = store.recordSnapshot(abs, v1);
			store.recordSnapshot(abs, v2);
			// File reverts to v1 content: recording it again makes v1 the head.
			expect(store.recordSnapshot(abs, v1)).toBe(tag1);
			expect(store.headHash(abs)).toBe(tag1);
			expect(store.headText(abs)).toBe(v1);
		});
	});

	it("bounds per-path history to the default version limit (oldest dropped)", async () => {
		await withWorkspace("snapshots-versions", async ws => {
			const store = new EditStore();
			const abs = ws.abs(PATH);
			// Re-expression of the old `{maxVersionsPerPath: 2}` case against the
			// production default (4 versions per path, `src/store.rs`): record one
			// version MORE than the default retains, then pin which tags survive.
			// The option-shaped oracle stays upstream in
			// `snapshot_store_matches_snapshot_contract_cases` (`with_limits(8, 2)`).
			const v1 = "version one\n";
			const v2 = "version two\n";
			const v3 = "version three\n";
			const v4 = "version four\n";
			const v5 = "version five\n";
			const t1 = store.recordSnapshot(abs, v1);
			const t2 = store.recordSnapshot(abs, v2);
			const t3 = store.recordSnapshot(abs, v3);
			const t4 = store.recordSnapshot(abs, v4);
			const t5 = store.recordSnapshot(abs, v5);
			expect(new Set([t1, t2, t3, t4, t5]).size).toBe(DEFAULT_MAX_VERSIONS_PER_PATH + 1);

			// The newest four resolve; the fifth-oldest was dropped.
			expect(store.byHashText(abs, t5)).toBe(v5);
			expect(store.byHashText(abs, t4)).toBe(v4);
			expect(store.byHashText(abs, t3)).toBe(v3);
			expect(store.byHashText(abs, t2)).toBe(v2);
			expect(store.byHashText(abs, t1)).toBeNull();
			expect(store.headHash(abs)).toBe(t5);
		});
	});

	it("bounds tracked paths to the default path limit (cold path evicted)", async () => {
		await withWorkspace("snapshots-paths", async ws => {
			const store = new EditStore();
			const recorded: Array<{ abs: string; tag: string }> = [];
			for (let index = 0; index < DEFAULT_MAX_PATHS + 1; index += 1) {
				const abs = ws.abs(`snapshots-lru-${index}.ts`);
				recorded.push({ abs, tag: store.recordSnapshot(abs, `path ${index}\n`) });
			}
			const at = (index: number): { abs: string; tag: string } => {
				const entry = recorded[index];
				if (entry === undefined) throw new Error(`no recorded path at ${index}`);
				return entry;
			};

			// Re-expression of the old `{maxPaths: 1}` case against the production
			// default (256 retained paths, `src/store.rs`): recording the 257th path
			// evicts the least-recently-recorded one, and the surviving neighbours
			// keep their tags. The option-shaped oracle stays upstream
			// (`with_limits(1, 4)`).
			expect(store.headText(at(0).abs)).toBeNull();
			expect(store.byHashText(at(0).abs, at(0).tag)).toBeNull();
			expect(store.headHash(at(1).abs)).toBe(at(1).tag);
			expect(store.headHash(at(DEFAULT_MAX_PATHS).abs)).toBe(at(DEFAULT_MAX_PATHS).tag);
		});
	});

	it("rejects cross-path lookups", async () => {
		await withWorkspace("snapshots-crosspath", async ws => {
			const store = new EditStore();
			const abs = ws.abs(PATH);
			const other = ws.abs(OTHER);
			const tag = store.recordSnapshot(abs, "shared\n");
			expect(store.byHashText(abs, tag)).toBe("shared\n");
			expect(store.byHashText(other, tag)).toBeNull();
			expect(store.headHash(other)).toBeNull();
		});
	});

	it("invalidate drops one path; clear drops everything", async () => {
		await withWorkspace("snapshots-invalidate", async ws => {
			const store = new EditStore();
			const abs = ws.abs(PATH);
			const other = ws.abs(OTHER);
			const tagA = store.recordSnapshot(abs, "A\n");
			const tagB = store.recordSnapshot(other, "B\n");
			store.invalidate(abs);
			expect(store.byHashText(abs, tagA)).toBeNull();
			expect(store.headHash(abs)).toBeNull();
			expect(store.byHashText(other, tagB)).toBe("B\n");
			store.clear();
			expect(store.byHashText(other, tagB)).toBeNull();
			expect(store.headHash(other)).toBeNull();
		});
	});

	it("relocate moves version history and read provenance to a new path", async () => {
		await withWorkspace("snapshots-relocate", async ws => {
			const store = new EditStore();
			const abs = ws.abs(PATH);
			const dest = ws.abs(DEST);
			const tag = store.recordSnapshot(abs, "A\n", [1]);
			store.relocate(abs, dest);
			expect(store.byHashText(abs, tag)).toBeNull();
			expect(store.byHashText(dest, tag)).toBe("A\n");
			// Provenance travels with the version. Native returns the recorded
			// line numbers as an array where the old store exposed a `Set`.
			expect(store.seenLines(dest, tag)).toEqual([1]);
			expect(store.headHash(dest)).toBe(tag);
			expect(store.headText(dest)).toBe("A\n");
		});
	});

	it("resolves a shared tag on every path that recorded it (findByHash across paths)", async () => {
		await withWorkspace("snapshots-findbyhash", async ws => {
			const store = new EditStore();
			const abs = ws.abs(PATH);
			const other = ws.abs(OTHER);
			const text = "shared\n";
			const tag = store.recordSnapshot(abs, text);
			store.recordSnapshot(other, text);

			// Re-expression of `findByHash(tag)` (which returned every retained
			// version carrying the tag, across paths). The N-API has no cross-path
			// scan, so the same contract is pinned per path: each recording path
			// resolves the tag to its own retained version and reports it as head.
			expect(store.byHashText(abs, tag)).toBe(text);
			expect(store.byHashText(other, tag)).toBe(text);
			expect(store.headHash(abs)).toBe(tag);
			expect(store.headHash(other)).toBe(tag);

			// A tag no retained version carries resolves nowhere.
			const missing = tag === "0000" ? "FFFF" : "0000";
			expect(store.byHashText(abs, missing)).toBeNull();
			expect(store.byHashText(other, missing)).toBeNull();
		});
	});

	// 4-hex tags are the low 16 bits of a non-cryptographic hash, so two
	// genuinely different file states can collide (birthday collisions at
	// ~256 distinct texts). The store must retain them as DISTINCT versions
	// so downstream tag→text lookups can still tell them apart. Regression
	// for issue #4075.
	describe("hash collisions", () => {
		// These two texts both hash to `1D84` under `computeFileHash`.
		const COLLIDE_A = "line one 263\nline two 4471\n";
		const COLLIDE_B = "line one 410\nline two 6970\n";

		it("keeps two colliding texts as separate versions with separate seenLines", async () => {
			await withWorkspace("snapshots-collide", async ws => {
				expect(computeFileHash(COLLIDE_A)).toBe(computeFileHash(COLLIDE_B));

				const store = new EditStore();
				const abs = ws.abs(PATH);
				const tagA = store.recordSnapshot(abs, COLLIDE_A, [1]);
				const tagB = store.recordSnapshot(abs, COLLIDE_B, [2]);
				expect(tagA).toBe(tagB);

				// The two colliders occupy separate version slots even though the tag
				// is identical: the tag surfaces the most-recently-recorded version
				// (B, recorded second → head), and that version's provenance is its
				// own `[2]` — A's `[1]` never leaks across the shared tag. A single
				// fused snapshot would have had to report the union `[1, 2]`, so this
				// pins the separation the old `byContent` assertions pinned.
				expect(store.byHashText(abs, tagA)).toBe(COLLIDE_B);
				expect(store.headText(abs)).toBe(COLLIDE_B);
				expect(store.seenLines(abs, tagA)).toEqual([2]);

				// Re-observing A promotes A back to head with A's own provenance:
				// A's text round-trips through the shared tag.
				expect(store.recordSnapshot(abs, COLLIDE_A, [1])).toBe(tagA);
				expect(store.byHashText(abs, tagA)).toBe(COLLIDE_A);
				expect(store.headText(abs)).toBe(COLLIDE_A);
				expect(store.seenLines(abs, tagA)).toEqual([1]);
			});
		});

		it("still fuses identical repeated reads of one colliding text onto one snapshot", async () => {
			await withWorkspace("snapshots-collide-fuse", async ws => {
				const store = new EditStore();
				const abs = ws.abs(PATH);
				const first = store.recordSnapshot(abs, COLLIDE_A, [1]);
				const again = store.recordSnapshot(abs, COLLIDE_A, [2]);
				expect(again).toBe(first);
				// One snapshot, seenLines union, and the colliding tag resolves to the
				// text that was actually recorded — the never-recorded collider B is
				// not reachable through the shared tag (the old `byContent(B) → null`
				// assertion, expressed through the surviving lookup API).
				expect(store.seenLines(abs, first)).toEqual([1, 2]);
				expect(store.byHashText(abs, first)).toBe(COLLIDE_A);
				expect(store.headText(abs)).toBe(COLLIDE_A);
			});
		});
	});
});
