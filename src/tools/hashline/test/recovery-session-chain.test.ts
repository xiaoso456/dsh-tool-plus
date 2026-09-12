/**
 * Native session-chain recovery: the deleted TS suite drove
 * `new Recovery(store).tryRecover({ path, currentText, fileHash, edits })`
 * directly. That entry point is gone — recovery now happens *inside*
 * `EditSession.apply` — so every case here is expressed the way a host actually
 * reaches it:
 *
 *   1. record the snapshot the payload will be bound to (the stale tag `h0`),
 *   2. leave the drifted text on disk (the file moved on since that read),
 *   3. author `[path#h0]` plus the anchored payload and apply it,
 *   4. assert the persisted bytes and the engine's recovery warnings.
 *
 * Cases that used to expect `null` ("no path forward") now assert the native
 * rejection: the stale-tag mismatch diagnostic, no per-file outcome, and zero
 * writes — the live file keeps its new content instead of being overwritten
 * with payload authored against a state that no longer exists.
 *
 * Warning strings are byte-identical to the deleted `engine/messages.ts`
 * constants (`refs/oh-my-pi/crates/pi-edit/src/modes/hashline/messages.rs`) and
 * are asserted through `expectWarnings(..., { includes: [...] })`.
 */
import { describe, expect, it } from "vitest";

import {
	applyPatch,
	expectError,
	expectFile,
	expectSuccess,
	expectWarnings,
	withWorkspace,
} from "./harness.ts";
import type { ApplyResult, Workspace } from "./harness.ts";
import { computeFileHash } from "../native/index.ts";

/** Authored path for every case; the native diagnostic names it. */
const REL = "recovery-chain.ts";

/**
 * Engine warning text, byte-identical to the deleted TS constants
 * (`messages.rs::RECOVERY_SESSION_CHAIN_WARNING` / `RECOVERY_LINE_REMAP_WARNING`).
 */
const RECOVERY_SESSION_CHAIN_WARNING =
	"Recovered from a stale file hash using an earlier in-session snapshot (a prior edit in this session advanced the hash).";
const RECOVERY_LINE_REMAP_WARNING =
	"Recovered by remapping stale line anchors to unchanged current lines (file changed since the tagged read). Verify the diff matches your intent.";

/**
 * Native replacement for the old `tryRecover(...) === null`: `EditSession.apply`
 * refuses the payload with the snapshot-tag mismatch diagnostic. The two hashes
 * are the section tag and the live file's tag, so they vary per case; the rest
 * of the teaching message is pinned exactly.
 */
const STALE_TAG_REFUSAL =
	/^Edit rejected for recovery-chain\.ts: file changed between read and edit\.\nSection is bound to #[0-9A-F]{4}, but the current file hashes to #[0-9A-F]{4}\./;

function lines(...rows: string[]): string {
	return `${rows.join("\n")}\n`;
}

/**
 * Drive one recovery scenario: record `snapshots` in order (the first one owns
 * the stale tag the payload is bound to, the last one becomes the store's
 * head), put `current` on disk, then apply `[REL#staleTag]` + `payload`.
 */
async function applyStale(
	ws: Workspace,
	snapshots: string[],
	current: string,
	payload: string,
): Promise<ApplyResult> {
	const stale = snapshots[0];
	if (stale === undefined) throw new Error("applyStale needs at least one snapshot");
	const staleTag = ws.snapshot(REL, stale);
	for (const text of snapshots.slice(1)) ws.snapshot(REL, text);
	ws.write(REL, current);
	return applyPatch(ws, `${ws.header(REL, staleTag)}\n${payload}`);
}

/**
 * Assert the native "no path forward" outcome: stale-tag rejection, no per-file
 * outcome, and not a single byte written.
 */
function expectStaleTagRefusal(result: ApplyResult): void {
	expectError(result, STALE_TAG_REFUSAL);
	expect(result.outcome.files).toEqual([]);
	expect(result.requests).toEqual([]);
}

/** The ten-line fixture `seedTwoSnapshots` used: v1 rewrote line 5 in-session. */
const V0_TEXT = lines("L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10");
const V1_TEXT = lines("L1", "L2", "L3", "L4", "L5-CHANGED", "L6", "L7", "L8", "L9", "L10");

describe("Recovery — session-chain replay anchor-content gate", () => {
	it("refuses replay when an edit anchor's line content diverges between snapshot and current", async () => {
		await withWorkspace("recovery-diverge", async ws => {
			// Edit anchored at line 5 — the exact line the prior in-session edit
			// rewrote. Replaying onto current would overwrite "L5-CHANGED" with
			// payload the model authored against the stale "L5". That is
			// corruption, not recovery.
			const result = await applyStale(ws, [V0_TEXT, V1_TEXT], V1_TEXT, "PUT 5-5:\n+L5-MODEL");
			expectStaleTagRefusal(result);
			// The live content survives untouched.
			expectFile(ws, REL, V1_TEXT);
		});
	});

	it("replays edits onto current when every anchor's line content is unchanged", async () => {
		await withWorkspace("recovery-unchanged", async ws => {
			// Edit anchored at line 3 — unchanged between v0 and v1. Recovery
			// proves that the target and its surrounding context still map to the
			// same live lines before replaying the edit.
			const result = await applyStale(ws, [V0_TEXT, V1_TEXT], V1_TEXT, "PUT 3-3:\n+L3-MODEL");
			expectSuccess(result);
			// The model's edit lands on top of current, not on top of the stale
			// snapshot: the prior in-session change to line 5 must survive.
			expectFile(ws, REL, lines("L1", "L2", "L3-MODEL", "L4", "L5-CHANGED", "L6", "L7", "L8", "L9", "L10"));
			// Zero-offset recovery against an earlier retained snapshot reports the
			// session-chain banner; unlike the removed direct replay fallback, this
			// path has proved the anchors through the unchanged-line map.
			expectWarnings(result, REL, { includes: [RECOVERY_SESSION_CHAIN_WARNING] });
		});
	});

	it("recovers stale anchors shifted by a prior in-session insertion", async () => {
		await withWorkspace("recovery-insertion", async ws => {
			const v0Text = lines("L1", "L2", "L3", "L4", "L5", "L6");
			const v1Text = lines("L1", "L2", "INSERTED", "L3", "L4", "L5", "L6");
			const result = await applyStale(ws, [v0Text, v1Text], v1Text, "PUT 5-5:\n+L5-MODEL");
			expectSuccess(result);
			expectFile(ws, REL, lines("L1", "L2", "INSERTED", "L3", "L4", "L5-MODEL", "L6"));
			expectWarnings(result, REL, { includes: [RECOVERY_LINE_REMAP_WARNING] });
		});
	});

	it("recovers stale anchors shifted by a prior in-session deletion", async () => {
		await withWorkspace("recovery-deletion", async ws => {
			const v0Text = lines("L1", "L2", "L3", "L4", "L5", "L6");
			const v1Text = lines("L1", "L3", "L4", "L5", "L6");
			const result = await applyStale(ws, [v0Text, v1Text], v1Text, "PUT 5-5:\n+L5-MODEL");
			expectSuccess(result);
			expectFile(ws, REL, lines("L1", "L3", "L4", "L5-MODEL", "L6"));
			expectWarnings(result, REL, { includes: [RECOVERY_LINE_REMAP_WARNING] });
		});
	});

	it("refuses duplicate-line remaps when surrounding context no longer matches", async () => {
		await withWorkspace("recovery-dup-remap", async ws => {
			const v0Text = lines("start", "DUP", "mid", "DUP", "tail");
			const v1Text = lines("start", "mid", "DUP", "CHANGED", "tail");
			const result = await applyStale(ws, [v0Text, v1Text], v1Text, "PUT 4-4:\n+MODEL");
			expectStaleTagRefusal(result);
			expectFile(ws, REL, v1Text);
		});
	});

	it("refuses to relocate a stale replacement onto duplicated context", async () => {
		await withWorkspace("recovery-dup-context", async ws => {
			const block = ["head", "TARGET_A", "TARGET_B", "ctx1", "ctx2", "ctx3"];
			const v0Text = lines(...block, "middle", ...block, "tail");
			const currentText = lines("head", "CHANGED_A", "CHANGED_B", "ctx1", "ctx2", "ctx3", "middle", ...block, "tail");
			const result = await applyStale(ws, [v0Text], currentText, "PUT 2-3:\n+MODEL_A\n+MODEL_B");
			expectStaleTagRefusal(result);
			expectFile(ws, REL, currentText);
			expect(currentText).toContain("TARGET_A\nTARGET_B");
		});
	});

	it("refuses an isolated unique-line remap when neither neighbor follows its offset", async () => {
		await withWorkspace("recovery-isolated", async ws => {
			const v0Text = lines("L1", "L2", "L3", "L4", "T", "L6");
			const v1Text = lines("X", "L1", "L2", "L3", "L4", "BEFORE", "T", "AFTER", "L6");
			const result = await applyStale(ws, [v0Text, v1Text], v1Text, "PUT 5-5:\n+MODEL");
			expectStaleTagRefusal(result);
			expectFile(ws, REL, v1Text);
		});
	});

	it("recovers duplicate-line anchors shifted by a prior insertion when context still matches", async () => {
		await withWorkspace("recovery-dup-accept", async ws => {
			// Remap-parity pin for the linearized validator: an anchor RANGE
			// covering a duplicated line ("DUP" appears twice) plus a unique line
			// must still remap through a prior insertion — the duplicate-context
			// and unique-context branches both accept exactly as before.
			const v0Text = lines("alpha", "DUP", "beta", "DUP", "omega");
			const v1Text = lines("alpha", "INSERTED", "DUP", "beta", "DUP", "omega");
			const result = await applyStale(ws, [v0Text, v1Text], v1Text, "PUT 3-4:\n+B-MODEL\n+MODEL");
			expectSuccess(result);
			expectFile(ws, REL, lines("alpha", "INSERTED", "DUP", "B-MODEL", "MODEL", "omega"));
			expectWarnings(result, REL, { includes: [RECOVERY_LINE_REMAP_WARNING] });
		});
	});
});

/**
 * Brute-force two distinct texts sharing one 4-hex tag. 16-bit tags collide
 * within a few hundred candidates (birthday bound), so this stays cheap.
 * Texts share `template` around a varying middle line so line-anchored edits
 * against one collider are plausible-but-wrong against the other.
 */
function findCollidingTexts(): { older: string; newer: string } {
	const textFor = (n: number): string => lines("shared head", `unique payload ${n}`, "shared tail");
	const byTag = new Map<string, number>();
	for (let n = 0; ; n++) {
		const text = textFor(n);
		const tag = computeFileHash(text);
		const prior = byTag.get(tag);
		if (prior !== undefined) return { older: textFor(prior), newer: text };
		byTag.set(tag, n);
	}
}

describe("Recovery — colliding snapshot tags", () => {
	it("recovers against the most-recently retained text when two colliders share the tag", async () => {
		const { older, newer } = findCollidingTexts();
		const tag = computeFileHash(older);
		expect(computeFileHash(newer)).toBe(tag);
		expect(newer).not.toBe(older);

		// Live drifted away from both colliders, so recovery cannot shortcut
		// via live==snapshot. The tag cannot name a unique base; recovery uses
		// the most-recently retained collider and maps its unchanged anchors —
		// the anchor line here only exists verbatim in `newer`, so a successful
		// remap proves `newer` was the base.
		const currentText = `${newer}drifted trailer\n`;
		await withWorkspace("recovery-collide", async ws => {
			const result = await applyStale(ws, [older, newer], currentText, "PUT 2-2:\n+model payload");
			expectSuccess(result);
			expectFile(ws, REL, lines("shared head", "model payload", "shared tail", "drifted trailer"));
		});

		// Negative control: recording the same colliders in the opposite order
		// makes the OLDER text the most recent one for the tag, and the very same
		// payload is then refused (its anchor line does not exist in the live
		// text). The positive case above therefore pins "most recent wins", not
		// "either collider works".
		await withWorkspace("recovery-collide-reversed", async ws => {
			const result = await applyStale(ws, [newer, older], currentText, "PUT 2-2:\n+model payload");
			expectStaleTagRefusal(result);
			expectFile(ws, REL, currentText);
		});
	});

	it("still recovers when exactly one retained text carries the tag", async () => {
		// Same drift scenario with a single retained text for the tag.
		const { older } = findCollidingTexts();
		const currentText = `${older}drifted trailer\n`;
		await withWorkspace("recovery-collide-single", async ws => {
			const result = await applyStale(ws, [older], currentText, "PUT 2-2:\n+model payload");
			expectSuccess(result);
			expectFile(ws, REL, lines("shared head", "model payload", "shared tail", "drifted trailer"));
		});
	});
});

describe("Recovery — ill-formed UTF-16 content", () => {
	it("remaps line anchors natively when the file contains lone surrogates", async () => {
		await withWorkspace("recovery-surrogate", async ws => {
			// The on-disk boundary is UTF-8, so an unpaired surrogate is encoded as
			// U+FFFD: the engine reads the replacement character, remaps over those
			// raw UTF-16 units, and writes the same character back. The snapshot
			// keeps the raw lone surrogate (as the original in-memory case did) and
			// the persisted bytes are still asserted exactly.
			const LONE_SURROGATE_LINE = "lone \ud800 surrogate";
			const LONE_SURROGATE_LINE_ON_DISK = "lone \ufffd surrogate";
			const snapshotText = lines("head", LONE_SURROGATE_LINE, "target line", "tail");
			// Current text gained one line above the target; the anchor must shift.
			const currentText = lines("inserted above", "head", LONE_SURROGATE_LINE, "target line", "tail");

			const result = await applyStale(ws, [snapshotText], currentText, "PUT 3-3:\n+model payload");
			expectSuccess(result);
			expectFile(ws, REL, lines("inserted above", "head", LONE_SURROGATE_LINE_ON_DISK, "model payload", "tail"));
			expectWarnings(result, REL, { includes: [RECOVERY_LINE_REMAP_WARNING] });
		});
	});
});
