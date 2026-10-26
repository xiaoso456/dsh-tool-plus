/**
 * DSH → native {@link EditPolicy} mapping.
 *
 * The Rust engine owns path resolution, tag validation, block resolution and
 * every guard; the host only declares *policy* up front. This module is the
 * single place where DSH settings/context become that policy, so the mapping
 * is auditable field by field against upstream's construction site
 * (`refs/oh-my-pi/packages/coding-agent/src/edit/index.ts:554-573`, v18.1.17)
 * and against DSH's own settings facade.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import { DEFAULT_FUZZY_THRESHOLD } from "../../omp/edit/modes/replace.ts";
import { DEFAULT_MAX_COLUMN } from "../../omp/session/streaming-output.ts";
import { resolveOutputMaxColumns } from "../../omp/tools/output-meta.ts";
import type { ToolSession } from "../../omp/sdk.ts";
import type { EditPolicy } from "./index.ts";

/** Optional overrides for {@link buildHashlineEditPolicy}. */
export interface HashlinePolicyOptions {
	/**
	 * The payload is a verbatim custom-format string rather than JSON
	 * (upstream sets this when the call arrived through the custom-tool wire).
	 * DSH never opens an argument stream — it hands `executeHashlineSingle` the
	 * parsed `{ input }` arguments — so this stays `false`.
	 */
	rawInput?: boolean;
}

/**
 * S-13 threshold resolution, mirroring
 * `src/tools/edit/adapter/index.ts:resolveFuzzyThreshold`: an explicit
 * numeric threshold passes through verbatim (0 = accept the best match at any
 * confidence), anything else falls back to the shared engine default. Kept
 * local rather than imported because `edit/adapter/index.ts` imports
 * `executeHashlineSingle`, so importing back would close a module cycle.
 */
function resolveFuzzyThreshold(raw: unknown): number {
	return typeof raw === "number" ? raw : DEFAULT_FUZZY_THRESHOLD;
}

/**
 * Canonicalize `cwd` for the engine policy.
 *
 * The Rust engine canonicalizes the paths it stores (`recordSnapshot`), but it
 * uses `policy.cwd` verbatim for path resolution and for its containment check,
 * and that check compares byte-wise (`path_policy.rs:429-431`). On Windows a
 * workspace under `%TEMP%` reaches JS in 8.3 short form
 * (`C:\Users\XIAOSO~1\...`) while the engine's canonical snapshot key is the
 * long form (`C:\Users\xiaoso456\...`), so an un-normalized `cwd` makes
 * `is_within` fail and tag path recovery silently skip — verified with
 * `D:/tmp/hashline-probes/probe-d3-recovery.mts` (raw cwd →
 * `File not found: a.ts`; canonical cwd → recovered onto `nested/a.ts`).
 *
 * `.native` is required: the JS `realpathSync` does NOT expand short names.
 * A failure (missing directory, permissions) falls back to the input, matching
 * `canonicalSnapshotKey`'s behaviour so both sides of the store agree on one
 * spelling.
 *
 * The same byte-wise check also drives the plan-sandbox / vault-root
 * decisions, so normalizing here is what keeps those from silently
 * mis-evaluating on a short-name cwd. Parity measured this normalization as
 * neutral for every other policy behaviour (7 scenarios, raw vs canonical).
 */
export function canonicalCwd(cwd: string): string {
	try {
		return fs.realpathSync.native(cwd);
	} catch {
		return cwd;
	}
}

/**
 * Mirror upstream `displayMaxColumns`: read's per-line cap bounded by the
 * shared `DEFAULT_MAX_COLUMN`, falling back to the constant when read never
 * cuts lines. The engine uses it to decide whether a hashline anchor that was
 * never displayed by `read` can still be trusted on a long line.
 */
function resolveMaxColumns(session: ToolSession): number {
	const readMaxColumns = resolveOutputMaxColumns(session.settings);
	return readMaxColumns > 0 ? Math.min(readMaxColumns, DEFAULT_MAX_COLUMN) : DEFAULT_MAX_COLUMN;
}

/**
 * Build the engine policy for one `hashline` tool call.
 *
 * Field sources (all reads go through the DSH settings facade, which maps the
 * OMP dotted keys onto the tool-plus config — `src/config/omp-settings.ts`):
 *
 * - `cwd`               — `session.cwd` through {@link canonicalCwd}: the
 *                         engine resolves every authored path against it and
 *                         runs its byte-wise containment check on it
 *                         (upstream :563 passes the cwd verbatim; the
 *                         normalization is a DSH-required fix for Windows
 *                         short names — see {@link canonicalCwd}).
 * - `mode`              — constant `"hashline"`: this adapter only serves the
 *                         hashline entry point.
 * - `allowFuzzy`        — `edit.fuzzyMatch`, default true
 *                         (`edit/adapter/index.ts:210`).
 * - `fuzzyThreshold`    — `edit.fuzzyThreshold`, default 0.95 (S-13 above).
 * - `enforceSeenLines`  — `edit.enforceSeenLines`, schema default false
 *                         (`src/config/omp-settings.ts:24/72`). **Passed
 *                         explicitly and never left to a default**: the
 *                         vendored TS `Patcher` defaulted this to `true`,
 *                         while upstream/native resolve it from settings
 *                         (default `false`). The old engine's stricter
 *                         default therefore deliberately does not survive
 *                         the migration; DSH follows the settings value
 *                         (strict boolean, so a missing key reads as "off").
 * - `blockAutoGenerated`— `edit.blockAutoGenerated`, schema default true
 *                         (`omp-settings.ts:21/69`); `!== false` mirrors
 *                         `shouldBlockAutoGeneratedFiles`'s default-on
 *                         semantics in `omp/tools/auto-generated-guard.ts:297`.
 * - `planActive`        — upstream reads `session.getPlanModeState()?.enabled`.
 *                         DSH's plan mode is a hint layer with **no hard
 *                         gate** (`edit/adapter/tools/plan-mode-guard.ts`
 *                         documents `enforcePlanModeWrite` as a deliberate
 *                         no-op), and no DSH session installs
 *                         `getPlanModeState`, so this resolves to `false`.
 * - `maxColumns`        — upstream `displayMaxColumns(settings)`: read's
 *                         `tools.outputMaxColumns` bounded by
 *                         `DEFAULT_MAX_COLUMN` (512), or 512 when read never
 *                         cuts lines. DSH resolves the same setting through
 *                         `resolveOutputMaxColumns`, so the mapping stays
 *                         identical; the engine uses this cap to decide when a
 *                         hashline anchor on a long line needs recorded read
 *                         provenance.
 * - `urlSchemes` / `urlAliasSchemes` — upstream lists the internal-URL
 *                         router specs (and the schemes whose `scheme:/x`
 *                         spelling aliases `scheme://x`). DSH wires no
 *                         internal-URL router into the edit path and installs
 *                         no `resolveUrl` callback, so both stay empty: the
 *                         engine only ever sees plain paths here.
 * - `planWritableRoots` — upstream `router.sandboxRoots(context)`: plain-path
 *                         roots writable while plan mode is active. DSH's
 *                         plan mode is a hint layer with no sandbox roots, so
 *                         this stays empty while `planActive` still carries
 *                         the hint.
 * - `homeDir`           — `os.homedir()` (upstream :571); the engine uses it
 *                         to recognise and refuse home-directory escapes.
 * - `rawInput`          — see {@link HashlinePolicyOptions.rawInput}.
 */

export function buildHashlineEditPolicy(
	session: ToolSession,
	options: HashlinePolicyOptions = {},
): EditPolicy {
	return {
		cwd: canonicalCwd(session.cwd),
		mode: "hashline",
		allowFuzzy: session.settings.get("edit.fuzzyMatch") !== false,
		fuzzyThreshold: resolveFuzzyThreshold(session.settings.get("edit.fuzzyThreshold")),
		enforceSeenLines: session.settings.get("edit.enforceSeenLines") === true,
		maxColumns: resolveMaxColumns(session),
		blockAutoGenerated: session.settings.get("edit.blockAutoGenerated") !== false,
		planActive: session.getPlanModeState?.()?.enabled ?? false,
		urlSchemes: [],
		urlAliasSchemes: [],
		planWritableRoots: [],
		homeDir: os.homedir(),
		rawInput: options.rawInput ?? false,
	};
}
