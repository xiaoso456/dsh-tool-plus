/**
 * Shared harness for the native hashline test suite.
 *
 * The engine is a Rust binding: files must exist on disk, the host owns bytes
 * through a writer callback, and rejections come back as
 * `{ isError: true, text }` instead of thrown exceptions. This module is the
 * single place those mechanics live, so every spec reads like the old engine
 * tests (patch text in → observable outcome out) without touching internals.
 *
 * Invariants, each learned the hard way:
 * - `policy.cwd` and the workspace directory are `fs.realpathSync.native`d.
 *   Tag-based path recovery compares canonical keys; an uncanonicalized
 *   mkdtemp path (short path / case differences on Windows) makes
 *   `patcher.json#012` fail with `File not found: a.txt`.
 * - `session.finish()` is required before `apply`; the Rust reference harness
 *   calls it too, and skipping it drops the final untrimmed preview.
 * - Snapshot text is LF-normalized on record, matching Rust
 *   `Workspace::snapshot` (`pi-edit/tests/common/mod.rs`).
 * - The writer is an error-first callback, not an object, and every write
 *   really lands on disk so expectations can assert persisted bytes.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect } from "vitest";

import { EditSession, EditStore } from "../native/index.ts";
import type {
	EditFileOutcome,
	EditFilePreview,
	EditPolicy,
	EditPreviewBatch,
	EditWriteRequest,
	EditWriteResponse,
} from "../native/index.ts";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/** `EditSession.apply` outcome, narrowed to what tests assert on. */
export interface NativeOutcome {
	text: string;
	isError: boolean;
	files: EditFileOutcome[];
}

/** Result of one applied payload, plus everything the case may assert on. */
export interface ApplyResult {
	outcome: NativeOutcome;
	/** Raw write requests, in order (assert `op`, `moveTo`, count, …). */
	requests: EditWriteRequest[];
	/** Text of the last non-delete write. */
	lastText: string | undefined;
	/** Preview batches delivered to `onPreview`, in generation order. */
	previews: EditPreviewBatch[];
	/** Write requests that failed by design (`failAt`). */
	writerErrors: string[];
}

/** Optional failure injection / rewriting for {@link makeWriter}. */
export interface WriterOptions {
	/** Override the text reported as persisted (host-side re-formatting). */
	rewrite?: (request: EditWriteRequest) => string;
	/** Make the Nth (0-based) write reject with this message. */
	failAt?: [number, string];
	/** Skip disk writes entirely (pure interaction tests). */
	dryRun?: boolean;
}

export interface ApplyOptions {
	/** Policy overrides merged onto {@link Workspace.policy}'s defaults. */
	policy?: Partial<EditPolicy>;
	/**
	 * Collect `onPreview` batches. The preview pump is **async**: batches arrive
	 * on later macrotasks, so a caller that pushes fragments and applies
	 * immediately observes none. Pass {@link ApplyOptions.fragments} (or rely on
	 * the settle windows this function performs) and read `result.previews`
	 * afterwards; cases that need strict per-generation sequencing should drive
	 * `EditSession` directly with their own wait loop.
	 */
	collectPreviews?: boolean;
	/** Writer failure injection / rewriting. */
	writer?: WriterOptions;
	/** Set for verbatim custom-format payloads instead of JSON args. */
	rawInput?: boolean;
	/**
	 * Feed the payload as **streamed argument fragments** instead of one JSON blob.
	 * Each fragment is pushed and then given `settleMs` for preview batches to
	 * arrive before the next one (`finish()` follows the last fragment).
	 *
	 * Do not reach for `setArgsJson` after a push: it *replaces* the argument
	 * buffer (`pi-edit/src/session.rs`), so earlier fragments are discarded — a
	 * streaming test written that way is silently not streaming.
	 */
	fragments?: string[];
	/** Milliseconds to wait after each fragment (default 200). */
	settleMs?: number;
}

export interface RecordingWriter {
	requests: EditWriteRequest[];
	errors: string[];
	lastText(): string | undefined;
	fn: (error: Error | null, request: EditWriteRequest) => Promise<EditWriteResponse>;
}

/* -------------------------------------------------------------------------- */
/* Workspace                                                                   */
/* -------------------------------------------------------------------------- */

/** Temp-dir root; override with `HASHLINE_TEST_TMP` to run under D:/tmp. */
export function tempRoot(): string {
	return process.env.HASHLINE_TEST_TMP ?? os.tmpdir();
}

let workspaceSeq = 0;

/**
 * One test's real on-disk working directory plus an isolated {@link EditStore}.
 * Always `dispose()` it in a `finally` block (or use {@link withWorkspace}).
 */
export class Workspace {
	readonly dir: string;
	readonly store: EditStore;

	constructor(label = "case") {
		const safe = label.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "case";
		const dir = fs.mkdtempSync(path.join(tempRoot(), `hashline-${safe}-${workspaceSeq++}-`));
		this.dir = fs.realpathSync.native(dir);
		this.store = new EditStore();
	}

	/** Absolute path for a workspace-relative path. */
	abs(rel: string): string {
		return path.join(this.dir, rel);
	}

	/** Write `text` (creating parent directories) and return the absolute path. */
	write(rel: string, text: string): string {
		const target = this.abs(rel);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, text, "utf8");
		return target;
	}

	/** Persisted text, or `undefined` when the file is absent. */
	read(rel: string): string | undefined {
		try {
			return fs.readFileSync(this.abs(rel), "utf8");
		} catch {
			return undefined;
		}
	}

	/** Bytes of every file currently in the workspace, keyed by relative path. */
	tree(): Record<string, string> {
		const out: Record<string, string> = {};
		const walk = (dir: string, prefix: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
				const abs = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(abs, rel);
				else out[rel] = fs.readFileSync(abs, "utf8");
			}
		};
		walk(this.dir, "");
		return out;
	}

	exists(rel: string): boolean {
		return fs.existsSync(this.abs(rel));
	}

	remove(rel: string): void {
		fs.rmSync(this.abs(rel), { force: true });
	}

	/**
	 * Record a snapshot for `rel` and return its tag. `text` defaults to the
	 * file's on-disk bytes; line endings are normalized to LF.
	 */
	snapshot(rel: string, text?: string, seenLines?: number[]): string {
		const source = text ?? this.read(rel);
		if (source === undefined) throw new Error(`snapshot source missing: ${rel}`);
		return this.store.recordSnapshot(this.abs(rel), source.replace(/\r\n?/g, "\n"), seenLines ?? null);
	}

	/** The header a test should author for a section: `[rel#TAG]`. */
	header(rel: string, tag: string): string {
		return `[${rel}#${tag}]`;
	}

	/** Build a policy bound to this workspace, with per-case overrides. */
	policy(overrides: Partial<EditPolicy> = {}): EditPolicy {
		return {
			cwd: this.dir,
			mode: "hashline",
			allowFuzzy: true,
			fuzzyThreshold: 0.95,
			enforceSeenLines: false,
			blockAutoGenerated: true,
			planActive: false,
			homeDir: this.dir,
			rawInput: false,
			...overrides,
		};
	}

	dispose(): void {
		this.store.clear();
		fs.rmSync(this.dir, { recursive: true, force: true });
	}
}

/** Run `body` against a fresh workspace and always clean up. */
export async function withWorkspace<T>(label: string, body: (ws: Workspace) => Promise<T>): Promise<T> {
	const ws = new Workspace(label);
	try {
		return await body(ws);
	} finally {
		ws.dispose();
	}
}

/* -------------------------------------------------------------------------- */
/* Writer                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Disk-backed writer: `delete` unlinks, `move` writes `moveTo` then unlinks the
 * source, `create`/`update` write `content`. Mirrors the Rust `DiskWriter`
 * (`pi-edit/tests/common/mod.rs`) so persisted bytes are the assertion target.
 */
export function makeWriter(options: WriterOptions = {}): RecordingWriter {
	const requests: EditWriteRequest[] = [];
	const errors: string[] = [];
	const fn = async (error: Error | null, request: EditWriteRequest): Promise<EditWriteResponse> => {
		if (error) throw error;
		const index = requests.push(request) - 1;
		if (options.failAt && options.failAt[0] === index) {
			errors.push(options.failAt[1]);
			throw new Error(options.failAt[1]);
		}
		if (options.dryRun) return { written: "" };
		if (request.op === "delete") {
			fs.rmSync(request.path, { force: true });
			return { written: "" };
		}
		const text = options.rewrite ? options.rewrite(request) : request.content ?? "";
		const target = request.moveTo ?? request.path;
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, text, "utf8");
		if (request.moveTo) fs.rmSync(request.path, { force: true });
		return { written: text };
	};
	return {
		requests,
		errors,
		fn,
		lastText() {
			for (let i = requests.length - 1; i >= 0; i -= 1) {
				if (requests[i].op !== "delete") return requests[i].content ?? "";
			}
			return undefined;
		},
	};
}

/* -------------------------------------------------------------------------- */
/* Driving a payload                                                           */
/* -------------------------------------------------------------------------- */

/** Sleep one macrotask; used to let async preview batches settle. */
function settle(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wait until `predicate` holds or `budgetMs` elapses. The preview pump runs on
 * the native worker pool and delivers batches asynchronously, so a fixed sleep
 * is either flaky or needlessly slow; polling ends as soon as the batch lands.
 */
async function settleUntil(predicate: () => boolean, budgetMs: number): Promise<void> {
	const deadline = Date.now() + budgetMs;
	while (!predicate() && Date.now() < deadline) await settle(10);
}

/**
 * Stage `args` (or a bare `input` string) on a fresh session and apply it.
 * This is the native paradigm: snapshot first, args JSON, `finish()`, apply.
 *
 * Pass {@link ApplyOptions.fragments} instead of `args.input` to exercise the
 * streaming path: the fragments are pushed one at a time, each followed by a
 * settle window, so `onPreview` sees genuine partial batches.
 */
export async function applyArgs(
	ws: Workspace,
	args: Record<string, unknown>,
	options: ApplyOptions = {},
): Promise<ApplyResult> {
	const writer = makeWriter(options.writer);
	const previews: EditPreviewBatch[] = [];
	const onPreview = options.collectPreviews
		? (_error: Error | null, batch: EditPreviewBatch) => previews.push(batch)
		: null;
	const policy = ws.policy({ ...options.policy, rawInput: options.rawInput ?? false });
	const session = new EditSession(ws.store, policy, onPreview);
	const budget = options.settleMs ?? 200;
	try {
		if (options.fragments !== undefined) {
			for (const fragment of options.fragments) {
				const before = previews.length;
				session.push(fragment);
				// Give the pump a chance to publish this generation's batch.
				if (options.collectPreviews) await settleUntil(() => previews.length > before, budget);
				else await settle(0);
			}
		} else {
			session.setArgsJson(JSON.stringify(args));
		}
		session.finish();
		if (options.collectPreviews) {
			// The final (streaming:false) batch is always delivered.
			await settleUntil(() => previews.some(batch => !batch.streaming), budget);
		}
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
}

/** {@link applyArgs} for the common `{ input }` payload shape. */
export function applyPatch(ws: Workspace, input: string, options: ApplyOptions = {}): Promise<ApplyResult> {
	return applyArgs(ws, { input }, options);
}

/* -------------------------------------------------------------------------- */
/* Assertions                                                                  */
/* -------------------------------------------------------------------------- */

/** The per-file outcome for `rel`, or `undefined` when the section never ran. */
export function fileOutcome(result: ApplyResult, rel: string): EditFileOutcome | undefined {
	return result.outcome.files.find(item => item.displayPath === rel || item.path.endsWith(rel));
}

/** Assert the payload applied, surfacing the model-facing text on failure. */
export function expectSuccess(result: ApplyResult): void {
	expect(result.outcome.isError, `unexpected engine rejection: ${result.outcome.text}`).toBe(false);
}

/** Assert the payload was rejected and the model-facing text matched `pattern`. */
export function expectError(result: ApplyResult, pattern?: RegExp | string): void {
	expect(result.outcome.isError, `expected a rejection, got: ${result.outcome.text}`).toBe(true);
	pattern === undefined ? undefined : expect(result.outcome.text).toMatch(pattern);
}

/** Warnings the engine reported for `rel`. */
export function warningsOf(result: ApplyResult, rel: string): string[] {
	return fileOutcome(result, rel)?.warnings ?? [];
}

/**
 * Assert the warning set. `includes` is the portable direction (native appends
 * a syntax advisory for source-like paths); pass `exact` only where the engine
 * warning list is a real contract, and it is compared as a sorted set so
 * ordering never becomes an accidental assertion.
 */
export function expectWarnings(
	result: ApplyResult,
	rel: string,
	expected: { includes?: string[]; exact?: string[] },
): void {
	const actual = warningsOf(result, rel);
	for (const warning of expected.includes ?? []) expect(actual).toContain(warning);
	if (expected.exact !== undefined) {
		expect([...actual].sort()).toEqual([...expected.exact].sort());
	}
}

/** Persisted text of one file — the primary assertion target. */
export function expectFile(ws: Workspace, rel: string, expected: string): void {
	expect(ws.read(rel)).toBe(expected);
}
