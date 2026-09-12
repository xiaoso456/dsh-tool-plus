/**
 * Upstream hashline fixture parity — the independent oracle layer.
 *
 * These cases are ported from the Rust fixture runner
 * (`refs/oh-my-pi/crates/pi-edit/tests/common/mod.rs`, v18.1.17) and pinned to
 * the fixtures' own `expect` blocks. They are deliberately separate from the
 * migrated `*.test.ts` files: the fixtures were generated upstream from the
 * original TS suite's case names, so they check the same behaviour against a
 * byte-for-byte foreign oracle after the engine swap.
 *
 * Provenance: `refs/` is gitignored, so the payload-bearing fixtures are
 * vendored byte-identically under `./fixtures/`. Six upstream fixture files are
 * name-only placeholders with no executable payload and are therefore not
 * vendored (see `D:/tmp/hashline-tests/REGISTRY.md` §I for where those domains
 * are covered instead).
 *
 * Coverage: `patcher.json` (25 session cases) + 203 `apply` calls from nine
 * `parity_*.json` files = 228 assertions across 226 `it()` blocks (the two
 * cross-call clipboard cases fold their calls into one block each).
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	applyArgs,
	applyPatch,
	expectError,
	expectSuccess,
	expectWarnings,
	makeWriter,
	Workspace,
} from "./harness.ts";
import { EditSession } from "../native/index.ts";
import type { EditPolicy, EditPreviewBatch } from "../native/index.ts";

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

/* -------------------------------------------------------------------------- */
/* Fixture shapes                                                              */
/* -------------------------------------------------------------------------- */

interface SessionCase {
	name: string;
	files?: Record<string, string>;
	snapshots?: Array<{ path: string; text?: string; seenLines?: number[] }>;
	policy?: Record<string, unknown>;
	args?: Record<string, unknown>;
	expect: {
		files?: Record<string, string>;
		deleted?: string[];
		error?: string;
		text?: string;
		textContains?: string[];
		writes?: number;
	};
}

interface ApplyCall {
	text: string;
	input: string;
	path?: string;
	clipboard?: Record<string, unknown>;
	expect?: { text?: string; firstChangedLine?: number; warnings?: string[] };
	error?: string;
}

function loadFixture(name: string): any {
	return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Rust `expect_matches`: a leading `^` marks a regex, anything else a substring. */
function matches(actual: string, pattern: string): boolean {
	return pattern.startsWith("^") ? new RegExp(`^${pattern.slice(1)}`).test(actual) : actual.includes(pattern);
}

/** Drop the legacy TS error prefixes (the Rust parity test does the same). */
function legacyError(message: string): string {
	return message.replace(/^(InvalidAbsoluteRangeError|Error): /, "");
}

function shouldMatch(actual: string, pattern: string): boolean {
	return matches(legacyError(actual), legacyError(pattern));
}

/** Deep-walk `{{tag:<path>}}` placeholders in the fixture args. */
function substituteTags<T>(value: T, tags: Array<[string, string]>): T {
	if (typeof value === "string") {
		// `value` narrows to `T & string`; widen explicitly so the joins typecheck.
		let out: string = value;
		for (const [rel, tag] of tags) out = out.split(`{{tag:${rel}}}`).join(tag);
		return out as unknown as T;
	}
	if (Array.isArray(value)) return value.map(item => substituteTags(item, tags)) as unknown as T;
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, inner] of Object.entries(value)) out[key] = substituteTags(inner, tags);
		return out as unknown as T;
	}
	return value;
}

/** Absolute fixture paths collapse into the temp dir (last two segments). */
function displayRel(rawPath: string): string {
	if (!path.isAbsolute(rawPath)) return rawPath.replace(/^[/\\]+/, "");
	const parts = rawPath.replace(/\\/g, "/").split("/").filter(Boolean);
	const tail = parts.slice(-2).join("/");
	return tail.includes(".") ? tail : parts[parts.length - 1] ?? "a.ts";
}

/** Port of Rust `common::run_case`: files → snapshots → args → apply → expect. */
async function runSessionCase(caseData: SessionCase, label: string): Promise<void> {
	const ws = new Workspace(label);
	try {
		for (const [rel, text] of Object.entries(caseData.files ?? {})) ws.write(rel, text);

		const tags: Array<[string, string]> = [];
		for (const snap of caseData.snapshots ?? []) {
			tags.push([snap.path, ws.snapshot(snap.path, snap.text, snap.seenLines)]);
		}

		const policy: Partial<EditPolicy> = {};
		if (caseData.policy) {
			for (const key of ["allowFuzzy", "fuzzyThreshold", "enforceSeenLines", "planActive", "blockAutoGenerated"]) {
				if (caseData.policy[key] !== undefined) (policy as Record<string, unknown>)[key] = caseData.policy[key];
			}
		}

		const args = substituteTags(caseData.args ?? {}, tags);
		const result = await applyArgs(ws, args, { policy });

		if (caseData.expect.error !== undefined) {
			expect(result.outcome.isError, `expected a rejection, got: ${result.outcome.text}`).toBe(true);
			expect(shouldMatch(result.outcome.text, caseData.expect.error)).toBe(true);
		} else {
			expectSuccess(result);
		}
		if (caseData.expect.text !== undefined) expect(result.outcome.text).toBe(caseData.expect.text);
		for (const part of caseData.expect.textContains ?? []) {
			expect(matches(result.outcome.text, part), `${JSON.stringify(part)} missing from ${JSON.stringify(result.outcome.text)}`).toBe(true);
		}
		for (const [rel, expected] of Object.entries(caseData.expect.files ?? {})) {
			expect(ws.read(rel), `persisted bytes for ${rel}`).toBe(expected);
		}
		for (const rel of caseData.expect.deleted ?? []) {
			expect(ws.exists(rel), `${rel} should have been deleted`).toBe(false);
		}
		if (caseData.expect.writes !== undefined) expect(result.requests.length).toBe(caseData.expect.writes);
	} finally {
		ws.dispose();
	}
}

/** Re-express one fixture `apply` call (parsed edits + raw text) as a session run. */
async function runApplyCall(call: ApplyCall, index: number, label: string): Promise<void> {
	const rel = displayRel(call.path ?? `fixture-${index}.ts`);
	const ws = new Workspace(label);
	try {
		ws.write(rel, call.text);
		const tag = ws.snapshot(rel, call.text);
		const result = await applyPatch(ws, `[${rel}#${tag}]\n${call.input}`);

		if (call.error !== undefined) {
			expect(result.outcome.isError, `expected a rejection, got: ${result.outcome.text}`).toBe(true);
			expect(shouldMatch(result.outcome.text, call.error)).toBe(true);
			return;
		}
		expectSuccess(result);

		const file = result.outcome.files.find(item => item.displayPath === rel || item.path.endsWith(rel));
		expect(file, `no per-file outcome for ${rel}`).toBeDefined();
		if (call.expect?.text !== undefined) expect(file?.newText).toBe(call.expect.text);
		if (call.expect?.firstChangedLine !== undefined) expect(file?.firstChangedLine).toBe(call.expect.firstChangedLine);
		if (call.expect?.warnings !== undefined && call.expect.warnings.length > 0) {
			expectWarnings(result, rel, { includes: call.expect.warnings });
		}
	} finally {
		ws.dispose();
	}
}

/* -------------------------------------------------------------------------- */
/* Fixture files                                                               */
/* -------------------------------------------------------------------------- */

const PARITY_FIXTURES = [
	"parity_block.json",
	"parity_boundary_repair.json",
	"parity_clipboard.json",
	"parity_core_contracts.json",
	"parity_file_ops.json",
	"parity_format_v2.json",
	"parity_landing_shift.json",
	"parity_leniency.json",
	"parity_patcher.json",
] as const;

/* -------------------------------------------------------------------------- */
/* Session-level parity                                                        */
/* -------------------------------------------------------------------------- */

describe("upstream fixture parity — session cases (patcher.json)", () => {
	const root = loadFixture("patcher.json");
	for (const [index, caseData] of (root.cases as SessionCase[]).entries()) {
		it(`[${index}] ${caseData.name}`, async () => {
			await runSessionCase(caseData, `patcher-${index}`);
		});
	}
});

/* -------------------------------------------------------------------------- */
/* Apply-call parity                                                           */
/* -------------------------------------------------------------------------- */

describe("upstream fixture parity — apply calls (parity_*.json)", () => {
	for (const fixture of PARITY_FIXTURES) {
		const root = loadFixture(fixture);
		for (const caseData of root.cases as Array<Record<string, any>>) {
			const calls = (caseData.apply ?? []) as ApplyCall[];
			if (calls.length === 0) continue;

			// Two upstream cases seed a host-owned clipboard across calls. The
			// N-API surface has no clipboard accessor, so the state is rebuilt
			// from payload text: named registers persist across applies on one
			// store; anonymous ones never cross calls, so those fold into a
			// single multi-section payload.
			const namedCarry = calls.some(call => (call.clipboard as any)?.named !== undefined);
			const anonCarry = calls
				.slice(1)
				.some(call => (call.clipboard as any)?.lines !== undefined && (call.clipboard as any)?.pendingAnonCuts !== undefined);

			if (namedCarry || anonCarry) {
				it(`[${fixture}] ${caseData.name} (cross-call clipboard equivalence)`, async () => {
					const ws = new Workspace(`${fixture}-${caseData.name}`);
					const writer = makeWriter();
					try {
						const sections: string[] = [];
						for (const [index, call] of calls.entries()) {
							const rel = displayRel(call.path ?? `fixture-${index}.ts`);
							ws.write(rel, call.text);
							sections.push(`[${rel}#${ws.snapshot(rel, call.text)}]\n${call.input}`);
						}
						const payload = anonCarry ? sections.join("\n") : undefined;
						// Named-register carry needs one session per call; the
						// anonymous case is a single atomic payload.
						const previews: EditPreviewBatch[] = [];
						const applyOne = async (input: string) => {
							const session = new EditSession(ws.store, ws.policy(), null);
							try {
								session.setArgsJson(JSON.stringify({ input }));
								session.finish();
								return (await session.apply({ lspFlush: false }, writer.fn)) as any;
							} finally {
								session.close();
							}
						};
						const outcomes: any[] = [];
						if (payload !== undefined) outcomes.push(await applyOne(payload));
						else for (const section of sections) outcomes.push(await applyOne(section));

						const last = outcomes[outcomes.length - 1];
						expect(last.isError, `unexpected rejection: ${last.text}`).toBe(false);
						const files = outcomes.flatMap(outcome => outcome.files ?? []);
						for (const [index, call] of calls.entries()) {
							const rel = displayRel(call.path ?? `fixture-${index}.ts`);
							const file = files.find((item: any) => item.displayPath === rel || item.path.endsWith(rel));
							if (call.expect?.text !== undefined) expect(file?.newText, `applied text for ${rel}`).toBe(call.expect.text);
							if (call.expect?.firstChangedLine !== undefined) expect(file?.firstChangedLine).toBe(call.expect.firstChangedLine);
						}
						expect(previews.length).toBe(0);
					} finally {
						ws.dispose();
					}
				});
				continue;
			}

			for (const [index, call] of calls.entries()) {
				it(`[${fixture}] ${caseData.name} [apply#${index}]`, async () => {
					await runApplyCall(call, index, `${fixture}-${index}`);
				});
			}
		}
	}
});
