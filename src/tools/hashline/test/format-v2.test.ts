/**
 * hashline format v4 — payload semantics against the native engine.
 *
 * Migrated from the pre-18.0 TS suite, where every case was expressed as
 * `applyEdits(text, parsePatch(diff).edits).text` with no path. The native
 * paradigm has no parse-level API, so each case is re-expressed as one session
 * run: write the source text to disk, `snapshot` it for the `[path#tag]`
 * header, author the payload, `applyPatch`, then assert the applied text with
 * `fileOutcome(...).newText` and the persisted bytes with `expectFile`.
 *
 * Error assertions keep the original message regexes verbatim: the engine's
 * rejection text is byte-identical to the deleted `engine/messages.ts`
 * constants.
 *
 * The two `parsePatchStreaming` cases are the only ones whose behaviour lives
 * in the streaming path. `parse_patch_streaming` is not exposed to JS; the
 * observable native surface is the preview pump's streaming batches, so those
 * two cases drive a real `EditSession` with the payload pushed as raw argument
 * fragments (see {@link FragmentStream}).
 */
import { describe, expect, it } from "vitest";

import {
	applyPatch,
	expectError,
	expectFile,
	expectSuccess,
	expectWarnings,
	fileOutcome,
	makeWriter,
	withWorkspace,
} from "./harness.ts";
import type { ApplyResult, NativeOutcome, Workspace } from "./harness.ts";
import { EditSession, formatNumberedLines, splitAddressableFileLines } from "../native/index.ts";
import type { EditPreviewBatch } from "../native/index.ts";

const REL = "a.ts";

/** Source text of the trailing-newline sentinel cases. */
const SENTINEL_TEXT = "a\nb\n";

/**
 * Write `text`, snapshot it, and apply `diff` under a fresh `[rel#tag]`
 * header. Re-running against the same workspace rewrites and re-snapshots, so
 * every call starts from the case's own source text.
 */
async function run(ws: Workspace, text: string, diff: string): Promise<ApplyResult> {
	ws.write(REL, text);
	const tag = ws.snapshot(REL, text);
	return applyPatch(ws, `${ws.header(REL, tag)}\n${diff}`);
}

/** Applied text of the one file these cases target. */
function applied(result: ApplyResult): string | undefined {
	return fileOutcome(result, REL)?.newText;
}

/* -------------------------------------------------------------------------- */
/* Streaming                                                                   */
/* -------------------------------------------------------------------------- */

/** Wait until `ready()` holds; previews arrive on an async pump. */
async function waitUntil(ready: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 600; attempt += 1) {
		if (ready()) return;
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	throw new Error(`timed out waiting for ${label}`);
}

/**
 * How long a pushed generation is given to settle on the preview pump. The
 * pump only previews the newest buffer per wake, so a negative preview
 * assertion needs the pump to have run before the next push; every preview
 * observed in this suite lands in single-digit milliseconds.
 */
const PUMP_SETTLE_MS = 250;

/**
 * One payload fed the way the streaming tool-call path feeds it: raw argument
 * fragments pushed onto a real session (each push advances a preview
 * generation, and the pump delivers one batch per generation that has files),
 * then `finish()` and `apply()`.
 *
 * `harness.applyArgs`'s `delta` option cannot express this: the native
 * `set_args_json` *replaces* the argument buffer (`pi-edit/src/session.rs`),
 * so a fragment pushed before it is discarded. Pushing is the only way to make
 * the buffer genuinely partial — which is what `parse_patch_streaming` is for.
 */
class FragmentStream {
	/** Delivered preview batches, in generation order (empty ones are skipped). */
	readonly previews: EditPreviewBatch[] = [];

	private readonly writer = makeWriter();
	private readonly session: EditSession;

	constructor(ws: Workspace) {
		this.session = new EditSession(ws.store, ws.policy(), (_error: Error | null, batch: EditPreviewBatch) => {
			this.previews.push(batch);
		});
	}

	/** Append one raw argument fragment. */
	push(fragment: string): void {
		this.session.push(fragment);
	}

	/** Wait until at least `count` preview batches were delivered. */
	async waitForBatches(count: number, label: string): Promise<void> {
		await waitUntil(() => this.previews.length >= count, label);
	}

	/** Finish the arguments and apply them; the final batch is awaited first. */
	async apply(): Promise<ApplyResult> {
		this.session.finish();
		await waitUntil(() => this.previews.some(batch => !batch.streaming), "the final preview batch");
		const outcome = (await this.session.apply({ lspFlush: false }, this.writer.fn)) as unknown as NativeOutcome;
		return {
			outcome,
			requests: this.writer.requests,
			lastText: this.writer.lastText(),
			previews: this.previews,
			writerErrors: this.writer.errors,
		};
	}

	close(): void {
		this.session.close();
	}
}

describe("hashline format v4", () => {
	it("replaces a concrete range with literal body rows in textual order", async () => {
		await withWorkspace("format-v2-replace-range", async ws => {
			const text = "a\nb\nc";
			const diff = ["PUT 2.=2:", "+before", "+after"].join("\n");

			const result = await run(ws, text, diff);
			expectSuccess(result);
			expect(applied(result)).toBe("a\nbefore\nafter\nc");
			expectFile(ws, REL, "a\nbefore\nafter\nc");
		});
	});

	it("deletes a single source line", async () => {
		await withWorkspace("format-v2-cut-one", async ws => {
			const result = await run(ws, "a\nb\nc", "CUT 2.=2");
			expectSuccess(result);
			expect(applied(result)).toBe("a\nc");
			expectFile(ws, REL, "a\nc");
		});
	});

	it("deletes a concrete range", async () => {
		await withWorkspace("format-v2-cut-range", async ws => {
			const result = await run(ws, "a\nb\nc\nd", "CUT 2.=3");
			expectSuccess(result);
			expect(applied(result)).toBe("a\nd");
			expectFile(ws, REL, "a\nd");
		});
	});

	it("leniently accepts common range separator variants", async () => {
		await withWorkspace("format-v2-separators", async ws => {
			const text = "a\nb\nc\nd";
			for (const separator of ["-", ".", "=", "..", "…", " "]) {
				const cut = await run(ws, text, `CUT 2${separator}3`);
				expectSuccess(cut);
				expect(applied(cut), `CUT 2${separator}3`).toBe("a\nd");

				const put = await run(ws, text, `PUT 2${separator}3:\n+middle`);
				expectSuccess(put);
				expect(applied(put), `PUT 2${separator}3:`).toBe("a\nmiddle\nd");
			}
		});
	});

	it("inserts before and after concrete anchors", async () => {
		await withWorkspace("format-v2-anchors", async ws => {
			const text = "a\nb\nc";
			const diff = ["PUT <2:", "+before", "PUT >2:", "+after"].join("\n");

			const result = await run(ws, text, diff);
			expectSuccess(result);
			expect(applied(result)).toBe("a\nbefore\nb\nafter\nc");
			expectFile(ws, REL, "a\nbefore\nb\nafter\nc");
		});
	});

	it("inserts at head and tail", async () => {
		await withWorkspace("format-v2-head-tail", async ws => {
			const text = "a\nb";

			const head = await run(ws, text, "PUT <1:\n+HEAD");
			expectSuccess(head);
			expect(applied(head)).toBe("HEAD\na\nb");

			const tail = await run(ws, text, "PUT >$:\n+TAIL");
			expectSuccess(tail);
			expect(applied(tail)).toBe("a\nb\nTAIL");
		});
	});

	it("treats an empty replace as deletion while still rejecting an empty insert", async () => {
		await withWorkspace("format-v2-empty-replace", async ws => {
			const result = await run(ws, "a\nb\nc\nd", "PUT 2-3:");
			expectSuccess(result);
			expect(applied(result)).toBe("a\nd");
			expectFile(ws, REL, "a\nd");
			expectWarnings(result, REL, {
				includes: ["Interpreted an empty `PUT` body as deletion. Use `CUT N.=M` or `CUT N*` for bodyless deletes."],
			});

			expectError(
				await run(ws, "a\nb\nc\nd", "PUT <1:"),
				/promises body rows/,
			);
		});
	});

	it("rejects body rows under cut", async () => {
		await withWorkspace("format-v2-cut-body", async ws => {
			expectError(await run(ws, "a\nb\nc", "CUT 2\n+replacement"), /takes no body rows/);
			expectFile(ws, REL, "a\nb\nc");
		});
	});

	it("does not recognize removed DEL or COPY headers", async () => {
		await withWorkspace("format-v2-del-copy", async ws => {
			for (const header of ["DEL 2", "DEL.BLK 2", "COPY 2", "COPY.BLK 2"]) {
				expectError(await run(ws, "a\nb\nc", header), /payload line has no preceding hunk header/);
			}
			expectFile(ws, REL, "a\nb\nc");
		});
	});

	it("auto-pipes bare body rows as literal text", async () => {
		await withWorkspace("format-v2-bare-row", async ws => {
			const result = await run(ws, "a\nb\nc", "PUT 2-2:\nraw");
			expectSuccess(result);
			expect(applied(result)).toBe("a\nraw\nc");
			expectFile(ws, REL, "a\nraw\nc");
			expectWarnings(result, REL, {
				includes: ["Auto-prefixed bare body row(s) with `+`. Body rows must be `+TEXT` literal lines."],
			});
		});
	});

	it("strips read-output line number prefix from auto-piped bare body rows", async () => {
		await withWorkspace("format-v2-bare-prefix", async ws => {
			// Without this fix, "3:text" becomes literal "3:text" in the file.
			// With the fix, the "3:" prefix is stripped, yielding just "text".
			const result = await run(ws, "a\nb\nc", "PUT 2-2:\n3:replaced");
			expectSuccess(result);
			expect(applied(result)).toBe("a\nreplaced\nc");
			expectFile(ws, REL, "a\nreplaced\nc");
			expectWarnings(result, REL, {
				includes: ["Auto-prefixed bare body row(s) with `+`. Body rows must be `+TEXT` literal lines."],
			});
		});
	});

	it("validates insert anchors against file bounds", async () => {
		await withWorkspace("format-v2-insert-bounds", async ws => {
			expectError(await run(ws, "a\nb", "PUT <4:\n+x"), /Line 4 does not exist/);
			expectFile(ws, REL, "a\nb");
		});
	});

	it("rejects unsafe line numbers before expanding ranges", async () => {
		await withWorkspace("format-v2-unsafe-lid", async ws => {
			// Behavioural re-expression of the old `parseLid`/`Tokenizer` probe.
			// The native anchor domain is u32, so "safe" means "representable as
			// an anchor": u32::MAX parses into a real op that then fails on file
			// bounds, while MAX_SAFE_INTEGER and above never become ops at all —
			// they are rejected before any range expansion, which is what the old
			// `Tokenizer().isOp(SWAP ...)` assertion pinned.
			expectError(await run(ws, "a\nb\nc", "PUT 4294967295:\n+x"), /Line 4294967295 does not exist/);

			for (const unsafe of [String(Number.MAX_SAFE_INTEGER), String(Number.MAX_SAFE_INTEGER + 1)]) {
				expectError(await run(ws, "a\nb\nc", `PUT ${unsafe}:\n+x`), /payload line has no preceding hunk header/);
				expectError(
					await run(ws, "a\nb\nc", `SWAP ${unsafe}.=${unsafe}:\n+x`),
					/payload line has no preceding hunk header/,
				);
			}
			expectFile(ws, REL, "a\nb\nc");
		});
	});

	it("rejects safe-integer ranges above the expansion limit", async () => {
		await withWorkspace("format-v2-expansion-limit", async ws => {
			expectError(
				await run(ws, "a\nb", "PUT 1-100001:\n+x"),
				/replace range spans 100001 lines; the maximum is 100000/,
			);
			expectFile(ws, REL, "a\nb");
		});
	});

	it("ignores cutting the trailing blank sentinel of a newline-terminated file", async () => {
		await withWorkspace("format-v2-sentinel-cut", async ws => {
			// "a\nb\n" splits into ["a", "b", ""]; line 3 is the phantom sentinel.
			const result = await run(ws, SENTINEL_TEXT, "CUT 3");
			expectSuccess(result);
			expect(applied(result)).toBe(SENTINEL_TEXT);
			expectFile(ws, REL, SENTINEL_TEXT);
			// Nothing to write: the sentinel cut is a no-op on disk.
			expect(result.requests.length).toBe(0);
		});
	});

	it("separates terminal newline sentinels from addressable file lines", () => {
		expect(splitAddressableFileLines("a\nb\n")).toEqual(["a", "b"]);
		expect(splitAddressableFileLines("a\nb\n\n")).toEqual(["a", "b", ""]);
	});

	it("keeps a selected terminal blank line when formatting", () => {
		const selected = splitAddressableFileLines("a\n\nb\n").slice(0, 2).join("\n");
		expect(formatNumberedLines(selected)).toBe("1:a\n2:");
	});

	it("treats a cut range ending at the trailing sentinel as ending at the last real line", async () => {
		await withWorkspace("format-v2-sentinel-cut-range", async ws => {
			const result = await run(ws, SENTINEL_TEXT, "CUT 2-3");
			expectSuccess(result);
			expect(applied(result)).toBe("a\n");
			expectFile(ws, REL, "a\n");
		});
	});

	it("treats a replace range ending at the trailing sentinel as ending at the last real line", async () => {
		await withWorkspace("format-v2-sentinel-replace-range", async ws => {
			const result = await run(ws, SENTINEL_TEXT, "PUT 2-3:\n+B");
			expectSuccess(result);
			expect(applied(result)).toBe("a\nB\n");
			expectFile(ws, REL, "a\nB\n");
		});
	});

	it("still allows inserts anchored on the trailing blank sentinel", async () => {
		await withWorkspace("format-v2-sentinel-insert", async ws => {
			const result = await run(ws, SENTINEL_TEXT, "PUT >3:\n+tail");
			expectSuccess(result);
			expect(applied(result)).toBe("a\nb\n\ntail");
			expectFile(ws, REL, "a\nb\n\ntail");
		});
	});

	it("still cuts a genuine last line of a non-newline-terminated file", async () => {
		await withWorkspace("format-v2-no-sentinel-cut", async ws => {
			// "a\nb" has no sentinel; line 2 is real content.
			const result = await run(ws, "a\nb", "CUT 2");
			expectSuccess(result);
			expect(applied(result)).toBe("a");
			expectFile(ws, REL, "a");
		});
	});

	it("does not flush a trailing streaming pending empty replace hunk", async () => {
		await withWorkspace("format-v2-stream-pending", async ws => {
			// Old contract: `parsePatchStreaming("PUT 5-5:\n").edits` is empty —
			// a replace hunk whose body has not arrived is held back instead of
			// being flushed as an empty-replace delete. The native grammar loses
			// that trailing op in `Executor::finish(streaming = true)`, which is
			// reachable only through the preview pump: a flushed hunk would
			// deliver a batch (a delete), a held-back one delivers nothing.
			ws.write(REL, "a\nb\nc");
			const tag = ws.snapshot(REL, "a\nb\nc");

			// Control: the same single-push shape, but with a *complete* bodyless
			// op, does preview within the settle window below — so the silence
			// asserted for the pending hunk is the engine holding it back, not a
			// pump that never ran.
			const control = new FragmentStream(ws);
			try {
				control.push(JSON.stringify({ input: `[${REL}#${tag}]\nCUT 2\n` }));
				await control.waitForBatches(1, "the bodyless `CUT` hunk to preview");
				expect(control.previews[0]?.streaming).toBe(true);
				expect(control.previews[0]?.files.map(file => file.path)).toEqual([REL]);
			} finally {
				control.close();
			}

			const json = JSON.stringify({ input: `[${REL}#${tag}]\nPUT 2-2:\n+REPLACED\n` });
			const split = json.indexOf("+REPLACED");
			const stream = new FragmentStream(ws);
			try {
				stream.push(json.slice(0, split));
				await new Promise(resolve => setTimeout(resolve, PUMP_SETTLE_MS));
				expect(stream.previews).toEqual([]);

				stream.push(json.slice(split));
				const result = await stream.apply();
				// The first delivered batch is the one where the body arrived:
				// generation 1 had nothing to show instead of previewing a delete.
				expect(stream.previews[0]?.generation).toBe(2);
				expectSuccess(result);
				expect(applied(result)).toBe("a\nREPLACED\nc");
				expectFile(ws, REL, "a\nREPLACED\nc");
			} finally {
				stream.close();
			}
		});
	});

	it("flushes a streaming CUT hunk when another hunk starts", async () => {
		await withWorkspace("format-v2-stream-cut", async ws => {
			// Old contract: `parsePatchStreaming("CUT 2\nPUT >$:\n")` yields the
			// CUT (and drops the bodyless trailing hunk). Native observable: with
			// the CUT flushed, the fragment that ends on `PUT >$:` already
			// previews a file entry — a payload with only that bodyless hunk
			// previews nothing at all. The pending body must not land yet.
			ws.write(REL, "a\nb\nc");
			const tag = ws.snapshot(REL, "a\nb\nc");
			const json = JSON.stringify({ input: `[${REL}#${tag}]\nCUT 2\nPUT >$:\n+TAIL\n` });
			const split = json.indexOf("+TAIL");

			const stream = new FragmentStream(ws);
			try {
				stream.push(json.slice(0, split));
				await stream.waitForBatches(1, "the CUT hunk to be flushed once `PUT >$:` starts");

				const first = stream.previews[0];
				expect(first.streaming).toBe(true);
				expect(first.files.map(file => file.path)).toEqual([REL]);
				expect(first.files[0]?.op).toBe("update");
				// The flushed CUT is a trailing removal-only change, so the
				// streaming diff carries no rows yet — the pending `+TAIL` body
				// has not landed.
				expect(first.files[0]?.diff).toBe("");

				stream.push(json.slice(split));
				const result = await stream.apply();
				expectSuccess(result);
				expect(applied(result)).toBe("a\nc\nTAIL");
				expectFile(ws, REL, "a\nc\nTAIL");
			} finally {
				stream.close();
			}
		});
	});
});
